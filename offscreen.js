let current = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "chatgpt-flow-offscreen" || message?.type !== "play-ready-sound") return;

  try {
    current?.pause();
  } catch {}

  current = new Audio(chrome.runtime.getURL("sounds/done.mp3"));
  current.volume = 1;
  current.play().catch((error) => console.error("[ChatGPT Flow] Offscreen audio failed:", error));
});
