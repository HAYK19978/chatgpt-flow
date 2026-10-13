(() => {
  "use strict";

  if (window.__CHATGPT_FLOW_V020__) return;
  window.__CHATGPT_FLOW_V020__ = true;

  const SILENCE_MS = 5000;
  const AUDIO_SAMPLE_MS = 80;
  const VOICE_CONFIRM_MS = 180;
  const MIN_VOICE_RMS = 0.005;
  const VOICE_THRESHOLD_MULTIPLIER = 2.8;

  const READ_DELAY_MS = 1000;
  const READ_POLL_MS = 350;
  const READ_TIMEOUT_MS = 300000;
  const DICTATE_ARM_TIMEOUT_MS = 5000;

  const READ_SELECTOR = 'button[aria-label="Read aloud"]';

  const TRANSCRIBE_SEND_SELECTOR = 'button[aria-label="Transcribe and send"]';

  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
  ];

  const COMPOSER_SELECTORS = [
    'div[role="textbox"][aria-label="Ask ChatGPT"]',
    "#prompt-textarea",
    'div[contenteditable="true"][data-lexical-editor="true"]',
  ];

  let enabled = true;

  let dictateArmed = false;
  let dictateArmTimer = 0;
  let audioSession = null;

  let readSession = null;

  function log(...args) {
    console.log("[ChatGPT Flow]", ...args);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.source !== "chatgpt-flow-extension" ||
      event.data?.type !== "settings"
    ) {
      return;
    }

    enabled = event.data.settings?.enabled !== false;

    log(enabled ? "enabled" : "disabled");

    if (!enabled) {
      disarmDictation();
      cleanupAudioSession();
      cancelAutomaticRead();
    }
  });

  window.postMessage(
    {
      source: "chatgpt-flow-main",
      type: "request-settings",
    },
    "*",
  );

  // -------------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------------

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) {
      return false;
    }

    const rect = element.getBoundingClientRect();

    const style = getComputedStyle(element);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  function isUsableButton(button) {
    return (
      button instanceof HTMLButtonElement &&
      button.isConnected &&
      !button.disabled &&
      button.getAttribute("aria-disabled") !== "true" &&
      isVisible(button)
    );
  }

  function getButtonFromEvent(event) {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];

    for (const node of path) {
      if (node instanceof HTMLButtonElement) {
        return node;
      }
    }

    const target = event.target;

    return target instanceof Element ? target.closest("button") : null;
  }

  function buttonLabel(button) {
    return (button?.getAttribute("aria-label") || "").trim();
  }

  function getComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const composer = document.querySelector(selector);

      if (composer instanceof HTMLElement) {
        return composer;
      }
    }

    return null;
  }

  function getComposerText() {
    const composer = getComposer();

    if (!composer) {
      return "";
    }

    return (composer.innerText || composer.textContent || "").trim();
  }

  function composerContains(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    const composer = getComposer();

    return !!(composer && (target === composer || composer.contains(target)));
  }

  function isSendButton(button) {
    if (!(button instanceof HTMLButtonElement)) {
      return false;
    }

    if (button.matches(SEND_SELECTORS.join(","))) {
      return true;
    }

    return /^send(?: prompt| message)?$/i.test(buttonLabel(button));
  }

  function isStopGeneratingButton(button) {
    if (!(button instanceof HTMLButtonElement)) {
      return false;
    }

    if (button.matches('[data-testid="stop-button"]')) {
      return true;
    }

    return /stop.*(?:generat|stream|response)/i.test(buttonLabel(button));
  }

  function generationRunning() {
    return [...document.querySelectorAll("button")].some(
      (button) => isStopGeneratingButton(button) && isVisible(button),
    );
  }

  function getReadButtons() {
    return [...document.querySelectorAll(READ_SELECTOR)];
  }

  // -------------------------------------------------------------------------
  // Dictation arming
  // -------------------------------------------------------------------------

  function disarmDictation() {
    dictateArmed = false;

    if (dictateArmTimer) {
      clearTimeout(dictateArmTimer);

      dictateArmTimer = 0;
    }
  }

  function armDictation() {
    disarmDictation();
    cleanupAudioSession();

    dictateArmed = true;

    log("Dictate clicked; waiting for ChatGPT microphone stream");

    dictateArmTimer = window.setTimeout(() => {
      dictateArmTimer = 0;

      if (!dictateArmed) {
        return;
      }

      dictateArmed = false;

      log("No ChatGPT microphone stream detected within 5 seconds");
    }, DICTATE_ARM_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------
  // Hook ChatGPT's own microphone stream
  // -------------------------------------------------------------------------

  const mediaDevices = navigator.mediaDevices;

  if (mediaDevices && typeof mediaDevices.getUserMedia === "function") {
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);

    mediaDevices.getUserMedia = async function (...args) {
      const constraints = args[0];

      let stream;

      try {
        stream = await originalGetUserMedia(...args);
      } catch (error) {
        if (dictateArmed) {
          disarmDictation();

          log("ChatGPT microphone request failed:", error);
        }

        throw error;
      }

      if (enabled && dictateArmed && constraints?.audio) {
        disarmDictation();

        attachToChatGPTStream(stream).catch((error) => {
          log("Could not attach silence detector:", error);

          cleanupAudioSession();
        });
      }

      return stream;
    };

    log("Native microphone hook installed");
  } else {
    log("navigator.mediaDevices.getUserMedia is unavailable");
  }

  // -------------------------------------------------------------------------
  // Audio analysis
  // -------------------------------------------------------------------------

  function calculateRms(analyser, buffer) {
    analyser.getFloatTimeDomainData(buffer);

    let sum = 0;

    for (let i = 0; i < buffer.length; i += 1) {
      const sample = buffer[i];

      sum += sample * sample;
    }

    return Math.sqrt(sum / buffer.length);
  }

  function cleanupAudioSession() {
    const session = audioSession;

    if (!session) {
      return;
    }

    audioSession = null;

    if (session.timer) {
      clearInterval(session.timer);

      session.timer = 0;
    }

    if (session.track && session.onTrackEnded) {
      session.track.removeEventListener("ended", session.onTrackEnded);
    }

    try {
      session.source?.disconnect();
    } catch {
      // Ignore.
    }

    try {
      session.analyser?.disconnect();
    } catch {
      // Ignore.
    }

    if (session.audioContext) {
      session.audioContext.close().catch(() => {});
    }

    /*
     * Очень важно:
     * MediaStream принадлежит самому ChatGPT.
     * Мы его НЕ останавливаем.
     */
  }

  async function attachToChatGPTStream(stream) {
    cleanupAudioSession();

    if (!enabled || !(stream instanceof MediaStream)) {
      return;
    }

    const track = stream.getAudioTracks()[0];

    if (!track) {
      log("ChatGPT stream has no audio track");

      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      log("Web Audio API unavailable");

      return;
    }

    const audioContext = new AudioContextClass();

    if (audioContext.state === "suspended") {
      try {
        await audioContext.resume();
      } catch {
        // Continue.
      }
    }

    if (!enabled) {
      audioContext.close().catch(() => {});

      return;
    }

    const source = audioContext.createMediaStreamSource(stream);

    const analyser = audioContext.createAnalyser();

    analyser.fftSize = 1024;

    analyser.smoothingTimeConstant = 0.12;

    source.connect(analyser);

    const session = {
      stream,
      track,
      audioContext,
      source,
      analyser,

      buffer: new Float32Array(analyser.fftSize),

      timer: 0,

      onTrackEnded: null,

      noiseFloor: 0.0015,

      speechConfirmed: false,

      speechEvidenceMs: 0,

      lastSampleAt: performance.now(),

      lastSpeechAt: 0,

      sending: false,
    };

    session.onTrackEnded = () => {
      if (audioSession !== session) {
        return;
      }

      log("ChatGPT microphone track ended");

      cleanupAudioSession();
    };

    track.addEventListener("ended", session.onTrackEnded, {
      once: true,
    });

    audioSession = session;

    session.timer = window.setInterval(() => {
      sampleAudio(session);
    }, AUDIO_SAMPLE_MS);

    log("Monitoring ChatGPT microphone stream");
  }

  function sampleAudio(session) {
    if (
      audioSession !== session ||
      !enabled ||
      session.sending ||
      !session.analyser ||
      !session.buffer
    ) {
      return;
    }

    const now = performance.now();

    const delta = Math.min(200, Math.max(0, now - session.lastSampleAt));

    session.lastSampleAt = now;

    const rms = calculateRms(session.analyser, session.buffer);

    const threshold = Math.max(
      MIN_VOICE_RMS,
      session.noiseFloor * VOICE_THRESHOLD_MULTIPLIER,
    );

    const voiceNow = rms > threshold;

    if (!session.speechConfirmed) {
      if (voiceNow) {
        session.speechEvidenceMs += delta;
      } else {
        session.speechEvidenceMs = Math.max(
          0,
          session.speechEvidenceMs - delta * 0.6,
        );

        if (rms < Math.max(0.015, threshold * 1.2)) {
          session.noiseFloor = session.noiseFloor * 0.97 + rms * 0.03;
        }
      }

      if (session.speechEvidenceMs >= VOICE_CONFIRM_MS) {
        session.speechConfirmed = true;

        session.lastSpeechAt = now;

        log("Speech detected");
      }

      return;
    }

    if (voiceNow) {
      session.lastSpeechAt = now;

      return;
    }

    if (now - session.lastSpeechAt >= SILENCE_MS) {
      transcribeAndSendAfterSilence(session);
    }
  }

  // -------------------------------------------------------------------------
  // Silence -> native Transcribe and send
  // -------------------------------------------------------------------------

  function transcribeAndSendAfterSilence(session) {
    if (audioSession !== session || session.sending || !enabled) {
      return;
    }

    session.sending = true;

    if (session.timer) {
      clearInterval(session.timer);

      session.timer = 0;
    }

    log("5 seconds of silence detected");

    const button = document.querySelector(TRANSCRIBE_SEND_SELECTOR);

    if (!isUsableButton(button)) {
      log("Transcribe and send button not found; dictation left untouched");

      cleanupAudioSession();

      return;
    }

    /*
     * Запоминаем старые Read aloud
     * ДО отправки нового сообщения.
     */
    armAutomaticRead();

    /*
     * Закрываем только наш analyser.
     * Родной микрофон ChatGPT не трогаем.
     */
    cleanupAudioSession();

    log("Clicking native Transcribe and send");

    button.click();
  }

  // -------------------------------------------------------------------------
  // Automatic Read aloud
  // -------------------------------------------------------------------------

  function cancelAutomaticRead() {
    const session = readSession;

    if (!session) {
      return;
    }

    readSession = null;

    if (session.pollTimer) {
      clearInterval(session.pollTimer);
    }

    if (session.clickTimer) {
      clearTimeout(session.clickTimer);
    }
  }

  function armAutomaticRead() {
    if (!enabled) {
      return;
    }

    cancelAutomaticRead();

    const session = {
      baseline: new Set(getReadButtons()),

      route: location.href,

      startedAt: performance.now(),

      pollTimer: 0,

      clickTimer: 0,
    };

    readSession = session;

    log("Waiting for new assistant response");

    session.pollTimer = window.setInterval(() => {
      pollForFinishedResponse(session);
    }, READ_POLL_MS);
  }

  function pollForFinishedResponse(session) {
    if (readSession !== session || !enabled) {
      return;
    }

    if (location.href !== session.route) {
      cancelAutomaticRead();
      return;
    }

    if (performance.now() - session.startedAt > READ_TIMEOUT_MS) {
      log("Read-aloud wait timed out");

      cancelAutomaticRead();

      return;
    }

    if (generationRunning()) {
      return;
    }

    const candidate = getReadButtons()
      .filter(
        (button) => !session.baseline.has(button) && isUsableButton(button),
      )
      .at(-1);

    if (!candidate) {
      return;
    }

    if (session.pollTimer) {
      clearInterval(session.pollTimer);

      session.pollTimer = 0;
    }

    log("Response finished; Read aloud in 1 second");

    session.clickTimer = window.setTimeout(() => {
      session.clickTimer = 0;

      if (readSession !== session || !enabled || generationRunning()) {
        return;
      }

      if (!isUsableButton(candidate)) {
        log("Read aloud button disappeared before click");

        cancelAutomaticRead();

        return;
      }

      readSession = null;

      log("Starting Read aloud");

      candidate.click();
    }, READ_DELAY_MS);
  }

  // -------------------------------------------------------------------------
  // User actions
  // -------------------------------------------------------------------------

  function onDocumentClick(event) {
    const button = getButtonFromEvent(event);

    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const label = buttonLabel(button);

    /*
     * User starts native Dictate.
     */
    if (/^dictate$/i.test(label)) {
      if (enabled) {
        armDictation();
      }

      return;
    }

    /*
     * User manually cancels/stops dictation.
     * Our analyser must disappear too.
     */
    if (
      /^(?:cancel dictation|stop dictation|cancel transcription)$/i.test(label)
    ) {
      disarmDictation();
      cleanupAudioSession();

      return;
    }

    /*
     * User manually presses native
     * Transcribe and send.
     */
    if (/^transcribe and send$/i.test(label)) {
      disarmDictation();
      cleanupAudioSession();

      if (enabled && isUsableButton(button)) {
        armAutomaticRead();
      }

      return;
    }

    /*
     * User manually stops response generation.
     * Do not read partial response.
     */
    if (isStopGeneratingButton(button)) {
      cancelAutomaticRead();

      return;
    }

    /*
     * Normal typed message sent by button.
     */
    if (enabled && isSendButton(button) && isUsableButton(button)) {
      armAutomaticRead();
    }
  }

  function onDocumentKeyDown(event) {
    if (
      !enabled ||
      event.defaultPrevented ||
      event.isComposing ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      !composerContains(event.target) ||
      getComposerText().length === 0
    ) {
      return;
    }

    armAutomaticRead();
  }

  document.addEventListener("click", onDocumentClick, true);

  document.addEventListener("keydown", onDocumentKeyDown, true);

  /*
   * Не держим analyser в фоновой вкладке.
   * Родной микрофон ChatGPT при этом не останавливаем.
   */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      return;
    }

    disarmDictation();
    cleanupAudioSession();
  });

  window.addEventListener("pagehide", () => {
    disarmDictation();
    cleanupAudioSession();
    cancelAutomaticRead();
  });

  log("v0.2.0 main controller loaded");
})();
