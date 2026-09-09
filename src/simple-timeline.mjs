import {showKeyframeEasingPopover} from './keyframe-easing-popover.mjs';
import { icon } from "./icons.mjs";

// Pivot interaction reference: https://www.pivotanimator.net/help5-2/animation_frame_controls.htm
const CARD_WIDTH = 112,
  PREVIEW_WIDTH = 100,
  PREVIEW_HEIGHT = 60;
const STYLE = `
.styk-simple-timeline *{box-sizing:border-box}
:where(.styk-simple-timeline) button{border:0;font:inherit;cursor:pointer}
.styk-simple-timeline button:disabled{opacity:.35;cursor:default}
.styk-simple-timeline button:focus-visible,.styk-simple-timeline input:focus-visible{outline:2px solid #0d99ff;outline-offset:2px}
.styk-simple-card[data-selected=true]{background:#edf6ff}
.styk-simple-card[data-current=true] .styk-simple-number{color:#0877c5;font-weight:650}
.styk-simple-card[data-current=true] .styk-simple-number:after{content:'Editing';float:right;font-size:9px;font-weight:400}
.styk-simple-preview{cursor:grab!important}
.styk-simple-preview:active{cursor:grabbing!important}
.styk-simple-amount{cursor:default;touch-action:pan-x}
.styk-simple-amount input{cursor:ew-resize;touch-action:none;min-height:18px}
.styk-simple-jump{display:flex;align-items:center;gap:5px;color:#767676;font-size:10px;white-space:nowrap}
.styk-simple-amount input[type=range]{appearance:none;background:transparent}
.styk-simple-amount input::-webkit-slider-runnable-track{height:4px;background:#d7e7dd;border-radius:3px}
.styk-simple-amount input::-webkit-slider-thumb{appearance:none;width:12px;height:12px;margin-top:-4px;background:#14ae5c;border:2px solid white;border-radius:50%;box-shadow:0 0 0 1px #14ae5c}
.styk-simple-amount input::-moz-range-track{height:4px;background:#d7e7dd;border-radius:3px}
.styk-simple-amount input::-moz-range-thumb{width:10px;height:10px;background:#14ae5c;border:2px solid white;border-radius:50%}
.styk-simple-jump input{width:100%;min-width:0;height:24px;border:1px solid #dce1e7;border-radius:4px;padding:0 6px;background:#fff;color:#333;font:inherit}
.styk-simple-timeline{display:flex;position:relative;min-height:0;height:100%;overflow:hidden;color:#2c2c2c;font-size:11px;background:#fff}.styk-simple-controls{display:flex;flex-direction:column;gap:5px;justify-content:center;width:139px;flex-shrink:0;padding:6px 12px;border-right:1px solid #e5e5e5;background:#fafafa}.styk-simple-controls>*{flex-shrink:0}.styk-simple-counter{display:flex;align-items:baseline;gap:5px;font-size:10px;color:#767676;white-space:nowrap}.styk-simple-counter strong{font-size:12px;color:#2c2c2c;font-weight:600;font-variant-numeric:tabular-nums}.styk-simple-between{display:flex;flex-direction:column;gap:5px;color:#767676;font-size:10px}.styk-simple-between input{height:27px;min-width:0;width:100%;padding:0 8px;border:1px solid #dedede;border-radius:4px;background:#fff;font-size:11px;color:#2c2c2c}.styk-simple-update{height:29px;border-radius:4px;background:#0d99ff;color:white;font-size:11px;font-weight:500}.styk-simple-update:hover{background:#0087e6!important}.styk-simple-actions{display:flex;justify-content:space-between;gap:3px}.styk-simple-actions button{width:26px;height:25px;padding:0;border-radius:3px;color:#767676}.styk-simple-actions .icon{width:15px;height:15px}.styk-simple-strip{position:relative;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;overscroll-behavior:contain;contain:strict;outline-offset:-2px}.styk-simple-spacer{height:100%;position:relative;min-width:100%}.styk-simple-card{position:absolute;top:0;bottom:0;width:112px;padding:10px 6px 6px;display:flex;flex-direction:column;justify-content:center;gap:6px}.styk-simple-card[data-drop=before]{box-shadow:inset 3px 0 #0d99ff}.styk-simple-card[data-drop=after]{box-shadow:inset -3px 0 #0d99ff}.styk-simple-number{font-size:10px;color:#767676;font-variant-numeric:tabular-nums}.styk-simple-preview{height:64px;width:100px;flex-shrink:0;position:relative;padding:0;border:2px solid #d9d9d9;border-radius:3px;background:#fff;overflow:hidden;outline-offset:2px}.styk-simple-preview[aria-selected=true]{border-color:#0d99ff}.styk-simple-preview[data-current=true]{box-shadow:0 0 0 1px #0d99ff}.styk-simple-preview>canvas{display:block;width:100px;height:60px;pointer-events:none;flex-shrink:0}.styk-simple-preview>.icon{width:20px;height:20px;color:#b0b0b0}.styk-simple-amount{display:flex;align-items:center;gap:5px;font-size:9px;color:#858585;height:15px}.styk-simple-amount input{width:100%;min-width:0;margin:0;height:3px;accent-color:#14ae5c}.styk-simple-amount span{min-width:14px;text-align:right;font-variant-numeric:tabular-nums}.styk-simple-empty{position:absolute;inset:0;display:grid;place-items:center;color:#858585}.styk-simple-menu{position:fixed;z-index:70;min-width:195px;padding:5px;border:1px solid #dedede;border-radius:6px;background:#fff;box-shadow:0 5px 20px #0002;color:#2c2c2c}.styk-simple-menu button{display:flex;align-items:center;justify-content:flex-start;gap:8px;width:100%;height:29px;padding:0 8px;border-radius:3px;font-size:11px}.styk-simple-menu .icon{width:14px;height:14px;color:#767676}.styk-simple-menu hr{height:1px;margin:4px;border:0;background:#e5e5e5}@media(max-height:720px){.styk-simple-controls{gap:5px;padding:6px 10px}.styk-simple-card{gap:4px;padding-top:5px;padding-bottom:5px}}
`;

