(() => {
  "use strict";

  if (window.__CHATGPT_FLOW_ROW_UI_V0541__) return;
  window.__CHATGPT_FLOW_ROW_UI_V0541__ = true;

  const ROW_SELECTOR = ".turn-action-controls";
  const CONTROL_ATTR = "data-chatgpt-flow-row-controls";
  const SPEED_MENU_ATTR = "data-chatgpt-flow-speed-menu";
  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

  let frame = 0;
  let controlsEnabled = true;
  let speedMenu = null;
  let speedMenuAnchor = null;

  const style = document.createElement("style");
  style.textContent = `
    [${CONTROL_ATTR}] { display: contents !important; }
    html.chatgpt-flow-controls-off [${CONTROL_ATTR}] { display: none !important; }

    [${SPEED_MENU_ATTR}] {
      position: fixed;
      z-index: 2147483647;
      min-width: 94px;
      padding: 6px;
      border-radius: 12px;
      background: var(--main-surface-primary, Canvas);
      color: var(--text-primary, CanvasText);
      box-shadow:
        0 10px 30px rgba(0, 0, 0, .18),
        0 0 0 1px rgba(128, 128, 128, .22);
      font: inherit;
    }

    [${SPEED_MENU_ATTR}] button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-height: 32px;
      padding: 5px 9px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      text-align: left;
    }

    [${SPEED_MENU_ATTR}] button:hover,
    [${SPEED_MENU_ATTR}] button:focus-visible {
      background: rgba(128, 128, 128, .16);
      outline: none;
    }

    [${SPEED_MENU_ATTR}] button[data-selected="true"] {
      font-weight: 650;
    }

    [${SPEED_MENU_ATTR}] .chatgpt-flow-speed-check {
      width: 18px;
      text-align: center;
    }
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
      buttons.find((button) =>
        /^(?:Read aloud|Stop reading aloud)$/i.test(label(button)),
      ) ||
      buttons.find((button) => /^Regenerate response$/i.test(label(button))) ||
      buttons.find((button) => /^Rate response$/i.test(label(button))) ||
      buttons.find((button) => /^Copy$/i.test(label(button))) ||
      null
    );
  }

  function isAssistantRow(row) {
    return nativeButtons(row).some((button) =>
      /^(?:Read aloud|Stop reading aloud|Regenerate response|Rate response)$/i.test(
        label(button),
      ),
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
    button.style.cursor = "pointer";
    button.style.touchAction = "manipulation";
    button.dataset.flowIcon = kind;
    button.appendChild(icon(kind));

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(event);
      schedule();
    });

    return button;
  }

  function closeSpeedMenu() {
    if (speedMenu) speedMenu.remove();
    speedMenu = null;
    speedMenuAnchor = null;
  }

  function positionSpeedMenu() {
    if (!speedMenu || !speedMenuAnchor?.isConnected) {
      closeSpeedMenu();
      return;
    }

    const rect = speedMenuAnchor.getBoundingClientRect();
    const menuRect = speedMenu.getBoundingClientRect();
    const gap = 7;

    let left = rect.left + rect.width / 2 - menuRect.width / 2;
    left = Math.max(8, Math.min(left, innerWidth - menuRect.width - 8));

    let top = rect.top - menuRect.height - gap;
    if (top < 8) top = rect.bottom + gap;

    speedMenu.style.left = `${Math.round(left)}px`;
    speedMenu.style.top = `${Math.round(top)}px`;
  }

  function openSpeedMenu(anchorButton, row) {
    if (speedMenuAnchor === anchorButton && speedMenu) {
      closeSpeedMenu();
      return;
    }

    closeSpeedMenu();

    const state =
      window.__CHATGPT_FLOW_CONTROLLER__?.state?.(row) || { rate: 1 };
    const current = Number(state.rate || 1);

    const menu = document.createElement("div");
    menu.setAttribute(SPEED_MENU_ATTR, "");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Read aloud speed");

    for (const rate of SPEEDS) {
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute(
        "aria-checked",
        Math.abs(rate - current) < 0.001 ? "true" : "false",
      );
      option.dataset.selected =
        Math.abs(rate - current) < 0.001 ? "true" : "false";

      const value = document.createElement("span");
      value.textContent = `${rate}×`;

      const check = document.createElement("span");
      check.className = "chatgpt-flow-speed-check";
      check.textContent =
        Math.abs(rate - current) < 0.001 ? "✓" : "";

      option.append(value, check);

      option.addEventListener("click", (event) => {
        event.stopPropagation();
        window.__CHATGPT_FLOW_CONTROLLER__?.setSpeed?.(rate);
        closeSpeedMenu();
        schedule();
      });

      menu.appendChild(option);
    }

    document.body.appendChild(menu);
    speedMenu = menu;
    speedMenuAnchor = anchorButton;
    positionSpeedMenu();

    const selected = menu.querySelector('[data-selected="true"]');
    selected?.focus({ preventScroll: true });
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
      () => openSpeedMenu(speed, row),
    );

    speed.replaceChildren();
    delete speed.dataset.flowIcon;
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
        playing: false,
        transition: "",
        rate: 1,
      };

    const actuallyPlaying =
      typeof state.playing === "boolean"
        ? state.playing
        : state.active && !state.paused;

    const nextIcon = actuallyPlaying ? "pause" : "play";

    if (group.toggle.dataset.flowIcon !== nextIcon) {
      group.toggle.dataset.flowIcon = nextIcon;
      group.toggle.replaceChildren(icon(nextIcon));
    }

    const toggleTitle = actuallyPlaying
      ? "Pause Read aloud"
      : state.paused || state.transition === "resume"
        ? "Resume Read aloud"
        : "Play Read aloud";

    group.toggle.setAttribute("aria-label", toggleTitle);
    group.toggle.title = toggleTitle;

    const speedText = `${state.rate || 1}×`;
    if (group.speed.textContent !== speedText) {
      group.speed.textContent = speedText;
    }
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
      if (speedMenu) positionSpeedMenu();
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
    if (!controlsEnabled) closeSpeedMenu();
    schedule();
  });

  window.addEventListener("chatgpt-flow-playback-state", schedule);

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!speedMenu) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (speedMenu.contains(target) || speedMenuAnchor?.contains(target)) return;
      closeSpeedMenu();
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") closeSpeedMenu();
    },
    true,
  );

  window.addEventListener("resize", positionSpeedMenu);
  window.addEventListener("scroll", positionSpeedMenu, true);

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
    () => {
      observer.disconnect();
      closeSpeedMenu();
    },
    { once: true },
  );

  window.postMessage(
    { source: "chatgpt-flow-main", type: "request-settings" },
    "*",
  );
})();
