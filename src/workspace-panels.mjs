/** Floating panel interaction; no animation loop or document edits. */
const clamp = (value, min, max) =>
  Math.min(Math.max(value, min), Math.max(min, max));
export function constrainFloatingPanel(
  rect,
  name,
  width,
  height,
  { minTimelineHeight = 150 } = {},
) {
  const margin = Math.min(8, width / 2, height / 2);
  const maxWidth = Math.max(0, width - margin * 2),
    maxHeight = Math.max(0, height - margin * 2);
  const w = clamp(
    Number.isFinite(rect.width) ? rect.width : name === "timeline" ? 760 : 280,
    Math.min(name === "timeline" ? 420 : 220, maxWidth),
    maxWidth,
  );
  const h = clamp(
    Number.isFinite(rect.height)
      ? rect.height
      : name === "timeline"
        ? 260
        : 520,
    Math.min(name === "timeline" ? minTimelineHeight : 240, maxHeight),
    maxHeight,
  );
  return {
    x: clamp(Number.isFinite(rect.x) ? rect.x : 24, margin, width - w - margin),
    y: clamp(
      Number.isFinite(rect.y) ? rect.y : 24,
      margin,
      height - h - margin,
    ),
    width: w,
    height: h,
  };
}

const icon = (path) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.25">${path}</svg>`;
const floatIcon = icon(
  '<path d="M9 2h5v5M14 2 7 9"/><path d="M6 3H3v10h10v-3"/>',
);
const dockIcon = icon(
  '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M6 2v12M12 8H8m2-2-2 2 2 2"/>',
);
const gripIcon =
  '<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true"><circle cx="2" cy="3" r=".9"/><circle cx="6" cy="3" r=".9"/><circle cx="2" cy="7" r=".9"/><circle cx="6" cy="7" r=".9"/><circle cx="2" cy="11" r=".9"/><circle cx="6" cy="11" r=".9"/></svg>';
