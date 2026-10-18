(() => {
  "use strict";

  if (window.__CHATGPT_FLOW_ROW_UI_V047__) return;
  window.__CHATGPT_FLOW_ROW_UI_V047__ = true;

  const LEGACY_ID = "chatgpt-flow-playback-controls";
  const ROW_SELECTOR = ".turn-action-controls";
  const CONTROL_ATTR = "data-chatgpt-flow-row-controls";
  let activeRow = null;
  let frame = 0;

  const style = document.createElement("style");
  style.textContent = `
    #${LEGACY_ID} { display: none !important; }
    [${CONTROL_ATTR}] { display: contents !important; }
  `;
  (document.head || document.documentElement).appendChild(style);

  function label(button) {
    return (button?.getAttribute("aria-label") || "").trim();
  }

  function legacy() {
    const root = document.getElementById(LEGACY_ID);
    if (!root) return null;
    const buttons = [...root.querySelectorAll("button")];
    return {
      root,
      back: buttons.find((b) => /^Back 15 seconds$/i.test(label(b))),
      toggle: buttons.find((b) => /Read aloud/i.test(label(b)) && !/speed/i.test(label(b)) && !/seconds/i.test(label(b))),
      forward: buttons.find((b) => /^Forward 15 seconds$/i.test(label(b))),
      speed: buttons.find((b) => /^Read aloud speed/i.test(label(b))),
    };
  }

  function nativeReadButton(row) {
    return [...row.querySelectorAll("button")].find(
      (b) => !b.closest(`[${CONTROL_ATTR}]`) && /^Read aloud$/i.test(label(b)),
    ) || null;
  }

  function nativeAnchor(row) {
    const buttons = [...row.querySelectorAll("button")].filter(
      (b) => !b.closest(`[${CONTROL_ATTR}]`),
    );
    return (
      buttons.find((b) => /^Read aloud$/i.test(label(b))) ||
      buttons.find((b) => /^Regenerate response$/i.test(label(b))) ||
      buttons.find((b) => /^Rate response$/i.test(label(b))) ||
      buttons.find((b) => /^Copy$/i.test(label(b))) ||
      null
    );
  }

  function isAssistantRow(row) {
    return [...row.querySelectorAll("button")].some((b) => {
      if (b.closest(`[${CONTROL_ATTR}]`)) return false;
      return /^(?:Read aloud|Regenerate response|Rate response)$/i.test(label(b));
    });
  }

  function actionHost(anchor, row) {
    let node = anchor?.parentElement;
    while (node && node !== row) {
      const nativeButtons = [...node.querySelectorAll("button")].filter(
        (b) => !b.closest(`[${CONTROL_ATTR}]`),
      );
      if (nativeButtons.length >= 2) return node;
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
      svg.innerHTML = '<path d="M7.2 5.15v9.7c0 .55.61.88 1.07.58l6.85-4.45a1.17 1.17 0 0 0 0-1.96L8.27 4.57a.69.69 0 0 0-1.07.58Z" fill="currentColor"/>';
    } else if (kind === "pause") {
      svg.innerHTML = '<path d="M6.75 5v10M13.25 5v10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
    } else {
      const back = kind === "back";
      svg.innerHTML = back
        ? '<path d="M5.35 5.35H2.9V2.9" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.05 5.2A7 7 0 1 1 3.55 14.75" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/><text x="10" y="12.1" text-anchor="middle" fill="currentColor" font-size="6.1" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">15</text>'
        : '<path d="M14.65 5.35h2.45V2.9" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.95 5.2A7 7 0 1 0 16.45 14.75" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/><text x="10" y="12.1" text-anchor="middle" fill="currentColor" font-size="6.1" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">15</text>';
    }
    return svg;
  }

  function makeButton(anchor, aria, kind, click) {
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
      click();
    });
    return button;
  }

  function syncGroup(group, row) {
    const old = legacy();
    const active = row === activeRow;
    const title = old?.toggle?.getAttribute("aria-label") || "Play / pause Read aloud";
    const paused = /^(?:Resume|Play)/i.test(title);
    group.toggle.replaceChildren(icon(active && !paused ? "pause" : "play"));
    group.toggle.setAttribute("aria-label", active ? title : "Play Read aloud");
    group.toggle.title = group.toggle.getAttribute("aria-label");
    const speedText = old?.speed?.textContent?.trim() || "1×";
    group.speed.textContent = speedText;
    group.speed.setAttribute("aria-label", `Read aloud speed: ${speedText}`);
    group.speed.title = group.speed.getAttribute("aria-label");
  }

  function createGroup(row, anchor) {
    const root = document.createElement("span");
    root.setAttribute(CONTROL_ATTR, "");

    const proxy = (name) => {
      const button = legacy()?.[name];
      if (button) button.click();
    };

    const back = makeButton(anchor, "Back 15 seconds", "back", () => proxy("back"));
    const toggle = makeButton(anchor, "Play Read aloud", "play", () => {
      const read = nativeReadButton(row);
      if (row !== activeRow && read) {
        activeRow = row;
        read.click();
      } else {
        proxy("toggle");
      }
      schedule();
    });
    const forward = makeButton(anchor, "Forward 15 seconds", "forward", () => proxy("forward"));
    const speed = makeButton(anchor, "Read aloud speed: 1×", "play", () => proxy("speed"));
    speed.replaceChildren();
    Object.assign(speed.style, {
      fontSize: "11px",
      fontWeight: "600",
      lineHeight: "20px",
      minWidth: "30px",
      paddingInline: "4px",
    });

    root.append(back, toggle, forward, speed);
    root.__flowControls = { root, back, toggle, forward, speed };
    return root;
  }

  function mountRow(row) {
    if (!(row instanceof Element) || !row.isConnected || !isAssistantRow(row)) return;
    const anchor = nativeAnchor(row);
    if (!anchor) return;
    const host = actionHost(anchor, row);
    let root = row.querySelector(`[${CONTROL_ATTR}]`);
    if (!root) root = createGroup(row, anchor);

    // Keep Flow immediately after ChatGPT's native action cluster. It now
    // participates in normal layout and scrolls with the message.
    if (root.parentElement !== host) host.appendChild(root);

    const group = root.__flowControls;
    if (group) {
      for (const button of [group.back, group.toggle, group.forward, group.speed]) {
        if (anchor.className) button.className = anchor.className;
      }
      syncGroup(group, row);
    }
  }

  function mountAll() {
    document.querySelectorAll(ROW_SELECTOR).forEach(mountRow);
    if (activeRow && !activeRow.isConnected) activeRow = null;
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      mountAll();
    });
  }

  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!button || button.closest(`[${CONTROL_ATTR}]`)) return;
    if (/^Read aloud$/i.test(label(button))) {
      activeRow = button.closest(ROW_SELECTOR);
      schedule();
    }
  }, true);

  const observer = new MutationObserver(schedule);
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    mountAll();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
})();
