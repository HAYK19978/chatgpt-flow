(() => {
  "use strict";

  const SETTINGS_KEY = "chatgptFlowSettings";

  const DEFAULT_SETTINGS = {
    enabled: true,
  };

  let settings = {
    ...DEFAULT_SETTINGS,
  };

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

    const value = stored[SETTINGS_KEY] || DEFAULT_SETTINGS;

    settings = {
      enabled: value.enabled !== false,
    };

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
    if (areaName !== "local" || !changes[SETTINGS_KEY]) {
      return;
    }

    const value = changes[SETTINGS_KEY].newValue || DEFAULT_SETTINGS;

    settings = {
      enabled: value.enabled !== false,
    };

    sendSettings();
  });

  loadSettings().catch((error) => {
    console.log("[ChatGPT Flow] Settings bridge failed:", error);
  });
})();