const STYLE = `
.styk-panel-controls {display:inline-flex;align-items:center;gap:0;flex-shrink:0;margin-left:auto;}
.styk-panel-controls button {padding:0;color:#777;border-radius:3px;height:22px;flex-shrink:0;}
.styk-panel-drag-handle {width:14px;cursor:grab;touch-action:none;}
.styk-panel-toggle {width:22px;}
.styk-panel-controls button:hover {background:#eee;color:#333;}
.panel-tabs:has(.styk-panel-controls) {gap:4px;padding-right:6px;padding-left:6px;}
.panel-tabs > .styk-panel-controls {margin-left:0;}
.panel-tabs > .panel-add {margin-left:auto;width:22px;}
.timeline-toolbar > .styk-panel-controls {margin-left:4px;}
[data-workspace-drag-handle] {cursor:grab;touch-action:none;}
.styk-resizable .styk-floating-panel {position:fixed;flex:none;max-width:none;min-width:0;min-height:0;max-height:none;overflow:visible;border:1px solid #d5d5d5;border-radius:7px;background:#fff;box-shadow:0 8px 30px #00000020,0 1px 5px #00000012;z-index:30;}
.styk-floating-panel > .panel-tabs,.styk-floating-panel > .timeline-toolbar {border-radius:6px 6px 0 0;background:#fafafa;}
.styk-floating-panel > .panel-bottom,.styk-floating-panel > .timeline-footer,.styk-floating-panel > .right-footer {border-radius:0 0 6px 6px;}
.styk-floating-panel > #layers-view,.styk-floating-panel > #assets-view,.styk-floating-panel > #inspector {min-height:0;overflow:auto;}
.styk-panel-resize-edge {display:none;position:absolute;touch-action:none;z-index:2;}
.styk-floating-panel > .styk-panel-resize-edge {display:block;}
.styk-panel-resize-edge[data-edge=n],.styk-panel-resize-edge[data-edge=s] {height:7px;left:7px;right:7px;cursor:ns-resize;}
.styk-panel-resize-edge[data-edge=n] {top:-4px;}.styk-panel-resize-edge[data-edge=s] {bottom:-4px;}
.styk-panel-resize-edge[data-edge=e],.styk-panel-resize-edge[data-edge=w] {width:7px;top:7px;bottom:7px;cursor:ew-resize;}
.styk-panel-resize-edge[data-edge=e] {right:-4px;}.styk-panel-resize-edge[data-edge=w] {left:-4px;}
.styk-panel-resize-edge[data-edge=ne],.styk-panel-resize-edge[data-edge=nw],.styk-panel-resize-edge[data-edge=se],.styk-panel-resize-edge[data-edge=sw] {width:12px;height:12px;}
.styk-panel-resize-edge[data-edge=ne] {right:-4px;top:-4px;cursor:nesw-resize;}.styk-panel-resize-edge[data-edge=nw] {left:-4px;top:-4px;cursor:nwse-resize;}
.styk-panel-resize-edge[data-edge=se] {right:-4px;bottom:-4px;cursor:nwse-resize;}.styk-panel-resize-edge[data-edge=sw] {left:-4px;bottom:-4px;cursor:nesw-resize;}
.styk-panel-dock-zone {position:absolute;pointer-events:none;z-index:100000;border:1px dashed #0d99ff;background:#e5f4ffdd;color:#0577c4;border-radius:5px;display:grid;place-items:center;font-size:11px;font-weight:550;}
.styk-floating-panel.timeline-panel {container-type:inline-size;}
@container (max-width:600px) {.styk-floating-panel.timeline-panel .timeline-title,.styk-floating-panel.timeline-panel .fps-control,.styk-floating-panel.timeline-panel .timeline-actions {display:none;}.styk-floating-panel.timeline-panel .playback-controls {margin:0;}.styk-floating-panel.timeline-panel .styk-panel-controls {margin-left:auto;}}
.styk-panel-dock-zone[data-active] {background:#c9eaffee;border:2px solid #0d99ff;}
body.styk-moving-panel,body.styk-moving-panel * {cursor:grabbing !important;user-select:none !important;}
`;

