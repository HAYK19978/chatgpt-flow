(() => {
  "use strict";

  if (window.__CHATGPT_FLOW_ROW_UI_V053__) return;
  window.__CHATGPT_FLOW_ROW_UI_V053__ = true;

  const ROW_SELECTOR = ".turn-action-controls";
  const CONTROL_ATTR = "data-chatgpt-flow-row-controls";
  let frame = 0;
  let controlsEnabled = true;

  const style = document.createElement("style");
  style.textContent = `
    [${CONTROL_ATTR}] { display: contents !important; }
    html.chatgpt-flow-controls-off [${CONTROL_ATTR}] { display: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);

  function label(button) {
    return (button?.getAttribute("aria-label") || "").trim();
  }

  function nativeButtons(row) {
    return [...row.querySelectorAll("button")].filter(
      (button) => !button.closest(`[${CONTROL_ATTR}]`),
    );
  }

  function nativeAnchor(row) {
    const buttons = nativeButtons(row);
    return (
      buttons.find((button) => /^Read aloud$/i.test(label(button))) ||
      buttons.find((button) => /^Regenerate response$/i.test(label(button))) ||
      buttons.find((button) => /^Rate response$/i.test(label(button))) ||
      buttons.find((button) => /^Copy$/i.test(label(button))) ||
      null
    );
  }

  function isAssistantRow(row) {
    return nativeButtons(row).some((button) =>
      /^(?:Read aloud|Regenerate response|Rate response)$/i.test(label(button)),
    );
  }

  function actionHost(anchor, row) {
    let node = anchor?.parentElement;

    while (node && node !== row) {
      const count = [...node.querySelectorAll("button")].filter(
        (button) => !button.closest(`[${CONTROL_ATTR}]`),
      ).length;

      if (count >= 2) return node;
      node = node.parentElement;
    }

    return row;
  }

  function icon(kind) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");

    if (kind === "play") {
      svg.innerHTML =
        '<path d="M7.2 5.15v9.7c0 .55.61.88 1.07.58l6.85-4.45a1.17 1.17 0 0 0 0-1.96L8.27 4.57a.69.69 0 0 0-1.07.58Z" fill="currentColor"/>';
    } else if (kind === "pause") {
      svg.innerHTML =
        '<path d="M6.75 5v10M13.25 5v10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
    } else {
      const back = kind === "back";
      svg.innerHTML = back
        ? '<path d="M5.35 5.35H2.9V2.9" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.05 5.2A7 7 0 1 1 3.55 14.75" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/><text x="10" y="12.1" text-anchor="middle" fill="currentColor" font-size="6.1" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">15</text>'
        : '<path d="M14.65 5.35h2.45V2.9" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.95 5.2A7 7 0 1 0 16.45 14.75" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/><text x="10" y="12.1" text-anchor="middle" fill="currentColor" font-size="6.1" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">15</text>';
    }

    return svg;
  }

  function makeButton(anchor, aria, kind, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = anchor?.className || "";
    button.setAttribute("aria-label", aria);
    button.title = aria;
    button.style.margin = "0";
    button.style.flex = "0 0 auto";
    button.appendChild(icon(kind));

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
      schedule();
    });

    return button;
  }

  function createGroup(row, anchor) {
    const root = document.createElement("span");
    root.setAttribute(CONTROL_ATTR, "");
    root.setAttribute("data-chatgpt-flow", "playback-controls");

    const back = makeButton(
      anchor,
      "Back 15 seconds",
      "back",
      () => window.__CHATGPT_FLOW_CONTROLLER__?.seekBack?.(row),
    );

    const toggle = makeButton(
      anchor,
      "Play Read aloud",
      "play",
      () => window.__CHATGPT_FLOW_CONTROLLER__?.toggle?.(row),
    );

    const forward = makeButton(
      anchor,
      "Forward 15 seconds",
      "forward",
      () => window.__CHATGPT_FLOW_CONTROLLER__?.seekForward?.(row),
    );

    const speed = makeButton(
      anchor,
      "Read aloud speed: 1×",
      "play",
      () => window.__CHATGPT_FLOW_CONTROLLER__?.cycleSpeed?.(),
    );

    speed.replaceChildren();
    Object.assign(speed.style, {
      fontSize: "11px",
      fontWeight: "600",
      lineHeight: "20px",
      minWidth: "30px",
      paddingInline: "4px",
    });

    root.append(back, toggle, forward, speed);
    root.__flowControls = { back, toggle, forward, speed };
    return root;
  }

  function syncGroup(root, row, anchor) {
    const group = root.__flowControls;
    if (!group) return;

    for (const button of [
      group.back,
      group.toggle,
      group.forward,
      group.speed,
    ]) {
      if (anchor.className) button.className = anchor.className;
    }

    const state =
      window.__CHATGPT_FLOW_CONTROLLER__?.state?.(row) || {
        active: false,
        paused: false,
        rate: 1,
      };

    group.toggle.replaceChildren(
      icon(state.active && !state.paused ? "pause" : "play"),
    );

    const toggleTitle = state.active
      ? state.paused
        ? "Resume Read aloud"
        : "Pause Read aloud"
      : "Play Read aloud";

    group.toggle.setAttribute("aria-label", toggleTitle);
    group.toggle.title = toggleTitle;

    const speedText = `${state.rate || 1}×`;
    group.speed.textContent = speedText;
    group.speed.setAttribute("aria-label", `Read aloud speed: ${speedText}`);
    group.speed.title = group.speed.getAttribute("aria-label");
  }

  function mountRow(row) {
    if (
      !(row instanceof Element) ||
      !row.isConnected ||
      !isAssistantRow(row)
    ) {
      return;
    }

    const anchor = nativeAnchor(row);
    if (!anchor) return;

    const host = actionHost(anchor, row);
    let root = row.querySelector(`[${CONTROL_ATTR}]`);

    if (!root) root = createGroup(row, anchor);
    if (root.parentElement !== host) host.appendChild(root);

    syncGroup(root, row, anchor);
  }

  function mountAll() {
    document.documentElement.classList.toggle(
      "chatgpt-flow-controls-off",
      !controlsEnabled,
    );

    if (!controlsEnabled) return;
    document.querySelectorAll(ROW_SELECTOR).forEach(mountRow);
  }

  function schedule() {
    if (frame) return;

    frame = requestAnimationFrame(() => {
      frame = 0;
      mountAll();
    });
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.source !== "chatgpt-flow-extension" ||
      event.data?.type !== "settings"
    ) {
      return;
    }

    controlsEnabled = event.data.settings?.enabled !== false;
    schedule();
  });

  window.addEventListener("chatgpt-flow-playback-state", schedule);

  const observer = new MutationObserver(schedule);

  const start = () => {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    mountAll();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  window.addEventListener(
    "pagehide",
    () => observer.disconnect(),
    { once: true },
  );

  window.postMessage(
    { source: "chatgpt-flow-main", type: "request-settings" },
    "*",
  );
})();
