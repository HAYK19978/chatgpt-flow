(() => {
  "use strict";

  const SETTINGS_KEY = "chatgptFlowSettings";
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true });

  const enabledInput = document.getElementById("enabled");
  const status = document.getElementById("status");

  async function save() {
    const enabled = enabledInput.checked;

    await chrome.storage.local.set({
      [SETTINGS_KEY]: { enabled },
    });

    status.textContent = enabled ? "Enabled" : "Disabled";
  }

  async function init() {
    const stored = await chrome.storage.local.get({
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
    });

    const settings = stored[SETTINGS_KEY] || DEFAULT_SETTINGS;

    enabledInput.checked = settings.enabled !== false;
    status.textContent = enabledInput.checked ? "Enabled" : "Disabled";

    enabledInput.addEventListener("change", save);
  }

  init().catch((error) => {
    console.debug("[ChatGPT Flow] popup init failed:", error);
    status.textContent = "Could not load settings";
  });
})();
