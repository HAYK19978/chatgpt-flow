(() => {
  "use strict";

  if (window.__CHATGPT_FLOW_V032__) return;
  window.__CHATGPT_FLOW_V032__ = true;

  const DEFAULT_SILENCE_MS = 5000;
  const MIN_SILENCE_MS = 2000;
  const MAX_SILENCE_MS = 90000;

  const VOICE_CONFIRM_MS = 180;
  const MIN_VOICE_RMS = 0.005;
  const VOICE_THRESHOLD_MULTIPLIER = 2.8;

  const READ_DELAY_MS = 1000;
  const READ_POLL_MS = 350;
  const READ_TIMEOUT_MS = 300000;
  const READ_AUDIO_START_TIMEOUT_MS = 8000;
  const READ_LOCK_MAX_MS = 30 * 60 * 1000;

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

  const READ_LOCK_NAME = "chatgpt-flow-read-aloud-v1";
  const CHANNEL_NAME = "chatgpt-flow-control-v1";

  const tabId =
    crypto.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let enabled = true;
  let silenceMs = DEFAULT_SILENCE_MS;

  let dictateRequested = false;
  let attachFallbackTimer = 0;
  let lastChatGPTStream = null;
  let audioSession = null;

  let readSession = null;
  let readLockHeld = false;
  let readLockRelease = null;
  let readLockGuardTimer = 0;
  let awaitingAutoReadAudio = false;
  let readAudioStartTimer = 0;
  let activeReadAudio = null;
  let controlChannel = null;

  function log(...args) {
    console.log("[ChatGPT Flow]", ...args);
  }

  function clampSilenceMs(value) {
    const numeric = Number(value);

    if (!Number.isFinite(numeric)) {
      return DEFAULT_SILENCE_MS;
    }

    return Math.min(
      MAX_SILENCE_MS,
      Math.max(MIN_SILENCE_MS, Math.round(numeric)),
    );
  }

  // ---------------------------------------------------------------------------
  // Settings bridge
  // ---------------------------------------------------------------------------

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.source !== "chatgpt-flow-extension" ||
      event.data?.type !== "settings"
    ) {
      return;
    }

    const next = event.data.settings || {};

    enabled = next.enabled !== false;
    silenceMs = clampSilenceMs(next.silenceMs);

    log(
      enabled ? "enabled" : "disabled",
      `silence=${Math.round(silenceMs / 100) / 10}s`,
    );

    if (!enabled) {
      cancelDictationMonitoring();
      cancelAutomaticRead();
      pauseManagedReadAloud();
      releaseReadLock();
    }
  });

  window.postMessage(
    {
      source: "chatgpt-flow-main",
      type: "request-settings",
    },
    "*",
  );

  // ---------------------------------------------------------------------------
  // Cross-tab read control
  // ---------------------------------------------------------------------------

  if (typeof BroadcastChannel === "function") {
    controlChannel = new BroadcastChannel(CHANNEL_NAME);

    controlChannel.addEventListener("message", (event) => {
      const message = event.data;

      if (
        !message ||
        message.source !== "chatgpt-flow" ||
        message.tabId === tabId
      ) {
        return;
      }

      if (message.type === "pause-read-aloud") {
        pauseManagedReadAloud();
      }
    });
  }

  function broadcastPauseReadAloud() {
    try {
      controlChannel?.postMessage({
        source: "chatgpt-flow",
        type: "pause-read-aloud",
        tabId,
      });
    } catch {}
  }

  function clearReadLockGuard() {
    if (!readLockGuardTimer) return;

    clearTimeout(readLockGuardTimer);
    readLockGuardTimer = 0;
  }

  function releaseReadLock() {
    clearReadLockGuard();

    if (readAudioStartTimer) {
      clearTimeout(readAudioStartTimer);
      readAudioStartTimer = 0;
    }

    awaitingAutoReadAudio = false;

    const release = readLockRelease;
    readLockRelease = null;

    if (release) release();
  }

  async function acquireReadLock() {
    if (readLockHeld) return true;

    if (!navigator.locks?.request) {
      log("Web Locks API unavailable; cross-tab read lock skipped");
      return true;
    }

    return new Promise((resolve) => {
      let settled = false;

      navigator.locks
        .request(
          READ_LOCK_NAME,
          { ifAvailable: true, mode: "exclusive" },
          async (lock) => {
            if (!lock) {
              settled = true;
              resolve(false);
              return;
            }

            readLockHeld = true;

            let releaseHold;

            const hold = new Promise((release) => {
              releaseHold = release;
            });

            readLockRelease = () => {
              if (!readLockHeld) return;

              readLockHeld = false;
              releaseHold();
            };

            readLockGuardTimer = window.setTimeout(() => {
              log("Read lock safety timeout");
              releaseReadLock();
            }, READ_LOCK_MAX_MS);

            if (!settled) {
              settled = true;
              resolve(true);
            }

            await hold;
          },
        )
        .catch((error) => {
          log("Read lock failed:", error);

          if (!settled) {
            settled = true;
            resolve(false);
          }
        });
    });
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

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

    return event.target instanceof Element
      ? event.target.closest("button")
      : null;
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

    return composer
      ? (composer.innerText || composer.textContent || "").trim()
      : "";
  }

  function composerContains(target) {
    if (!(target instanceof Element)) return false;

    const composer = getComposer();

    return !!(composer && (target === composer || composer.contains(target)));
  }

  function isSendButton(button) {
    if (!(button instanceof HTMLButtonElement)) {
      return false;
    }

    return (
      button.matches(SEND_SELECTORS.join(",")) ||
      /^send(?: prompt| message)?$/i.test(buttonLabel(button))
    );
  }

  function isStopGeneratingButton(button) {
    if (!(button instanceof HTMLButtonElement)) {
      return false;
    }

    return (
      button.matches('[data-testid="stop-button"]') ||
      /stop.*(?:generat|stream|response)/i.test(buttonLabel(button))
    );
  }

  function generationRunning() {
    return [...document.querySelectorAll("button")].some(
      (button) => isStopGeneratingButton(button) && isVisible(button),
    );
  }

  function dictationUIIsActive() {
    return (
      isVisible(
        document.querySelector('button[aria-label="Stop dictation"]'),
      ) ||
      isVisible(document.querySelector(TRANSCRIBE_SEND_SELECTOR)) ||
      isVisible(document.querySelector('button[aria-label="Cancel dictation"]'))
    );
  }

  function getAssistantTurns() {
    const articles = [
      ...document.querySelectorAll('article[data-turn="assistant"]'),
    ];

    if (articles.length) {
      return articles;
    }

    const nodes = [
      ...document.querySelectorAll('[data-message-author-role="assistant"]'),
    ];

    const seen = new Set();
    const turns = [];

    for (const node of nodes) {
      const turn = node.closest("article") || node;

      if (!seen.has(turn)) {
        seen.add(turn);
        turns.push(turn);
      }
    }

    return turns;
  }

  function getReadButtonForTurn(turn) {
    if (!(turn instanceof Element) || !turn.isConnected) {
      return null;
    }

    const inside = turn.querySelector(READ_SELECTOR);

    if (isUsableButton(inside)) {
      return inside;
    }

    const article = turn.closest("article");

    if (article) {
      const button = article.querySelector(READ_SELECTOR);

      if (isUsableButton(button)) {
        return button;
      }
    }

    return null;
  }

  function findNativeReadStopButton() {
    return (
      [...document.querySelectorAll("button")]
        .filter(isVisible)
        .filter((button) => !isStopGeneratingButton(button))
        .filter((button) => !/dictation/i.test(buttonLabel(button)))
        .find((button) =>
          /^(?:stop|pause)(?:\s+(?:reading|read aloud|audio))?$/i.test(
            buttonLabel(button),
          ),
        ) || null
    );
  }

  // ---------------------------------------------------------------------------
  // Read-aloud pause / lifecycle
  // ---------------------------------------------------------------------------

  function pauseManagedReadAloud() {
    let paused = false;

    if (
      activeReadAudio instanceof HTMLMediaElement &&
      !activeReadAudio.paused &&
      !activeReadAudio.ended
    ) {
      try {
        activeReadAudio.pause();
        paused = true;
      } catch {}
    }

    if (!paused) {
      for (const media of document.querySelectorAll("audio")) {
        if (
          !(media instanceof HTMLMediaElement) ||
          media.paused ||
          media.ended
        ) {
          continue;
        }

        try {
          media.pause();
          activeReadAudio = media;
          paused = true;
          break;
        } catch {}
      }
    }

    if (!paused) {
      const stopButton = findNativeReadStopButton();

      if (stopButton) {
        try {
          stopButton.click();
          paused = true;
        } catch {}
      }
    }

    if (paused) {
      log("Paused Read aloud before dictation");
    }

    releaseReadLock();

    return paused;
  }

  document.addEventListener(
    "play",
    (event) => {
      const media = event.target;

      if (!(media instanceof HTMLMediaElement)) {
        return;
      }

      if (!readLockHeld && !awaitingAutoReadAudio) {
        return;
      }

      activeReadAudio = media;
      awaitingAutoReadAudio = false;

      if (readAudioStartTimer) {
        clearTimeout(readAudioStartTimer);

        readAudioStartTimer = 0;
      }

      log("Read aloud audio started");
    },
    true,
  );

  function onManagedMediaStopped(event) {
    const media = event.target;

    if (!(media instanceof HTMLMediaElement) || media !== activeReadAudio) {
      return;
    }

    if (media.paused || media.ended) {
      log(media.ended ? "Read aloud finished" : "Read aloud paused");

      releaseReadLock();
    }
  }

  document.addEventListener("pause", onManagedMediaStopped, true);

  document.addEventListener("ended", onManagedMediaStopped, true);

  // ---------------------------------------------------------------------------
  // Dictation stream capture
  // ---------------------------------------------------------------------------

  function streamHasLiveAudio(stream) {
    return (
      stream instanceof MediaStream &&
      stream.getAudioTracks().some((track) => track.readyState === "live")
    );
  }

  function clearAttachFallbackTimer() {
    if (!attachFallbackTimer) {
      return;
    }

    clearTimeout(attachFallbackTimer);

    attachFallbackTimer = 0;
  }

  function cleanupAudioSession() {
    const session = audioSession;

    if (!session) return;

    audioSession = null;

    if (session.fallbackTimer) {
      clearInterval(session.fallbackTimer);

      session.fallbackTimer = 0;
    }

    if (session.track && session.onTrackEnded) {
      session.track.removeEventListener("ended", session.onTrackEnded);
    }

    if (session.processor) {
      session.processor.onaudioprocess = null;
    }

    try {
      session.source?.disconnect();
    } catch {}

    try {
      session.processor?.disconnect();
    } catch {}

    try {
      session.silentGain?.disconnect();
    } catch {}

    try {
      session.analyser?.disconnect();
    } catch {}

    session.audioContext?.close().catch(() => {});
  }

  function cancelDictationMonitoring() {
    dictateRequested = false;
    clearAttachFallbackTimer();
    cleanupAudioSession();
  }

  const mediaDevices = navigator.mediaDevices;

  if (mediaDevices && typeof mediaDevices.getUserMedia === "function") {
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);

    mediaDevices.getUserMedia = async function (...args) {
      const constraints = args[0];

      let stream;

      try {
        stream = await originalGetUserMedia(...args);
      } catch (error) {
        if (dictateRequested) {
          dictateRequested = false;
          clearAttachFallbackTimer();

          log("ChatGPT microphone request failed:", error);
        }

        throw error;
      }

      if (constraints?.audio && streamHasLiveAudio(stream)) {
        lastChatGPTStream = stream;

        if (enabled && dictateRequested) {
          dictateRequested = false;
          clearAttachFallbackTimer();

          attachToChatGPTStream(stream).catch((error) => {
            log("Could not attach silence detector:", error);

            cleanupAudioSession();
          });
        }
      }

      return stream;
    };

    log("v0.3.2 native microphone hook installed");
  } else {
    log("navigator.mediaDevices.getUserMedia is unavailable");
  }

  function beginDictationMonitoring() {
    cancelDictationMonitoring();

    if (!enabled) return;

    pauseManagedReadAloud();
    broadcastPauseReadAloud();

    dictateRequested = true;

    attachFallbackTimer = window.setTimeout(() => {
      attachFallbackTimer = 0;

      if (!enabled || !dictateRequested) {
        return;
      }

      if (!dictationUIIsActive()) {
        dictateRequested = false;

        log("Dictation UI did not become active");

        return;
      }

      if (!streamHasLiveAudio(lastChatGPTStream)) {
        attachFallbackTimer = window.setTimeout(() => {
          attachFallbackTimer = 0;

          if (!enabled || !dictateRequested) {
            return;
          }

          if (streamHasLiveAudio(lastChatGPTStream)) {
            dictateRequested = false;

            attachToChatGPTStream(lastChatGPTStream).catch((error) => {
              log("Could not reuse ChatGPT microphone stream:", error);

              cleanupAudioSession();
            });

            return;
          }

          dictateRequested = false;

          log("No live ChatGPT microphone stream available");
        }, 1200);

        return;
      }

      dictateRequested = false;

      attachToChatGPTStream(lastChatGPTStream).catch((error) => {
        log("Could not reuse ChatGPT microphone stream:", error);

        cleanupAudioSession();
      });
    }, 300);

    log("Dictate clicked; waiting for ChatGPT microphone stream");
  }

  // ---------------------------------------------------------------------------
  // Voice / silence detection
  // ---------------------------------------------------------------------------

  function calculateRmsFromFloat32(buffer) {
    let sum = 0;

    for (let i = 0; i < buffer.length; i += 1) {
      const sample = buffer[i];

      sum += sample * sample;
    }

    return Math.sqrt(sum / buffer.length);
  }

  function calculateAnalyserRms(analyser, buffer) {
    analyser.getFloatTimeDomainData(buffer);

    return calculateRmsFromFloat32(buffer);
  }

  function processAudioLevel(session, rms, now) {
    if (
      audioSession !== session ||
      !enabled ||
      session.sending ||
      !dictationUIIsActive()
    ) {
      return;
    }

    const delta = Math.min(300, Math.max(0, now - session.lastSampleAt));

    session.lastSampleAt = now;

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

    if (now - session.lastSpeechAt >= silenceMs) {
      transcribeAndSendAfterSilence(session);
    }
  }

  async function attachToChatGPTStream(stream) {
    cleanupAudioSession();

    if (!enabled || !streamHasLiveAudio(stream)) {
      return;
    }

    const track = stream
      .getAudioTracks()
      .find((item) => item.readyState === "live");

    if (!track) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      log("Web Audio API unavailable");

      return;
    }

    const audioContext = new AudioContextClass();

    if (audioContext.state === "suspended") {
      try {
        await audioContext.resume();
      } catch {}
    }

    if (!enabled || !dictationUIIsActive()) {
      audioContext.close().catch(() => {});

      return;
    }

    const source = audioContext.createMediaStreamSource(stream);

    const session = {
      stream,
      track,
      audioContext,
      source,
      processor: null,
      silentGain: null,
      analyser: null,
      analyserBuffer: null,
      fallbackTimer: 0,
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

      if (lastChatGPTStream === stream) {
        lastChatGPTStream = null;
      }
    };

    track.addEventListener("ended", session.onTrackEnded);

    audioSession = session;

    if (typeof audioContext.createScriptProcessor === "function") {
      const processor = audioContext.createScriptProcessor(1024, 1, 1);

      const silentGain = audioContext.createGain();

      silentGain.gain.value = 0;

      processor.onaudioprocess = (event) => {
        if (audioSession !== session) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);

        const rms = calculateRmsFromFloat32(input);

        processAudioLevel(session, rms, performance.now());
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      session.processor = processor;

      session.silentGain = silentGain;

      log("Monitoring ChatGPT microphone stream with audio callbacks");

      return;
    }

    const analyser = audioContext.createAnalyser();

    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.12;

    source.connect(analyser);

    session.analyser = analyser;

    session.analyserBuffer = new Float32Array(analyser.fftSize);

    session.fallbackTimer = window.setInterval(() => {
      if (audioSession !== session) {
        return;
      }

      const rms = calculateAnalyserRms(analyser, session.analyserBuffer);

      processAudioLevel(session, rms, performance.now());
    }, 80);

    log("Monitoring ChatGPT microphone stream with timer fallback");
  }

  function transcribeAndSendAfterSilence(session) {
    if (audioSession !== session || session.sending || !enabled) {
      return;
    }

    session.sending = true;

    log(`${Math.round(silenceMs / 100) / 10}s of silence detected`);

    const button = document.querySelector(TRANSCRIBE_SEND_SELECTOR);

    if (!isUsableButton(button)) {
      log("Transcribe and send button not available; dictation left untouched");

      session.sending = false;

      return;
    }

    armAutomaticRead();
    cleanupAudioSession();

    log("Clicking native Transcribe and send");

    button.click();
  }

  // ---------------------------------------------------------------------------
  // Automatic Read aloud - only the newly generated assistant turn
  // ---------------------------------------------------------------------------

  function cancelAutomaticRead() {
    const session = readSession;

    if (!session) return;

    readSession = null;

    if (session.pollTimer) {
      clearInterval(session.pollTimer);
    }

    if (session.clickTimer) {
      clearTimeout(session.clickTimer);
    }
  }

  function armAutomaticRead() {
    if (!enabled) return;

    cancelAutomaticRead();

    const turns = getAssistantTurns();

    const session = {
      baselineTurns: new Set(turns),
      baselineCount: turns.length,
      route: location.pathname,
      startedAt: performance.now(),
      seenGeneration: false,
      targetTurn: null,
      pollTimer: 0,
      clickTimer: 0,
    };

    readSession = session;

    log("Waiting for the new assistant response");

    session.pollTimer = window.setInterval(() => {
      pollForFinishedResponse(session);
    }, READ_POLL_MS);
  }

  function resolveTargetTurn(session) {
    if (session.targetTurn?.isConnected) {
      return session.targetTurn;
    }

    const turns = getAssistantTurns();

    if (turns.length <= session.baselineCount) {
      return null;
    }

    const newest = turns.at(-1);

    if (!newest || session.baselineTurns.has(newest)) {
      return null;
    }

    session.targetTurn = newest;

    return newest;
  }

  async function startAutomaticRead(session) {
    if (readSession !== session || !enabled || generationRunning()) {
      return;
    }

    const targetTurn = resolveTargetTurn(session);

    if (!targetTurn) return;

    let button = getReadButtonForTurn(targetTurn);

    if (!button) return;

    const lockGranted = await acquireReadLock();

    if (readSession !== session || !enabled || generationRunning()) {
      if (lockGranted) {
        releaseReadLock();
      }

      return;
    }

    if (!lockGranted) {
      log("Another ChatGPT tab is already reading; auto-read skipped");

      readSession = null;

      return;
    }

    button = getReadButtonForTurn(targetTurn);

    if (!button) {
      log("Read aloud button for the new response disappeared");

      readSession = null;

      releaseReadLock();

      return;
    }

    readSession = null;
    awaitingAutoReadAudio = true;

    readAudioStartTimer = window.setTimeout(() => {
      readAudioStartTimer = 0;

      if (!awaitingAutoReadAudio) {
        return;
      }

      awaitingAutoReadAudio = false;

      log("Read aloud audio did not start; releasing cross-tab lock");

      releaseReadLock();
    }, READ_AUDIO_START_TIMEOUT_MS);

    log("Starting Read aloud for the new assistant response");

    button.click();
  }

  function pollForFinishedResponse(session) {
    if (readSession !== session || !enabled) {
      return;
    }

    if (location.pathname !== session.route) {
      cancelAutomaticRead();

      return;
    }

    if (performance.now() - session.startedAt > READ_TIMEOUT_MS) {
      log("Read-aloud wait timed out");

      cancelAutomaticRead();

      return;
    }

    const running = generationRunning();

    if (running) {
      session.seenGeneration = true;

      return;
    }

    const targetTurn = resolveTargetTurn(session);

    if (!targetTurn) {
      return;
    }

    const button = getReadButtonForTurn(targetTurn);

    if (!button) return;

    if (session.pollTimer) {
      clearInterval(session.pollTimer);

      session.pollTimer = 0;
    }

    log("New response finished; Read aloud in 1 second");

    session.clickTimer = window.setTimeout(() => {
      session.clickTimer = 0;

      startAutomaticRead(session).catch((error) => {
        log("Could not start automatic Read aloud:", error);

        if (readSession === session) {
          readSession = null;
        }

        releaseReadLock();
      });
    }, READ_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // User actions
  // ---------------------------------------------------------------------------

  function onDocumentClick(event) {
    const button = getButtonFromEvent(event);

    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const label = buttonLabel(button);

    if (/^dictate$/i.test(label)) {
      if (enabled) {
        beginDictationMonitoring();
      }

      return;
    }

    if (
      /^(?:cancel dictation|stop dictation|cancel transcription)$/i.test(label)
    ) {
      cancelDictationMonitoring();

      return;
    }

    if (/^transcribe and send$/i.test(label)) {
      cancelDictationMonitoring();

      if (enabled && isUsableButton(button)) {
        armAutomaticRead();
      }

      return;
    }

    if (isStopGeneratingButton(button)) {
      cancelAutomaticRead();

      return;
    }

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

  window.addEventListener("pagehide", () => {
    cancelDictationMonitoring();
    cancelAutomaticRead();
    pauseManagedReadAloud();
    releaseReadLock();

    try {
      controlChannel?.close();
    } catch {}
  });

  log("v0.3.2 main controller loaded");
})();
