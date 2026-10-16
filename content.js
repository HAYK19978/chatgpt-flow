(() => {
  "use strict";

  const SETTINGS_KEY = "chatgptFlowSettings";
  const DEFAULT_SETTINGS = {
    enabled: true,
    silenceMs: 5000,
  };

  function normalizeSettings(value) {
    const silenceMs = Number(value?.silenceMs);

    return {
      enabled: value?.enabled !== false,
      silenceMs: Number.isFinite(silenceMs)
        ? Math.min(90000, Math.max(2000, Math.round(silenceMs)))
        : DEFAULT_SETTINGS.silenceMs,
    };
  }

  let settings = { ...DEFAULT_SETTINGS };

  function sendSettings() {
    window.postMessage(
      {
        source: "chatgpt-flow-extension",
        type: "settings",
        settings,
      },
      "*",
    );
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get({
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
    });

    settings = normalizeSettings(stored[SETTINGS_KEY]);
    sendSettings();
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.source !== "chatgpt-flow-main" ||
      event.data?.type !== "request-settings"
    ) {
      return;
    }

    sendSettings();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTINGS_KEY]) return;

    settings = normalizeSettings(
      changes[SETTINGS_KEY].newValue || DEFAULT_SETTINGS,
    );

    sendSettings();
  });

  loadSettings().catch((error) => {
    console.log("[ChatGPT Flow] Settings bridge failed:", error);
  });
})();
