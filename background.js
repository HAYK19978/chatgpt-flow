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
    justification:
      "Play the user-selected response-ready sound while ChatGPT is in a background tab.",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreenDocument() {
  try {
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {}
}

async function playReadySoundOnce() {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    target: "chatgpt-flow-offscreen",
    type: "play-ready-sound",
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Offscreen sound did not acknowledge playback");
  }
}

async function playReadySoundReliable() {
  try {
    await playReadySoundOnce();
    return;
  } catch (firstError) {
    console.warn("[ChatGPT Flow] Ready sound first attempt failed:", firstError);
  }

  // A newly-created/stale offscreen document can occasionally miss its first
  // message. Recreate it once and require an explicit play() acknowledgement.
  await closeOffscreenDocument();
  await ensureOffscreenDocument();
  await new Promise((resolve) => setTimeout(resolve, 80));
  await playReadySoundOnce();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "chatgpt-flow-play-ready-sound") return;

  playReadySoundReliable()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error("[ChatGPT Flow] Ready sound failed:", error);
      sendResponse({ ok: false, error: String(error) });
    });

  return true;
});
