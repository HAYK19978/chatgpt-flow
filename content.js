(() => {
  "use strict";

  const SETTINGS_KEY = "chatgptFlowSettings";
  const DEFAULT_SETTINGS = {
    enabled: true,
    autoSendEnabled: true,
    silenceMs: 5000,
    autoReadEnabled: true,
    autoReadDelayMs: 0,
    readySoundEnabled: false,
    resumePlaybackEnabled: true,
    playbackRate: 1,
  };

  function normalizeSettings(value) {
    const silenceMs = Number(value?.silenceMs);
    const autoReadDelayMs = Number(value?.autoReadDelayMs);
    const playbackRate = Number(value?.playbackRate);

    return {
      enabled: value?.enabled !== false,
      autoSendEnabled: value?.autoSendEnabled !== false,
      silenceMs: Number.isFinite(silenceMs) ? Math.min(90000, Math.max(2000, Math.round(silenceMs))) : 5000,
      autoReadEnabled: value?.autoReadEnabled !== false,
      autoReadDelayMs: Number.isFinite(autoReadDelayMs) ? Math.min(30000, Math.max(0, Math.round(autoReadDelayMs))) : 0,
      readySoundEnabled: value?.readySoundEnabled === true,
      resumePlaybackEnabled: value?.resumePlaybackEnabled !== false,
      playbackRate: Number.isFinite(playbackRate) ? Math.min(2, Math.max(0.5, Math.round(playbackRate * 4) / 4)) : 1,
    };
  }

  let settings = { ...DEFAULT_SETTINGS };


  function extensionContextAlive() {
    try {
      return !!chrome?.runtime?.id;
    } catch {
      return false;
    }
  }

  function isInvalidatedContextError(error) {
    return /extension context invalidated/i.test(
      String(error?.message || error || ""),
    );
  }

  function logBridgeError(prefix, error) {
    if (isInvalidatedContextError(error)) return;
    console.log(`[ChatGPT Flow] ${prefix}:`, error);
  }

  function safeStorageSet(value) {
    if (!extensionContextAlive()) return;

    try {
      const result = chrome.storage.local.set(value);
      Promise.resolve(result).catch((error) => {
        logBridgeError("Could not save settings", error);
      });
    } catch (error) {
      logBridgeError("Could not save settings", error);
    }
  }

  function safeRuntimeMessage(message) {
    if (!extensionContextAlive()) return;

    try {
      const result = chrome.runtime.sendMessage(message);
      Promise.resolve(result).catch((error) => {
        logBridgeError("Could not request ready sound", error);
      });
    } catch (error) {
      logBridgeError("Could not request ready sound", error);
    }
  }

  function sendSettings() {
    window.postMessage({
      source: "chatgpt-flow-extension",
      type: "settings",
      settings,
    }, "*");
  }

  async function loadSettings() {
    if (!extensionContextAlive()) return;

    let stored;
    try {
      stored = await chrome.storage.local.get({
        [SETTINGS_KEY]: DEFAULT_SETTINGS,
      });
    } catch (error) {
      logBridgeError("Settings bridge failed", error);
      return;
    }

    if (!extensionContextAlive()) return;

    settings = normalizeSettings(stored[SETTINGS_KEY]);
    sendSettings();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "chatgpt-flow-main") return;

    if (event.data?.type === "request-settings") {
      sendSettings();
      return;
    }

    if (event.data?.type === "update-settings") {
      settings = normalizeSettings({ ...settings, ...(event.data.settings || {}) });
      safeStorageSet({ [SETTINGS_KEY]: settings });
      return;
    }

    if (event.data?.type === "play-ready-sound") {
      safeRuntimeMessage({ type: "chatgpt-flow-play-ready-sound" });
    }
  });

  if (extensionContextAlive()) {
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes[SETTINGS_KEY]) return;
        settings = normalizeSettings(
          changes[SETTINGS_KEY].newValue || DEFAULT_SETTINGS,
        );
        sendSettings();
      });
    } catch (error) {
      logBridgeError("Could not attach storage listener", error);
    }
  }

  loadSettings().catch((error) => {
    logBridgeError("Settings bridge failed", error);
  });
})();
