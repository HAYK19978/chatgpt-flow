(() => {
  "use strict";

  if (window.__CHATGPT_FLOW_CONTROLLER_V0538__) return;
  window.__CHATGPT_FLOW_CONTROLLER_V0538__ = true;

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
  const PLAYBACK_PROGRESS_STALL_MS = 12000;
  const PLAYBACK_NO_MEDIA_GRACE_MS = 12000;
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

  // Ready handling is deduplicated independently from the send gesture.
  // ChatGPT can change how a message is submitted (dictation, voice UI,
  // rerenders, background tabs), so a completed new assistant action row is
  // also watched as a fallback completion signal.
  const readyHandledKeys = new Set();
  const readyHandledReasons = new Map();

  // Stress diagnostics are deliberately passive: they expose what actually
  // happened without changing normal behavior.
  let responseArmCount = 0;
  let lastResponseArmAt = 0;
  let lastResponseArmRoute = "";
  let lastReadyKey = "";
  let lastReadySource = "";
  let lastReadyAt = 0;
  let lastReadyMarkReason = "";
  let autoReadConfirmedCount = 0;
  let autoReadFailedStartCount = 0;
  let lastAutoReadConfirmedKey = "";
  let lastAutoReadConfirmedAt = 0;

  // Explicit send-arm fallback. This survives SPA route changes and a lost
  // responseSession so the first answer in a brand-new chat can never be
  // mistaken for historical hydration.
  let liveResponseArmPending = false;
  let liveResponseArmAt = 0;
  let liveResponseBaselineCount = 0;
  let liveResponseBaselineRows = new WeakSet();
  let liveResponseCandidateKey = "";
  let liveResponseCandidateSince = 0;

  // Some current ChatGPT DOM variants expose no stable turn/message id around
  // the action row. Using the visible assistant-row index as identity is wrong:
  // virtualization can keep exactly N mounted rows, so a brand-new answer can
  // reuse the same final index as the previous answer. That made the ready
  // detector think "nothing new happened".
  const syntheticRowIds = new WeakMap();
  let nextSyntheticRowId = 1;

  let passiveReadyRoute = location.pathname;
  let passiveReadyInitialized = false;
  let passiveReadyBaselineKey = "";
  let passiveReadyCandidateKey = "";
  let passiveReadyCandidateSince = 0;
  let passiveReadyBaselineSince = 0;

  // Dictation / silence monitor.
  let lastMicStream = null;
  let silenceSession = null;
  let silenceRestartBlockedUntil = 0;
  let silenceMonitorStartPromise = null;
  let silenceMonitorStartStream = null;

  // Read-aloud media state.
  let pendingReadKey = "";
  let pendingReadRow = null;
  let activeReadKey = "";
  let activeReadRow = null;
  let activeReadOrdinal = -1;
  let activeReadRoute = "";
  let activeMedia = null;
  let virtualPaused = false;
  let virtualPauseUsesMedia = false;
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
  let resumeRestoring = false;

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
  let activeMediaStartingUntil = 0;
  let activeMediaStartTimer = 0;

  // Cross-tab playback coordination and auto-read lock.
  let autoReadRelease = null;
  let autoReadSafetyTimer = 0;
  const remotePlayback = new Map();
  let playbackHeartbeatTimer = 0;
  let playbackHeartbeatStartedAt = 0;
  let playbackProgressMedia = null;
  let playbackProgressTime = 0;
  let playbackProgressAt = 0;
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

  function findTranscribeAndSendButton() {
    const exact = document.querySelector(TRANSCRIBE_SELECTOR);
    if (isUsableButton(exact)) return exact;

    return (
      [...document.querySelectorAll("button")].find((button) => {
        if (!isUsableButton(button)) return false;

        const label = buttonLabel(button);
        const testId = button.getAttribute("data-testid") || "";

        return (
          /transcrib.*send|send.*transcrib/i.test(label) ||
          /transcrib.*send|send.*transcrib/i.test(testId)
        );
      }) || null
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

  function turnIdentity(row) {
    if (!(row instanceof Element)) return "";

    const turn = row.closest(
      '[data-testid^="conversation-turn-"],[data-turn-id],[data-message-id],article[data-testid],article',
    );

    if (turn instanceof Element) {
      for (const name of [
        "data-message-id",
        "data-turn-id",
        "data-testid",
        "id",
      ]) {
        const value = (turn.getAttribute(name) || "").trim();
        if (value) return `${name}:${value}`;
      }
    }

    // No stable ChatGPT turn id is available in this DOM variant.
    // Give the actual action-row element its own identity instead of using its
    // list index. A new mounted response therefore always gets a new key even
    // when ChatGPT virtualizes old messages and keeps the mounted row count
    // constant.
    let syntheticId = syntheticRowIds.get(row);

    if (!syntheticId) {
      syntheticId = nextSyntheticRowId++;
      syntheticRowIds.set(row, syntheticId);
    }

    return `assistant-row-dom:${syntheticId}`;
  }

  function entryForRow(row) {
    if (!isAssistantActionRow(row)) return null;
    const read = nativeReadButton(row);
    if (!isUsableButton(read)) return null;

    const identity = turnIdentity(row);
    if (!identity) return null;

    const text = normalizedTurnText(row);

    return {
      row,
      read,
      text,
      identity,
      key: `${location.pathname}::${identity}`,
    };
  }

  function assistantEntries() {
    return [...document.querySelectorAll(ACTION_ROW_SELECTOR)]
      .map(entryForRow)
      .filter(Boolean);
  }

  function assistantActionRows() {
    return [...document.querySelectorAll(ACTION_ROW_SELECTOR)].filter(
      (row) => isAssistantActionRow(row),
    );
  }

  function actionRowOrdinal(row) {
    if (!(row instanceof Element)) return -1;
    return assistantActionRows().indexOf(row);
  }

  function actionRowKey(row) {
    if (!isAssistantActionRow(row)) return "";
    const identity = turnIdentity(row);
    return identity ? `${location.pathname}::${identity}` : "";
  }

  function rememberActiveRow(row) {
    if (!(row instanceof Element)) return;
    activeReadRow = row;
    activeReadOrdinal = actionRowOrdinal(row);
    activeReadRoute = location.pathname;
  }

  function resolveActiveReadRow() {
    if (activeReadRow instanceof Element && activeReadRow.isConnected) {
      return activeReadRow;
    }

    const exact = resolveEntryByKey(activeReadKey)?.row;
    if (exact instanceof Element) {
      rememberActiveRow(exact);
      return exact;
    }

    if (activeReadOrdinal >= 0 && activeReadRoute === location.pathname) {
      const candidate = assistantActionRows()[activeReadOrdinal] || null;
      if (candidate instanceof Element) {
        activeReadRow = candidate;
        return candidate;
      }
    }

    return null;
  }

  function maybeRebindActiveRow(row, key) {
    if (!activeReadKey || !(row instanceof Element) || !key) return false;
    if (key === activeReadKey) return true;

    if (
      !activeReadKey.includes("::assistant-row-dom:") ||
      !key.includes("::assistant-row-dom:") ||
      activeReadRoute !== location.pathname ||
      activeReadOrdinal < 0 ||
      actionRowOrdinal(row) !== activeReadOrdinal
    ) {
      return false;
    }

    const oldKey = activeReadKey;
    activeReadKey = key;
    activeReadRow = row;

    if (pendingReadKey === oldKey) pendingReadKey = key;
    if (transportIntent?.key === oldKey) {
      transportIntent.key = key;
      transportIntent.row = row;
    }

    return true;
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

  function requestPlaybackTakeover() {
    if (!playbackChannel) return;

    try {
      playbackChannel.postMessage({
        tabId: TAB_ID,
        state: "takeover",
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
        return;
      }

      if (data.state === "idle") {
        remotePlayback.delete(data.tabId);
        return;
      }

      if (data.state === "takeover") {
        remotePlayback.set(data.tabId, Number(data.at) || Date.now());

        if (resumeRestoring && virtualPaused) {
          abortResumeRestore(activeMedia, "cross-tab takeover");
          return;
        }

        if (virtualPaused || !localPlaybackLooksActive()) return;

        // Manual playback in another tab wins. Prefer Flow Pause so this tab
        // can later resume from its own saved position; fall back to Stop only
        // if ChatGPT's current native state cannot be paused cleanly.
        if (!beginVirtualPause()) {
          stopCurrentPlayback();
        }
      }
    });
  }

  function notePlaybackProgress(media = activeMedia) {
    if (!(media instanceof HTMLMediaElement)) return;

    const current = Number(media.currentTime || 0);
    const now = performance.now();

    if (playbackProgressMedia !== media) {
      playbackProgressMedia = media;
      playbackProgressTime = current;
      playbackProgressAt = now;
      return;
    }

    if (current > playbackProgressTime + 0.03) {
      playbackProgressTime = current;
      playbackProgressAt = now;
    }
  }

  function playbackHeartbeatStillLive() {
    const now = performance.now();

    if (virtualPaused) return false;

    if (activeMedia instanceof HTMLMediaElement && mediaHasSource(activeMedia)) {
      notePlaybackProgress(activeMedia);

      if (
        mediaActuallyPlaying(activeMedia) &&
        now - playbackProgressAt <= PLAYBACK_PROGRESS_STALL_MS
      ) {
        return true;
      }

      // A media element can remain paused=false forever after a broken/stalled
      // streamed TTS. If its clock no longer advances, it is not allowed to
      // keep global ownership alive indefinitely.
      return false;
    }

    if (capturePendingFor() || nativePlaybackVisible()) {
      return (
        now - playbackHeartbeatStartedAt <= PLAYBACK_NO_MEDIA_GRACE_MS
      );
    }

    return false;
  }

  function startPlaybackHeartbeat() {
    const now = performance.now();

    if (!playbackHeartbeatStartedAt) {
      playbackHeartbeatStartedAt = now;
    }

    if (activeMedia instanceof HTMLMediaElement) {
      notePlaybackProgress(activeMedia);
    }

    claimPlaybackOwner();
    announcePlayback("playing");

    if (playbackHeartbeatTimer) return;

    playbackHeartbeatTimer = window.setInterval(() => {
      if (playbackHeartbeatStillLive()) {
        claimPlaybackOwner();
        announcePlayback("playing");
      } else {
        // A stale/stalled stream must relinquish both local playback state and
        // global ownership so other ChatGPT tabs can continue automatically.
        if (
          activeMedia instanceof HTMLMediaElement &&
          !virtualPaused
        ) {
          try {
            nativeMediaPause.call(activeMedia);
          } catch {}
        }

        clearTransportIntent();
        disarmMediaCapture();
        clearPauseGuard();

        activeMedia = null;
        activeReadKey = "";
        activeReadRow = null;
        activeReadOrdinal = -1;
        activeReadRoute = "";
        pendingReadKey = "";
        pendingReadRow = null;
        resumeSeekTarget = null;
        resumeRestoring = false;
        virtualPaused = false;
        virtualPauseUsesMedia = false;

        stopPlaybackHeartbeat();
        releaseAutoReadLock();
        dispatchPlaybackState();
      }
    }, 2000);
  }

  function stopPlaybackHeartbeat() {
    if (playbackHeartbeatTimer) {
      clearInterval(playbackHeartbeatTimer);
      playbackHeartbeatTimer = 0;
    }

    playbackHeartbeatStartedAt = 0;
    playbackProgressMedia = null;
    playbackProgressTime = 0;
    playbackProgressAt = 0;

    releasePlaybackOwner();
    announcePlayback("idle");
  }

  function clearPendingAutoRead() {
    if (!pendingAutoReadTimer) return;
    clearTimeout(pendingAutoReadTimer);
    pendingAutoReadTimer = 0;
  }

  function responseRouteCanMigrate(fromRoute, toRoute) {
    if (fromRoute === toRoute) return true;

    const from = String(fromRoute || "").replace(/\/$/, "") || "/";
    const to = String(toRoute || "");

    // A brand-new ChatGPT conversation starts on / and is promoted by the
    // SPA to /c/<id> after the first send. Custom GPT/project entry routes
    // can similarly gain a /c/<id> suffix. That promotion is still the same
    // response session and must not cancel ready/auto-read tracking.
    if (from === "/" && /^\/c\/[^/]+/.test(to)) return true;

    return (
      !from.includes("/c/") &&
      to.includes("/c/") &&
      to.startsWith(`${from}/c/`)
    );
  }

  function armForResponse() {
    if (!settings.enabled) return;

    clearPendingAutoRead();

    const baselineEntries = assistantEntries();
    const latest = baselineEntries.at(-1) || null;

    responseArmCount += 1;
    lastResponseArmAt = performance.now();
    lastResponseArmRoute = location.pathname;

    liveResponseArmPending = true;
    liveResponseArmAt = performance.now();
    liveResponseBaselineCount = baselineEntries.length;
    liveResponseBaselineRows = new WeakSet(
      baselineEntries
        .map((entry) => entry.row)
        .filter((row) => row instanceof Element),
    );
    liveResponseCandidateKey = "";
    liveResponseCandidateSince = 0;

    // An explicit send means the next completed assistant turn is live, not
    // historical hydration. Keep the passive watcher armed as a fallback even
    // if the explicit response tracker later misses a transient SPA signal.
    passiveReadyRoute = location.pathname;
    passiveReadyInitialized = true;
    passiveReadyBaselineKey = latest?.key || "";
    passiveReadyCandidateKey = "";
    passiveReadyCandidateSince = 0;
    passiveReadyBaselineSince = 0;

    responseSession = {
      route: location.pathname,
      startedAt: performance.now(),
      baselineKey: latest?.key || "",
      baselineKeys: new Set(baselineEntries.map((entry) => entry.key)),
      baselineRows: new WeakSet(
        baselineEntries
          .map((entry) => entry.row)
          .filter((row) => row instanceof Element),
      ),
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
    virtualPauseUsesMedia = false;
    virtualPausePosition = 0;
    virtualPauseOriginalMuted = false;
    virtualPauseOriginalVolume = 1;
    resumeSeekTarget = null;
    resumeRestoring = false;
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
    return (
      mediaHasSource(media) &&
      (
        !media.paused ||
        (media === activeMedia && performance.now() < activeMediaStartingUntil)
      )
    );
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

    if (activeMediaStartTimer) {
      clearTimeout(activeMediaStartTimer);
      activeMediaStartTimer = 0;
    }
    activeMediaStartingUntil = 0;

    clearVirtualPause({ restoreMuted: false });
    activeMedia = null;
    activeReadKey = "";
    activeReadRow = null;
    activeReadOrdinal = -1;
    activeReadRoute = "";
    virtualPauseUsesMedia = false;
    pendingReadKey = "";
    pendingReadRow = null;
    stopPlaybackHeartbeat();
    dispatchPlaybackState();
    releaseAutoReadLock();
  }

  function abortResumeRestore(media = activeMedia, reason = "resume restore failed") {
    const target = Math.max(
      0,
      Number.isFinite(resumeSeekTarget)
        ? Number(resumeSeekTarget)
        : Number(virtualPausePosition) || 0,
    );

    disarmMediaCapture();

    const row = resolveActiveReadRow();
    const control = nativeReadButton(row);

    try {
      if (
        isUsableButton(control) &&
        /^Stop reading aloud$/i.test(buttonLabel(control))
      ) {
        flowInitiatedNativeStop = true;
        nativeButtonClick.call(control);
      } else if (
        media instanceof HTMLMediaElement &&
        !media.paused
      ) {
        nativeMediaPause.call(media);
      }
    } catch {}

    if (activeMedia === media) {
      activeMedia = null;
    }

    if (activeMediaStartTimer) {
      clearTimeout(activeMediaStartTimer);
      activeMediaStartTimer = 0;
    }

    activeMediaStartingUntil = 0;
    pendingReadKey = "";
    pendingReadRow = null;
    resumeSeekTarget = null;
    resumeRestoring = false;

    // Preserve the original response + saved position. A failed restore must
    // remain a real Pause, never silently degrade into replay from zero.
    virtualPaused = true;
    virtualPausePosition = target;

    stopPlaybackHeartbeat();
    releaseAutoReadLock();
    dispatchPlaybackState();

    queueMicrotask(() => {
      flowInitiatedNativeStop = false;
    });

    log("Resume restore aborted:", reason, `position=${target.toFixed(2)}`);
  }

  function seekResumeTarget(media, target, restoreMuted, restoreVolume) {
    const deadline = performance.now() + 8000;
    const tolerance = 0.12;

    const succeed = () => {
      if (activeMedia !== media) return;

      try {
        media.currentTime = Math.max(0, target);
        media.defaultPlaybackRate = settings.playbackRate;
        media.playbackRate = settings.playbackRate;
        media.muted = restoreMuted;
        media.volume = restoreVolume;
      } catch {}

      resumeSeekTarget = null;
      resumeRestoring = false;
      virtualPaused = false;
      virtualPausePosition = 0;
      virtualPauseOriginalMuted = false;
      virtualPauseOriginalVolume = 1;
      startPlaybackHeartbeat();
      dispatchPlaybackState();
    };

    const trySeek = () => {
      if (activeMedia !== media) return;

      try {
        const current = Number(media.currentTime || 0);

        if (current + tolerance >= target) {
          succeed();
          return;
        }

        let furthest = null;

        if (media.seekable?.length) {
          const firstStart = media.seekable.start(0);
          const lastEnd = media.seekable.end(media.seekable.length - 1);

          if (target >= firstStart && target <= lastEnd) {
            media.currentTime = target;
            succeed();
            return;
          }

          if (lastEnd > firstStart) {
            furthest = Math.max(firstStart, lastEnd - 0.03);
          }
        } else if (
          Number.isFinite(media.duration) &&
          media.duration > 0
        ) {
          if (media.duration > target) {
            media.currentTime = target;
            succeed();
            return;
          }

          furthest = Math.max(0, media.duration - 0.03);
        }

        // While muted, jump as far through already-buffered TTS as Chrome
        // allows. This avoids spending real-time replaying from zero just to
        // reach the saved position.
        if (
          Number.isFinite(furthest) &&
          furthest > current + 0.05
        ) {
          media.currentTime = Math.min(target, furthest);
        }

        try {
          media.playbackRate = Math.max(
            settings.playbackRate,
            4,
          );
        } catch {}

        if (performance.now() >= deadline) {
          abortResumeRestore(media, "saved position did not become seekable");
          return;
        }
      } catch (error) {
        if (performance.now() >= deadline) {
          abortResumeRestore(media, String(error));
          return;
        }
      }

      window.setTimeout(trySeek, 80);
    };

    trySeek();
  }

  function adoptReadMedia(media, key = pendingReadKey, row = pendingReadRow) {
    if (!(media instanceof HTMLMediaElement)) return;

    if (activeMediaStartTimer) {
      clearTimeout(activeMediaStartTimer);
      activeMediaStartTimer = 0;
    }

    activeMedia = media;
    activeMediaStartingUntil = performance.now() + 3000;
    playbackProgressMedia = media;
    playbackProgressTime = Number(media.currentTime || 0);
    playbackProgressAt = performance.now();
    activeReadKey = key || activeReadKey;
    if (row instanceof Element) rememberActiveRow(row);
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

    if (!media.__chatgptFlowV0538Lifecycle) {
      media.addEventListener(
        "ended",
        () => {
          if (activeMedia !== media) return;

          if (resumeRestoring && virtualPaused) {
            abortResumeRestore(media, "resume media ended before restore");
            return;
          }

          // Some streamed ChatGPT TTS media are torn down when pause() is
          // requested. That must not erase the user's saved virtual Pause.
          // Keep the response identity + saved position and resume later via
          // ChatGPT's fresh Read aloud stream.
          if (virtualPaused) {
            activeMedia = null;
            activeMediaStartingUntil = 0;
            virtualPauseUsesMedia = false;
            stopPlaybackHeartbeat();
            releaseAutoReadLock();
            dispatchPlaybackState();
            return;
          }

          clearActiveMedia(media);
        },
        { once: true },
      );

      try {
        Object.defineProperty(media, "__chatgptFlowV0538Lifecycle", {
          value: true,
          configurable: true,
        });
      } catch {}
    }

    activeMediaStartTimer = window.setTimeout(() => {
      activeMediaStartTimer = 0;
      activeMediaStartingUntil = 0;

      // Startup cleanup is forbidden while virtualPaused: pause() can make
      // media.paused true before ChatGPT has fully settled the original play().
      if (
        activeMedia === media &&
        media.paused &&
        !virtualPaused &&
        !/^Stop reading aloud$/i.test(
          buttonLabel(nativeReadButton(activeReadRow)),
        )
      ) {
        clearActiveMedia(media);
        return;
      }

      dispatchPlaybackState();
    }, 3100);

    startPlaybackHeartbeat();
    dispatchPlaybackState();
  }

  function armMediaCapture(key, row) {
    disarmMediaCapture();

    pendingReadKey = key || "";
    pendingReadRow = row || null;
    if (key) activeReadKey = key;
    if (row instanceof Element) rememberActiveRow(row);
    dispatchPlaybackState();

    const previousPlay = HTMLMediaElement.prototype.play;

    const hook = function (...args) {
      const media = this;
      const result = previousPlay.apply(media, args);

      if (looksLikeReadAloudMedia(media)) {
        adoptReadMedia(media, key, row);
        queueMicrotask(disarmMediaCapture);

        Promise.resolve(result).then(
          () => {
            if (activeMedia !== media) return;

            activeMediaStartingUntil = 0;

            // A user can pause while ChatGPT's original play() promise is
            // still pending. Its late resolution must never resurrect
            // playback ownership behind the paused state.
            if (virtualPaused) {
              stopPlaybackHeartbeat();
              releaseAutoReadLock();
              dispatchPlaybackState();
              return;
            }

            startPlaybackHeartbeat();
            dispatchPlaybackState();
          },
          (error) => {
            if (activeMedia !== media) return;

            log("Read aloud media.play rejected:", error);

            if (resumeRestoring && virtualPaused) {
              abortResumeRestore(media, "media.play rejected");
              return;
            }

            // Calling pause() during media startup can reject the still-pending
            // play() promise with AbortError. This is a successful Pause, not
            // a failed playback start. Preserve the virtual paused state.
            if (virtualPaused) {
              activeMediaStartingUntil = 0;
              stopPlaybackHeartbeat();
              releaseAutoReadLock();
              dispatchPlaybackState();
              return;
            }

            clearActiveMedia(media);
          },
        );
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
        resumeRestoring &&
        virtualPaused &&
        pendingReadKey &&
        !activeMedia
      ) {
        abortResumeRestore(null, "no resume media was captured");
        return;
      }

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

    const row = resolveActiveReadRow();
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
    const row = resolveActiveReadRow();
    const control = nativeReadButton(row);

    if (!activeReadKey) return false;

    virtualPausePosition = mediaHasSource(activeMedia)
      ? Number(activeMedia.currentTime || 0)
      : virtualPausePosition;

    virtualPaused = true;
    resumeSeekTarget = null;
    resumeRestoring = false;

    disarmMediaCapture();
    pendingReadKey = "";
    pendingReadRow = null;
    clearPauseGuard();

    if (
      isUsableButton(control) &&
      /^Stop reading aloud$/i.test(buttonLabel(control))
    ) {
      try {
        virtualPauseUsesMedia = false;
        flowInitiatedNativeStop = true;
        nativeButtonClick.call(control);
        activeMedia = null;
        stopPlaybackHeartbeat();
        releaseAutoReadLock();
        dispatchPlaybackState();
        return true;
      } catch (error) {
        virtualPaused = false;
        log("Pause failed:", error);
        dispatchPlaybackState();
        return false;
      } finally {
        queueMicrotask(() => {
          flowInitiatedNativeStop = false;
        });
      }
    }

    if (
      activeMedia instanceof HTMLMediaElement &&
      mediaHasSource(activeMedia) &&
      !activeMedia.paused
    ) {
      try {
        virtualPauseUsesMedia = true;
        nativeMediaPause.call(activeMedia);
        stopPlaybackHeartbeat();
        releaseAutoReadLock();
        dispatchPlaybackState();
        return true;
      } catch (error) {
        virtualPaused = false;
        virtualPauseUsesMedia = false;
        log("Media fallback pause failed:", error);
        dispatchPlaybackState();
        return false;
      }
    }

    virtualPaused = false;
    virtualPauseUsesMedia = false;
    dispatchPlaybackState();
    return false;
  }

  function resumeVirtualPause({ allowMediaFallback = true } = {}) {
    if (!virtualPaused || !activeReadKey) return false;
    if (resumeRestoring) return true;

    const entry =
      resolveEntryByKey(activeReadKey) ||
      (() => {
        const row = resolveActiveReadRow();
        return row ? entryForRow(row) : null;
      })();

    // Preferred resume path: once ChatGPT exposes Read aloud again, restart
    // through ChatGPT itself and restore the saved position on the new TTS
    // media. This is much more reliable than reviving a stale streamed media
    // object that ChatGPT already considers stopped.
    if (
      entry &&
      isUsableButton(entry.read) &&
      /^Read aloud$/i.test(buttonLabel(entry.read))
    ) {
      resumeSeekTarget = Math.max(0, Number(virtualPausePosition) || 0);
      resumeRestoring = true;
      virtualPauseUsesMedia = false;
      activeReadRow = entry.row;

      requestPlaybackTakeover();
      armMediaCapture(entry.key, entry.row);

      try {
        nativeButtonClick.call(entry.read);

        // Deliberately keep virtualPaused=true. adoptReadMedia() clears it only
        // after the saved position has been restored and audio is ready.
        dispatchPlaybackState();
        return true;
      } catch (error) {
        disarmMediaCapture();
        resumeSeekTarget = null;
        resumeRestoring = false;
        virtualPaused = true;
        stopPlaybackHeartbeat();
        log("Native resume failed:", error);
        dispatchPlaybackState();
        return false;
      }
    }

    if (
      allowMediaFallback &&
      virtualPauseUsesMedia &&
      activeMedia instanceof HTMLMediaElement &&
      mediaHasSource(activeMedia)
    ) {
      const media = activeMedia;

      try {
        media.defaultPlaybackRate = settings.playbackRate;
        media.playbackRate = settings.playbackRate;
      } catch {}

      requestPlaybackTakeover();

      const playResult = nativeMediaPlay.call(media);
      Promise.resolve(playResult).then(
        () => {
          if (activeMedia !== media || !virtualPaused) return;
          virtualPaused = false;
          virtualPauseUsesMedia = false;
          virtualPausePosition = 0;
          startPlaybackHeartbeat();
          dispatchPlaybackState();
        },
        (error) => {
          virtualPaused = true;
          virtualPauseUsesMedia = true;
          stopPlaybackHeartbeat();
          log("Media fallback resume failed:", error);
          dispatchPlaybackState();
        },
      );

      dispatchPlaybackState();
      return true;
    }

    return false;
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

      const timedOutType = intent.type;
      clearTransportIntent();

      if (row) {
        reconcileRowPlayback(row, intent.key);
      }

      // Give ChatGPT a short grace period to bring back its native Read aloud
      // control. Only after that grace expires may Resume fall back to directly
      // reviving the paused media object.
      if (timedOutType === "resume" && virtualPaused) {
        const resumed = resumeVirtualPause({ allowMediaFallback: true });
        dispatchPlaybackState();
        return resumed;
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
      return resumeVirtualPause({ allowMediaFallback: false });
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
    return entryForRow(row)?.key || actionRowKey(row);
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

    maybeRebindActiveRow(row, key);
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

    maybeRebindActiveRow(row, key);
    reconcileRowPlayback(row, key);

    const sameResponse = !!activeReadKey && activeReadKey === key;
    const nativeLabel = buttonLabel(nativeReadButton(row));
    const startingThisResponse = capturePendingFor(key);

    if (sameResponse && virtualPaused) {
      activeReadRow = row;
      requestPlaybackTakeover();
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
    requestPlaybackTakeover();
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

  function readStartupConfirmed(key, row) {
    const candidateRow =
      row instanceof Element && row.isConnected
        ? row
        : resolveEntryByKey(key)?.row || activeReadRow;

    const nativeLabel = buttonLabel(nativeReadButton(candidateRow));

    return (
      (
        activeReadKey === key &&
        (
          mediaHasSource(activeMedia) ||
          mediaActuallyPlaying(activeMedia)
        )
      ) ||
      /^Stop reading aloud$/i.test(nativeLabel)
    );
  }

  function waitForReadStartup(key, row, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const deadline = performance.now() + timeoutMs;

      const poll = () => {
        if (readStartupConfirmed(key, row)) {
          resolve(true);
          return;
        }

        if (performance.now() >= deadline) {
          resolve(false);
          return;
        }

        window.setTimeout(poll, 100);
      };

      poll();
    });
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

    let latest = latestAssistantEntry();
    if (!latest) {
      log("Skipping stale auto-read target");
      return;
    }

    if (latest.key !== key) {
      const original = resolveEntryByKey(key);
      const sameResponseAfterRerender =
        original?.text &&
        latest.text &&
        original.text === latest.text;

      if (!sameResponseAfterRerender) {
        log("Skipping stale auto-read target");
        return;
      }

      key = latest.key;
    }

    if (localPlaybackLooksActive() || otherTabPlaybackActive()) {
      log("Auto-read deferred because another message is already playing");
      retry();
      return;
    }

    const runWithLock = async (lock) => {
      if (!lock) {
        retry();
        return;
      }

      let entry = resolveEntryByKey(key);
      const currentLatest = latestAssistantEntry();

      if (
        !entry &&
        currentLatest &&
        latest?.text &&
        currentLatest.text === latest.text
      ) {
        entry = currentLatest;
        key = currentLatest.key;
      }

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
        log("Auto-read deferred because another message is already playing");
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

      // A native button click only means the request was dispatched. In a
      // background tab ChatGPT can briefly accept the click without actually
      // starting TTS. Do not permanently mark this response as auto-read until
      // native playback is observable. Failed starts release the lock and retry.
      const confirmed = await waitForReadStartup(key, entry.row, 10000);

      if (!confirmed) {
        autoReadFailedStartCount += 1;
        log("Auto-read start was not confirmed; retrying", { key });
        disarmMediaCapture();

        if (pendingReadKey === key) {
          pendingReadKey = "";
          pendingReadRow = null;
        }

        if (
          activeReadKey === key &&
          !mediaHasSource(activeMedia) &&
          !virtualPaused
        ) {
          activeReadKey = "";
          activeReadRow = null;
        }

        stopPlaybackHeartbeat();
        releaseAutoReadLock();
        dispatchPlaybackState();
        retry();
        return;
      }

      markAutoReadHandled(key);
      autoReadConfirmedCount += 1;
      lastAutoReadConfirmedKey = key;
      lastAutoReadConfirmedAt = performance.now();

      window.setTimeout(() => {
        if (autoReadRelease && !mediaHasSource(activeMedia)) {
          const candidateRow =
            entry.row instanceof Element && entry.row.isConnected
              ? entry.row
              : resolveEntryByKey(key)?.row || activeReadRow;

          if (!/^Stop reading aloud$/i.test(
            buttonLabel(nativeReadButton(candidateRow)),
          )) {
            releaseAutoReadLock();
          }
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

  function markReadyHandled(key, reason = "unknown") {
    if (!key) return;

    readyHandledKeys.add(key);
    readyHandledReasons.set(key, reason);
    lastReadyMarkReason = reason;

    if (readyHandledKeys.size > 200) {
      const oldest = readyHandledKeys.values().next().value;
      if (oldest) {
        readyHandledKeys.delete(oldest);
        readyHandledReasons.delete(oldest);
      }
    }
  }

  function handleReadyEntry(entry, source = "tracked") {
    if (!settings.enabled || !entry?.key) {
      return false;
    }

    if (readyHandledKeys.has(entry.key)) {
      const previousReason = readyHandledReasons.get(entry.key) || "";

      // Historical hydration is allowed to establish a baseline, but it must
      // never permanently steal a response that the explicit live tracker later
      // proves belongs to the user's just-submitted prompt.
      if (source === "tracked" && previousReason === "passive-hydration") {
        readyHandledKeys.delete(entry.key);
        readyHandledReasons.delete(entry.key);
      } else {
        return false;
      }
    }

    markReadyHandled(entry.key, source);
    liveResponseArmPending = false;
    liveResponseCandidateKey = "";
    liveResponseCandidateSince = 0;

    lastReadyKey = entry.key;
    lastReadySource = source;
    lastReadyAt = performance.now();
    passiveReadyBaselineKey = entry.key;
    passiveReadyCandidateKey = "";
    passiveReadyCandidateSince = 0;

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
      source,
      sound: settings.readySoundEnabled,
      autoRead: settings.autoReadEnabled,
      delayMs: settings.autoReadDelayMs,
      key: entry.key,
    });

    return true;
  }

  function finishResponse(session, entry) {
    if (responseSession !== session) return;
    responseSession = null;
    handleReadyEntry(entry, "tracked");
  }

  function pollPassiveReadyState() {
    if (!settings.enabled) return;

    const now = performance.now();

    if (location.pathname !== passiveReadyRoute) {
      const previousRoute = passiveReadyRoute;
      const nextRoute = location.pathname;
      const freshConversationPromotion =
        responseRouteCanMigrate(previousRoute, nextRoute) &&
        !String(previousRoute || "").includes("/c/");

      passiveReadyRoute = nextRoute;
      passiveReadyBaselineKey = "";
      passiveReadyCandidateKey = "";
      passiveReadyCandidateSince = 0;
      passiveReadyBaselineSince = 0;

      // A same-document promotion such as / -> /c/<id> is the first live
      // conversation response, not historical hydration. If the explicit send
      // tracker missed the submit gesture, keep the passive watcher armed so
      // the first completed assistant row still gets ready sound + Auto Read.
      passiveReadyInitialized =
        freshConversationPromotion || liveResponseArmPending;

      if (!freshConversationPromotion && !liveResponseArmPending) {
        return;
      }
    }

    // When the explicit response tracker is armed, it owns the new response.
    // This check MUST happen before passive hydration. On the first message of
    // a brand-new chat, ChatGPT promotes / -> /c/<id>; the passive watcher
    // resets for that new route. If it hydrates while responseSession is live,
    // it can incorrectly mark the just-created answer as historical/handled,
    // suppressing both ready sound and Auto Read.
    if (responseSession || generationRunning()) {
      passiveReadyCandidateKey = "";
      passiveReadyCandidateSince = 0;
      return;
    }

    const latest = latestAssistantEntry();
    if (!latest) return;

    if (liveResponseArmPending) {
      if (now - liveResponseArmAt > 300000) {
        liveResponseArmPending = false;
        liveResponseCandidateKey = "";
        liveResponseCandidateSince = 0;
      } else {
        const entries = assistantEntries();
        const looksLikeArmedResponse =
          entries.length > liveResponseBaselineCount ||
          !liveResponseBaselineRows.has(latest.row);

        if (looksLikeArmedResponse) {
          if (latest.key !== liveResponseCandidateKey) {
            liveResponseCandidateKey = latest.key;
            liveResponseCandidateSince = now;
            return;
          }

          if (now - liveResponseCandidateSince >= 700) {
            responseSession = null;
            handleReadyEntry(latest, "armed-passive");
            return;
          }
        }

        if (!passiveReadyInitialized) passiveReadyInitialized = true;
        return;
      }
    }

    // Initial hydration can add historical action rows one by one. Establish
    // a quiet baseline first so opening/reloading an existing conversation
    // never produces a fake "new response" sound.
    if (!passiveReadyInitialized) {
      if (latest.key !== passiveReadyBaselineKey) {
        passiveReadyBaselineKey = latest.key;
        passiveReadyBaselineSince = now;
        return;
      }

      if (!passiveReadyBaselineSince) {
        passiveReadyBaselineSince = now;
        return;
      }

      if (now - passiveReadyBaselineSince < 1500) return;

      passiveReadyInitialized = true;
      assistantEntries().forEach((entry) =>
        markReadyHandled(entry.key, "passive-hydration"),
      );
      return;
    }

    if (
      latest.key === passiveReadyBaselineKey ||
      readyHandledKeys.has(latest.key)
    ) {
      passiveReadyBaselineKey = latest.key;
      passiveReadyCandidateKey = "";
      passiveReadyCandidateSince = 0;
      return;
    }

    if (latest.key !== passiveReadyCandidateKey) {
      passiveReadyCandidateKey = latest.key;
      passiveReadyCandidateSince = now;
      return;
    }

    if (now - passiveReadyCandidateSince < 700) return;

    handleReadyEntry(latest, "passive");
  }

  function pollResponseState() {
    const session = responseSession;
    if (!session || !settings.enabled) return;

    const now = performance.now();

    if (now - session.startedAt > 300000) {
      responseSession = null;
      return;
    }

    if (location.pathname !== session.route) {
      if (!responseRouteCanMigrate(session.route, location.pathname)) {
        responseSession = null;
        return;
      }

      log("Response tracking followed SPA route promotion", {
        from: session.route,
        to: location.pathname,
      });
      session.route = location.pathname;
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
      (
        latest.key !== session.baselineKey &&
        !session.baselineKeys?.has?.(latest.key)
      ) ||
      (
        latest.row instanceof Element &&
        !session.baselineRows?.has?.(latest.row)
      );

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

  async function startSilenceMonitorImpl(stream) {
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
      startedAt: performance.now(),
      lastSampleAt: performance.now(),
      lastSpeechAt: 0,
      quietSince: 0,
      unconfirmedQuietSince: 0,
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

      const startThreshold = Math.max(
        0.0012,
        session.noiseFloor * 1.8,
      );

      if (!session.speechConfirmed) {
        const voice = level > startThreshold;

        if (voice) {
          session.speechEvidenceMs += delta;
          session.unconfirmedQuietSince = 0;
        } else {
          session.speechEvidenceMs = Math.max(
            0,
            session.speechEvidenceMs - delta * 0.35,
          );

          if (!session.unconfirmedQuietSince) {
            session.unconfirmedQuietSince = now;
          }

          if (level < Math.max(0.008, startThreshold * 1.4)) {
            session.noiseFloor =
              session.noiseFloor * 0.97 + level * 0.03;
          }
        }

        if (
          session.speechEvidenceMs >= 100 ||
          (session.peakRms >= 0.0025 && session.speechEvidenceMs >= 60)
        ) {
          session.speechConfirmed = true;
          session.lastSpeechAt = now;
          session.quietSince = 0;
          session.unconfirmedQuietSince = 0;
          log("Speech detected");
          return;
        }

        const fallbackSilenceMs = Math.max(
          2000,
          Math.min(90000, Number(settings.silenceMs) || 5000),
        );

        // Fallback only when native dictation is definitely active and the
        // analyser has observed uninterrupted quiet for the user's configured
        // timeout. This prevents a missed very-early utterance from leaving the
        // first dictation session stuck forever.
        if (
          session.unconfirmedQuietSince &&
          now - session.unconfirmedQuietSince >= fallbackSilenceMs &&
          isUsableButton(findTranscribeAndSendButton())
        ) {
          session.speechConfirmed = true;
          session.lastSpeechAt = session.unconfirmedQuietSince;
          session.quietSince = session.unconfirmedQuietSince;
          log("Recovering missed early speech from dictation silence");
        } else {
          return;
        }
      }

      // After speech is confirmed, use a noticeably stronger threshold than
      // the old 1.35× noise-floor tail. The old threshold was so sensitive
      // that ordinary room/microphone noise could be classified as speech
      // forever, which explains intermittent "3 seconds passed, no send".
      const tailThreshold = Math.max(
        0.0016,
        session.noiseFloor * 2.0,
        Math.min(0.006, session.peakRms * 0.12),
      );

      const voice = level > tailThreshold;

      if (voice) {
        session.lastSpeechAt = now;
        session.quietSince = 0;
        return;
      }

      if (!session.quietSince) {
        session.quietSince = now;
      }

      // Keep adapting the noise floor while the input is genuinely quiet.
      if (level < tailThreshold * 0.85) {
        session.noiseFloor =
          session.noiseFloor * 0.985 + level * 0.015;
      }

      const silenceMs = Math.max(
        2000,
        Math.min(90000, Number(settings.silenceMs) || 5000),
      );

      if (now - session.quietSince < silenceMs) return;

      const button = findTranscribeAndSendButton();
      if (!isUsableButton(button)) {
        // Keep monitoring. The native send button can appear a fraction later.
        return;
      }

      session.sending = true;
      silenceRestartBlockedUntil = performance.now() + 2000;
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

  function startSilenceMonitor(stream) {
    if (
      silenceMonitorStartPromise &&
      silenceMonitorStartStream === stream
    ) {
      return silenceMonitorStartPromise;
    }

    const task = startSilenceMonitorImpl(stream);
    silenceMonitorStartStream = stream;
    silenceMonitorStartPromise = task;

    task.finally(() => {
      if (silenceMonitorStartPromise !== task) return;
      silenceMonitorStartPromise = null;
      silenceMonitorStartStream = null;
    });

    return task;
  }

  function restartSilenceMonitorIfPossible() {
    if (
      performance.now() >= silenceRestartBlockedUntil &&
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
          try {
            await startSilenceMonitor(stream);
          } catch (error) {
            log("Could not attach silence monitor:", error);
          }
        }
      }

      return stream;
    };
  }

  function ensureSilenceMonitorForActiveDictation() {
    if (
      !settings.enabled ||
      !settings.autoSendEnabled ||
      silenceSession ||
      silenceMonitorStartPromise ||
      performance.now() < silenceRestartBlockedUntil ||
      !streamHasLiveAudio(lastMicStream) ||
      !findTranscribeAndSendButton()
    ) {
      return;
    }

    startSilenceMonitor(lastMicStream).catch((error) =>
      log("Could not recover silence monitor:", error),
    );
  }

  // ---------------------------------------------------------------------------
  // User actions / settings / observers
  // ---------------------------------------------------------------------------

  window.addEventListener(
    "pagehide",
    () => {
      clearPendingAutoRead();
      stopPlaybackHeartbeat();
      releaseAutoReadLock();
    },
    { capture: true },
  );

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
          if (event.isTrusted) {
            requestPlaybackTakeover();
          }

          clearPendingAutoRead();
          markAutoReadHandled(entry.key);
          armMediaCapture(entry.key, entry.row);
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
          resumeRestoring = false;
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
        silenceRestartBlockedUntil = performance.now() + 2000;
        clearSilenceSession();
        return;
      }

      if (/^Transcribe and send$/i.test(label)) {
        silenceRestartBlockedUntil = performance.now() + 2000;
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
      liveResponseArmPending = false;
      liveResponseCandidateKey = "";
      liveResponseCandidateSince = 0;
      passiveReadyCandidateKey = "";
      passiveReadyCandidateSince = 0;
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
      releaseAutoReadLock();
    }
  });

  const mutationObserver = new MutationObserver(() => {
    pollResponseState();
    pollPassiveReadyState();
    ensureSilenceMonitorForActiveDictation();
  });

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  responsePollTimer = window.setInterval(() => {
    pollResponseState();
    pollPassiveReadyState();
    ensureSilenceMonitorForActiveDictation();
  }, 250);

  window.__CHATGPT_FLOW_CONTROLLER__ = {
    toggle(row) {
      return toggleForRow(row);
    },
    pauseActive() {
      return beginVirtualPause();
    },
    resumeActive() {
      if (!virtualPaused || !activeReadKey) return false;

      const row = resolveActiveReadRow();
      if (row instanceof Element) {
        requestPlaybackTakeover();
        return requestTransport("resume", row, activeReadKey);
      }

      return resumeVirtualPause({ allowMediaFallback: true });
    },
    stopActive() {
      stopCurrentPlayback();
      return true;
    },
    start(row) {
      requestPlaybackTakeover();
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
    diagnostics() {
      const session = responseSession;

      return {
        route: location.pathname,
        responseSession: session
          ? {
              route: session.route,
              ageMs: Math.round(performance.now() - session.startedAt),
              sawGeneration: !!session.sawGeneration,
              candidateKey: session.candidateKey || "",
              stableForMs: session.stableSince
                ? Math.round(performance.now() - session.stableSince)
                : 0,
            }
          : null,
        pendingAutoReadTimer: !!pendingAutoReadTimer,
        liveResponseArmPending,
        liveResponseArmAgeMs: liveResponseArmAt
          ? Math.round(performance.now() - liveResponseArmAt)
          : null,
        liveResponseBaselineCount,
        liveResponseCandidateKey,
        responseArmCount,
        lastResponseArmAgeMs: lastResponseArmAt
          ? Math.round(performance.now() - lastResponseArmAt)
          : null,
        lastResponseArmRoute,
        readyHandledCount: readyHandledKeys.size,
        lastReadyKey,
        lastReadySource,
        lastReadyMarkReason,
        lastReadyAgeMs: lastReadyAt
          ? Math.round(performance.now() - lastReadyAt)
          : null,
        autoReadHandledCount: autoReadHandledKeys.size,
        autoReadConfirmedCount,
        autoReadFailedStartCount,
        lastAutoReadConfirmedKey,
        lastAutoReadConfirmedAgeMs: lastAutoReadConfirmedAt
          ? Math.round(performance.now() - lastAutoReadConfirmedAt)
          : null,
        settings: {
          enabled: settings.enabled,
          autoReadEnabled: settings.autoReadEnabled,
          autoReadDelayMs: settings.autoReadDelayMs,
          readySoundEnabled: settings.readySoundEnabled,
          playbackRate: settings.playbackRate,
        },
        pendingReadKey,
        activeReadKey,
        activeReadOrdinal,
        activeReadRoute,
        virtualPauseUsesMedia,
        hasActiveMedia: mediaHasSource(activeMedia),
        mediaPlaying: mediaActuallyPlaying(activeMedia),
        virtualPaused,
        resumeRestoring,
        capturePending: capturePendingFor(),
        autoReadLockHeld: !!autoReadRelease,
        playbackOwner: readPlaybackOwner(),
        heartbeatRunning: !!playbackHeartbeatTimer,
        heartbeatAgeMs: playbackHeartbeatStartedAt
          ? Math.round(performance.now() - playbackHeartbeatStartedAt)
          : null,
        playbackProgressAgeMs: playbackProgressAt
          ? Math.round(performance.now() - playbackProgressAt)
          : null,
        playbackProgressTime,
        nativePlaybackVisible: nativePlaybackVisible(),
        otherTabPlaybackActive: otherTabPlaybackActive(),
      };
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

  log("v0.5.30 response-route + auto-read-lock fixes loaded");
})();
