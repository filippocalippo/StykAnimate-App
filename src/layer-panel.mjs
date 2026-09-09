import { icon } from "./icons.mjs";

const ROW_HEIGHT = 32;
const STYLE = `
.styk-layer-panel{display:flex;flex-direction:column;min-height:0;overflow:hidden!important;position:relative;font-size:11px;color:#2c2c2c}
.styk-layer-tools{display:flex;align-items:center;justify-content:space-between;gap:4px;height:32px;padding:0 8px;flex-shrink:0;border-bottom:1px solid #e5e5e5}
.styk-layer-tools button{height:25px;padding:0 5px;border-radius:4px;font-size:11px;gap:6px}.styk-layer-tools .icon{width:14px;height:14px}
.styk-layer-tree{position:relative;flex:1;min-height:0;overflow:auto;contain:strict;overscroll-behavior:contain;outline-offset:-2px}
.styk-layer-spacer{position:relative;min-height:100%}.styk-tree-row{position:absolute;left:0;right:0;display:flex;align-items:center;gap:5px;height:32px;padding:0 7px 0 8px;outline-offset:-2px;user-select:none;cursor:default;border-left:2px solid transparent}
.styk-tree-row:hover{background:#f5f5f5}.styk-tree-row[aria-selected=true]{background:#e5f4ff;border-left-color:#0d99ff}.styk-tree-row[data-kind=layer]{font-weight:600}.styk-tree-row[data-kind=figure]{padding-left:28px;font-weight:400}.styk-tree-row[data-kind=scene],.styk-tree-row[data-kind=camera]{padding-left:10px}.styk-tree-row[data-kind=camera]{border-bottom:1px solid #e5e5e5}
.styk-tree-row .styk-tree-symbol{display:flex;align-items:center;flex-shrink:0;color:#767676}.styk-tree-symbol .icon{width:14px;height:14px}.styk-tree-row[aria-selected=true] .styk-tree-symbol{color:#007be5}
.styk-tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.styk-tree-count{font-size:10px;font-weight:400;color:#858585;min-width:10px;text-align:right}.styk-tree-controls{display:flex;gap:0;align-items:center;flex-shrink:0}.styk-tree-row button{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:20px;height:23px;padding:0;border-radius:3px;color:#767676}.styk-tree-row button .icon{width:13px;height:13px}.styk-tree-controls button{opacity:0}.styk-tree-row:hover .styk-tree-controls button,.styk-tree-row:focus-within .styk-tree-controls button,.styk-tree-controls button[data-on=true]{opacity:1}.styk-tree-row button:hover{background:#e5e5e5;color:#2c2c2c}.styk-tree-disclosure{width:16px!important}.styk-tree-row[data-hidden=true]>.styk-tree-name{opacity:.5}.styk-tree-row[data-drop=before]{box-shadow:inset 0 2px #0d99ff}.styk-tree-row[data-drop=after]{box-shadow:inset 0 -2px #0d99ff}.styk-tree-row[data-drop=inside]{box-shadow:inset 0 0 0 2px #0d99ff;background:#e5f4ff}.styk-tree-row[data-dragging=true]{opacity:.45}
.styk-layer-rename{min-width:0;width:0;flex:1;height:24px;padding:0 4px;border:1px solid #0d99ff;border-radius:3px;outline:none!important;background:#fff;font-size:11px;font-weight:500}.styk-layer-empty{position:absolute;top:110px;left:12px;right:12px;color:#858585;line-height:1.5;text-align:center;font-size:11px;pointer-events:none}
.styk-layer-menu{position:fixed;z-index:70;min-width:210px;max-width:280px;padding:5px;border:1px solid #dedede;border-radius:6px;background:#fff;box-shadow:0 5px 20px #0002;color:#2c2c2c;font-size:11px}.styk-layer-menu button{display:flex;align-items:center;justify-content:flex-start;gap:8px;width:100%;height:29px;padding:0 8px;border-radius:3px;text-align:left;font-size:11px}.styk-layer-menu button .icon{width:14px;height:14px;color:#767676}.styk-layer-menu button kbd{margin-left:auto;color:#858585;font:10px inherit}.styk-layer-menu hr{height:1px;padding:0;margin:4px;border:0;background:#e5e5e5}.styk-layer-menu label{display:flex;flex-direction:column;gap:6px;padding:7px 8px;color:#767676;font-size:10px}.styk-layer-menu select{width:100%;height:28px;padding:0 6px;border:1px solid #dedede;border-radius:3px;background:#fff;color:#2c2c2c;font-size:11px}
`;

