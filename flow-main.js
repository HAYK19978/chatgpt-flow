(() => {
  "use strict";

  if (window.__CHATGPT_FLOW_V046__) return;
  window.__CHATGPT_FLOW_V046__ = true;

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
  const DEFAULT_PLAYBACK_RATE = 1;
  const MIN_PLAYBACK_RATE = 0.5;
  const MAX_PLAYBACK_RATE = 2;
  const FLOW_PAUSE_PIN_MS = 40;

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
  let playbackRate = DEFAULT_PLAYBACK_RATE;

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
  let playbackControls = null;
  let playbackControlsHost = null;
  let activeReadButton = null;
  let activeReadTurn = null;
  let playbackPortalOffset = null;
  let playbackPortalRect = null;
  let flowReadPaused = false;
  let flowPausePosition = 0;
  let flowPauseTimer = 0;
  let flowPauseOriginalMuted = false;
  let awaitingNativeReadAudio = false;
  let controlChannel = null;
  let nativeMediaPlay = null;
  let nativeMediaPause = null;

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

  function clampPlaybackRate(value) {
    const numeric = Number(value);

    if (!Number.isFinite(numeric)) {
      return DEFAULT_PLAYBACK_RATE;
    }

    return Math.min(
      MAX_PLAYBACK_RATE,
      Math.max(MIN_PLAYBACK_RATE, Math.round(numeric * 4) / 4),
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
    playbackRate = clampPlaybackRate(next.playbackRate);

    if (activeReadAudio instanceof HTMLMediaElement) {
      try {
        activeReadAudio.playbackRate = playbackRate;
      } catch {}
    }

    updatePlaybackControls();

    log(
      enabled ? "enabled" : "disabled",
      `silence=${Math.round(silenceMs / 100) / 10}s`,
      `speed=${playbackRate}x`,
    );

    if (!enabled) {
      cancelDictationMonitoring();
      cancelAutomaticRead();
      stopManagedReadAloud();
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

  function sendPlaybackRateSetting() {
    window.postMessage(
      {
        source: "chatgpt-flow-main",
        type: "update-settings",
        settings: { playbackRate },
      },
      "*",
    );
  }

  function playbackIcon(kind) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.style.display = "block";

    if (kind === "pause") {
      svg.innerHTML = `
        <path d="M6.75 4.25v11.5M13.25 4.25v11.5"
          stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      `;
      return svg;
    }

    if (kind === "play") {
      svg.innerHTML = `
        <path d="M7 4.9v10.2c0 .62.69.99 1.21.65l7.2-4.68a1.28 1.28 0 0 0 0-2.14l-7.2-4.68A.78.78 0 0 0 7 4.9Z"
          fill="currentColor"/>
      `;
      return svg;
    }

    const back = kind === "back";
    svg.innerHTML = back
      ? `
        <path d="M5.1 5.55H2.85V3.3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3.05 5.35A7 7 0 1 1 3.5 14.9" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>
        <text x="10" y="12.15" text-anchor="middle" fill="currentColor"
          font-size="6.2" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">15</text>
      `
      : `
        <path d="M14.9 5.55h2.25V3.3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M16.95 5.35A7 7 0 1 0 16.5 14.9" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>
        <text x="10" y="12.15" text-anchor="middle" fill="currentColor"
          font-size="6.2" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">15</text>
      `;

    return svg;
  }

  function setPlaybackButtonIcon(button, kind) {
    if (button.dataset.chatgptFlowIcon === kind) return;

    button.dataset.chatgptFlowIcon = kind;
    button.replaceChildren(playbackIcon(kind));
  }

  function stylePlaybackControlLikeChatGPT(button, anchor) {
    if (anchor instanceof HTMLButtonElement && typeof anchor.className === "string") {
      button.className = anchor.className;
    } else {
      button.className =
        "no-drag cursor-interaction items-center select-none focus:outline-hidden whitespace-nowrap flex border gap-1 rounded-full text-tertiary border-transparent flex items-center justify-center p-0.5";
    }

    button.style.margin = "0";
    button.style.flex = "0 0 auto";
  }

  function createPlaybackControl(title, onClick) {
    const button = document.createElement("button");

    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });

    return button;
  }

  function rememberPlaybackPlacement(anchor, root) {
    const turn = activeReadTurn || anchor?.closest?.("article") || null;

    if (turn instanceof Element && turn.isConnected) {
      activeReadTurn = turn;
    }

    // v0.4.6: the controls NEVER live inside ChatGPT's React tree. React was
    // deleting our sibling whenever its Read aloud/Stop action rerendered.
    // Remember the viewport position beside the native button and render the
    // controls from document.body instead.
    try {
      const anchorRect = anchor?.getBoundingClientRect?.();
      const rootRect = root?.getBoundingClientRect?.();

      if (anchorRect && anchorRect.width > 0 && anchorRect.height > 0) {
        playbackPortalRect = {
          documentLeft: anchorRect.right + window.scrollX,
          documentTop: anchorRect.top + window.scrollY,
        };
      } else if (rootRect && rootRect.width > 0 && rootRect.height > 0) {
        playbackPortalRect = {
          documentLeft: rootRect.left + window.scrollX,
          documentTop: rootRect.top + window.scrollY,
        };
      }
    } catch {}
  }

  function findReadPlaybackAnchorInTurn(turn) {
    if (!(turn instanceof Element) || !turn.isConnected) return null;

    const read = [...turn.querySelectorAll(READ_SELECTOR)].filter(isUsableButton).at(-1);
    if (read) return read;

    const stop = [...turn.querySelectorAll("button")]
      .filter(isUsableButton)
      .filter((button) => !isStopGeneratingButton(button))
      .filter((button) => !/dictation/i.test(buttonLabel(button)))
      .find((button) =>
        /^(?:stop|pause)(?:\s+(?:reading|read aloud|audio))?$/i.test(buttonLabel(button)),
      );

    return stop || null;
  }

  function renderPlaybackControlsInBody(root) {
    if (!root || !playbackPortalRect) return false;

    try {
      if (root.parentElement !== document.body) {
        document.body.appendChild(root);
      }

      Object.assign(root.style, {
        position: "fixed",
        left: `${Math.round(playbackPortalRect.documentLeft - window.scrollX)}px`,
        top: `${Math.round(playbackPortalRect.documentTop - window.scrollY)}px`,
        zIndex: "2147483000",
        display: "inline-flex",
        pointerEvents: "auto",
      });

      return true;
    } catch {
      return false;
    }
  }

  function readPlaybackIsPinned() {
    return !!(
      activeReadAudio ||
      awaitingNativeReadAudio ||
      awaitingAutoReadAudio ||
      flowReadPaused
    );
  }

  function resolvePlaybackAnchor() {
    // First preference while a session is active: an action in the SAME turn.
    // Never jump to an older answer.
    if (readPlaybackIsPinned()) {
      const inTurn = findReadPlaybackAnchorInTurn(activeReadTurn);
      if (inTurn) return inTurn;
      return isUsableButton(activeReadButton) ? activeReadButton : null;
    }

    const latestVisible = [...document.querySelectorAll(READ_SELECTOR)]
      .filter(isUsableButton)
      .at(-1);

    if (latestVisible) return latestVisible;

    const nativeStop = findNativeReadStopButton();
    if (isUsableButton(nativeStop)) return nativeStop;

    return isUsableButton(activeReadButton) ? activeReadButton : null;
  }

  function placePlaybackControls() {
    const controls = playbackControls;
    if (!controls?.root) return false;

    const anchor = resolvePlaybackAnchor();

    if (anchor instanceof HTMLButtonElement) {
      activeReadButton = anchor;
      playbackControlsHost = anchor.parentElement || playbackControlsHost;

      for (const button of [controls.back, controls.toggle, controls.forward, controls.speed]) {
        stylePlaybackControlLikeChatGPT(button, anchor);
      }

      rememberPlaybackPlacement(anchor, controls.root);
    }

    // Crucial invariant: once we know where the controls belong, keep them in
    // document.body. ChatGPT can replace/remove its whole action row and our
    // buttons survive because they are no longer descendants of that row.
    if (renderPlaybackControlsInBody(controls.root)) {
      return true;
    }

    return controls.root.isConnected && isVisible(controls.root);
  }

  function ensurePlaybackControls() {
    if (playbackControls?.root) {
      placePlaybackControls();
      return playbackControls;
    }

    if (!document.body) {
      return null;
    }

    const root = document.createElement("span");
    root.id = "chatgpt-flow-playback-controls";
    root.hidden = false;
    root.setAttribute("data-chatgpt-flow", "playback-controls");

    Object.assign(root.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "0",
      verticalAlign: "middle",
    });

    const back = createPlaybackControl("Back 15 seconds", () => {
      seekManagedReadAloud(-15);
    });
    setPlaybackButtonIcon(back, "back");

    const toggle = createPlaybackControl("Pause Read aloud", () => {
      toggleManagedReadAloud().catch((error) => {
        log("Could not toggle Read aloud:", error);
      });
    });
    setPlaybackButtonIcon(toggle, "pause");

    const forward = createPlaybackControl("Forward 15 seconds", () => {
      seekManagedReadAloud(15);
    });
    setPlaybackButtonIcon(forward, "forward");

    const speed = createPlaybackControl("Read aloud speed", () => {
      cyclePlaybackRate();
    });
    speed.setAttribute("aria-label", "Read aloud speed");
    speed.textContent = `${playbackRate}×`;
    Object.assign(speed.style, {
      fontSize: "11px",
      fontWeight: "600",
      lineHeight: "20px",
      minWidth: "30px",
      paddingInline: "4px",
    });

    root.append(back, toggle, forward, speed);
    playbackControls = { root, back, toggle, forward, speed };
    placePlaybackControls();

    return playbackControls;
  }

  function mediaHasSource(media) {
    return !!(media?.currentSrc || media?.src);
  }

  function updatePlaybackControls() {
    const controls = ensurePlaybackControls();

    if (!controls) return;

    // v0.3.9 deliberately keeps the three controls visible whenever the
    // native Read aloud action exists. Playback behavior will be refined
    // separately after the UI placement is confirmed.
    const placed = placePlaybackControls();

    controls.root.hidden = !placed;
    controls.root.style.display = placed ? "inline-flex" : "none";

    if (!placed) return;

    const media = activeReadAudio;
    const activelyPlaying =
      media instanceof HTMLMediaElement &&
      !media.paused &&
      !media.ended &&
      mediaHasSource(media);

    setPlaybackButtonIcon(
      controls.toggle,
      flowReadPaused || !activelyPlaying ? "play" : "pause",
    );

    controls.toggle.title = flowReadPaused
      ? "Resume Read aloud"
      : activelyPlaying
        ? "Pause Read aloud"
        : "Play / pause Read aloud";

    controls.toggle.setAttribute("aria-label", controls.toggle.title);

    controls.speed.textContent = `${playbackRate}×`;
    controls.speed.title = `Read aloud speed: ${playbackRate}×`;
    controls.speed.setAttribute("aria-label", controls.speed.title);
  }

  function cyclePlaybackRate() {
    const rates = [0.75, 1, 1.25, 1.5, 1.75, 2];
    const currentIndex = rates.findIndex(
      (rate) => Math.abs(rate - playbackRate) < 0.001,
    );
    playbackRate = rates[(currentIndex + 1 + rates.length) % rates.length];

    const media = activeReadAudio;
    if (media instanceof HTMLMediaElement && !media.ended && mediaHasSource(media)) {
      try {
        media.defaultPlaybackRate = playbackRate;
        media.playbackRate = playbackRate;
      } catch (error) {
        log("Could not change Read aloud speed:", error);
      }
    }

    sendPlaybackRateSetting();
    updatePlaybackControls();
    log("Read aloud speed", `${playbackRate}x`);
  }

  function clearFlowPauseTimer() {
    if (!flowPauseTimer) return;
    clearInterval(flowPauseTimer);
    flowPauseTimer = 0;
  }

  function clearFlowPauseState({ restoreMuted = true } = {}) {
    clearFlowPauseTimer();

    const media = activeReadAudio;
    if (restoreMuted && media instanceof HTMLMediaElement) {
      try {
        media.muted = flowPauseOriginalMuted;
      } catch {}
    }

    flowReadPaused = false;
    flowPausePosition = 0;
    flowPauseOriginalMuted = false;
  }

  function looksLikeChatGPTReadAudio(media) {
    if (!(media instanceof HTMLAudioElement)) return false;

    const src = String(media.currentSrc || media.src || "");

    return (
      !media.isConnected &&
      (src.startsWith("blob:https://chatgpt.com/") ||
        src.startsWith("blob:https://chat.openai.com/"))
    );
  }

  function adoptReadAudio(media) {
    if (!(media instanceof HTMLMediaElement)) return;

    if (activeReadAudio && activeReadAudio !== media) {
      clearFlowPauseState();
    }

    activeReadAudio = media;
    awaitingAutoReadAudio = false;
    awaitingNativeReadAudio = false;

    if (!media.__chatgptFlowEndHookV046) {
      media.addEventListener(
        "ended",
        () => {
          if (activeReadAudio !== media) return;

          clearFlowPauseState({ restoreMuted: false });
          activeReadAudio = null;
          activeReadButton = null;
          activeReadTurn = null;
          playbackPortalOffset = null;
          playbackPortalRect = null;
          updatePlaybackControls();
          releaseReadLock();
        },
        { once: true },
      );

      try {
        Object.defineProperty(media, "__chatgptFlowEndHookV046", {
          value: true,
          configurable: true,
        });
      } catch {}
    }

    if (readAudioStartTimer) {
      clearTimeout(readAudioStartTimer);
      readAudioStartTimer = 0;
    }

    try {
      media.defaultPlaybackRate = playbackRate;
      media.playbackRate = playbackRate;
    } catch {}

    updatePlaybackControls();
  }

  function installManagedPauseEventShield(media) {
    if (!(media instanceof HTMLMediaElement)) return;

    const blockManagedPause = (event) => {
      if (!flowReadPaused || activeReadAudio !== media) return;

      // The detached ChatGPT TTS element is destroyed by page cleanup after
      // its pause event. For Flow's resumable pause, hide ONLY this one pause
      // event from page listeners. A real Stop remains completely native.
      event.stopImmediatePropagation();
      event.stopPropagation();
      log("Suppressed ChatGPT pause cleanup for resumable Read aloud");
    };

    media.addEventListener("pause", blockManagedPause, {
      capture: true,
      once: true,
    });
  }

  function beginFlowPause(media) {
    if (
      !(media instanceof HTMLMediaElement) ||
      media.ended ||
      !mediaHasSource(media)
    ) {
      return false;
    }

    if (flowReadPaused && media === activeReadAudio) {
      return true;
    }

    activeReadAudio = media;
    flowPausePosition = Number.isFinite(media.currentTime)
      ? media.currentTime
      : 0;
    flowPauseOriginalMuted = !!media.muted;
    flowReadPaused = true;

    // IMPORTANT: never call pause() here. ChatGPT destroys its MediaSource
    // about a second after a real pause. Keep the native stream alive, mute it,
    // and pin currentTime to the saved position until the user resumes.
    try {
      media.muted = true;
      media.currentTime = flowPausePosition;
    } catch (error) {
      flowReadPaused = false;
      log("Read aloud virtual pause failed:", error);
      return false;
    }

    clearFlowPauseTimer();
    flowPauseTimer = window.setInterval(() => {
      if (activeReadAudio !== media || !flowReadPaused) {
        clearFlowPauseTimer();
        return;
      }

      if (media.ended || !mediaHasSource(media)) {
        clearFlowPauseState({ restoreMuted: false });
        activeReadAudio = null;
        updatePlaybackControls();
        releaseReadLock();
        return;
      }

      try {
        media.muted = true;
        if (Math.abs(media.currentTime - flowPausePosition) > 0.015) {
          media.currentTime = flowPausePosition;
        }
      } catch (error) {
        log("Read aloud pause pin failed:", error);
      }
    }, FLOW_PAUSE_PIN_MS);

    updatePlaybackControls();
    log("Read aloud virtually paused at", flowPausePosition.toFixed(2));
    return true;
  }

  async function resumeFlowPausedReadAloud() {
    const media = activeReadAudio;

    if (
      !(media instanceof HTMLMediaElement) ||
      media.ended ||
      !mediaHasSource(media)
    ) {
      clearFlowPauseState({ restoreMuted: false });
      activeReadAudio = null;
      updatePlaybackControls();
      return false;
    }

    const resumeAt = flowPausePosition;
    const restoreMuted = flowPauseOriginalMuted;

    clearFlowPauseTimer();

    try {
      media.currentTime = resumeAt;
      media.defaultPlaybackRate = playbackRate;
      media.playbackRate = playbackRate;
      media.muted = restoreMuted;
      flowReadPaused = false;
      flowPausePosition = 0;
      flowPauseOriginalMuted = false;

      // Normally the underlying media never stopped, so there is nothing to
      // restart. If the browser paused it for an unrelated reason, restart it
      // only while the original MediaSource is still alive.
      if (media.paused && mediaHasSource(media)) {
        const play = nativeMediaPlay || HTMLMediaElement.prototype.play;
        const promise = play.call(media);
        if (promise?.catch) {
          promise.catch((error) => {
            log("Read aloud resume play() failed:", error);
          });
        }
      }

      updatePlaybackControls();
      log("Read aloud resumed from", resumeAt.toFixed(2));
      return true;
    } catch (error) {
      flowReadPaused = true;
      flowPausePosition = resumeAt;
      flowPauseOriginalMuted = restoreMuted;
      try {
        media.muted = true;
      } catch {}
      updatePlaybackControls();
      throw error;
    }
  }

  async function toggleManagedReadAloud() {
    const media = activeReadAudio;

    if (!(media instanceof HTMLMediaElement) || media.ended || !mediaHasSource(media)) {
      // If there is no active media yet, make the center Play button useful:
      // start the latest native Read aloud action and let the interceptor adopt it.
      const readButton = resolvePlaybackAnchor();
      if (isUsableButton(readButton)) {
        activeReadButton = readButton;
        awaitingNativeReadAudio = true;
        readButton.click();
      }
      updatePlaybackControls();
      return;
    }

    if (flowReadPaused) {
      await resumeFlowPausedReadAloud();
      return;
    }

    beginFlowPause(media);
  }

  function seekManagedReadAloud(deltaSeconds) {
    const media = activeReadAudio;

    if (
      !(media instanceof HTMLMediaElement) ||
      media.ended ||
      !mediaHasSource(media)
    ) {
      updatePlaybackControls();
      return false;
    }

    const base = flowReadPaused ? flowPausePosition : media.currentTime;
    let target = Math.max(0, base + deltaSeconds);

    if (Number.isFinite(media.duration)) {
      target = Math.min(target, Math.max(0, media.duration - 0.05));
    }

    // ChatGPT TTS is streamed through MediaSource. Forward seeking cannot go
    // beyond the currently seekable window, so clamp to the live seek range.
    try {
      if (media.seekable?.length) {
        const start = media.seekable.start(0);
        const end = media.seekable.end(media.seekable.length - 1);
        target = Math.min(Math.max(target, start), Math.max(start, end - 0.02));
      }
    } catch {}

    try {
      // Use currentTime, not fastSeek(). fastSeek is explicitly allowed to
      // trade precision for speed and can land away from the requested point.
      // currentTime gives us an exact ±15 second target whenever that point is
      // inside ChatGPT's currently seekable streaming window.
      media.currentTime = target;

      if (flowReadPaused) {
        flowPausePosition = target;
      }

      updatePlaybackControls();
      log("Read aloud seek", `${deltaSeconds > 0 ? "+" : ""}${deltaSeconds}s`, target);
      return true;
    } catch (error) {
      log("Read aloud seek failed:", error);
      return false;
    }
  }

  function stopManagedReadAloud() {
    const media = activeReadAudio;

    clearFlowPauseState();

    if (media instanceof HTMLMediaElement && !media.paused) {
      try {
        (nativeMediaPause || HTMLMediaElement.prototype.pause).call(media);
      } catch {}
    }

    activeReadAudio = null;
    activeReadButton = null;
    activeReadTurn = null;
    playbackPortalOffset = null;
    playbackPortalRect = null;
    updatePlaybackControls();
    releaseReadLock();
  }

  // ---------------------------------------------------------------------------
  // Read-aloud media interception
  // ---------------------------------------------------------------------------

  function installReadAloudMediaInterceptor() {
    const proto = window.HTMLMediaElement?.prototype;

    if (!proto || proto.__chatgptFlowMediaHookV046) {
      return;
    }

    nativeMediaPlay = proto.play;
    nativeMediaPause = proto.pause;

    proto.play = function (...args) {
      const shouldCapture =
        this instanceof HTMLMediaElement &&
        (awaitingAutoReadAudio ||
          awaitingNativeReadAudio ||
          this === activeReadAudio ||
          looksLikeChatGPTReadAudio(this));

      if (shouldCapture) {
        adoptReadAudio(this);

        queueMicrotask(() => {
          updatePlaybackControls();
          log("Read aloud media captured", {
            connected: this.isConnected,
            currentTime: this.currentTime,
            duration: this.duration,
            src: this.currentSrc || this.src,
          });
        });
      }

      return nativeMediaPlay.apply(this, args);
    };

    proto.pause = function (...args) {
      const managed = this === activeReadAudio;
      const result = nativeMediaPause.apply(this, args);

      if (managed && !flowReadPaused) {
        queueMicrotask(() => {
          if (this.paused) {
            releaseReadLock();
          }
          updatePlaybackControls();
        });
      }

      return result;
    };

    Object.defineProperty(proto, "__chatgptFlowMediaHookV046", {
      value: true,
      configurable: true,
    });

    log("v0.4.6 body-portal controls + virtual resumable pause hook installed");
  }

  installReadAloudMediaInterceptor();

  // ---------------------------------------------------------------------------
  // Read-aloud pause / lifecycle
  // ---------------------------------------------------------------------------

  function pauseManagedReadAloud() {
    // Lifecycle/cross-tab "pause" means a real stop. The center UI button uses
    // beginFlowPause() directly and therefore remains resumable.
    if (
      activeReadAudio instanceof HTMLMediaElement &&
      !activeReadAudio.ended &&
      mediaHasSource(activeReadAudio)
    ) {
      stopManagedReadAloud();
      return true;
    }

    const stopButton = findNativeReadStopButton();

    if (stopButton) {
      try {
        stopButton.click();
        releaseReadLock();
        return true;
      } catch {}
    }

    releaseReadLock();
    return false;
  }

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

    log("v0.3.6 native microphone hook installed");
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

    // v0.3.3: use the stable analyser/timer path.
    // ScriptProcessor callbacks proved unreliable for silence auto-send in v0.3.2.
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

    activeReadButton = button;
    activeReadTurn = targetTurn.closest?.("article") || targetTurn;
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

    // Flow's own playback buttons bubble through this document-level capture
    // listener. Older builds mistook our "Pause Read aloud" button for
    // ChatGPT's native Stop/Pause button and cleared activeReadAudio BEFORE
    // the button's own click handler ran. That made pause/resume do nothing
    // and also caused the controls to disappear. Never classify our controls
    // as native ChatGPT actions.
    if (button.closest('[data-chatgpt-flow="playback-controls"]')) {
      return;
    }

    const label = buttonLabel(button);

    if (/^read aloud$/i.test(label)) {
      if (flowReadPaused) {
        stopManagedReadAloud();
      }

      activeReadButton = button;
      activeReadTurn = button.closest("article") || button.closest('[data-message-author-role="assistant"]') || null;
      awaitingNativeReadAudio = true;
      return;
    }

    if (
      activeReadAudio &&
      !isStopGeneratingButton(button) &&
      /^(?:stop|pause)(?:\s+(?:reading|read aloud|audio))?$/i.test(label)
    ) {
      clearFlowPauseState();
      activeReadAudio = null;
      activeReadButton = null;
      activeReadTurn = null;
      playbackPortalOffset = null;
      playbackPortalRect = null;
      updatePlaybackControls();
      releaseReadLock();
      return;
    }

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

  let playbackUiFrame = 0;

  function schedulePlaybackUiPlacement() {
    if (playbackUiFrame) return;

    playbackUiFrame = requestAnimationFrame(() => {
      playbackUiFrame = 0;
      updatePlaybackControls();
    });
  }

  const playbackUiObserver = new MutationObserver(() => {
    schedulePlaybackUiPlacement();
  });

  playbackUiObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("scroll", schedulePlaybackUiPlacement, true);
  window.addEventListener("resize", schedulePlaybackUiPlacement, { passive: true });

  document.addEventListener("click", onDocumentClick, true);

  document.addEventListener("keydown", onDocumentKeyDown, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensurePlaybackControls, { once: true });
  } else {
    ensurePlaybackControls();
  }

  window.addEventListener("pagehide", () => {
    playbackUiObserver.disconnect();

    cancelDictationMonitoring();
    cancelAutomaticRead();
    stopManagedReadAloud();
    releaseReadLock();

    try {
      controlChannel?.close();
    } catch {}
  });

  log("v0.4.5 main controller loaded");
})();
