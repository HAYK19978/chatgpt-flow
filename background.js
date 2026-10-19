const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null;

async function hasOffscreenDocument() {
  if (chrome.offscreen?.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play the user-selected response-ready sound while ChatGPT is in a background tab.",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "chatgpt-flow-play-ready-sound") return;

  (async () => {
    try {
      await ensureOffscreenDocument();
      await chrome.runtime.sendMessage({ target: "chatgpt-flow-offscreen", type: "play-ready-sound" });
      sendResponse({ ok: true });
    } catch (error) {
      console.error("[ChatGPT Flow] Ready sound failed:", error);
      sendResponse({ ok: false, error: String(error) });
    }
  })();

  return true;
});
