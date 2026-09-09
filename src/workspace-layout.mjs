/** Desktop workspace splitters. Resize changes only layout, never document state. */
import { initMovablePanels } from "./workspace-panels.mjs";
export const WORKSPACE_STORAGE_KEY = "stykanimate.workspace.v1";

const clamp = (value, min, max) =>
  Math.min(Math.max(value, min), Math.max(min, max));
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/** Portable, bounded preference schema shared by browser and native persistence. */
export function normalizeWorkspacePreferences(input) {
  const preferences = {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    return preferences;
  for (const name of ["left", "right", "timeline"]) {
    if (Number.isFinite(input[name]) && input[name] > 0)
      preferences[name] = input[name];
  }
  if (
    input.floating &&
    typeof input.floating === "object" &&
    !Array.isArray(input.floating)
  ) {
    const floating = {};
    for (const name of ["left", "right", "timeline"]) {
      const source = input.floating[name];
      if (!source || typeof source !== "object" || Array.isArray(source))
        continue;
      const rect = {};
      for (const key of ["x", "y", "width", "height"]) {
        if (
          Number.isFinite(source[key]) &&
          (key === "x" || key === "y" || source[key] > 0)
        )
          rect[key] = source[key];
      }
      floating[name] = rect;
    }
    if (Object.keys(floating).length) preferences.floating = floating;
  }
  return preferences;
}

/** Pure layout constraint solver, shared with tests. Preferences survive compact windows. */
export function constrainWorkspace(
  preferences = {},
  width,
  height,
  viewportHeight = height + 80,
  { minTimelineHeight = 135 } = {},
) {
  width = Math.max(0, finite(width, 0));
  height = Math.max(0, finite(height, 0));
  const compact = width <= 1200;
  const narrow = width <= 960;
  const defaults = {
    left: narrow ? 170 : compact ? 190 : 224,
    right: narrow ? 210 : compact ? 225 : 256,
    timeline: viewportHeight <= 720 ? 193 : 242,
  };
  const stageMin = Math.min(
    width,
    width >= 1100 ? 420 : width >= 960 ? 360 : width >= 760 ? 300 : 240,
  );
  const available = Math.max(0, width - stageMin);
  let minLeft = width < 760 ? 140 : 170;
  let minRight = width < 760 ? 180 : 210;
  const floatingLeft = Boolean(preferences.floating?.left),
    floatingRight = Boolean(preferences.floating?.right);
  if (floatingLeft) minLeft = 0;
  if (floatingRight) minRight = 0;
  if (minLeft + minRight > available) {
    const ratio = available / (minLeft + minRight);
    minLeft *= ratio;
    minRight *= ratio;
  }
  let left = floatingLeft
    ? 0
    : clamp(finite(preferences.left, defaults.left), minLeft, 420);
  let right = floatingRight
    ? 0
    : clamp(finite(preferences.right, defaults.right), minRight, 420);
  const excess = left + right - available;
  if (excess > 0) {
    const capacity = left + right - minLeft - minRight;
    if (capacity > 0) {
      const share = (left - minLeft) / capacity;
      left -= excess * share;
      right -= excess * (1 - share);
    } else {
      left = minLeft;
      right = minRight;
    }
  }
  // Avoid a negative stage from sub-pixel floating-point residue at zero width.
  left = Math.max(0, left);
  right = Math.max(0, Math.min(right, available - left));
  // Keep 160 px for posing plus the 47 px canvas toolbar whenever the window permits it.
  const maxTimeline = Math.max(0, Math.min(viewportHeight * 0.6, height - 207));
  const minTimeline = Math.min(minTimelineHeight, maxTimeline);
  const timeline = preferences.floating?.timeline
    ? 0
    : clamp(
        finite(preferences.timeline, defaults.timeline),
        minTimeline,
        maxTimeline,
      );
  return {
    left,
    right,
    timeline,
    stage: width - left - right,
    limits: {
      left: [minLeft, Math.min(420, available - right)],
      right: [minRight, Math.min(420, available - left)],
      timeline: [minTimeline, maxTimeline],
    },
  };
}

const STYLE = `
.workspace.styk-resizable { position:relative; }
.styk-resizable > .center { position:relative; min-width:0; }
.styk-resizable .timeline-panel { resize:none; min-height:0; max-height:none; }
.styk-workspace-splitter { position:absolute; z-index:20; touch-action:none; user-select:none; outline:none; }
.styk-workspace-splitter[data-axis="x"] { top:0; bottom:0; width:7px; margin-left:-3px; cursor:col-resize; }
.styk-workspace-splitter[data-axis="y"] { left:0; right:0; height:7px; margin-top:-3px; cursor:row-resize; }
.styk-workspace-splitter::after { content:""; position:absolute; background:transparent; transition:background 100ms; }
.styk-workspace-splitter[data-axis="x"]::after { top:0; bottom:0; left:3px; width:1px; }
.styk-workspace-splitter[data-axis="y"]::after { left:0; right:0; top:3px; height:1px; }
.styk-workspace-splitter:hover::after,.styk-workspace-splitter:focus-visible::after,.styk-workspace-splitter[data-dragging]::after { background:#0d99ff; }
.styk-workspace-splitter:focus-visible { outline:1px solid #80caff; outline-offset:-1px; }
body.styk-resizing-x,body.styk-resizing-x * { cursor:col-resize !important; user-select:none !important; }
body.styk-resizing-y,body.styk-resizing-y * { cursor:row-resize !important; user-select:none !important; }
`;

export function initWorkspaceLayout({
  onResize,
  root = document,
  storage,
  preferences: initialPreferences,
  onPersist,
  onPersistError,
} = {}) {
  const workspace = root.querySelector(".workspace");
  const leftPanel = workspace?.querySelector(".left-panel");
  const rightPanel = workspace?.querySelector(".right-panel");
  const center = workspace?.querySelector(".center");
  const timeline = center?.querySelector(".timeline-panel");
  if (!workspace || !leftPanel || !rightPanel || !center || !timeline) {
    throw new Error(
      "Workspace panels must exist before initializing their layout.",
    );
  }
  if (workspace._stykLayout) return workspace._stykLayout;
  const doc = workspace.ownerDocument;
  const win = doc.defaultView;
  if (storage === undefined) {
    try {
      storage = win.localStorage;
    } catch {
      storage = null;
    }
  }
  const previous = {
    left: leftPanel.style.width,
    right: rightPanel.style.width,
    timeline: timeline.style.height,
  };
  let preferences = {};
  try {
    const stored =
      initialPreferences !== undefined
        ? initialPreferences
        : JSON.parse(storage?.getItem(WORKSPACE_STORAGE_KEY) || "null");
    preferences = normalizeWorkspacePreferences(stored);
  } catch {
    /* A blocked or stale preference store must not prevent editing. */
  }
  const style = doc.createElement("style");
  style.dataset.stykWorkspaceStyle = "";
  style.textContent = STYLE;
  doc.head.append(style);
  workspace.classList.add("styk-resizable");
  let sizes,
    gesture = null,
    destroyed = false,
    movable;
  let persistTimer = null,
    pendingPreferences = null,
    persistChain = Promise.resolve(true),
    persistenceError = null;
  const abort = new AbortController();
  const splitters = {};
  const panels = { left: leftPanel, right: rightPanel, timeline };
  for (const [name, label, axis] of [
    ["left", "Resize layers panel", "x"],
    ["right", "Resize properties panel", "x"],
    ["timeline", "Resize timeline", "y"],
  ]) {
    const splitter = doc.createElement("div");
    splitter.className = "styk-workspace-splitter";
    splitter.dataset.panel = name;
    splitter.dataset.axis = axis;
    splitter.tabIndex = 0;
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-label", label);
    splitter.setAttribute(
      "aria-orientation",
      axis === "x" ? "vertical" : "horizontal",
    );
    splitter.setAttribute(
      "aria-keyshortcuts",
      axis === "x"
        ? "ArrowLeft ArrowRight Home End"
        : "ArrowUp ArrowDown Home End",
    );
    splitter.title = `${label} · Drag or use arrow keys · Double-click to reset`;
    if (!panels[name].id) panels[name].id = `styk-${name}-panel`;
    splitter.setAttribute("aria-controls", panels[name].id);
    (name === "timeline" ? center : workspace).append(splitter);
    splitters[name] = splitter;
  }
  function persist() {
    const snapshot = normalizeWorkspacePreferences(preferences);
    try {
      storage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      /* Optional preference persistence. */
    }
    if (typeof onPersist === "function") {
      pendingPreferences = snapshot;
      if (persistTimer !== null) win.clearTimeout(persistTimer);
      // Only settled gestures call persist; coalesce adjacent key presses/dock actions.
      persistTimer = win.setTimeout(flushPreferences, 200);
    }
  }
  function flushPreferences() {
    if (persistTimer !== null) {
      win.clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!pendingPreferences) return persistChain;
    const snapshot = pendingPreferences;
    pendingPreferences = null;
    // Keep asynchronous native writes ordered even if a later edit settles first.
    persistChain = persistChain.then(async () => {
      try {
        await onPersist(snapshot);
        persistenceError = null;
        return true;
      } catch (error) {
        persistenceError = error;
        try {
          onPersistError?.(error);
        } catch {
          /* Error reporting cannot stop later saves. */
        }
        workspace.dispatchEvent(
          new CustomEvent("styk-workspace-persistence-error", {
            detail: { message: error?.message || String(error) },
          }),
        );
        return false;
      }
    });
    return persistChain;
  }
  function apply() {
    if (destroyed) return;
    const width = workspace.clientWidth,
      height = workspace.clientHeight;
    const css = win.getComputedStyle(workspace),
      resolved = { ...preferences };
    for (const [name, key] of [
      ["left", "--workspace-left-width"],
      ["right", "--workspace-right-width"],
      ["timeline", "--workspace-timeline-height"],
    ]) {
      const value = parseFloat(css.getPropertyValue(key));
      if (
        Number.isFinite(value) &&
        resolved[name] === undefined &&
        (name === "timeline" ? win.innerHeight > 720 : width > 1200)
      )
        resolved[name] = value;
    }
    const next = constrainWorkspace(resolved, width, height, win.innerHeight, {
      minTimelineHeight: timeline.classList.contains("simple-mode") ? 205 : 135,
    });
    const changed =
      !sizes ||
      ["left", "right", "timeline", "stage"].some(
        (key) => sizes[key] !== next[key],
      );
    sizes = next;
    if (!preferences.floating?.left) leftPanel.style.width = `${next.left}px`;
    if (!preferences.floating?.right)
      rightPanel.style.width = `${next.right}px`;
    if (!preferences.floating?.timeline)
      timeline.style.height = `${next.timeline}px`;
    splitters.left.style.left = `${next.left}px`;
    splitters.right.style.left = `${width - next.right}px`;
    splitters.timeline.style.top = `${height - next.timeline}px`;
    for (const [name, splitter] of Object.entries(splitters)) {
      splitter.hidden = Boolean(preferences.floating?.[name]);
      splitter.setAttribute("aria-valuenow", String(Math.round(next[name])));
      splitter.setAttribute(
        "aria-valuemin",
        String(Math.round(next.limits[name][0])),
      );
      splitter.setAttribute(
        "aria-valuemax",
        String(Math.round(next.limits[name][1])),
      );
      splitter.setAttribute(
        "aria-valuetext",
        `${Math.round(next[name])} pixels`,
      );
    }
    movable?.update();
    if (changed) onResize?.({ ...next });
  }
  function setSize(name, value) {
    preferences[name] = clamp(value, ...sizes.limits[name]);
    apply();
  }
  function endGesture(cancel = false) {
    if (!gesture) return;
    const { splitter, pointerId, baseline } = gesture;
    gesture = null;
    if (cancel) {
      preferences = baseline;
      apply();
    } else persist();
    delete splitter.dataset.dragging;
    doc.body.classList.remove("styk-resizing-x", "styk-resizing-y");
    if (splitter.hasPointerCapture(pointerId))
      splitter.releasePointerCapture(pointerId);
  }
  for (const [name, splitter] of Object.entries(splitters)) {
    const axis = splitter.dataset.axis;
    const sign = name === "left" ? 1 : -1;
    splitter.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || gesture) return;
        event.preventDefault();
        event.stopPropagation();
        splitter.focus({ preventScroll: true });
        gesture = {
          splitter,
          pointerId: event.pointerId,
          start: axis === "x" ? event.clientX : event.clientY,
          size: sizes[name],
          baseline: { ...preferences },
        };
        splitter.setPointerCapture(event.pointerId);
        splitter.dataset.dragging = "";
        doc.body.classList.add(`styk-resizing-${axis}`);
      },
      { signal: abort.signal },
    );
    splitter.addEventListener(
      "pointermove",
      (event) => {
        if (
          gesture?.splitter !== splitter ||
          gesture.pointerId !== event.pointerId
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const position = axis === "x" ? event.clientX : event.clientY;
        setSize(name, gesture.size + (position - gesture.start) * sign);
      },
      { signal: abort.signal },
    );
    splitter.addEventListener(
      "pointerup",
      (event) => {
        if (gesture?.pointerId === event.pointerId) endGesture();
      },
      { signal: abort.signal },
    );
    splitter.addEventListener("pointercancel", () => endGesture(true), {
      signal: abort.signal,
    });
    splitter.addEventListener("lostpointercapture", () => endGesture(), {
      signal: abort.signal,
    });
    splitter.addEventListener(
      "dblclick",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        delete preferences[name];
        apply();
        persist();
      },
      { signal: abort.signal },
    );
    splitter.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && gesture) {
          event.preventDefault();
          event.stopPropagation();
          endGesture(true);
          return;
        }
        const negative = axis === "x" ? "ArrowLeft" : "ArrowUp";
        const positive = axis === "x" ? "ArrowRight" : "ArrowDown";
        let next;
        if (event.key === negative || event.key === positive)
          next =
            sizes[name] +
            (event.key === positive ? 1 : -1) *
              sign *
              (event.shiftKey ? 1 : 10);
        else if (event.key === "Home") next = sizes.limits[name][0];
        else if (event.key === "End") next = sizes.limits[name][1];
        else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          delete preferences[name];
          apply();
          persist();
          return;
        } else return;
        event.preventDefault();
        event.stopPropagation();
        setSize(name, next);
        persist();
      },
      { signal: abort.signal },
    );
  }
  win.addEventListener("blur", () => endGesture(true), {
    signal: abort.signal,
  });
  win.addEventListener("resize", apply, { signal: abort.signal });
  win.addEventListener(
    "pagehide",
    () => {
      void flushPreferences();
    },
    { signal: abort.signal },
  );
  movable = initMovablePanels({
    workspace,
    panels,
    getPreferences: () => preferences,
    setPreferences: (value) => {
      preferences = value;
    },
    apply,
    persist,
  });
  const observer = new ResizeObserver(apply);
  observer.observe(workspace);
  let simpleMode = timeline.classList.contains("simple-mode");
  const modeObserver = new MutationObserver(() => {
    const next = timeline.classList.contains("simple-mode");
    if (next !== simpleMode) {
      simpleMode = next;
      apply();
    }
  });
  modeObserver.observe(timeline, {
    attributes: true,
    attributeFilter: ["class"],
  });
  apply();
  const api = {
    get preferences() {
      return normalizeWorkspacePreferences(preferences);
    },
    get persistenceError() {
      return persistenceError;
    },
    flushPreferences,
    get sizes() {
      return structuredClone(sizes);
    },
    get floating() {
      return movable.positions;
    },
    float(name) {
      movable.float(name);
    },
    dock(name) {
      movable.dock(name);
    },
    reset() {
      endGesture(true);
      movable.cancel();
      preferences = {};
      apply();
      persist();
    },
    destroy() {
      endGesture(true);
      movable.destroy();
      void flushPreferences();
      destroyed = true;
      abort.abort();
      observer.disconnect();
      modeObserver.disconnect();
      for (const splitter of Object.values(splitters)) splitter.remove();
      style.remove();
      workspace.classList.remove("styk-resizable");
      leftPanel.style.width = previous.left;
      rightPanel.style.width = previous.right;
      timeline.style.height = previous.timeline;
      delete workspace._stykLayout;
    },
  };
  workspace._stykLayout = api;
  return api;
}
