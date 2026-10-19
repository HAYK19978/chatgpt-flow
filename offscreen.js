let current = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.target !== "chatgpt-flow-offscreen" ||
    message?.type !== "play-ready-sound"
  ) {
    return;
  }

  (async () => {
    try {
      try {
        current?.pause();
      } catch {}

      const audio = new Audio(chrome.runtime.getURL("sounds/done.mp3"));
      audio.preload = "auto";
      audio.volume = 1;
      audio.currentTime = 0;

      current = audio;

      audio.addEventListener(
        "ended",
        () => {
          if (current === audio) current = null;
        },
        { once: true },
      );

      await audio.play();
      sendResponse({ ok: true });
    } catch (error) {
      console.error("[ChatGPT Flow] Offscreen audio failed:", error);
      sendResponse({ ok: false, error: String(error) });
    }
  })();

  return true;
});
