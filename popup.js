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

  const clampInt = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };

  const clampRate = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(2, Math.max(0.5, Math.round(n * 4) / 4)) : 1;
  };

  function render() {
    status.textContent = enabled.checked ? "Flow включён" : "Flow выключен";
    document.body.classList.toggle("disabled", !enabled.checked);
    silence.disabled = !autoSend.checked;
    delay.disabled = !autoRead.checked;
  }

  async function load() {
    const result = await chrome.storage.local.get({ [KEY]: DEFAULTS });
    const settings = result[KEY] || DEFAULTS;

    enabled.checked = settings.enabled !== false;
    autoSend.checked = settings.autoSendEnabled !== false;
    silence.value = String(clampInt((Number(settings.silenceMs) || 5000) / 1000, 2, 90, 5));
    autoRead.checked = settings.autoReadEnabled !== false;
    delay.value = String(clampInt((Number(settings.autoReadDelayMs) || 0) / 1000, 0, 30, 0));
    readySound.checked = settings.readySoundEnabled === true;
    rate.value = String(clampRate(settings.playbackRate));
    render();
  }

  async function save() {
    const silenceSeconds = clampInt(silence.value, 2, 90, 5);
    const delaySeconds = clampInt(delay.value, 0, 30, 0);
    silence.value = String(silenceSeconds);
    delay.value = String(delaySeconds);

    const current = (await chrome.storage.local.get({ [KEY]: DEFAULTS }))[KEY] || DEFAULTS;
    await chrome.storage.local.set({
      [KEY]: {
        ...current,
        enabled: enabled.checked,
        autoSendEnabled: autoSend.checked,
        silenceMs: silenceSeconds * 1000,
        autoReadEnabled: autoRead.checked,
        autoReadDelayMs: delaySeconds * 1000,
        readySoundEnabled: readySound.checked,
        playbackRate: clampRate(rate.value),
      },
    });
    render();
  }

  [enabled, autoSend, silence, autoRead, delay, readySound, rate].forEach((element) => {
    element.addEventListener("change", () => save().catch(console.error));
  });

  load().catch(console.error);
})();
