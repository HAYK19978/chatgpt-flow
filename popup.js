(() => {
  "use strict";

  const SETTINGS_KEY = "chatgptFlowSettings";
  const DEFAULT_SETTINGS = {
    enabled: true,
    silenceMs: 5000,
  };

  const enabledInput = document.querySelector("#flow-enabled");
  const silenceInput = document.querySelector("#silence-seconds");
  const statusText = document.querySelector("#status-text");

  function clampSeconds(value) {
    const numeric = Number(value);

    if (!Number.isFinite(numeric)) return 5;

    return Math.min(90, Math.max(2, Math.round(numeric)));
  }

  async function load() {
    const stored = await chrome.storage.local.get({
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
    });

    const settings = stored[SETTINGS_KEY] || DEFAULT_SETTINGS;

    enabledInput.checked = settings.enabled !== false;

    silenceInput.value = String(
      clampSeconds((Number(settings.silenceMs) || 5000) / 1000),
    );

    renderStatus();
  }

  function renderStatus() {
    statusText.textContent = enabledInput.checked
      ? "Flow включён"
      : "Flow выключен";
  }

  async function save() {
    const seconds = clampSeconds(silenceInput.value);

    silenceInput.value = String(seconds);

    await chrome.storage.local.set({
      [SETTINGS_KEY]: {
        enabled: enabledInput.checked,
        silenceMs: seconds * 1000,
      },
    });

    renderStatus();
  }

  enabledInput.addEventListener("change", () => {
    save().catch(console.error);
  });

  silenceInput.addEventListener("change", () => {
    save().catch(console.error);
  });

  silenceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      silenceInput.blur();
    }
  });

  load().catch(console.error);
})();
