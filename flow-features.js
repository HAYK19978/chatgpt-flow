(() => {
  "use strict";

  if (window.__CHATGPT_FLOW_CONTROLLER_V0520__) return;
  window.__CHATGPT_FLOW_CONTROLLER_V0520__ = true;

  const READ_SELECTOR = 'button[aria-label="Read aloud"]';
  const TRANSCRIBE_SELECTOR = 'button[aria-label="Transcribe and send"]';
  const ACTION_ROW_SELECTOR = ".turn-action-controls";
  const COMPOSER_SELECTOR =
    '#prompt-textarea,div[role="textbox"][aria-label="Ask ChatGPT"],div[contenteditable="true"][data-lexical-editor="true"]';
  const SEND_SELECTOR =
    'button[data-testid="send-button"],button[aria-label="Send"],button[aria-label="Send prompt"],button[aria-label="Send message"]';
  const STOP_GENERATION_SELECTOR = 'button[data-testid="stop-button"]';
  const AUTO_READ_LOCK = "chatgpt-flow-auto-read-v0518";
  const PLAYBACK_CHANNEL = "chatgpt-flow-playback-v0518";
  const PLAYBACK_OWNER_KEY = "chatgpt-flow-playback-owner";
  const PLAYBACK_OWNER_TTL_MS = 8000;
  const TAB_ID = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

  // The UI intentionally still says 15. ChatGPT's streamed TTS timeline has
  // behaved much "wider" than wall-clock time in real use, so use a gentler
  // internal step. This can be tuned later without changing the UI.
  const DISPLAYED_SEEK_SECONDS = 15;
  const INTERNAL_SEEK_SECONDS = 3.6;

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

  // Resume is implemented by ChatGPT's own Stop/Read-aloud controls.
  // We never keep a global play() guard while paused, because that poisoned
  // subsequent native Read aloud attempts.
  let resumeSeekTarget = null;

  // nativeButtonClick.call(Stop reading aloud) dispatches a normal click event.
  // Without this flag, our document listener mistakes Flow's own Pause for a
  // manual native Stop and immediately wipes activeReadKey/virtualPaused,
  // making Resume impossible.
  let flowInitiatedNativeStop = false;

  // Native Read aloud changes between Read/Stop asynchronously. A custom
  // transport click that lands during that short transition must be queued,
  // not silently ignored or interpreted as a second Play.
  let transportIntent = null;
  let transportIntentTimer = 0;

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
      /^(?:Read aloud|Stop reading aloud|Regenerate response|Rate response)$/i.test(
        buttonLabel(button),
      ),
    );
  }

  function nativeReadButton(row) {
    if (!(row instanceof Element)) return null;
    return (
      nativeButtonsIn(row).find((button) =>
        /^(?:Read aloud|Stop reading aloud)$/i.test(buttonLabel(button)),
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

  function readPlaybackOwner() {
    try {
      const raw = localStorage.getItem(PLAYBACK_OWNER_KEY);
      if (!raw) return null;

      const owner = JSON.parse(raw);
      const at = Number(owner?.at) || 0;

      if (
        !owner?.tabId ||
        !at ||
        Date.now() - at > PLAYBACK_OWNER_TTL_MS
      ) {
        localStorage.removeItem(PLAYBACK_OWNER_KEY);
        return null;
      }

      return owner;
    } catch {
      return null;
    }
  }

  function claimPlaybackOwner() {
    try {
      localStorage.setItem(
        PLAYBACK_OWNER_KEY,
        JSON.stringify({
          tabId: TAB_ID,
          at: Date.now(),
        }),
      );
    } catch {}
  }

  function releasePlaybackOwner() {
    try {
      const owner = readPlaybackOwner();
      if (owner?.tabId === TAB_ID) {
        localStorage.removeItem(PLAYBACK_OWNER_KEY);
      }
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

    const owner = readPlaybackOwner();
    if (owner?.tabId && owner.tabId !== TAB_ID) return true;

    return [...remotePlayback.keys()].some((tabId) => tabId !== TAB_ID);
  }

  function nativePlaybackVisible() {
    return !!document.querySelector(
      'button[aria-label="Stop reading aloud"]',
    );
  }

  function localPlaybackLooksActive() {
    return (
      !virtualPaused &&
      (
        mediaActuallyPlaying(activeMedia) ||
        nativePlaybackVisible() ||
        capturePendingFor()
      )
    );
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
    claimPlaybackOwner();
    announcePlayback("playing");

    if (playbackHeartbeatTimer) return;

    playbackHeartbeatTimer = window.setInterval(() => {
      if (localPlaybackLooksActive()) {
        claimPlaybackOwner();
        announcePlayback("playing");
      } else {
        stopPlaybackHeartbeat();
      }
    }, 2000);
  }

  function stopPlaybackHeartbeat() {
    if (playbackHeartbeatTimer) {
      clearInterval(playbackHeartbeatTimer);
      playbackHeartbeatTimer = 0;
    }

    releasePlaybackOwner();
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
    resumeSeekTarget = null;
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

  function mediaActuallyPlaying(media = activeMedia) {
    return mediaHasSource(media) && !media.paused;
  }

  function capturePendingFor(key = pendingReadKey) {
    return (
      !!key &&
      pendingReadKey === key &&
      !!(captureHook || captureTimeout)
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

  function seekResumeTarget(media, target, restoreMuted, restoreVolume) {
    const deadline = performance.now() + 10000;

    const finish = () => {
      if (activeMedia !== media) return;

      try {
        media.defaultPlaybackRate = settings.playbackRate;
        media.playbackRate = settings.playbackRate;
        media.muted = restoreMuted;
        media.volume = restoreVolume;
      } catch {}

      resumeSeekTarget = null;
      virtualPaused = false;
      virtualPausePosition = 0;
      virtualPauseOriginalMuted = false;
      virtualPauseOriginalVolume = 1;
      dispatchPlaybackState();
    };

    const trySeek = () => {
      if (activeMedia !== media) return;

      try {
        let canSeek = false;

        if (media.seekable?.length) {
          const start = media.seekable.start(0);
          const end = media.seekable.end(media.seekable.length - 1);

          if (target >= start && target <= end) {
            media.currentTime = target;
            canSeek = true;
          }
        } else if (Number.isFinite(media.duration) && media.duration > target) {
          media.currentTime = target;
          canSeek = true;
        }

        if (
          canSeek ||
          performance.now() >= deadline
        ) {
          if (!canSeek) {
            try {
              media.currentTime = Math.max(0, target);
            } catch {}
          }

          finish();
          return;
        }
      } catch {}

      window.setTimeout(trySeek, 100);
    };

    trySeek();
  }

  function adoptReadMedia(media, key = pendingReadKey, row = pendingReadRow) {
    if (!(media instanceof HTMLMediaElement)) return;

    activeMedia = media;
    activeReadKey = key || activeReadKey;
    activeReadRow = row || activeReadRow;
    pendingReadKey = "";
    pendingReadRow = null;

    try {
      media.defaultPlaybackRate = settings.playbackRate;
      media.playbackRate = settings.playbackRate;
    } catch {}

    if (Number.isFinite(resumeSeekTarget)) {
      const target = Math.max(0, resumeSeekTarget);
      const restoreMuted = !!media.muted;
      const restoreVolume = Number.isFinite(media.volume) ? media.volume : 1;

      try {
        // Do not let the user hear the replay from zero while waiting for the
        // streamed TTS range to become seekable to the saved position.
        media.muted = true;
        media.volume = 0;
      } catch {}

      seekResumeTarget(media, target, restoreMuted, restoreVolume);
    }

    if (!media.__chatgptFlowV0520Lifecycle) {
      media.addEventListener(
        "ended",
        () => {
          if (activeMedia === media) clearActiveMedia(media);
        },
        { once: true },
      );

      try {
        Object.defineProperty(media, "__chatgptFlowV0520Lifecycle", {
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

    captureTimeout = window.setTimeout(() => {
      captureTimeout = 0;

      if (
        captureHook &&
        capturePreviousPlay &&
        HTMLMediaElement.prototype.play === captureHook
      ) {
        HTMLMediaElement.prototype.play = capturePreviousPlay;
      }

      captureHook = null;
      capturePreviousPlay = null;

      const control = nativeReadButton(
        pendingReadRow instanceof Element && pendingReadRow.isConnected
          ? pendingReadRow
          : activeReadRow,
      );

      // If ChatGPT never produced/captured media and its own button is back at
      // Read aloud, startup failed or already ended. Forget the pending start
      // instead of leaving our custom button stuck on Pause forever.
      if (
        pendingReadKey &&
        !mediaActuallyPlaying(activeMedia) &&
        !virtualPaused &&
        !/^Stop reading aloud$/i.test(buttonLabel(control))
      ) {
        const staleKey = pendingReadKey;
        pendingReadKey = "";
        pendingReadRow = null;

        if (activeReadKey === staleKey) {
          activeReadKey = "";
          activeReadRow = null;
        }

        clearTransportIntent();
        stopPlaybackHeartbeat();
        releaseAutoReadLock();
        dispatchPlaybackState();
      }
    }, 10000);
  }

  function stopCurrentPlayback() {
    disarmMediaCapture();
    clearPauseGuard();

    const row =
      (activeReadRow instanceof Element && activeReadRow.isConnected
        ? activeReadRow
        : resolveEntryByKey(activeReadKey)?.row) || null;
    const control = nativeReadButton(row);

    try {
      if (
        isUsableButton(control) &&
        /^Stop reading aloud$/i.test(buttonLabel(control))
      ) {
        nativeButtonClick.call(control);
      } else if (
        activeMedia instanceof HTMLMediaElement &&
        !activeMedia.paused
      ) {
        nativeMediaPause.call(activeMedia);
      }
    } catch {}

    clearActiveMedia(activeMedia);
  }

  function startReadEntry(entry) {
    if (
      !settings.enabled ||
      !entry ||
      !isUsableButton(entry.read) ||
      !/^Read aloud$/i.test(buttonLabel(entry.read))
    ) {
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
    startPlaybackHeartbeat();

    try {
      nativeButtonClick.call(entry.read);
      return true;
    } catch (error) {
      log("Read aloud click failed:", error);
      disarmMediaCapture();
      pendingReadKey = "";
      pendingReadRow = null;
      stopPlaybackHeartbeat();
      return false;
    }
  }

  function startReadForRow(row) {
    const entry = entryForRow(row);
    if (!entry) return false;
    return startReadEntry(entry);
  }

  function beginVirtualPause() {
    const row =
      (activeReadRow instanceof Element && activeReadRow.isConnected
        ? activeReadRow
        : resolveEntryByKey(activeReadKey)?.row) || null;
    const control = nativeReadButton(row);

    if (
      !activeReadKey ||
      !isUsableButton(control) ||
      !/^Stop reading aloud$/i.test(buttonLabel(control))
    ) {
      return false;
    }

    virtualPausePosition = mediaHasSource(activeMedia)
      ? Number(activeMedia.currentTime || 0)
      : virtualPausePosition;

    virtualPaused = true;
    resumeSeekTarget = null;

    // Critical: no HTMLMediaElement.prototype.play guard and no direct
    // media.pause(). Let ChatGPT tear down its own stream cleanly.
    disarmMediaCapture();
    pendingReadKey = "";
    pendingReadRow = null;
    clearPauseGuard();

    try {
      flowInitiatedNativeStop = true;
      nativeButtonClick.call(control);
      activeMedia = null;
      stopPlaybackHeartbeat();
      dispatchPlaybackState();
      return true;
    } catch (error) {
      virtualPaused = false;
      log("Pause failed:", error);
      dispatchPlaybackState();
      return false;
    } finally {
      // The click event is dispatched synchronously by HTMLElement.click().
      // Clear after the native handler + our capture listener have seen it.
      queueMicrotask(() => {
        flowInitiatedNativeStop = false;
      });
    }
  }

  function resumeVirtualPause() {
    if (!virtualPaused || !activeReadKey) return false;

    const entry = resolveEntryByKey(activeReadKey);
    if (
      !entry ||
      !isUsableButton(entry.read) ||
      !/^Read aloud$/i.test(buttonLabel(entry.read))
    ) {
      return false;
    }

    resumeSeekTarget = Math.max(0, Number(virtualPausePosition) || 0);
    activeReadRow = entry.row;

    armMediaCapture(entry.key, entry.row);
    startPlaybackHeartbeat();

    try {
      nativeButtonClick.call(entry.read);
      virtualPaused = false;
      dispatchPlaybackState();
      return true;
    } catch (error) {
      disarmMediaCapture();
      resumeSeekTarget = null;
      virtualPaused = true;
      stopPlaybackHeartbeat();
      log("Resume failed:", error);
      dispatchPlaybackState();
      return false;
    }
  }

  function clearTransportIntent() {
    if (transportIntentTimer) {
      clearTimeout(transportIntentTimer);
      transportIntentTimer = 0;
    }
    transportIntent = null;
  }

  function scheduleTransportIntent(delay = 45) {
    if (!transportIntent || transportIntentTimer) return;
    transportIntentTimer = window.setTimeout(() => {
      transportIntentTimer = 0;
      serviceTransportIntent();
    }, delay);
  }

  function serviceTransportIntent() {
    const intent = transportIntent;
    if (!intent) return false;

    if (performance.now() >= intent.deadline) {
      const row =
        intent.row instanceof Element && intent.row.isConnected
          ? intent.row
          : resolveEntryByKey(intent.key)?.row || null;

      clearTransportIntent();

      if (row) {
        reconcileRowPlayback(row, intent.key);
      }

      dispatchPlaybackState();
      return false;
    }

    const row =
      intent.row instanceof Element && intent.row.isConnected
        ? intent.row
        : resolveEntryByKey(intent.key)?.row || null;

    const control = nativeReadButton(row);
    const currentLabel = buttonLabel(control);

    if (
      intent.type === "pause" &&
      isUsableButton(control) &&
      /^Stop reading aloud$/i.test(currentLabel)
    ) {
      clearTransportIntent();
      activeReadRow = row;
      return beginVirtualPause();
    }

    if (
      intent.type === "resume" &&
      isUsableButton(control) &&
      /^Read aloud$/i.test(currentLabel)
    ) {
      clearTransportIntent();
      activeReadRow = row;
      return resumeVirtualPause();
    }

    scheduleTransportIntent();
    return true;
  }

  function requestTransport(type, row, key) {
    clearTransportIntent();
    transportIntent = {
      type,
      row,
      key,
      deadline: performance.now() + 3000,
    };
    dispatchPlaybackState();
    serviceTransportIntent();
    return true;
  }

  function rowKey(row) {
    return entryForRow(row)?.key || "";
  }

  function reconcileRowPlayback(row, key = rowKey(row)) {
    if (!key) return;

    const control = nativeReadButton(row);
    const nativeLabel = buttonLabel(control);
    const pending = capturePendingFor(key);

    // The diagnostic showed the broken state exactly as:
    // native = Read aloud, custom = Pause, controller.active = true.
    // In that state ChatGPT itself is idle, there is no playing media and no
    // live capture. Any active/pending/transport state is stale and must be
    // discarded before interpreting the next click.
    if (
      activeReadKey === key &&
      !virtualPaused &&
      !mediaActuallyPlaying(activeMedia) &&
      !pending &&
      !/^Stop reading aloud$/i.test(nativeLabel)
    ) {
      pendingReadKey = "";
      pendingReadRow = null;
      activeReadKey = "";
      activeReadRow = null;

      if (transportIntent?.key === key) {
        clearTransportIntent();
      }

      stopPlaybackHeartbeat();
      releaseAutoReadLock();
    }
  }

  function rowMatchesActive(row, key = rowKey(row)) {
    if (!key) return false;

    reconcileRowPlayback(row, key);

    return (
      key === activeReadKey &&
      (
        virtualPaused ||
        mediaActuallyPlaying(activeMedia) ||
        capturePendingFor(key) ||
        transportIntent?.key === key ||
        /^Stop reading aloud$/i.test(buttonLabel(nativeReadButton(row)))
      )
    );
  }

  function toggleForRow(row) {
    const key = rowKey(row);
    if (!key) return false;

    reconcileRowPlayback(row, key);

    const sameResponse = !!activeReadKey && activeReadKey === key;
    const nativeLabel = buttonLabel(nativeReadButton(row));
    const startingThisResponse = capturePendingFor(key);

    if (sameResponse && virtualPaused) {
      activeReadRow = row;
      return requestTransport("resume", row, key);
    }

    if (
      sameResponse &&
      (
        startingThisResponse ||
        mediaActuallyPlaying(activeMedia) ||
        /^Stop reading aloud$/i.test(nativeLabel)
      )
    ) {
      activeReadRow = row;
      return requestTransport("pause", row, key);
    }

    if (activeReadKey && activeReadKey !== key) {
      clearTransportIntent();
      stopCurrentPlayback();
    }

    // Native Read aloud + no live media means Play, even if an older capture
    // attempt left bookkeeping behind.
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
    const matched = rowMatchesActive(row, key);

    return {
      active: matched,
      paused: matched && virtualPaused,
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

    if (localPlaybackLooksActive() || otherTabPlaybackActive()) {
      markAutoReadHandled(key);
      log("Auto-read skipped because another message is already playing");
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

      if (localPlaybackLooksActive() || otherTabPlaybackActive()) {
        markAutoReadHandled(key);
        log("Auto-read skipped because another message is already playing");
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
          startPlaybackHeartbeat();
        }
        return;
      }

      if (/^Stop reading aloud$/i.test(label)) {
        if (flowInitiatedNativeStop) {
          // Flow Pause deliberately keeps activeReadKey + saved position so the
          // next custom click can restart native Read aloud and seek back.
          return;
        }

        // Genuine user/native Stop: forget Flow playback state completely so
        // the next native Read aloud starts from a clean state.
        window.setTimeout(() => {
          clearTransportIntent();
          disarmMediaCapture();
          clearPauseGuard();
          activeMedia = null;
          activeReadKey = "";
          activeReadRow = null;
          pendingReadKey = "";
          pendingReadRow = null;
          virtualPaused = false;
          virtualPausePosition = 0;
          resumeSeekTarget = null;
          stopPlaybackHeartbeat();
          releaseAutoReadLock();
          dispatchPlaybackState();
        }, 0);
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
    setSpeed(rate) {
      setPlaybackRate(rate, true);
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
      clearTransportIntent();
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

  log("v0.5.20 stale playback-state reconciliation loaded");
})();