/** User-layer hierarchy. The flattened index is rebuilt for structure/seek changes only. */
export class LayerPanel {
  constructor(
    container,
    editor,
    {
      onSelectTrack = () => {},
      onSelectFigure,
      onToggleFigureVisibility = () => {},
      onToggleFigureLock = () => {},
      onAssignFigures = (uids,id) => editor.assignFiguresToLayer(uids,id),
      onDeleteLayer = id => editor.deleteLayer(id),
      onError = () => {},
    } = {},
  ) {
    this.container = container;
    this.editor = editor;
    this.onSelectTrack = onSelectTrack;
    this.onSelectFigure =
      onSelectFigure ||
      ((uid, modifiers) =>
        editor.select(uid, -1, { toggle: modifiers.toggle }));
    this.onToggleFigureVisibility = onToggleFigureVisibility;
    this.onToggleFigureLock = onToggleFigureLock;
    this.onError = onError;
    this.onAssignFigures=onAssignFigures; this.onDeleteLayer=onDeleteLayer;
    this.collapsed = new Set();
    this.rendered = new Map();
    this.options = {};
    this.rows = [];
    this.groups = new Map();
    this.byKey = new Map();
    this.dirty = true;
    this.activeKey = null;
    this.query = "";
    this.disposed = false;
    this.drag = null;
    this.stats = {
      indexBuilds: 0,
      indexMs: 0,
      rows: 0,
      totalRows: 0,
      renderCount: 0,
    };
    this.events = new AbortController();
    const events = { signal: this.events.signal };
    this.style = document.createElement("style");
    this.style.dataset.stykLayerPanel = "";
    this.style.textContent = STYLE;
    document.head.append(this.style);
    container.classList.add("styk-layer-panel");
    container.innerHTML = `<div class="styk-layer-tools"><button type="button" data-layer-command="create" aria-label="New layer" title="New layer">${icon("plus")}<span>New layer</span></button><button type="button" data-layer-command="collapse" aria-label="Collapse layers" title="Collapse layers">${icon("collapse")}</button></div><div class="styk-layer-tree" role="tree" aria-label="Scene layers" aria-multiselectable="true" tabindex="0"><div class="styk-layer-spacer"></div><div class="styk-layer-empty" hidden>No matching figures</div></div>`;
    this.tree = container.querySelector(".styk-layer-tree");
    this.spacer = container.querySelector(".styk-layer-spacer");
    this.empty = container.querySelector(".styk-layer-empty");
    this.tree.addEventListener("scroll", () => this.render(), {
      ...events,
      passive: true,
    });
    container.addEventListener("click", (event) => this.click(event), events);
    this.tree.addEventListener(
      "dblclick",
      (event) => {
        const row = this.rowFrom(event);
        if (row?.kind === "layer" && !event.target.closest("button")) {
          event.preventDefault();
          event.stopPropagation();
          this.rename(row.id);
        }
      },
      events,
    );
    this.tree.addEventListener(
      "keydown",
      (event) => this.keydown(event),
      events,
    );
    this.tree.addEventListener(
      "contextmenu",
      (event) => {
        const row = this.rowFrom(event);
        if (!row) return;
        event.preventDefault();
        event.stopPropagation();
        this.showMenu(row, event.clientX, event.clientY);
      },
      events,
    );
    for (const type of [
      "dragstart",
      "dragover",
      "dragleave",
      "drop",
      "dragend",
    ])
      this.tree.addEventListener(
        type,
        (event) => this.dragEvent(event),
        events,
      );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (this.menu && !this.menu.contains(event.target)) this.closeMenu();
      },
      events,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && this.menu) {
          event.preventDefault();
          event.stopPropagation();
          this.closeMenu();
        }
      },
      events,
    );
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.tree);
    editor.addEventListener(
      "change",
      (event) => {
        const detail = event.detail || {};
        if (
          detail.layers ||
          detail.structural ||
          detail.definition ||
          detail.kind === "history" ||
          detail.kind === "document"
        )
          this.dirty = true;
        if (detail.kind === "document") {
          this.collapsed.clear();
          this.tree.scrollTop = 0;
        }
      },
      events,
    );
    this.update();
  }

  get layers() {
    return this.editor.layers || [];
  }
  get userLayers() {
    return this.layers
      .filter(
        (layer) =>
          !layer.permanent && layer.kind !== "scene" && layer.kind !== "camera",
      )
      .toReversed();
  }
  handle(operation) {
    try {
      Promise.resolve(operation()).catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }

  update(options = {}) {
    if (this.disposed) return;
    this.options = { ...this.options, ...options };
    const frame = this.editor.selectionFrame ?? this.editor.frame,
      layers = this.layers,
      query = String(this.options.query || "")
        .trim()
        .toLocaleLowerCase();
    if (
      this.dirty ||
      frame?.objects !== this.previousObjects ||
      frame?.objects?.length !== this.previousLength ||
      layers !== this.previousLayers ||
      query !== this.query
    ) {
      this.previousFrame = frame;
      this.previousObjects = frame?.objects;
      this.previousLength = frame?.objects?.length;
      this.previousLayers = layers;
      this.query = query;
      this.rebuild();
      this.dirty = false;
    }
    this.render();
  }

  rebuild() {
    const started = performance.now(),
      layers = [
        ...this.layers.filter(
          (layer) =>
            layer.permanent || ["scene", "camera"].includes(layer.kind),
        ),
        ...this.userLayers,
      ];
    const types = new Map(
      (this.editor.report.figure_types || []).map((figure) => [
        figure.figure_type_id,
        figure,
      ]),
    );
    this.groups = new Map(layers.map((layer) => [layer.id, []]));
    const frame =
      this.previousFrame ?? this.editor.selectionFrame ?? this.editor.frame;
    const objects = frame?.objects || [];
    const paintOrder =
      frame?.object_draw_order || objects.map((_, index) => index);
    for (let i = paintOrder.length - 1; i >= 0; i--) {
      const object = objects[paintOrder[i]];
      if (!object) continue;
      const figure = types.get(object.figure_type_id);
      const assigned = this.editor.layerForUid(object.unique_id),
        layerId = typeof assigned === "object" ? assigned?.id : assigned;
      const group = this.groups.get(layerId);
      if (!group) continue;
      group.push({
        key: `figure:${object.unique_id}`,
        kind: "figure",
        id: object.unique_id,
        uid: object.unique_id,
        layerId,
        object,
        name: object.name || figure?.name || `Figure ${object.figure_type_id}`,
        symbol: figure?.text_assets?.length
          ? "text"
          : figure?.image_assets?.length
            ? "image"
            : "person",
      });
    }
    this.rows = [];
    for (const layer of layers) {
      const permanent =
        layer.permanent || ["scene", "camera"].includes(layer.kind);
      if (permanent) {
        this.rows.push({
          key: layer.id,
          id: layer.id,
          kind: layer.kind,
          name: layer.name,
          layer,
          symbol: layer.kind === "camera" ? "camera" : "frame",
        });
        continue;
      }
      const figures = this.groups.get(layer.id) || [],
        matches = layer.name.toLocaleLowerCase().includes(this.query);
      const shown =
        this.query && !matches
          ? figures.filter((figure) =>
              figure.name.toLocaleLowerCase().includes(this.query),
            )
          : figures;
      if (this.query && !matches && !shown.length) continue;
      const expanded = Boolean(this.query) || !this.collapsed.has(layer.id);
      this.rows.push({
        key: layer.id,
        id: layer.id,
        kind: "layer",
        layer,
        name: layer.name,
        symbol: "layers",
        count: figures.length,
        expanded,
      });
      if (expanded) for (const figure of shown) this.rows.push(figure);
    }
    this.byKey = new Map(
      this.rows.map((row, index) => [row.key, { ...row, index }]),
    );
    this.spacer.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    this.empty.hidden = !(this.query && this.rows.length <= 2);
    this.stats.indexBuilds++;
    this.stats.indexMs = performance.now() - started;
    this.stats.totalRows = this.rows.length;
  }

  selectedUids() {
    return (
      this.options.selectedUids ||
      this.editor.selectedUids ||
      new Set(this.editor.selectedUid == null ? [] : [this.editor.selectedUid])
    );
  }
  selected(row) {
    return row.kind === "figure"
      ? this.selectedUids().has(row.uid)
      : (this.options.selectedTrackId || this.editor.activeLayerId) === row.id;
  }
  render() {
    if (this.disposed || !this.tree.clientHeight || this.renaming) return;
    const start = Math.max(0, Math.floor(this.tree.scrollTop / ROW_HEIGHT) - 1),
      end = Math.min(
        this.rows.length,
        Math.ceil((this.tree.scrollTop + this.tree.clientHeight) / ROW_HEIGHT) +
          1,
      ),
      keep = new Set();
    for (let i = start; i < end; i++) {
      const row = this.rows[i];
      keep.add(row.key);
      let element = this.rendered.get(row.key);
      if (!element) {
        element = document.createElement("div");
        element.className = "styk-tree-row";
        element.dataset.key = row.key;
        element.setAttribute("role", "treeitem");
        this.spacer.append(element);
        this.rendered.set(row.key, element);
      }
      element.dataset.kind = row.kind;
      element.style.top = `${i * ROW_HEIGHT}px`;
      element.tabIndex = this.activeKey === row.key ? 0 : -1;
      element.setAttribute("aria-selected", String(this.selected(row)));
      element.setAttribute("aria-level", row.kind === "figure" ? "2" : "1");
      element.setAttribute("aria-label", row.name);
      element.title = row.name;
      if (row.kind === "layer")
        element.setAttribute("aria-expanded", String(row.expanded));
      else element.removeAttribute("aria-expanded");
      element.draggable = row.kind === "layer" || row.kind === "figure";
      const hidden =
        row.kind === "figure"
          ? this.options.hiddenUids?.has(row.uid)
          : row.layer?.visible === false;
      const locked =
        row.kind === "figure"
          ? this.options.lockedUids?.has(row.uid)
          : row.layer?.locked;
      element.dataset.hidden = String(Boolean(hidden));
      const controls =
        row.kind === "figure" || row.kind === "layer"
          ? `<span class="styk-tree-controls"><button type="button" data-layer-command="visibility" data-on="${Boolean(hidden)}" title="${hidden ? "Show" : "Hide"} ${row.kind}" aria-label="${hidden ? "Show" : "Hide"} ${row.kind}">${icon(hidden ? "eye-off" : "eye")}</button><button type="button" data-layer-command="lock" data-on="${Boolean(locked)}" title="${locked ? "Unlock" : "Lock"} ${row.kind}" aria-label="${locked ? "Unlock" : "Lock"} ${row.kind}">${icon(locked ? "lock" : "unlock")}</button></span>`
          : "";
      const markup = `${row.kind === "layer" ? `<button type="button" class="styk-tree-disclosure" data-layer-command="expand" aria-label="${row.expanded ? "Collapse" : "Expand"} ${this.escape(row.name)}">${icon(row.expanded ? "chevron-down" : "chevron-right")}</button>` : ""}<span class="styk-tree-symbol">${icon(row.symbol)}</span><span class="styk-tree-name">${this.escape(row.name)}</span>${row.kind === "layer" ? `<span class="styk-tree-count">${row.count}</span>` : ""}${controls}`;
      if (element._markup !== markup) {
        element.innerHTML = markup;
        element._markup = markup;
      }
    }
    for (const [key, element] of this.rendered)
      if (!keep.has(key)) {
        element.remove();
        this.rendered.delete(key);
      }
    this.stats.rows = this.rendered.size;
    this.stats.renderCount++;
  }
  escape(value) {
    return String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
  rowFrom(event) {
    return this.byKey.get(event.target.closest(".styk-tree-row")?.dataset.key);
  }
  click(event) {
    if (event.target.closest(".styk-layer-rename")) {
      event.stopPropagation();
      return;
    }
    const row = this.rowFrom(event),
      command = event.target.closest("[data-layer-command]")?.dataset
        .layerCommand;
    if (!row && !command) return;
    event.preventDefault();
    event.stopPropagation();
    if (command) this.handle(() => this.command(command, row));
    else this.selectRow(row, event);
  }
  selectRow(row, event = {}) {
    this.activeKey = row.key;
    if (row.kind === "figure")
      this.handle(() =>
        this.onSelectFigure(row.uid, {
          toggle: Boolean(event.ctrlKey || event.metaKey || event.shiftKey),
          range: Boolean(event.shiftKey),
        }),
      );
    else
      this.handle(() => {
        this.editor.setActiveLayer(row.id);
        this.onSelectTrack(row.layer);
      });
    this.update();
    this.rendered.get(row.key)?.focus({ preventScroll: true });
  }
  command(command, row) {
    if (command === "create") {
      const created = this.editor.createLayer();
      const layer =
        typeof created === "object"
          ? created
          : this.editor.getLayer(created || this.editor.activeLayerId);
      this.dirty = true;
      this.update();
      if (layer) {
        this.activeKey = layer.id;
        this.onSelectTrack(layer);
        this.rename(layer.id);
      }
      return;
    }
    if (command === "collapse") {
      const allCollapsed = this.userLayers.every((layer) =>
        this.collapsed.has(layer.id),
      );
      this.collapsed = allCollapsed
        ? new Set()
        : new Set(this.userLayers.map((layer) => layer.id));
      this.dirty = true;
      this.update();
      return;
    }
    if (!row) return;
    if (command === "expand") {
      this.collapsed.has(row.id)
        ? this.collapsed.delete(row.id)
        : this.collapsed.add(row.id);
      this.dirty = true;
    } else if (command === "visibility")
      row.kind === "figure"
        ? this.onToggleFigureVisibility(row.uid)
        : this.editor.setLayerVisible(row.id, row.layer.visible === false);
    else if (command === "lock")
      row.kind === "figure"
        ? this.onToggleFigureLock(row.uid)
        : this.editor.setLayerLocked(row.id, !row.layer.locked);
    this.update();
  }
  focusIndex(index) {
    const row = this.rows[Math.max(0, Math.min(this.rows.length - 1, index))];
    if (!row) return;
    this.activeKey = row.key;
    const top = this.byKey.get(row.key).index * ROW_HEIGHT;
    if (top < this.tree.scrollTop) this.tree.scrollTop = top;
    else if (top + ROW_HEIGHT > this.tree.scrollTop + this.tree.clientHeight)
      this.tree.scrollTop = top + ROW_HEIGHT - this.tree.clientHeight;
    this.render();
    this.rendered.get(row.key)?.focus({ preventScroll: true });
  }
  keydown(event) {
    if (event.target.matches("input,select")) return;
    if (
      event.target.closest("button") &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.stopPropagation();
      return;
    }
    const row = this.rowFrom(event) || this.byKey.get(this.activeKey),
      index = row?.index ?? -1;
    const next = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: this.rows.length - 1,
      PageDown: index + Math.floor(this.tree.clientHeight / ROW_HEIGHT),
      PageUp: index - Math.floor(this.tree.clientHeight / ROW_HEIGHT),
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      this.focusIndex(next);
      return;
    }
    if (!row) return;
    if (event.key === "ArrowRight" && row.kind === "layer") {
      event.preventDefault();
      event.stopPropagation();
      if (!row.expanded) this.command("expand", row);
      else this.focusIndex(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      if (row.kind === "layer" && row.expanded) this.command("expand", row);
      else if (row.kind === "figure")
        this.focusIndex(this.byKey.get(row.layerId)?.index || 0);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      this.selectRow(row, event);
    } else if (event.key === "F2" && row.kind === "layer") {
      event.preventDefault();
      event.stopPropagation();
      this.rename(row.id);
    } else if (
      event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      const rect = this.rendered.get(row.key).getBoundingClientRect();
      this.showMenu(row, rect.x + 24, rect.bottom);
    }
  }
  rename(id) {
    this.closeMenu();
    const row = this.byKey.get(id);
    if (!row || row.kind !== "layer") return;
    this.focusIndex(row.index);
    const element = this.rendered.get(id),
      name = element.querySelector(".styk-tree-name");
    const input = document.createElement("input");
    input.className = "styk-layer-rename";
    input.value = row.name;
    input.maxLength = 120;
    input.setAttribute("aria-label", "Layer name");
    this.renaming = true;
    name.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      this.renaming = false;
      if (commit && input.value.trim() && input.value.trim() !== row.name)
        this.handle(() => this.editor.renameLayer(id, input.value.trim()));
      element._markup = null;
      this.dirty = true;
      this.update();
    };
    input.addEventListener("blur", () => finish(true), { once: true });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        finish(event.key === "Enter");
        this.rendered.get(id)?.focus({ preventScroll: true });
      }
    });
  }
  moveLayer(id, delta) {
    const ids = this.userLayers.map((layer) => layer.id),
      index = ids.indexOf(id),
      target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(target, 0, id);
    this.editor.reorderLayers(ids.toReversed());
    this.update();
  }
  figureDragUids(row) {
    return this.selectedUids().has(row.uid)
      ? [...this.selectedUids()]
      : [row.uid];
  }
  showMenu(row, x, y) {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "styk-layer-menu";
    menu.setAttribute("role", "menu");
    const add = (label, symbol, action, disabled = false, key = "") => {
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = disabled;
      button.setAttribute("role", "menuitem");
      button.innerHTML = `${icon(symbol)}<span>${this.escape(label)}</span>${key ? `<kbd>${key}</kbd>` : ""}`;
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu();
        this.handle(action);
      };
      menu.append(button);
    };
    const divider = () => menu.append(document.createElement("hr"));
    if (row.kind === "layer") {
      const index = this.userLayers.findIndex((layer) => layer.id === row.id);
      add("Rename layer", "text", () => this.rename(row.id), false, "F2");
      add("New layer", "plus", () => this.command("create"));
      divider();
      add("Move layer up", "up", () => this.moveLayer(row.id, -1), index <= 0);
      add(
        "Move layer down",
        "down",
        () => this.moveLayer(row.id, 1),
        index === this.userLayers.length - 1,
      );
      add(
        "Move selected figures here",
        "layers",
        () =>
          this.onAssignFigures([...this.selectedUids()], row.id),
        !this.selectedUids().size,
      );
      divider();
      add(
        row.layer.visible === false ? "Show layer" : "Hide layer",
        "eye",
        () => this.command("visibility", row),
      );
      add(row.layer.locked ? "Unlock layer" : "Lock layer", "lock", () =>
        this.command("lock", row),
      );
      divider();
      add(
        "Delete layer",
        "trash",
        () => this.onDeleteLayer(row.id),
        this.userLayers.length <= 1,
      );
    } else if (row.kind === "figure") {
      add("Select figure", "cursor", () => this.selectRow(row));
      const label = document.createElement("label");
      label.textContent = "Move to layer";
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Move figures to layer");
      for (const layer of this.userLayers) {
        const option = document.createElement("option");
        option.value = layer.id;
        option.textContent = layer.name;
        option.selected = layer.id === row.layerId;
        select.append(option);
      }
      select.onchange = (event) => {
        event.stopPropagation();
        this.closeMenu();
        this.handle(() =>
          this.onAssignFigures(
            this.figureDragUids(row),
            select.value,
          ),
        );
      };
      label.append(select);
      menu.append(label);
      divider();
      add(
        this.options.hiddenUids?.has(row.uid) ? "Show figure" : "Hide figure",
        "eye",
        () => this.command("visibility", row),
      );
      add(
        this.options.lockedUids?.has(row.uid) ? "Unlock figure" : "Lock figure",
        "lock",
        () => this.command("lock", row),
      );
    } else add(`${row.name} settings`, row.symbol, () => this.selectRow(row));
    document.body.append(menu);
    this.menu = menu;
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
    menu.querySelector("button:not(:disabled)")?.focus();
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu();
        this.rendered.get(row.key)?.focus();
      } else if (
        ["ArrowDown", "ArrowUp"].includes(event.key) &&
        event.target.tagName !== "SELECT"
      ) {
        event.preventDefault();
        event.stopPropagation();
        const buttons = [
            ...menu.querySelectorAll("button:not(:disabled),select"),
          ],
          index = buttons.indexOf(document.activeElement);
        buttons[
          (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
        ]?.focus();
      }
    });
  }
  closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }
  dragEvent(event) {
    const row = this.rowFrom(event);
    if (event.type === "dragstart") {
      if (
        !row ||
        !["figure", "layer"].includes(row.kind) ||
        event.target.closest("button,input")
      ) {
        event.preventDefault();
        return;
      }
      this.drag =
        row.kind === "figure"
          ? { kind: "figure", uids: this.figureDragUids(row), key: row.key }
          : { kind: "layer", id: row.id, key: row.key };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(
        "application/x-styk-layer",
        JSON.stringify(this.drag),
      );
      this.rendered.get(row.key).dataset.dragging = "true";
      event.stopPropagation();
      return;
    }
    if (event.type === "dragend") {
      this.clearDrag();
      return;
    }
    if (!this.drag || row?.kind !== "layer") return;
    if (event.type === "dragleave") {
      delete this.rendered.get(row.key)?.dataset.drop;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "dragover") {
      for (const element of this.rendered.values()) delete element.dataset.drop;
      const element = this.rendered.get(row.key),
        rect = element.getBoundingClientRect();
      element.dataset.drop =
        this.drag.kind === "figure"
          ? "inside"
          : event.clientY < rect.y + rect.height / 2
            ? "before"
            : "after";
      event.dataTransfer.dropEffect = "move";
    } else if (event.type === "drop") {
      const drag = this.drag,
        edge = this.rendered.get(row.key).dataset.drop;
      this.clearDrag();
      this.handle(async () => {
        if (drag.kind === "figure")
          await this.onAssignFigures(drag.uids, row.id);
        else if (drag.id !== row.id) {
          const ids = this.userLayers
              .map((layer) => layer.id)
              .filter((id) => id !== drag.id),
            index = ids.indexOf(row.id) + (edge === "after" ? 1 : 0);
          ids.splice(index, 0, drag.id);
          this.editor.reorderLayers(ids.toReversed());
        }
        this.dirty = true;
        this.update();
      });
    }
  }
  clearDrag() {
    this.drag = null;
    for (const element of this.rendered.values()) {
      delete element.dataset.dragging;
      delete element.dataset.drop;
    }
  }
  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.closeMenu();
    this.events.abort();
    this.resizeObserver.disconnect();
    this.style.remove();
    this.rendered.clear();
    this.container.replaceChildren();
    this.container.classList.remove("styk-layer-panel");
  }
}