/** Virtual Pivot filmstrip; thumbnail production is supplied by the app's rendering engine. */
export class SimpleTimeline {
  constructor(
    container,
    editor,
    {
      onSeek = () => {},
      onRangeChange = () => {},
      onError = () => {},
      renderThumbnail,
      onUpdateFrame = () => {},
      confirmDiscardFrame = () => globalThis.confirm('Discard changes to this frame? You can undo this action.'),
      onInsertInbetween,
      runClipboardOperation,
      maxPreviews = 72,
    } = {},
  ) {
    this.container = container;
    this.editor = editor;
    this.onSeek = onSeek;
    this.onRangeChange = onRangeChange;
    this.onError = onError;
    this.renderThumbnail = renderThumbnail;
    this.onUpdateFrame = onUpdateFrame;
    this.confirmDiscardFrame = confirmDiscardFrame;
    editor.enableFrameDrafts?.({mode: 'update'});
    this.onInsertInbetween = onInsertInbetween;
    this.runClipboardOperation = runClipboardOperation;
    this.maxPreviews = Math.max(8, Math.min(128, maxPreviews));
    this.selected = new Set([editor.frameIndex]);
    this.anchor = editor.frameIndex;
    this.revealOnFirstLayout = true;
    this.cards = new Map();
    this.previews = new Map();
    this.draftSnapshot = editor.report._styk?.simpleFrameDraft;
    this.queue = [];
    this.idle = null;
    this.busy = false;
    this.generation = 0;
    this.editing = false;
    this.stats = {
      cards: 0,
      previewRenders: 0,
      cachedPreviews: 0,
      thumbnailBytes: 0,
      paintMs: 0,
      renderCount: 0,
    };
    this.style = document.createElement("style");
    this.style.dataset.stykSimpleTimeline = "";
    this.style.textContent = STYLE;
    document.head.append(this.style);
    container.classList.add("styk-simple-timeline");
    container.innerHTML = `<div class="styk-simple-controls"><div class="styk-simple-counter">Frame <strong>1</strong><span></span></div><label class="styk-simple-between">Inbetweens<input type="number" min="0" max="65534" value="0" aria-label="Frame inbetweens"></label><button type="button" class="styk-simple-update" data-simple-action="add">Add frame</button><div class="styk-simple-actions"><button type="button" data-simple-action="copy" aria-label="Copy frames" title="Copy frames">${icon("duplicate")}</button><button type="button" data-simple-action="paste-end" aria-label="Paste frames at end" title="Paste frames at end">${icon("clipboard")}</button><button type="button" data-simple-action="insert" aria-label="Insert frame" title="Insert frame before selection">${icon("plus")}</button><button type="button" data-simple-action="delete" aria-label="Delete frames" title="Delete frames">${icon("trash")}</button></div></div><div class="styk-simple-strip" role="listbox" aria-label="Animation frames" aria-multiselectable="true" tabindex="0"><div class="styk-simple-spacer"></div></div>`;
    this.strip = container.querySelector(".styk-simple-strip");
    this.spacer = container.querySelector(".styk-simple-spacer");
    this.counter = container.querySelector(".styk-simple-counter");
    this.duration = container.querySelector(".styk-simple-between input");
    this.mainButton = container.querySelector(".styk-simple-update");
    const jump = document.createElement('label'); jump.className = 'styk-simple-jump';
    jump.innerHTML = 'Go to<input type="number" min="1" step="1" aria-label="Go to keyframe">';
    this.counter.after(jump); this.jumpInput = jump.querySelector('input');
    this.events = new AbortController();
    const events = { signal: this.events.signal };
    this.jumpInput.addEventListener('change', () => {
      const index = Number(this.jumpInput.value) - 1;
      if (Number.isInteger(index) && index >= 0) this.handle(() => this.selectFrame(index));
      this.jumpInput.value = String(this.editor.frameIndex + 1);
    }, events);
    container.addEventListener("click", (event) => this.click(event), events);
    container.addEventListener('dblclick', event => {
      const card = event.target.closest('[data-frame]');
      if (!card || event.target.closest('input')) return;
      event.preventDefault(); event.stopPropagation();
      this.handle(() => { this.selectFrame(Number(card.dataset.frame)); this.showEasingPopover(); });
    }, events);
    container.addEventListener(
      "keydown",
      (event) => this.keydown(event),
      events,
    );
    this.duration.addEventListener(
      "change",
      () =>
        this.handle(() =>
          this.setDuration(
            this.editor.frameDraft?.mode === 'add' ? [this.editor.frameIndex] : this.selectedFrameIndices,
            Number(this.duration.value),
          ),
        ),
      events,
    );
    this.strip.addEventListener("scroll", () => this.requestRender(), {
      ...events,
      passive: true,
    });
    this.strip.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        this.strip.scrollLeft +=
          Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
      },
      { ...events, passive: false },
    );
    this.strip.addEventListener(
      "input",
      (event) => {
        const input = event.target.closest("[data-inbetween]");
        if (input) { input.nextElementSibling.textContent = input.value; input.setAttribute('aria-valuetext', `${input.value} inbetweens`); }
      },
      events,
    );
    this.strip.addEventListener(
      "change",
      (event) => {
        const input = event.target.closest("[data-inbetween]");
        if (input) {
          event.stopPropagation();
          this.handle(() =>
            this.setDuration(
              [Number(input.dataset.inbetween)],
              Number(input.value),
              {stored:true},
            ),
          );
        }
      },
      events,
    );
    this.strip.addEventListener(
      "contextmenu",
      (event) => {
        const index = Number(
          event.target.closest("[data-frame]")?.dataset.frame,
        );
        if (!Number.isInteger(index)) return;
        event.preventDefault();
        event.stopPropagation();
        this.showMenu(index, event.clientX, event.clientY);
      },
      events,
    );
    for (const name of [
      "dragstart",
      "dragover",
      "dragleave",
      "drop",
      "dragend",
    ])
      this.strip.addEventListener(
        name,
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
    this.resizeObserver = new ResizeObserver(() => this.requestRender());
    this.resizeObserver.observe(this.strip);
    editor.addEventListener(
      "change",
      (event) => {
        const detail = event.detail || {};
        if (detail.kind === "document") {
          this.selected = new Set([editor.frameIndex]);
          this.anchor = editor.frameIndex;
          this.strip.scrollLeft = 0;
          this.previews.clear();
          this.generation++;
          this.previewAbort?.abort();
          this.editing = false;
        } else if (
          detail.kind === "seek" &&
          !this.selecting &&
          this.selected.size <= 1
        ) {
          this.selected = new Set([editor.frameIndex]);
          this.anchor = editor.frameIndex;
        } else if (detail.kind === "edit" || detail.kind === "history") {
          const timingOnly = detail.timingOnly && !editor.animationChannels?.length;
          const draft = editor.report._styk?.simpleFrameDraft;
          const draftOnly = draft?.mode === 'add' && (draft.baseline || detail.live) && !detail.structural &&
            !detail.definition && !detail.layers && !detail.animation && !detail.projectFields &&
            detail.kind !== 'history' && (detail.frameIndices || detail.changedFrames || [editor.frameIndex]).every(index => index === draft.index);
          if (!timingOnly && !draftOnly) {
            if (detail.definition || detail.layers || detail.animation || detail.projectFields || detail.structural || detail.kind === 'history') this.previews.clear();
            else for (const index of detail.frameIndices || detail.changedFrames || [editor.frameIndex])
              this.previews.delete(this.previewKey(editor.report.keyframes[index]));
            this.generation++;
            this.previewAbort?.abort();
          }
          this.editing = editor.frameDraft?.mode !== 'add';
        } else if (detail.kind === 'frame-draft') {
          // Selection and Add/Update mode changes emit this event too. Only
          // committing an Add working pose changes the stored preview.
          const previous = this.draftSnapshot, next = editor.report._styk?.simpleFrameDraft;
          if (previous?.mode === 'add' && previous.baseline && previous.baseline !== next?.baseline) {
            this.previews.delete(previous.frameId);
            this.generation++;
            this.previewAbort?.abort();
          }
          this.editing = editor.frameDraft?.mode !== 'add';
        }
        this.draftSnapshot = editor.report._styk?.simpleFrameDraft;
        if (
          detail.structural &&
          this.previousCount !== editor.report.keyframes.length
        ) {
          this.selected = new Set(detail.insertedFrameIndices ?? [editor.frameIndex]);
          this.anchor = editor.frameIndex;
          this.onRangeChange(this.selectedFrameIndices);
        }
      },
      events,
    );
    this.update();
  }
  get selectedFrameIndices() {
    if(this.editor.frameDraft?.empty) return [];
    return [...this.selected]
      .filter(
        (index) => index >= 0 && index < this.editor.report.keyframes.length,
      )
      .sort((a, b) => a - b);
  }
  handle(action) {
    try {
      return Promise.resolve(action()).catch(error=>{if(error.name!=='AbortError')this.onError(error);});
    } catch (error) {
      this.onError(error);
    }
  }
  update() {
    if (this.disposed) return;
    const count = this.editor.frameDraft?.empty ? 0 : this.editor.report.keyframes.length,
      index = this.editor.frameIndex;
    if (this.editor.frameDraft) this.editing = this.editor.frameDraft.mode === 'update';
    this.previousCount = count;
    this.spacer.style.width = `${count * CARD_WIDTH}px`;
    this.counter.querySelector("strong").textContent = String(this.editor.frameDraft?.mode === 'add' && !this.editor._frameDraftPreviewing ? count + 1 : index + 1);
    this.counter.querySelector("span").textContent = `/ ${count}`;
    this.jumpInput.max = String(Math.max(1, count)); this.jumpInput.disabled = !count;
    if (document.activeElement !== this.jumpInput) this.jumpInput.value = String(index + 1);
    this.duration.closest('label').firstChild.textContent = this.selected.size > 1 ? `Inbetweens · ${this.selected.size} selected` : 'Inbetweens';
    this.counter.title = `${(this.editor.tick / this.editor.report.fps).toFixed(2)} seconds`;
    if (document.activeElement !== this.duration)
      this.duration.value = String(
        Math.max(0, (this.editor.frame.duration_raw ?? 1) - 1),
      );
    this.duration.disabled = !this.selected.size && this.editor.frameDraft?.mode !== 'add';
    this.mainButton.textContent = this.editing ? "Update frame" : "Add frame";
    this.mainButton.dataset.simpleAction = this.editing ? "update" : "add";
    this.mainButton.title = this.editing ? 'Save changes to the current frame · A' : 'Append the working pose as a new frame · A';
    for (const action of ["copy", "delete"])
      this.container.querySelector(
        `[data-simple-action="${action}"]`,
      ).disabled = !count || !this.selected.size;
    this.container.querySelector('[data-simple-action="paste-end"]').disabled =
      !this.editor.hasFrameClipboard;
    this.render();
  }
  resize() {
    this.requestRender();
  }
  previewKey(frame) { return frame?._styk?.frameId ?? frame; }
  requestRender() {
    if (this.renderRaf || this.disposed) return;
    this.renderRaf = requestAnimationFrame(() => { this.renderRaf = 0; this.render(); });
  }
  setPaused(paused) {
    if (this.paused === Boolean(paused)) return;
    this.paused = Boolean(paused);
    if (this.paused) {
      this.previewAbort?.abort();
      if (this.idle != null) {
        if (globalThis.cancelIdleCallback) cancelIdleCallback(this.idle);
        else clearTimeout(this.idle);
        this.idle = null;
      }
    } else this.render();
  }
  render() {
    if (this.disposed || !this.strip.clientWidth) return;
    // A newly mounted filmstrip must retain the playhead when switching modes.
    // Defer until the panel has width so this also works in hidden workspaces.
    if (this.revealOnFirstLayout) {
      this.revealOnFirstLayout = false;
      this.ensureVisible(this.editor.frameIndex);
      return;
    }
    const frames = this.editor.frameDraft?.empty ? [] : this.editor.report.keyframes,
      start = Math.max(0, Math.floor(this.strip.scrollLeft / CARD_WIDTH) - 1),
      end = Math.min(
        frames.length,
        Math.ceil(
          (this.strip.scrollLeft + this.strip.clientWidth) / CARD_WIDTH,
        ) + 1,
      ),
      keep = new Set();
    this.queue = [];
    for (let index = start; index < end; index++) {
      keep.add(index);
      let card = this.cards.get(index);
      if (!card) {
        card = document.createElement("div");
        card.className = "styk-simple-card";
        card.dataset.frame = index;
        card.innerHTML = `<span class="styk-simple-number"></span><button type="button" class="styk-simple-preview" role="option" draggable="true" title="Double-click for easing · Drag preview to reorder · Shift-click for a range"></button><label class="styk-simple-amount" title="Inbetweens after this frame"><input type="range" min="0" max="20" step="1" draggable="false"><span></span></label>`;
        this.spacer.append(card);
        this.cards.set(index, card);
      }
      card.style.left = `${index * CARD_WIDTH}px`;
      card.querySelector(".styk-simple-number").textContent = String(index + 1);
      const button = card.querySelector(".styk-simple-preview");
      button.setAttribute("aria-label", `Frame ${index + 1}`);
      button.setAttribute("aria-selected", String(this.selected.has(index)));
      button.dataset.current = String(index === this.editor.frameIndex && this.editor.frameDraft?.mode !== 'add');
      card.dataset.selected = String(this.selected.has(index));
      card.dataset.current = button.dataset.current;
      button.tabIndex = index === this.editor.frameIndex ? 0 : -1;
      const amount = Math.max(0, (frames[index].duration_raw ?? 1) - 1),
        slider = card.querySelector("input");
      slider.dataset.inbetween = index;
      slider.max = String(Math.max(20, amount));
      slider.setAttribute("aria-label", `Frame ${index + 1} inbetweens`);
      if (document.activeElement !== slider) slider.value = amount;
      if (document.activeElement !== slider) slider.nextElementSibling.textContent = String(amount);
      slider.setAttribute('aria-valuetext', `${slider.value} inbetweens`);
      const key = this.previewKey(frames[index]), cached = this.previews.get(key);
      if (cached) {
        this.previews.delete(key);
        this.previews.set(key, cached);
        if (button.firstChild !== cached) button.replaceChildren(cached);
      } else {
        if (
          button.dataset.source !== String(index) ||
          button.querySelector("canvas") ||
          !button.firstChild
        ) {
          button.innerHTML = icon("frame");
          button.dataset.source = index;
        }
        this.queue.push({ index, frame: frames[index], key });
      }
    }
    for (const [index, card] of this.cards)
      if (!keep.has(index)) {
        card.remove();
        this.cards.delete(index);
      }
    this.stats.cards = this.cards.size;
    this.stats.renderCount++;
    this.updateStats();
    // Render visible previews before the one-card overscan on either side.
    const firstVisible = Math.floor(this.strip.scrollLeft / CARD_WIDTH);
    this.queue.sort((a, b) => (a.index < firstVisible ? 1 : 0) - (b.index < firstVisible ? 1 : 0));
    this.schedule();
  }
  updateStats() {
    this.stats.cachedPreviews = this.previews.size;
    this.stats.thumbnailBytes = [...this.previews.values()].reduce(
      (sum, canvas) => sum + canvas.width * canvas.height * 4,
      0,
    );
  }
  selectFrame(index, event = {}) {
    this.onSeek();
    if(this.editor.frameDraft?.empty) return false;
    const count = this.editor.report.keyframes.length;
    index = Math.max(0, Math.min(count - 1, index));
    this.editor.commitDrag?.();
    if (!event.skipDiscard && this.editor.frameDraft?.dirty && (this.editor.frameDraft.mode === 'add' ||
      (!event.shiftKey && !event.ctrlKey && !event.metaKey && index === this.editor.frameIndex))) {
      const token = this.editor._documentToken, revision = this.editor.revision, editingIndex = this.editor.frameIndex;
      const finish = confirmed => {
        if (!confirmed || this.disposed || token !== this.editor._documentToken || revision !== this.editor.revision || editingIndex !== this.editor.frameIndex) return false;
        this.editor.discardFrameDraft(); return this.selectFrame(index, {skipDiscard: true, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey});
      };
      const confirmed = this.confirmDiscardFrame({index, mode: this.editor.frameDraft.mode});
      return confirmed?.then ? confirmed.then(finish) : finish(confirmed);
    }
    if (event.shiftKey) {
      const from = Math.min(this.anchor, index),
        to = Math.max(this.anchor, index);
      if (!event.ctrlKey && !event.metaKey) this.selected.clear();
      for (let i = from; i <= to; i++) this.selected.add(i);
    } else if (event.ctrlKey || event.metaKey) {
      this.selected.has(index)
        ? this.selected.delete(index)
        : this.selected.add(index);
      this.anchor = index;
    } else {
      this.selected = new Set([index]);
      this.anchor = index;
    }
    this.selecting = true;
    try {
      this.editor.commitFrameDraft?.({mode: 'update'});
      this.editor.selectFrame(index);
    } finally {
      this.selecting = false;
    }
    this.editing = true;
    this.onRangeChange(this.selectedFrameIndices);
    this.update();
    this.ensureVisible(index);
    this.cards
      .get(index)
      ?.querySelector("button")
      ?.focus({ preventScroll: true });
  }
  ensureVisible(index) {
    const left = index * CARD_WIDTH;
    if (left < this.strip.scrollLeft) this.strip.scrollLeft = left;
    else if (left + CARD_WIDTH > this.strip.scrollLeft + this.strip.clientWidth)
      this.strip.scrollLeft = left + CARD_WIDTH - this.strip.clientWidth;
    this.render();
  }
  setDuration(indices, inbetweens, {stored=false}={}) {
    if (!Number.isInteger(inbetweens) || inbetweens < 0 || inbetweens > 65534)
      throw new Error("Inbetweens must be 0–65,534.");
    const index = this.editor.frameIndex;
    if(stored && this.editor.frameDraft?.mode==='add') {
      this.editor.editStoredFrames(()=>this.editor.setFramesDuration(indices,inbetweens+1)); this.update(); return;
    }
    this.selecting = true;
    try {
      this.editor.setFramesDuration(
        indices.length ? indices : [index],
        inbetweens + 1,
      );
      this.editor.selectFrame(index);
    } finally {
      this.selecting = false;
    }
    this.editing = true;
    this.update();
  }
  showEasingPopover() { return showKeyframeEasingPopover.call(this); }
  click(event) {
    const action = event.target.closest("[data-simple-action]")?.dataset
      .simpleAction;
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      this.handle(() => this.action(action));
      return;
    }
    if (event.target.closest("input")) return;
    const card = event.target.closest("[data-frame]");
    if (card) {
      event.preventDefault();
      event.stopPropagation();
      this.handle(() => this.selectFrame(Number(card.dataset.frame), event));
    }
  }
  action(action, {skipDiscard = false, contextIndex} = {}) {
    this.onSeek();
    if (action === 'easing') return this.showEasingPopover();
    if(this.editor._frameClipboardWorker&&['copy','cut','paste','paste-end'].includes(action))return this._asyncClipboardAction(action,{skipDiscard,contextIndex});
    const addMode = this.editor.frameDraft?.mode === 'add';
    const deleteAll=['delete','cut'].includes(action)&&this.selectedFrameIndices.length===this.editor.report.keyframes.length;
    if(this.editor.frameDraft?.empty) {
      if(['copy','cut','delete','reverse','inbetween','select-all'].includes(action)) return false;
      if(['paste','paste-end'].includes(action)) {
        this.editor.editStoredFrames(()=>this.editor.pasteFrames(0),{preserveWorking:false}); this.update(); return;
      }
      if(['insert','blank','duplicate'].includes(action)) {this.editor.addDraftFrame({blank:action==='blank'});this.update();return;}
    }
    const preserveWorking = addMode && Number.isInteger(contextIndex) && (action === 'paste' || action === 'delete' && this.selectedFrameIndices.length === 1);
    if (preserveWorking) {
      this.editor.editStoredFrames(() => action === 'paste' ? this.editor.pasteFrames(contextIndex) : this.editor.deleteFrames([contextIndex]),
        {empty:action==='delete'&&this.editor.report.keyframes.length===1});
      this.onRangeChange(this.selectedFrameIndices); this.update(); return;
    }
    if (!skipDiscard && !deleteAll && this.editor.frameDraft?.mode === 'add' && this.editor.frameDraft.dirty &&
      ['cut', 'paste-end', 'paste', 'delete', 'reverse', 'inbetween', 'insert', 'blank', 'duplicate'].includes(action)) {
      const token = this.editor._documentToken, revision = this.editor.revision, index = this.editor.frameIndex;
      const finish = confirmed => {
        if (!confirmed || this.disposed || token !== this.editor._documentToken || revision !== this.editor.revision || index !== this.editor.frameIndex) return false;
        if (['paste-end','delete'].includes(action)) return this.action(action, {skipDiscard:true,contextIndex});
        this.editor.discardFrameDraft(); return this.action(action, {skipDiscard: true,contextIndex});
      };
      const confirmed = this.confirmDiscardFrame({index, mode: 'add', action});
      return confirmed?.then ? confirmed.then(finish) : finish(confirmed);
    }
    const indices = this.selectedFrameIndices.length
      ? this.selectedFrameIndices
      : [this.editor.frameIndex];
    if (action === "update") {
      this.editor.commitDrag?.();
      const updatedIndex = this.editor.frameIndex;
      if (this.editor.updateDraftFrame) this.editor.updateDraftFrame(); else this.editor.commitFrameDraft?.({mode: 'add'});
      this.onUpdateFrame(updatedIndex);
      this.editing = false;
    } else if (action === "add") {
      if (this.editor.addDraftFrame) this.editor.addDraftFrame(); else this.editor.addFrame();
      this.selected = new Set([this.editor.frameIndex]);
      this.anchor = this.editor.frameIndex;
      this.editing = false;
    } else if (action === "copy") this.editor.copyFrames(indices);
    else if (action === "cut") {
      if(deleteAll){
        if(!addMode)this.editor.commitFrameDraft({mode:'add'});
        this.editor.editStoredFrames(()=>this.editor.cutFrames(indices),{preserveWorking:true,empty:true});
      }else this.editor.cutFrames(indices);
    }
    else if (action === "paste-end") {
      const paste=()=>this.editor.pasteFrames(this.editor.report.keyframes.length);
      if (addMode) this.editor.editStoredFrames(paste,{preserveWorking:false}); else paste();
      if (!addMode) this.editor.beginFrameDraft?.({mode:'add',index:this.editor.report.keyframes.length-1});
    }
    else if (action === "paste") this.editor.pasteFrames(Math.min(...indices));
    else if (action === "delete") {
      const remove=()=>this.editor.deleteFrames(indices);
      const empty=indices.length===this.editor.report.keyframes.length;
      if (addMode) this.editor.editStoredFrames(remove,{preserveWorking:empty,empty});
      else if(empty) {
        this.editor.commitFrameDraft({mode:'add'}); this.editor.editStoredFrames(remove,{preserveWorking:true,empty:true});
      } else remove();
      if (!addMode && !empty) this.editor.beginFrameDraft?.({mode:'add',index:this.editor.report.keyframes.length-1});
    }
    else if (action === "reverse") this.editor.reverseFrames(indices);
    else if (action === "inbetween") {
      if (!this.onInsertInbetween) throw new Error("Inbetween preview is not available.");
      return this.onInsertInbetween(indices);
    }
    else if (action === "insert") {
      if (!this.editor.insertDuplicateFrames)
        throw new Error("Frame insertion is not available.");
      this.editor.insertDuplicateFrames(indices);
    } else if (action === "blank")
      this.editor.insertBlankFrame(Math.min(...indices));
    else if (action === "duplicate") this.editor.duplicateFrames(indices);
    else if (action === "select-all") {
      this.selected = new Set(
        this.editor.report.keyframes.map((_, index) => index),
      );
    }
    this.onRangeChange(this.selectedFrameIndices);
    this.update();
    this.ensureVisible(this.editor.frameIndex);
  }
  copySelection(){return this.action('copy');}
  cutSelection(){return this.action('cut');}
  pasteSelection(){return this.action('paste');}
  async _asyncClipboardAction(action,{skipDiscard=false,contextIndex}={}) {
    const empty=Boolean(this.editor.frameDraft?.empty),addMode=this.editor.frameDraft?.mode==='add';
    if(empty&&['copy','cut'].includes(action))return 0;
    const indices=this.selectedFrameIndices.length?this.selectedFrameIndices:[this.editor.frameIndex];
    const cutAll=action==='cut'&&indices.length===this.editor.report.keyframes.length;
    const preserve=cutAll||addMode&&Number.isInteger(contextIndex)&&action==='paste';
    if(!skipDiscard&&!preserve&&action!=='copy'&&addMode&&this.editor.frameDraft.dirty){
      const token=this.editor._documentToken,revision=this.editor.revision,index=this.editor.frameIndex;
      const accepted=await this.confirmDiscardFrame({index,mode:'add',action});
      if(!accepted||this.disposed||token!==this.editor._documentToken||revision!==this.editor.revision||index!==this.editor.frameIndex)return 0;
      // The discard is part of the isolated command. Cancelling its worker
      // keeps the current Add working copy and its checkpoint intact.
      return this._asyncClipboardAction(action,{skipDiscard:true,contextIndex});
    }
    const kind=action==='copy'?'copy':action==='cut'?'cut':'paste',token=this.editor._documentToken;
    const pasteIndex=empty?0:action==='paste-end'?this.editor.report.keyframes.length:Number.isInteger(contextIndex)?contextIndex:Math.min(...indices);
    const execute=options=>{
      if(kind==='copy')return this.editor.copyFramesAsync(indices,options);
      if(kind==='cut')return this.editor.cutFramesAsync(indices,{...options,storedFrames:addMode||cutAll,preserveWorking:cutAll});
      return this.editor.pasteFramesAsync(pasteIndex,{...options,storedFrames:addMode,preserveWorking:empty?false:preserve,
        afterMode:action==='paste-end'&&!addMode?'add':undefined});
    };
    const count=await(this.runClipboardOperation?this.runClipboardOperation(kind,execute):execute({}));
    if(!this.disposed&&token===this.editor._documentToken){this.onRangeChange(this.selectedFrameIndices);this.update();this.ensureVisible(this.editor.frameIndex);}
    return count;
  }
  keydown(event) {
    if (event.target.matches("input,select,textarea")) return;
    const mod = event.ctrlKey || event.metaKey,
      key = event.key.toLowerCase();
    const action = mod
      ? { c: "copy", x: "cut", v: "paste", a: "select-all", d: "duplicate" }[
          key
        ]
      : key === "delete" || key === "backspace"
        ? "delete"
        : key === "a"
          ? this.editing
            ? "update"
            : "add"
          : null;
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      this.handle(() => this.action(action));
      return;
    }
    if (event.target.closest("button") && (key === " " || key === "enter")) {
      event.stopPropagation();
      return;
    }
    const index = this.editor.frameIndex,
      next = {
        arrowleft: index - 1,
        arrowright: index + 1,
        ",": index - 1,
        ".": index + 1,
        home: 0,
        end: this.editor.report.keyframes.length - 1,
      }[key];
    if (next !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      this.handle(() => this.selectFrame(next, event));
    } else if (key === "enter" && event.target.closest("[data-frame]")) {
      event.preventDefault();
      event.stopPropagation();
      this.action("update");
    } else if (key === "escape" && this.menu) {
      event.preventDefault();
      event.stopPropagation();
      this.closeMenu();
    }
  }
  showMenu(index, x, y) {
    this.closeMenu();
    if (!this.selected.has(index)) {
      if (this.editor.frameDraft?.mode === 'add') { this.selected=new Set([index]); this.anchor=index; this.onRangeChange(this.selectedFrameIndices); this.update(); }
      else this.selectFrame(index);
    }
    const menu = document.createElement("div");
    menu.className = "styk-simple-menu";
    menu.setAttribute("role", "menu");
    for (const [action, label, symbol] of [
      ["easing", "Keyframe easing", "frame"],
      ["-"],
      ["insert", "Insert frame", "plus"],
      ["inbetween", "Insert inbetween…", "frame"],
      ["blank", "Insert blank frame", "frame"],
      ["duplicate", "Duplicate selected", "duplicate"],
      ["paste", "Paste insert", "clipboard"],
      ["-"],
      ["copy", "Copy frames", "duplicate"],
      ["cut", "Cut frames", "cut"],
      ["reverse", "Reverse selected", "flip"],
      ["delete", "Delete frames", "trash"],
    ]) {
      if (action === "-") {
        menu.append(document.createElement("hr"));
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.innerHTML = `${icon(symbol)}<span>${label}</span>`;
      button.disabled = action === "paste" && !this.editor.hasFrameClipboard ||
        action === "inbetween" && (!this.onInsertInbetween || !this.selectedFrameIndices.some(index => index > 0));
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu();
        this.handle(() => this.action(action,{contextIndex:index}));
      };
      menu.append(button);
    }
    document.body.append(menu);
    this.menu = menu;
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
    menu.querySelector("button")?.focus();
    menu.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu();
        this.cards.get(index)?.querySelector("button")?.focus();
      } else if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const buttons = [...menu.querySelectorAll("button:not(:disabled)")],
          i = buttons.indexOf(document.activeElement);
        buttons[
          (i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
        ]?.focus();
      }
    };
  }
  closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }
  dragEvent(event) {
    const card = event.target.closest("[data-frame]"),
      index = Number(card?.dataset.frame);
    if (event.type === "dragstart") {
      if (!card || !event.target.closest('.styk-simple-preview')) {
        event.preventDefault();
        return;
      }
      this.dragIndex = index;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-styk-frame", String(index));
      event.stopPropagation();
      return;
    }
    if (event.type === "dragend") {
      this.clearDrag();
      return;
    }
    if (!card || this.dragIndex == null) return;
    if (event.type === "dragleave") {
      delete card.dataset.drop;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "dragover") {
      for (const item of this.cards.values()) delete item.dataset.drop;
      const rect = card.getBoundingClientRect();
      const strip = this.strip.getBoundingClientRect();
      if (event.clientX < strip.left + 24) this.strip.scrollLeft -= CARD_WIDTH / 3;
      else if (event.clientX > strip.right - 24) this.strip.scrollLeft += CARD_WIDTH / 3;
      card.dataset.drop =
        event.clientX < rect.x + rect.width / 2 ? "before" : "after";
      event.dataTransfer.dropEffect = "move";
    } else if (event.type === "drop") {
      const from = this.dragIndex,
        before = card.dataset.drop === "before";
      this.clearDrag();
      let to = index + (before ? 0 : 1);
      if (from < to) to--;
      to = Math.max(0, Math.min(this.editor.report.keyframes.length - 1, to));
      this.handle(() => {
        if (!this.editor.moveFrame)
          throw new Error("Frame movement is not available.");
        this.editor.moveFrame(from, to);
        this.selected = new Set([to]);
        this.anchor = to;
        this.onRangeChange(this.selectedFrameIndices);
        this.update();
      });
    }
  }
  clearDrag() {
    this.dragIndex = null;
    for (const card of this.cards.values()) delete card.dataset.drop;
  }
  schedule() {
    if (
      this.idle != null ||
      this.busy ||
      !this.queue.length ||
      !this.renderThumbnail ||
      this.paused ||
      this.disposed
    )
      return;
    const run = () => {
      this.idle = null;
      void this.renderNext();
    };
    this.idle = globalThis.requestIdleCallback
      ? requestIdleCallback(run, {timeout: 200})
      : setTimeout(run, 32);
  }
  async renderNext() {
    if (this.busy || this.disposed || !this.strip.clientWidth) return;
    const item = this.queue.shift();
    if (!item) return;
    if (this.previews.has(item.key)) {
      this.schedule();
      return;
    }
    const generation = this.generation,
      ratio = Math.min(2, devicePixelRatio || 1),
      canvas = document.createElement("canvas");
    canvas.width = PREVIEW_WIDTH * ratio;
    canvas.height = PREVIEW_HEIGHT * ratio;
    this.busy = true;
    this.previewAbort = new AbortController();
    const started = performance.now();
    try {
      const painted = await this.renderThumbnail(item.index, canvas, {
        signal: this.previewAbort.signal,
      });
      if (
        painted === false ||
        this.previewAbort.signal.aborted ||
        this.disposed ||
        generation !== this.generation ||
        this.editor.report.keyframes[item.index] !== item.frame
      )
        return;
      this.previews.set(item.key, canvas);
      while (this.previews.size > this.maxPreviews)
        this.previews.delete(this.previews.keys().next().value);
      const target = this.cards.get(item.index)?.querySelector("button");
      if (target) target.replaceChildren(canvas);
      this.stats.previewRenders++;
    } catch (error) {
      if (error.name !== "AbortError") this.onError(error);
    } finally {
      this.stats.paintMs = Math.max(
        this.stats.paintMs,
        performance.now() - started,
      );
      this.busy = false;
      this.updateStats();
      this.schedule();
    }
  }
  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.dialog?.close();
    this.easingPopover?.hidePopover();
    this.generation++;
    this.previewAbort?.abort();
    if (this.renderRaf) cancelAnimationFrame(this.renderRaf);
    if (this.idle != null) {
      if (globalThis.cancelIdleCallback) cancelIdleCallback(this.idle);
      else clearTimeout(this.idle);
    }
    this.closeMenu();
    this.events.abort();
    this.resizeObserver.disconnect();
    this.style.remove();
    this.cards.clear();
    this.previews.clear();
    this.container.replaceChildren();
    this.container.classList.remove("styk-simple-timeline");
  }
}
