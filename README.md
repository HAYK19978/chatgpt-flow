# ChatGPT Flow

ChatGPT Flow is a personal Chrome extension for making long ChatGPT conversations easier to use hands-free.

It adds playback controls directly to ChatGPT message action rows and automates parts of the voice workflow without replacing ChatGPT's own Read aloud system.

## Features

- Custom Read aloud transport controls embedded next to ChatGPT's native message controls.
- Play / Pause / Resume built on top of ChatGPT's native Read aloud flow.
- Back and forward controls. The UI shows ±15; the internal step is intentionally tuned to the streamed TTS timeline rather than literal wall-clock seconds.
- Direct playback-speed menu: 0.75×, 1×, 1.25×, 1.5×, 1.75× and 2×.
- Playback speed is saved for later messages.
- Automatic Read aloud after a response is ready, with a configurable delay.
- Response-ready notification sound through `sounds/done.mp3`.
- Cross-tab playback arbitration: if another ChatGPT tab is already reading a message aloud, a newly completed response will not start a second automatic playback on top of it.
- Auto-send after dictation silence is present in the UI and is still being stabilized.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose Load unpacked.
5. Select the `chatgpt-flow` folder.
6. After updating the extension, press Reload on the extension card and refresh open ChatGPT tabs.

The extension runs on:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

## Usage

Open the ChatGPT Flow popup to configure:

- master Flow on/off;
- auto-send after silence;
- silence timeout;
- automatic Read aloud;
- automatic Read aloud delay;
- response-ready sound;
- saved Read aloud speed.

When Flow is enabled, extra playback controls are mounted into assistant-message action rows.

The speed control opens a small direct-selection menu instead of cycling through rates one click at a time.

## Permissions

The extension requests only:

- `storage` — stores local Flow settings such as delays, toggles and playback speed;
- `offscreen` — allows the extension to play the response-ready sound reliably from the extension context.

No separate backend is required.

## Architecture

The project uses Manifest V3.

Main pieces:

- `content.js` — isolated-world bridge between the extension and the page.
- `flow-features.js` — playback state, Read aloud integration, automatic Read aloud, response tracking, dictation/silence logic and cross-tab playback coordination.
- `flow-ui.js` — message-row playback controls and the speed menu.
- `popup.html`, `popup.css`, `popup.js` — extension settings UI.
- `background.js`, `offscreen.html`, `offscreen.js` — background/offscreen support for the ready sound.
- `sounds/done.mp3` — response-ready notification sound.

Playback deliberately reuses ChatGPT's own streamed Read aloud audio instead of implementing a separate TTS backend.

## Current limitations

- Pause / Resume can have a short delay because ChatGPT streams Read aloud audio and may recreate the underlying media stream during resume.
- The extension does not currently cache complete TTS audio locally.
- Auto-send after silence still needs reliability work.
- ChatGPT's DOM and native Read aloud behavior can change, so selectors and integration logic may need maintenance after ChatGPT UI updates.

## Roadmap

- Stabilize auto-send after dictation silence.
- Continue hardening Play / Pause / Resume against ChatGPT Read aloud changes.
- Add per-chat voice preferences so each conversation can remember and use its own selected voice.

## Development

This is a personal workflow project.

Product requirements, UX decisions, real-world testing and acceptance are driven by HAYK19978. Implementation, debugging and iteration are done collaboratively with ChatGPT as an AI coding partner.
