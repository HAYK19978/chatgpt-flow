(() => {
  "use strict";

  const KEY = "chatgptFlowSettings";
  const DEFAULTS = {
    enabled: true,
    autoSendEnabled: true,
    silenceMs: 5000,
    autoReadEnabled: true,
    autoReadDelayMs: 0,
    readySoundEnabled: false,
    resumePlaybackEnabled: true,
    playbackRate: 1,
  };

  const $ = (selector) => document.querySelector(selector);
  const enabled = $("#flow-enabled");
  const autoSend = $("#auto-send-enabled");
  const silence = $("#silence-seconds");
  const autoRead = $("#auto-read-enabled");
  const delay = $("#auto-read-delay");
  const readySound = $("#ready-sound-enabled");
  const rate = $("#playback-rate");
  const status = $("#status-text");

  let currentSettings = { ...DEFAULTS };

  const clampInt = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n)
      ? Math.min(max, Math.max(min, Math.round(n)))
      : fallback;
  };

  const clampRate = (value) => {
    const n = Number(value);
    return Number.isFinite(n)
      ? Math.min(2, Math.max(0.5, Math.round(n * 4) / 4))
      : 1;
  };

  function render() {
    status.textContent = enabled.checked ? "Flow включён" : "Flow выключен";
    document.body.classList.toggle("disabled", !enabled.checked);
    silence.disabled = !autoSend.checked;
    delay.disabled = !autoRead.checked;
  }

  async function load() {
    const result = await chrome.storage.local.get({ [KEY]: DEFAULTS });
    currentSettings = {
      ...DEFAULTS,
      ...(result[KEY] || {}),
    };

    enabled.checked = currentSettings.enabled !== false;
    autoSend.checked = currentSettings.autoSendEnabled !== false;
    silence.value = String(
      clampInt(
        (Number(currentSettings.silenceMs) || 5000) / 1000,
        2,
        90,
        5,
      ),
    );
    autoRead.checked = currentSettings.autoReadEnabled !== false;
    delay.value = String(
      clampInt(
        (Number(currentSettings.autoReadDelayMs) || 0) / 1000,
        0,
        30,
        0,
      ),
    );
    readySound.checked = currentSettings.readySoundEnabled === true;
    rate.value = String(clampRate(currentSettings.playbackRate));
    render();
  }

  function saveNow() {
    const silenceSeconds = clampInt(silence.value, 2, 90, 5);
    const delaySeconds = clampInt(delay.value, 0, 30, 0);

    silence.value = String(silenceSeconds);
    delay.value = String(delaySeconds);

    currentSettings = {
      ...currentSettings,
      enabled: enabled.checked,
      autoSendEnabled: autoSend.checked,
      silenceMs: silenceSeconds * 1000,
      autoReadEnabled: autoRead.checked,
      autoReadDelayMs: delaySeconds * 1000,
      readySoundEnabled: readySound.checked,
      playbackRate: clampRate(rate.value),
    };

    // Hand the write to the service worker immediately. The service worker
    // survives the popup closing and chrome.storage.onChanged then pushes the
    // new settings into every open ChatGPT tab without a page reload.
    chrome.runtime
      .sendMessage({
        type: "chatgpt-flow-update-settings",
        settings: currentSettings,
      })
      .catch((error) => {
        console.log(
          "[ChatGPT Flow] Background settings save failed; using direct fallback:",
          error,
        );

        chrome.storage.local
          .set({ [KEY]: currentSettings })
          .catch((fallbackError) =>
            console.log(
              "[ChatGPT Flow] Direct settings fallback failed:",
              fallbackError,
            ),
          );
      });

    render();
  }

  // Toggles/selects must persist on the same interaction, without waiting for
  // the popup to lose focus. Number inputs use change so partially typed values
  // are not clamped mid-edit.
  [enabled, autoSend, autoRead, readySound, rate].forEach((element) => {
    element.addEventListener("input", saveNow);
    element.addEventListener("change", saveNow);
  });

  [silence, delay].forEach((element) => {
    element.addEventListener("change", saveNow);
  });

  load().catch((error) => {
    console.log("[ChatGPT Flow] Popup settings load failed:", error);
  });
})();