export function initMovablePanels({
  workspace,
  panels,
  getPreferences,
  setPreferences,
  apply,
  persist,
}) {
  const doc = workspace.ownerDocument,
    win = doc.defaultView,
    abort = new AbortController();
  const limitFloatingPanel = (rect, name, width, height) =>
    constrainFloatingPanel(rect, name, width, height, {
      minTimelineHeight: panels.timeline.classList.contains("simple-mode")
        ? 205
        : 150,
    });
  const labels = { left: "Layers", right: "Properties", timeline: "Timeline" };
  const original = new Map(
    Object.values(panels).map((panel) => [panel, panel.getAttribute("style")]),
  );
  const controls = {},
    edges = [],
    sizes = {},
    headers = {};
  const style = doc.createElement("style");
  style.dataset.stykFloatingStyle = "";
  style.textContent = STYLE;
  doc.head.append(style);
  const zone = doc.createElement("div");
  zone.className = "styk-panel-dock-zone";
  zone.hidden = true;
  workspace.append(zone);
  let gesture = null,
    z = 30;
  const isFloating = (name) => Boolean(getPreferences().floating?.[name]);
  const storeRect = (name, rect) => {
    const prefs = getPreferences();
    prefs.floating ||= {};
    prefs.floating[name] = { ...rect };
  };
  function defaultRect(name) {
    const rect = panels[name].getBoundingClientRect(),
      width = workspace.clientWidth,
      height = workspace.clientHeight;
    const w =
      name === "timeline"
        ? Math.min(760, width - 32)
        : Math.max(260, rect.width);
    return limitFloatingPanel(
      {
        x:
          name === "right"
            ? width - w - 24
            : name === "timeline"
              ? (width - w) / 2
              : 24,
        y: name === "timeline" ? height - 300 : 24,
        width: w,
        height: name === "timeline" ? 260 : Math.min(560, height - 48),
      },
      name,
      width,
      height,
    );
  }
  function float(name, rect) {
    if (!panels[name]) throw new Error("Unknown workspace panel.");
    storeRect(
      name,
      rect ||
        (isFloating(name)
          ? getPreferences().floating[name]
          : defaultRect(name)),
    );
    panels[name].style.zIndex = String(++z);
    apply();
    persist();
  }
  function dock(name) {
    if (!panels[name]) throw new Error("Unknown workspace panel.");
    if (getPreferences().floating) delete getPreferences().floating[name];
    apply();
    persist();
  }
  function dockZone(name) {
    const w = workspace.clientWidth,
      h = workspace.clientHeight;
    return name === "timeline"
      ? {
          x: Math.max(12, w * 0.25),
          y: h - 64,
          width: Math.max(0, w * 0.5),
          height: 52,
        }
      : {
          x: name === "left" ? 12 : w - 108,
          y: Math.max(12, (h - 200) / 2),
          width: 96,
          height: Math.min(200, h - 24),
        };
  }
  function showZone(name, clientX, clientY) {
    const r = dockZone(name),
      base = workspace.getBoundingClientRect();
    Object.assign(zone.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    zone.textContent = `Dock ${labels[name].toLowerCase()}`;
    zone.hidden = false;
    const x = clientX - base.x,
      y = clientY - base.y,
      hit = x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    zone.toggleAttribute("data-active", hit);
    return hit;
  }
  function finish(cancel = false) {
    if (!gesture) return;
    const active = gesture;
    gesture = null;
    if (cancel) {
      setPreferences(active.baseline);
      apply();
    } else if (active.kind === "move" && active.moved && active.dock)
      dock(active.name);
    else persist();
    zone.hidden = true;
    doc.body.classList.remove("styk-moving-panel");
    doc.body.style.cursor = "";
    if (active.target.hasPointerCapture(active.id))
      active.target.releasePointerCapture(active.id);
  }
  function begin(event, name, kind, edge = "") {
    if (event.button !== 0 || gesture) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget,
      rect = panels[name].getBoundingClientRect();
    gesture = {
      name,
      kind,
      edge,
      target,
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      rect: { ...sizes[name] },
      panelRect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      baseline: structuredClone(getPreferences()),
      wasFloating: isFloating(name),
      moved: false,
    };
    target.setPointerCapture(event.pointerId);
    if (target.tabIndex >= 0) target.focus({ preventScroll: true });
    panels[name].style.zIndex = String(++z);
  }
  function move(event) {
    const g = gesture;
    if (!g || g.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - g.x,
      dy = event.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    if (!g.moved) {
      g.moved = true;
      if (g.kind === "move") {
        doc.body.classList.add("styk-moving-panel");
        if (!g.wasFloating) {
          const base = workspace.getBoundingClientRect(),
            initial = defaultRect(g.name);
          initial.x =
            g.x - base.x - Math.min(g.x - g.panelRect.x, initial.width - 30);
          initial.y = g.y - base.y - Math.min(g.y - g.panelRect.y, 30);
          g.rect = initial;
          storeRect(g.name, initial);
        }
      }
    }
    const rect = { ...g.rect };
    if (g.kind === "move") {
      rect.x += dx;
      rect.y += dy;
      g.dock = showZone(g.name, event.clientX, event.clientY);
    } else {
      if (g.edge.includes("e")) rect.width += dx;
      if (g.edge.includes("s")) rect.height += dy;
      if (g.edge.includes("w")) {
        rect.x += dx;
        rect.width -= dx;
      }
      if (g.edge.includes("n")) {
        rect.y += dy;
        rect.height -= dy;
      }
      const limited = limitFloatingPanel(
        rect,
        g.name,
        workspace.clientWidth,
        workspace.clientHeight,
      );
      if (g.edge.includes("w"))
        limited.x = g.rect.x + g.rect.width - limited.width;
      if (g.edge.includes("n"))
        limited.y = g.rect.y + g.rect.height - limited.height;
      Object.assign(rect, limited);
    }
    storeRect(
      g.name,
      limitFloatingPanel(
        rect,
        g.name,
        workspace.clientWidth,
        workspace.clientHeight,
      ),
    );
    apply();
  }
  function bindPointer(target, name, kind, edge = "") {
    target.addEventListener(
      "pointerdown",
      (event) => begin(event, name, kind, edge),
      { signal: abort.signal },
    );
    target.addEventListener("pointermove", move, { signal: abort.signal });
    target.addEventListener(
      "pointerup",
      (event) => {
        if (gesture?.id === event.pointerId) finish();
      },
      { signal: abort.signal },
    );
    target.addEventListener("pointercancel", () => finish(true), {
      signal: abort.signal,
    });
    target.addEventListener("lostpointercapture", () => finish(), {
      signal: abort.signal,
    });
  }
  for (const [name, panel] of Object.entries(panels)) {
    panel.dataset.workspacePanel = name;
    const header = panel.querySelector(
      name === "timeline" ? ".timeline-toolbar" : ".panel-tabs",
    );
    headers[name] = header;
    const box = doc.createElement("span");
    box.className = "styk-panel-controls";
    const grip = doc.createElement("button");
    grip.type = "button";
    grip.className = "styk-panel-drag-handle";
    grip.dataset.panelMove = name;
    grip.innerHTML = gripIcon;
    grip.setAttribute("aria-label", `Move ${labels[name].toLowerCase()} panel`);
    grip.title =
      "Drag to move panel · Arrow keys to move · Enter to dock · Home to reset";
    grip.setAttribute(
      "aria-keyshortcuts",
      "ArrowLeft ArrowRight ArrowUp ArrowDown Enter Home",
    );
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "styk-panel-toggle";
    toggle.dataset.panelToggle = name;
    box.append(grip, toggle);
    header.append(box);
    controls[name] = { box, grip, toggle };
    toggle.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        isFloating(name) ? dock(name) : float(name);
      },
      { signal: abort.signal },
    );
    bindPointer(grip, name, "move");
    // The empty header/title is draggable; interactive tabs and animation controls retain their behavior.
    header.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target.closest("button,input,select,a,[role=button]")) return;
        begin(event, name, "move");
      },
      { signal: abort.signal },
    );
    header.addEventListener("pointermove", move, { signal: abort.signal });
    header.addEventListener("pointerup", () => finish(), {
      signal: abort.signal,
    });
    header.addEventListener("pointercancel", () => finish(true), {
      signal: abort.signal,
    });
    header.addEventListener("lostpointercapture", () => finish(), {
      signal: abort.signal,
    });
    header.addEventListener(
      "dblclick",
      (event) => {
        if (!event.target.closest("button,input,select")) {
          event.preventDefault();
          event.stopPropagation();
          isFloating(name) ? dock(name) : float(name);
        }
      },
      { signal: abort.signal },
    );
    grip.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Home") {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
          delete getPreferences()[name];
          dock(name);
          return;
        }
        if (event.key === "Escape" && gesture) {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          isFloating(name) ? dock(name) : float(name);
          return;
        }
        if (
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (!isFloating(name)) float(name);
        const rect = { ...sizes[name] },
          step = event.shiftKey ? 1 : 10;
        if (event.key === "ArrowLeft") rect.x -= step;
        if (event.key === "ArrowRight") rect.x += step;
        if (event.key === "ArrowUp") rect.y -= step;
        if (event.key === "ArrowDown") rect.y += step;
        storeRect(
          name,
          limitFloatingPanel(
            rect,
            name,
            workspace.clientWidth,
            workspace.clientHeight,
          ),
        );
        apply();
        persist();
      },
      { signal: abort.signal },
    );
    for (const edge of ["n", "e", "s", "w", "ne", "se", "sw", "nw"]) {
      const handle = doc.createElement("div");
      handle.className = "styk-panel-resize-edge";
      handle.dataset.edge = edge;
      handle.setAttribute(
        "aria-label",
        `Resize ${labels[name].toLowerCase()} panel ${edge}`,
      );
      if (edge.length === 1) {
        handle.tabIndex = 0;
        handle.setAttribute("role", "separator");
        handle.setAttribute(
          "aria-orientation",
          ["n", "s"].includes(edge) ? "horizontal" : "vertical",
        );
      }
      bindPointer(handle, name, "resize", edge);
      handle.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape" && gesture) {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
            return;
          }
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const r = { ...sizes[name] },
            step = event.shiftKey ? 1 : 10;
          if (["e", "w"].includes(edge)) {
            const delta =
              event.key === "ArrowLeft"
                ? -step
                : event.key === "ArrowRight"
                  ? step
                  : 0;
            r.width += edge === "w" ? -delta : delta;
            if (edge === "w") r.x += delta;
          } else {
            const delta =
              event.key === "ArrowUp"
                ? -step
                : event.key === "ArrowDown"
                  ? step
                  : 0;
            r.height += edge === "n" ? -delta : delta;
            if (edge === "n") r.y += delta;
          }
          storeRect(
            name,
            limitFloatingPanel(
              r,
              name,
              workspace.clientWidth,
              workspace.clientHeight,
            ),
          );
          apply();
          persist();
        },
        { signal: abort.signal },
      );
      panel.append(handle);
      edges.push(handle);
    }
    panel.addEventListener(
      "pointerdown",
      () => {
        if (isFloating(name)) panel.style.zIndex = String(++z);
      },
      { signal: abort.signal },
    );
  }
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && gesture) {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }
    },
    { capture: true, signal: abort.signal },
  );
  win.addEventListener("blur", () => finish(true), { signal: abort.signal });
  return {
    float,
    dock,
    get positions() {
      return structuredClone(sizes);
    },
    get dragging() {
      return Boolean(gesture);
    },
    cancel() {
      finish(true);
    },
    update() {
      const base = workspace.getBoundingClientRect();
      for (const [name, panel] of Object.entries(panels)) {
        const floating = isFloating(name);
        panel.classList.toggle("styk-floating-panel", floating);
        controls[name].toggle.innerHTML = floating ? dockIcon : floatIcon;
        controls[name].toggle.setAttribute(
          "aria-label",
          `${floating ? "Dock" : "Float"} ${labels[name].toLowerCase()} panel`,
        );
        controls[name].toggle.title =
          `${floating ? "Dock" : "Float"} ${labels[name].toLowerCase()} panel`;
        controls[name].toggle.setAttribute("aria-pressed", String(floating));
        if (floating) {
          const rect = limitFloatingPanel(
            getPreferences().floating[name],
            name,
            workspace.clientWidth,
            workspace.clientHeight,
          );
          sizes[name] = rect;
          Object.assign(panel.style, {
            left: `${base.x + rect.x}px`,
            top: `${base.y + rect.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          });
          if (!panel.style.zIndex) panel.style.zIndex = String(++z);
        } else {
          delete sizes[name];
          panel.style.left = "";
          panel.style.top = "";
          panel.style.zIndex = "";
          if (name !== "timeline") panel.style.height = "";
          else panel.style.width = "";
        }
      }
    },
    destroy() {
      finish(true);
      abort.abort();
      style.remove();
      zone.remove();
      for (const { box } of Object.values(controls)) box.remove();
      for (const edge of edges) edge.remove();
      for (const panel of Object.values(panels)) {
        panel.classList.remove("styk-floating-panel");
        delete panel.dataset.workspacePanel;
        const attr = original.get(panel);
        if (attr === null) panel.removeAttribute("style");
        else panel.setAttribute("style", attr);
      }
    },
  };
}
