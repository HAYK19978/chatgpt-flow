(() => {
  "use strict";

  if (window.__CHATGPT_FLOW_CONTROLLER_V059__) return;
  window.__CHATGPT_FLOW_CONTROLLER_V059__ = true;

  const READ_SELECTOR = 'button[aria-label="Read aloud"]';
  const TRANSCRIBE_SELECTOR = 'button[aria-label="Transcribe and send"]';
  const ACTION_ROW_SELECTOR = ".turn-action-controls";
  const COMPOSER_SELECTOR =
    '#prompt-textarea,div[role="textbox"][aria-label="Ask ChatGPT"],div[contenteditable="true"][data-lexical-editor="true"]';
  const SEND_SELECTOR =
    'button[data-testid="send-button"],button[aria-label="Send"],button[aria-label="Send prompt"],button[aria-label="Send message"]';
  const STOP_GENERATION_SELECTOR = 'button[data-testid="stop-button"]';
  const AUTO_READ_LOCK = "chatgpt-flow-auto-read-v059";
  const PLAYBACK_CHANNEL = "chatgpt-flow-playback-v059";
  const TAB_ID = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

  // The UI intentionally still says 15. ChatGPT's streamed TTS timeline has
  // behaved much "wider" than wall-clock time in real use, so use a gentler
  // internal step. This can be tuned later without changing the UI.
  const DISPLAYED_SEEK_SECONDS = 15;
  const INTERNAL_SEEK_SECONDS = 1.5;

  const DEFAULTS = {
    enabled: true,
    autoSendEnabled: true,
    silenceMs: 5000,
    autoReadEnabled: true,
    autoReadDelayMs: 0,
    readySoundEnabled: false,
    playbackRate: 1,
  };

  const nativeButtonClick = HTMLButtonElement.prototype.click;
  const nativeMediaPlay = HTMLMediaElement.prototype.play;
  const nativeMediaPause = HTMLMediaElement.prototype.pause;
  const nativeGetUserMedia =
    navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices) || null;

  let settings = { ...DEFAULTS };

  // Response lifecycle.
  let responseSession = null;
  let pendingAutoReadTimer = 0;
  let responsePollTimer = 0;

  // Dictation / silence monitor.
  let lastMicStream = null;
  let silenceSession = null;

  // Read-aloud media state.
  let pendingReadKey = "";
  let pendingReadRow = null;
  let activeReadKey = "";
  let activeReadRow = null;
  let activeMedia = null;
  let virtualPaused = false;
  let virtualPausePosition = 0;
  let virtualPauseOriginalMuted = false;
  let virtualPauseOriginalVolume = 1;
  let virtualPauseTimer = 0;
  let pauseGuardHook = null;
  let pauseGuardPreviousPlay = null;

  // A response may be manually played before its delayed Auto Read fires.
  // Track handled response keys so the same answer cannot start a second lap.
  const autoReadHandledKeys = new Set();

  // The page can replace HTMLMediaElement.prototype.play after document_start.
  // Install a short-lived capture hook immediately before each Read aloud click.
  let captureHook = null;
  let capturePreviousPlay = null;
  let captureTimeout = 0;

  // Cross-tab playback coordination and auto-read lock.
  let autoReadRelease = null;
  let autoReadSafetyTimer = 0;
  const remotePlayback = new Map();
  let playbackHeartbeatTimer = 0;
  const playbackChannel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel(PLAYBACK_CHANNEL)
      : null;

  function log(...args) {
    console.log("[ChatGPT Flow]", ...args);
  }

  function buttonLabel(button) {
    return (button?.getAttribute("aria-label") || "").trim();
  }

  function isUsableButton(button) {
    return (
      button instanceof HTMLButtonElement &&
      button.isConnected &&
      !button.disabled &&
      button.getAttribute("aria-disabled") !== "true"
    );
  }

  function generationRunning() {
    return [...document.querySelectorAll("button")].some((button) => {
      if (!isUsableButton(button)) return false;
      return (
        button.matches(STOP_GENERATION_SELECTOR) ||
        /stop.*(?:generat|stream|response)/i.test(buttonLabel(button))
      );
    });
  }

  function nativeButtonsIn(row) {
    return [...row.querySelectorAll("button")].filter(
      (button) => !button.closest("[data-chatgpt-flow-row-controls]"),
    );
  }

  function isAssistantActionRow(row) {
    if (!(row instanceof Element) || !row.isConnected) return false;
    return nativeButtonsIn(row).some((button) =>
      /^(?:Read aloud|Regenerate response|Rate response)$/i.test(
        buttonLabel(button),
      ),
    );
  }

  function nativeReadButton(row) {
    if (!(row instanceof Element)) return null;
    return (
      nativeButtonsIn(row).find((button) =>
        /^Read aloud$/i.test(buttonLabel(button)),
      ) || null
    );
  }

  function turnContainer(row) {
    if (!(row instanceof Element)) return null;

    // Prefer the smallest ancestor that contains this action row and an actual
    // assistant message body. Broad utility-class ancestors can contain both
    // the user prompt and assistant reply and are unstable across rerenders.
    let node = row.parentElement;
    while (node && node !== document.body) {
      const actionRows = node.querySelectorAll?.(ACTION_ROW_SELECTOR)?.length || 0;
      const hasMessageBody = !!node.querySelector?.(
        '[data-message-author-role="assistant"],.markdown,.prose,[class*="markdown"]',
      );

      if (actionRows === 1 && hasMessageBody) return node;
      node = node.parentElement;
    }

    return row.parentElement || row;
  }

  function normalizedTurnText(row) {
    const container = turnContainer(row);
    if (!(container instanceof Element)) return "";

    try {
      const explicitAssistant = container.matches?.(
        '[data-message-author-role="assistant"]',
      )
        ? container
        : container.querySelector?.('[data-message-author-role="assistant"]');

      const body =
        explicitAssistant?.querySelector?.('.markdown,.prose,[class*="markdown"]') ||
        explicitAssistant ||
        container.querySelector?.('.markdown,.prose,[class*="markdown"]') ||
        container;

      const clone = body.cloneNode(true);
      clone
        .querySelectorAll?.(
          `${ACTION_ROW_SELECTOR},[data-chatgpt-flow-row-controls],button`,
        )
        .forEach((node) => node.remove());

      return (clone.innerText || clone.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
    } catch {
      return (container.innerText || container.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  function entryForRow(row) {
    if (!isAssistantActionRow(row)) return null;
    const read = nativeReadButton(row);
    if (!isUsableButton(read)) return null;

    const text = normalizedTurnText(row);
    if (!text) return null;

    return {
      row,
      read,
      text,
      key: `${location.pathname}::${text}`,
    };
  }

  function assistantEntries() {
    return [...document.querySelectorAll(ACTION_ROW_SELECTOR)]
      .map(entryForRow)
      .filter(Boolean);
  }

  function latestAssistantEntry() {
    return assistantEntries().at(-1) || null;
  }

  function resolveEntryByKey(key) {
    if (!key) return null;
    const entries = assistantEntries();
    return entries.find((entry) => entry.key === key) || null;
  }


  function announcePlayback(state) {
    if (!playbackChannel) return;
    try {
      playbackChannel.postMessage({
        tabId: TAB_ID,
        state,
        at: Date.now(),
      });
    } catch {}
  }

  function pruneRemotePlayback() {
    const now = Date.now();
    for (const [tabId, at] of remotePlayback) {
      if (now - at > 15000) remotePlayback.delete(tabId);
    }
  }

  function otherTabPlaybackActive() {
    pruneRemotePlayback();
    return remotePlayback.size > 0;
  }

  if (playbackChannel) {
    playbackChannel.addEventListener("message", (event) => {
      const data = event.data || {};
      if (!data.tabId || data.tabId === TAB_ID) return;

      if (data.state === "playing") {
        remotePlayback.set(data.tabId, Number(data.at) || Date.now());
      } else if (data.state === "idle") {
        remotePlayback.delete(data.tabId);
      }
    });
  }

  function startPlaybackHeartbeat() {
    if (playbackHeartbeatTimer) return;
    announcePlayback("playing");
    playbackHeartbeatTimer = window.setInterval(() => {
      if (mediaHasSource(activeMedia)) {
        announcePlayback("playing");
      } else {
        stopPlaybackHeartbeat();
      }
    }, 5000);
  }

  function stopPlaybackHeartbeat() {
    if (playbackHeartbeatTimer) {
      clearInterval(playbackHeartbeatTimer);
      playbackHeartbeatTimer = 0;
    }
    announcePlayback("idle");
  }

  function clearPendingAutoRead() {
    if (!pendingAutoReadTimer) return;
    clearTimeout(pendingAutoReadTimer);
    pendingAutoReadTimer = 0;
  }

  function armForResponse() {
    if (!settings.enabled) return;

    clearPendingAutoRead();

    const baselineEntries = assistantEntries();
    const latest = baselineEntries.at(-1) || null;
    responseSession = {
      route: location.pathname,
      startedAt: performance.now(),
      baselineKey: latest?.key || "",
      baselineKeys: new Set(baselineEntries.map((entry) => entry.key)),
      sawGeneration: generationRunning(),
      generationStoppedAt: 0,
      candidateKey: "",
      stableSince: 0,
    };

    log("Response tracking armed");
  }

  function playReadySound() {
    if (!settings.enabled || !settings.readySoundEnabled) return;
    window.postMessage(
      { source: "chatgpt-flow-main", type: "play-ready-sound" },
      "*",
    );
  }

  function releaseAutoReadLock() {
    if (autoReadSafetyTimer) {
      clearTimeout(autoReadSafetyTimer);
      autoReadSafetyTimer = 0;
    }

    const release = autoReadRelease;
    autoReadRelease = null;
    if (release) release();
  }

  function clearVirtualPause({ restoreMuted = true } = {}) {
    if (virtualPauseTimer) {
      clearInterval(virtualPauseTimer);
      virtualPauseTimer = 0;
    }

    clearPauseGuard();

    if (restoreMuted && activeMedia instanceof HTMLMediaElement) {
      try {
        activeMedia.muted = virtualPauseOriginalMuted;
        activeMedia.volume = virtualPauseOriginalVolume;
      } catch {}
    }

    virtualPaused = false;
    virtualPausePosition = 0;
    virtualPauseOriginalMuted = false;
    virtualPauseOriginalVolume = 1;
  }

  function dispatchPlaybackState() {
    window.dispatchEvent(new CustomEvent("chatgpt-flow-playback-state"));
  }

  function mediaHasSource(media) {
    return (
      media instanceof HTMLMediaElement &&
      !media.ended &&
      !!(media.currentSrc || media.src)
    );
  }

  function looksLikeReadAloudMedia(media) {
    if (!(media instanceof HTMLAudioElement)) return false;
    const src = String(media.currentSrc || media.src || "");
    return (
      !media.isConnected ||
      src.startsWith("blob:https://chatgpt.com/") ||
      src.startsWith("blob:https://chat.openai.com/")
    );
  }

  function markAutoReadHandled(key) {
    if (!key) return;
    autoReadHandledKeys.add(key);
    while (autoReadHandledKeys.size > 40) {
      autoReadHandledKeys.delete(autoReadHandledKeys.values().next().value);
    }
  }

  function clearPauseGuard() {
    if (
      pauseGuardHook &&
      pauseGuardPreviousPlay &&
      HTMLMediaElement.prototype.play === pauseGuardHook
    ) {
      HTMLMediaElement.prototype.play = pauseGuardPreviousPlay;
    }
    pauseGuardHook = null;
    pauseGuardPreviousPlay = null;
  }

  function disarmMediaCapture() {
    if (captureTimeout) {
      clearTimeout(captureTimeout);
      captureTimeout = 0;
    }

    if (
      captureHook &&
      capturePreviousPlay &&
      HTMLMediaElement.prototype.play === captureHook
    ) {
      HTMLMediaElement.prototype.play = capturePreviousPlay;
    }

    captureHook = null;
    capturePreviousPlay = null;
  }

  function clearActiveMedia(media = activeMedia) {
    if (media && activeMedia !== media) return;

    clearVirtualPause({ restoreMuted: false });
    activeMedia = null;
    activeReadKey = "";
    activeReadRow = null;
    pendingReadKey = "";
    pendingReadRow = null;
    stopPlaybackHeartbeat();
    dispatchPlaybackState();
    releaseAutoReadLock();
  }

  function adoptReadMedia(media, key = pendingReadKey, row = pendingReadRow) {
    if (!(media instanceof HTMLMediaElement)) return;

    // ChatGPT can replace its detached streaming <audio> while Flow is paused.
    // v0.5.7 cleared the logical pause during that handoff, which caused the
    // inconsistent first/second/third click behavior. Preserve pause state.
    const preservePause =
      virtualPaused &&
      activeMedia instanceof HTMLMediaElement &&
      activeMedia !== media;

    if (activeMedia && activeMedia !== media && !preservePause) {
      clearVirtualPause();
    }

    activeMedia = media;
    activeReadKey = key || activeReadKey;
    activeReadRow = row || activeReadRow;
    pendingReadKey = "";
    pendingReadRow = null;

    try {
      media.defaultPlaybackRate = settings.playbackRate;
      media.playbackRate = settings.playbackRate;

      if (preservePause || virtualPaused) {
        media.muted = true;
        media.volume = 0;

        if (!media.paused) {
          nativeMediaPause.call(media);
        }

        if (Number.isFinite(virtualPausePosition)) {
          try {
            media.currentTime = virtualPausePosition;
          } catch {}
        }
      }
    } catch {}

    if (!media.__chatgptFlowV059Lifecycle) {
      media.addEventListener(
        "ended",
        () => {
          if (activeMedia === media) clearActiveMedia(media);
        },
        { once: true },
      );

      try {
        Object.defineProperty(media, "__chatgptFlowV059Lifecycle", {
          value: true,
          configurable: true,
        });
      } catch {}
    }

    startPlaybackHeartbeat();
    dispatchPlaybackState();
  }

  function armMediaCapture(key, row) {
    disarmMediaCapture();

    pendingReadKey = key || "";
    pendingReadRow = row || null;
    if (key) activeReadKey = key;
    if (row) activeReadRow = row;
    dispatchPlaybackState();

    const previousPlay = HTMLMediaElement.prototype.play;

    const hook = function (...args) {
      const result = previousPlay.apply(this, args);

      if (looksLikeReadAloudMedia(this)) {
        adoptReadMedia(this, key, row);
        queueMicrotask(disarmMediaCapture);
      }

      return result;
    };

    capturePreviousPlay = previousPlay;
    captureHook = hook;
    HTMLMediaElement.prototype.play = hook;
    captureTimeout = window.setTimeout(disarmMediaCapture, 10000);
  }

  function stopCurrentPlayback() {
    const media = activeMedia;
    clearVirtualPause();

    if (media instanceof HTMLMediaElement && !media.paused) {
      try {
        nativeMediaPause.call(media);
      } catch {}
    }

    clearActiveMedia(media);
  }

  function startReadEntry(entry) {
    if (!settings.enabled || !entry || !isUsableButton(entry.read)) {
      return false;
    }

    if (
      activeMedia &&
      activeReadKey &&
      activeReadKey !== entry.key
    ) {
      stopCurrentPlayback();
    }

    armMediaCapture(entry.key, entry.row);

    try {
      nativeButtonClick.call(entry.read);
      return true;
    } catch (error) {
      log("Read aloud click failed:", error);
      disarmMediaCapture();
      pendingReadKey = "";
      pendingReadRow = null;
      return false;
    }
  }

  function startReadForRow(row) {
    const entry = entryForRow(row);
    if (!entry) return false;
    return startReadEntry(entry);
  }

  function beginVirtualPause() {
    if (!mediaHasSource(activeMedia)) return false;
    if (virtualPaused) return true;

    virtualPausePosition = Number.isFinite(activeMedia.currentTime)
      ? activeMedia.currentTime
      : 0;
    virtualPauseOriginalMuted = !!activeMedia.muted;
    virtualPauseOriginalVolume = Number.isFinite(activeMedia.volume)
      ? activeMedia.volume
      : 1;
    virtualPaused = true;

    try {
      disarmMediaCapture();
      clearPauseGuard();

      // ChatGPT may call play() again immediately after a real pause, or even
      // replace the detached TTS <audio>. While Flow is paused, block every
      // detached Read-aloud play() attempt and keep the newest such object.
      const previousPlay = HTMLMediaElement.prototype.play;
      const guard = function (...args) {
        if (virtualPaused && looksLikeReadAloudMedia(this)) {
          if (activeMedia !== this) {
            adoptReadMedia(this, activeReadKey, activeReadRow);
          }

          try {
            this.muted = true;
            this.volume = 0;
            if (!this.paused) nativeMediaPause.call(this);
            if (Number.isFinite(virtualPausePosition)) {
              this.currentTime = virtualPausePosition;
            }
          } catch {}

          return Promise.resolve();
        }

        return previousPlay.apply(this, args);
      };

      pauseGuardPreviousPlay = previousPlay;
      pauseGuardHook = guard;
      HTMLMediaElement.prototype.play = guard;

      // Pause the concrete media now, then keep enforcing the paused position.
      activeMedia.muted = true;
      activeMedia.volume = 0;
      nativeMediaPause.call(activeMedia);
      activeMedia.currentTime = virtualPausePosition;

      virtualPauseTimer = window.setInterval(() => {
        if (!virtualPaused || !mediaHasSource(activeMedia)) return;

        try {
          activeMedia.muted = true;
          activeMedia.volume = 0;

          if (!activeMedia.paused) {
            nativeMediaPause.call(activeMedia);
          }

          if (
            Number.isFinite(virtualPausePosition) &&
            Math.abs(activeMedia.currentTime - virtualPausePosition) > 0.015
          ) {
            activeMedia.currentTime = virtualPausePosition;
          }
        } catch {}
      }, 35);

      dispatchPlaybackState();
      return true;
    } catch (error) {
      clearVirtualPause();
      log("Pause failed:", error);
      return false;
    }
  }

  function resumeVirtualPause() {
    if (!virtualPaused || !mediaHasSource(activeMedia)) return false;

    const resumeAt = virtualPausePosition;
    const restoreMuted = virtualPauseOriginalMuted;
    const restoreVolume = virtualPauseOriginalVolume;
    const resumePlay = pauseGuardPreviousPlay || HTMLMediaElement.prototype.play;

    try {
      if (virtualPauseTimer) {
        clearInterval(virtualPauseTimer);
        virtualPauseTimer = 0;
      }

      clearPauseGuard();

      if (Number.isFinite(resumeAt)) activeMedia.currentTime = resumeAt;
      activeMedia.muted = restoreMuted;
      activeMedia.volume = restoreVolume;
      activeMedia.defaultPlaybackRate = settings.playbackRate;
      activeMedia.playbackRate = settings.playbackRate;

      virtualPaused = false;
      virtualPausePosition = 0;
      virtualPauseOriginalMuted = false;
      virtualPauseOriginalVolume = 1;

      if (activeMedia.paused) {
        const result = resumePlay.apply(activeMedia, []);
        result?.catch?.((error) => log("Resume play failed:", error));
      }

      dispatchPlaybackState();
      return true;
    } catch (error) {
      log("Resume failed:", error);
      return false;
    }
  }

  function rowKey(row) {
    return entryForRow(row)?.key || "";
  }

  function rowMatchesActive(row, key = rowKey(row)) {
    return (
      mediaHasSource(activeMedia) &&
      (!!key && (row === activeReadRow || key === activeReadKey))
    );
  }

  function toggleForRow(row) {
    const key = rowKey(row);
    if (!key) return false;

    const mediaActive = mediaHasSource(activeMedia);
    const sameResponse = mediaActive && activeReadKey === key;

    // The v0.5.8 bug was here: any stale paused TTS object in the tab was
    // treated as the media for whichever row the user clicked. That made the
    // first click resume/pause an older answer and left the visible button on
    // Play. Only control media that belongs to this exact assistant response.
    if (sameResponse) {
      activeReadRow = row;
      return virtualPaused ? resumeVirtualPause() : beginVirtualPause();
    }

    // A different response owns the remembered media. Stop and forget it
    // before starting the requested row; never inherit its pause state.
    if (mediaActive || virtualPaused || activeReadKey) {
      stopCurrentPlayback();
    }

    clearPendingAutoRead();
    markAutoReadHandled(key);
    return startReadForRow(row);
  }

  function seekForRow(row, direction) {
    // Seeking is likewise a property of the one active TTS media object in this
    // tab, not of the transient React row that happened to launch it.
    if (!mediaHasSource(activeMedia)) {
      return false;
    }

    const sign = Number(direction) < 0 ? -1 : 1;
    const delta = sign * INTERNAL_SEEK_SECONDS;
    const base = virtualPaused
      ? virtualPausePosition
      : Number(activeMedia.currentTime || 0);

    let target = Math.max(0, base + delta);

    try {
      if (activeMedia.seekable?.length) {
        const start = activeMedia.seekable.start(0);
        const end = activeMedia.seekable.end(activeMedia.seekable.length - 1);
        target = Math.min(Math.max(target, start), Math.max(start, end - 0.03));
      } else if (Number.isFinite(activeMedia.duration)) {
        target = Math.min(target, Math.max(0, activeMedia.duration - 0.03));
      }

      activeMedia.currentTime = target;
      if (virtualPaused) virtualPausePosition = target;
      dispatchPlaybackState();
      log(
        `Seek button ${sign < 0 ? "-" : "+"}${DISPLAYED_SEEK_SECONDS}s`,
        `internal=${delta}s`,
        `target=${target.toFixed(2)}`,
      );
      return true;
    } catch (error) {
      log("Seek failed:", error);
      return false;
    }
  }

  function clampPlaybackRate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 1;
    return Math.min(2, Math.max(0.5, Math.round(numeric * 4) / 4));
  }

  function setPlaybackRate(rate, persist = true) {
    settings.playbackRate = clampPlaybackRate(rate);

    if (mediaHasSource(activeMedia)) {
      try {
        activeMedia.defaultPlaybackRate = settings.playbackRate;
        activeMedia.playbackRate = settings.playbackRate;
      } catch {}
    }

    if (persist) {
      window.postMessage(
        {
          source: "chatgpt-flow-main",
          type: "update-settings",
          settings: { playbackRate: settings.playbackRate },
        },
        "*",
      );
    }

    dispatchPlaybackState();
  }

  function cyclePlaybackRate() {
    const rates = [0.75, 1, 1.25, 1.5, 1.75, 2];
    const current = rates.findIndex(
      (rate) => Math.abs(rate - settings.playbackRate) < 0.001,
    );
    setPlaybackRate(rates[(current + 1 + rates.length) % rates.length], true);
  }

  function playbackStateForRow(row) {
    const key = rowKey(row);
    const mediaActive = mediaHasSource(activeMedia);
    const matched = rowMatchesActive(row, key);

    return {
      // Pause/Play state belongs to one exact assistant response. A stale media
      // object from another response must never make this row look paused.
      active: mediaActive && matched,
      paused: mediaActive && matched && virtualPaused,
      rate: settings.playbackRate,
    };
  }

  async function startAutoReadByKey(key, requestedAt = performance.now()) {
    if (
      !settings.enabled ||
      !settings.autoReadEnabled ||
      !key ||
      autoReadHandledKeys.has(key)
    ) {
      return;
    }

    const retry = () => {
      if (
        autoReadHandledKeys.has(key) ||
        performance.now() - requestedAt >= 120000
      ) {
        return;
      }

      clearPendingAutoRead();
      pendingAutoReadTimer = window.setTimeout(() => {
        pendingAutoReadTimer = 0;
        startAutoReadByKey(key, requestedAt);
      }, 1000);
    };

    const latest = latestAssistantEntry();
    if (!latest || latest.key !== key) {
      log("Skipping stale auto-read target");
      return;
    }

    if (mediaHasSource(activeMedia) || otherTabPlaybackActive()) {
      retry();
      return;
    }

    const runWithLock = async (lock) => {
      if (!lock) {
        retry();
        return;
      }

      const entry = resolveEntryByKey(key);
      const currentLatest = latestAssistantEntry();
      if (
        !entry ||
        !currentLatest ||
        currentLatest.key !== key ||
        !settings.enabled ||
        !settings.autoReadEnabled ||
        generationRunning()
      ) {
        return;
      }

      if (mediaHasSource(activeMedia) || otherTabPlaybackActive()) {
        retry();
        return;
      }

      let releaseHold;
      const hold = new Promise((resolve) => {
        releaseHold = resolve;
      });

      autoReadRelease = releaseHold;
      autoReadSafetyTimer = window.setTimeout(
        releaseAutoReadLock,
        30 * 60 * 1000,
      );

      const started = startReadEntry(entry);
      if (!started) {
        releaseAutoReadLock();
        retry();
        return;
      }

      markAutoReadHandled(key);

      window.setTimeout(() => {
        if (autoReadRelease && !mediaHasSource(activeMedia)) {
          releaseAutoReadLock();
        }
      }, 10000);

      await hold;
    };

    if (navigator.locks?.request) {
      navigator.locks
        .request(
          AUTO_READ_LOCK,
          { ifAvailable: true, mode: "exclusive" },
          runWithLock,
        )
        .catch((error) => log("Auto-read lock failed:", error));
    } else {
      runWithLock({ name: AUTO_READ_LOCK }).catch(() => {});
    }
  }

  function finishResponse(session, entry) {
    if (responseSession !== session) return;
    responseSession = null;

    playReadySound();

    if (settings.autoReadEnabled) {
      clearPendingAutoRead();

      const key = entry.key;
      const delay = Math.max(0, Number(settings.autoReadDelayMs) || 0);

      const requestedAt = performance.now() + delay;
      pendingAutoReadTimer = window.setTimeout(() => {
        pendingAutoReadTimer = 0;
        startAutoReadByKey(key, requestedAt);
      }, delay);
    }

    log("Response ready", {
      sound: settings.readySoundEnabled,
      autoRead: settings.autoReadEnabled,
      delayMs: settings.autoReadDelayMs,
    });
  }

  function pollResponseState() {
    const session = responseSession;
    if (!session || !settings.enabled) return;

    const now = performance.now();

    if (
      location.pathname !== session.route ||
      now - session.startedAt > 300000
    ) {
      responseSession = null;
      return;
    }

    const running = generationRunning();
    if (running) {
      session.sawGeneration = true;
      session.generationStoppedAt = 0;
      session.candidateKey = "";
      session.stableSince = 0;
      return;
    }

    if (session.sawGeneration && !session.generationStoppedAt) {
      session.generationStoppedAt = now;
    }

    const latest = latestAssistantEntry();
    if (!latest) return;

    // The native Read aloud action row is only available for a completed
    // assistant turn. That is a stronger completion signal than the Stop
    // button, which can be missed entirely for short/background responses.
    const isNewEntry =
      latest.key !== session.baselineKey &&
      !session.baselineKeys?.has?.(latest.key);

    if (!isNewEntry) return;

    if (latest.key !== session.candidateKey) {
      session.candidateKey = latest.key;
      session.stableSince = now;
      return;
    }

    // Give React a brief settling window so a streaming/final DOM swap cannot
    // make us announce the previous answer or schedule auto-read too early.
    const stableFor = now - session.stableSince;
    const armedFor = now - session.startedAt;
    if (stableFor < 600 || armedFor < 700) return;

    finishResponse(session, latest);
  }

  // ---------------------------------------------------------------------------
  // Dictation silence auto-send
  // ---------------------------------------------------------------------------

  function streamHasLiveAudio(stream) {
    return (
      stream instanceof MediaStream &&
      stream.getAudioTracks().some((track) => track.readyState === "live")
    );
  }

  function clearSilenceSession() {
    const session = silenceSession;
    silenceSession = null;
    if (!session) return;

    if (session.timer) clearInterval(session.timer);
    if (session.track && session.onEnded) {
      session.track.removeEventListener("ended", session.onEnded);
    }

    try {
      session.source?.disconnect();
    } catch {}
    try {
      session.analyser?.disconnect();
    } catch {}
    try {
      session.context?.close();
    } catch {}
  }

  function calculateRms(analyser, buffer) {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  async function startSilenceMonitor(stream) {
    if (
      !settings.enabled ||
      !settings.autoSendEnabled ||
      !streamHasLiveAudio(stream)
    ) {
      return;
    }

    clearSilenceSession();

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();

    try {
      if (context.state === "suspended") await context.resume();
    } catch {}

    if (
      !settings.enabled ||
      !settings.autoSendEnabled ||
      !streamHasLiveAudio(stream)
    ) {
      context.close().catch(() => {});
      return;
    }

    const track = stream
      .getAudioTracks()
      .find((item) => item.readyState === "live");
    if (!track) {
      context.close().catch(() => {});
      return;
    }

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.08;
    source.connect(analyser);

    const session = {
      stream,
      track,
      context,
      source,
      analyser,
      buffer: new Float32Array(analyser.fftSize),
      timer: 0,
      onEnded: null,
      noiseFloor: 0.0008,
      speechConfirmed: false,
      speechEvidenceMs: 0,
      peakRms: 0,
      lastSampleAt: performance.now(),
      lastSpeechAt: 0,
      sending: false,
    };

    session.onEnded = () => {
      if (silenceSession === session) clearSilenceSession();
    };
    track.addEventListener("ended", session.onEnded);

    silenceSession = session;

    session.timer = window.setInterval(() => {
      if (
        silenceSession !== session ||
        !settings.enabled ||
        !settings.autoSendEnabled ||
        session.sending
      ) {
        return;
      }

      if (!streamHasLiveAudio(stream)) {
        clearSilenceSession();
        return;
      }

      const now = performance.now();
      const level = calculateRms(analyser, session.buffer);
      const delta = Math.min(250, Math.max(0, now - session.lastSampleAt));
      session.lastSampleAt = now;
      session.peakRms = Math.max(session.peakRms, level);

      const threshold = Math.max(0.0015, session.noiseFloor * 2.2);
      const tailThreshold = Math.max(0.00055, session.noiseFloor * 1.35);
      const voice = level > (session.speechConfirmed ? tailThreshold : threshold);

      if (!session.speechConfirmed) {
        if (voice) {
          session.speechEvidenceMs += delta;
        } else {
          session.speechEvidenceMs = Math.max(
            0,
            session.speechEvidenceMs - delta * 0.4,
          );

          if (level < Math.max(0.008, threshold * 1.3)) {
            session.noiseFloor =
              session.noiseFloor * 0.97 + level * 0.03;
          }
        }

        if (
          session.speechEvidenceMs >= 120 ||
          (session.peakRms >= 0.003 && session.speechEvidenceMs >= 80)
        ) {
          session.speechConfirmed = true;
          session.lastSpeechAt = now;
          log("Speech detected");
        }

        return;
      }

      if (voice) {
        session.lastSpeechAt = now;
        return;
      }

      const silenceMs = Math.max(
        2000,
        Math.min(90000, Number(settings.silenceMs) || 5000),
      );

      // Give the end of a spoken phrase a little hysteresis. This protects
      // quieter final syllables from being treated as silence several seconds
      // before the user actually stopped talking.
      const effectiveLastSpeechAt = session.lastSpeechAt + 250;
      if (now - effectiveLastSpeechAt < silenceMs) return;

      const button = document.querySelector(TRANSCRIBE_SELECTOR);
      if (!isUsableButton(button)) {
        // Keep monitoring. The native send button can appear a fraction later.
        return;
      }

      session.sending = true;
      armForResponse();
      log(`Silence timeout ${silenceMs}ms; clicking Transcribe and send`);

      clearSilenceSession();

      try {
        nativeButtonClick.call(button);
      } catch (error) {
        log("Auto-send click failed:", error);
      }
    }, 60);

    log("Silence monitor attached");
  }

  function restartSilenceMonitorIfPossible() {
    if (
      settings.enabled &&
      settings.autoSendEnabled &&
      streamHasLiveAudio(lastMicStream)
    ) {
      startSilenceMonitor(lastMicStream).catch((error) =>
        log("Could not start silence monitor:", error),
      );
    }
  }

  if (nativeGetUserMedia && navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async function (...args) {
      const stream = await nativeGetUserMedia(...args);

      if (args[0]?.audio && streamHasLiveAudio(stream)) {
        lastMicStream = stream;

        if (settings.enabled && settings.autoSendEnabled) {
          startSilenceMonitor(stream).catch((error) =>
            log("Could not attach silence monitor:", error),
          );
        }
      }

      return stream;
    };
  }

  // ---------------------------------------------------------------------------
  // User actions / settings / observers
  // ---------------------------------------------------------------------------

  document.addEventListener(
    "click",
    (event) => {
      const button =
        event.target instanceof Element
          ? event.target.closest("button")
          : null;
      if (!(button instanceof HTMLButtonElement)) return;

      if (button.closest("[data-chatgpt-flow-row-controls]")) return;

      const label = buttonLabel(button);

      if (/^Read aloud$/i.test(label)) {
        const row = button.closest(ACTION_ROW_SELECTOR);
        const entry = entryForRow(row);
        if (entry) {
          clearPendingAutoRead();
          markAutoReadHandled(entry.key);
          armMediaCapture(entry.key, entry.row);
        }
        return;
      }

      if (
        /^(?:dictate|start dictation|voice)$/i.test(label) ||
        /dictat/i.test(label)
      ) {
        restartSilenceMonitorIfPossible();
        return;
      }

      if (
        /^(?:cancel dictation|stop dictation|cancel transcription)$/i.test(
          label,
        )
      ) {
        clearSilenceSession();
        return;
      }

      if (/^Transcribe and send$/i.test(label)) {
        clearSilenceSession();
        if (settings.enabled) armForResponse();
        return;
      }

      if (button.matches(SEND_SELECTOR)) {
        if (settings.enabled) armForResponse();
        return;
      }
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        !settings.enabled ||
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== "Enter" ||
        event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      ) {
        return;
      }

      const composer =
        event.target instanceof Element
          ? event.target.closest(COMPOSER_SELECTOR)
          : null;

      if (
        composer &&
        (composer.innerText || composer.textContent || "").trim()
      ) {
        armForResponse();
      }
    },
    true,
  );

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.source !== "chatgpt-flow-extension" ||
      event.data?.type !== "settings"
    ) {
      return;
    }

    const next = event.data.settings || {};
    settings = {
      ...settings,
      ...next,
      playbackRate: clampPlaybackRate(next.playbackRate ?? settings.playbackRate),
    };

    setPlaybackRate(settings.playbackRate, false);

    if (!settings.enabled) {
      responseSession = null;
      clearPendingAutoRead();
      clearSilenceSession();
      disarmMediaCapture();
      releaseAutoReadLock();
      stopCurrentPlayback();
      return;
    }

    if (!settings.autoSendEnabled) {
      clearSilenceSession();
    } else if (!silenceSession) {
      restartSilenceMonitorIfPossible();
    }

    if (!settings.autoReadEnabled) {
      clearPendingAutoRead();
    }
  });

  const mutationObserver = new MutationObserver(() => {
    pollResponseState();
  });

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  responsePollTimer = window.setInterval(pollResponseState, 250);

  window.__CHATGPT_FLOW_CONTROLLER__ = {
    toggle(row) {
      return toggleForRow(row);
    },
    start(row) {
      return startReadForRow(row);
    },
    seekBack(row) {
      return seekForRow(row, -1);
    },
    seekForward(row) {
      return seekForRow(row, 1);
    },
    cycleSpeed() {
      cyclePlaybackRate();
    },
    state(row) {
      return playbackStateForRow(row);
    },
    displayedSeekSeconds: DISPLAYED_SEEK_SECONDS,
    internalSeekSeconds: INTERNAL_SEEK_SECONDS,
  };

  window.addEventListener(
    "pagehide",
    () => {
      mutationObserver.disconnect();
      if (responsePollTimer) clearInterval(responsePollTimer);
      clearPendingAutoRead();
      clearSilenceSession();
      disarmMediaCapture();
      stopCurrentPlayback();
      releaseAutoReadLock();
      stopPlaybackHeartbeat();
      try {
        playbackChannel?.close();
      } catch {}
    },
    { once: true },
  );

  window.postMessage(
    { source: "chatgpt-flow-main", type: "request-settings" },
    "*",
  );

  log("v0.5.5 unified controller loaded");
})();
