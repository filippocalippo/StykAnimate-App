/** Delegated numeric/property controls. Model transactions are supplied by the owner. */
export const propertyStep = (
  step = 1,
  { shiftKey = false, altKey = false } = {},
) => step * (shiftKey ? 0.1 : 1) * (altKey ? 0.01 : 1);
export const formatPropertyValue = (value, precision = 2) => {
  if (!Number.isFinite(Number(value))) return "";
  return String(
    Number(Number(value).toFixed(Math.max(0, Math.min(8, precision)))),
  );
};

const STYLES = `
.property-row {display:flex;align-items:center;gap:4px;min-width:0;}
.property-row.is-animatable {grid-column:1/-1;}
.property-row.is-wide {grid-column:1/-1;}
.property-row>.field {flex:1;min-width:0;}
.property-row.is-animatable>.field>.property-scrub {min-width:42px;}
.property-row .property-scrub {cursor:ew-resize;touch-action:none;user-select:none;border-radius:2px;outline-offset:2px;}
.property-row .property-scrub:hover {color:#0d99ff;}
.property-row .property-scrub:focus-visible {outline:2px solid #80caff;}
.property-row .field>input {min-width:35px;}
.property-row .field>input[aria-invalid=true] {color:#d24646;}
.property-key-controls {display:flex;align-items:center;gap:0;flex-shrink:0;}
.property-key-controls button {width:18px;height:26px;padding:0;color:#888;border-radius:3px;}
.property-key-controls button:hover:not(:disabled) {background:#e5f4ff;color:#0d99ff;}
.property-key-controls button:disabled {opacity:.24;}
.property-key-controls button>.icon {width:12px;height:12px;}
.property-key-controls [data-property-key].is-keyed {color:#0d99ff;background:#e5f4ff;}
.property-key-controls [data-property-key].is-keyed .icon {fill:currentColor;}
.property-key-controls [data-property-key].is-animated {color:#0d99ff;}
.property-row:has(.property-scrub:active)>.field {border-color:#0d99ff;}
.property-context-heading {display:flex;align-items:center;gap:9px;padding:14px 12px 12px;border-bottom:1px solid var(--border,#e5e5e5);}
.property-context-heading>span {display:grid;place-items:center;width:26px;height:26px;border-radius:5px;background:#f2f2f2;color:#555;flex-shrink:0;}
.property-context-heading strong {font-weight:600;font-size:12px;display:block;}
.property-context-heading small {display:block;color:#888;font-size:10px;margin-top:3px;}
.property-context-caption {font-size:10px;color:#888;line-height:1.45;margin:8px 0 0;}
.property-frame-summary {display:flex;justify-content:space-between;align-items:center;padding:0 0 10px;color:#777;font-size:11px;}
.property-context-actions {display:flex;gap:6px;margin-top:8px;}
.property-context-actions>.button {flex:1;min-width:0;}
.property-opacity-grid {margin-top:8px;}
[data-property-row="outline_opacity"] {grid-column:1/-1;margin-top:8px;}
.segment-gradient-fields {margin-top:3px;}
#inspector [data-action="mirror-segment-vertical"]>.icon,#inspector [data-action="mirror-branch-vertical"]>.icon {transform:rotate(90deg);}
.property-color-line>.color-row {flex:1;min-width:0;margin:0;}
.property-background-line {margin-top:8px;}
.property-background-name {flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:4px;background:#f2f2f2;padding:8px;font-size:11px;color:#666;}
.property-layer-name {width:100%;height:30px;border:1px solid transparent;border-radius:4px;background:#f2f2f2;padding:0 8px;font-size:11px;outline:none;}
.property-layer-name:focus {border-color:#0d99ff;background:#fff;}
.property-row:not(.is-animatable) .field {padding-inline:6px;gap:4px;}
.property-row:not(.is-animatable) .field>.property-scrub {font-size:10px;}
.property-row:not(.is-animatable) .field>input {min-width:24px;}
body.styk-property-scrubbing,body.styk-property-scrubbing * {cursor:ew-resize !important;user-select:none !important;}
`;
const styles = new WeakMap();
function installStyles(doc) {
  let shared = styles.get(doc);
  if (!shared) {
    const element = doc.createElement("style");
    element.dataset.stykPropertyStyles = "";
    element.textContent = STYLES;
    doc.head.append(element);
    shared = { element, count: 0 };
    styles.set(doc, shared);
  }
  shared.count++;
  return () => {
    if (--shared.count === 0) {
      shared.element.remove();
      styles.delete(doc);
    }
  };
}

/**
 * Callbacks receive {key,value,initialValue,token,source,element}. begin returns
 * a synchronous opaque token. preview/commit/cancel never dispatch DOM changes.
 * The owner should defer inspector replacement while active is true.
 */
export class PropertyControls {
  constructor(container, callbacks = {}) {
    if (!container?.addEventListener)
      throw new TypeError("Property controls need a container.");
    this.container = container;
    this.callbacks = callbacks;
    this.gesture = null;
    this.destroyed = false;
    this.doc = container.ownerDocument;
    this.win = this.doc.defaultView;
    this.abort = new AbortController();
    this.removeStyles = installStyles(this.doc);
    const listen = (type, handler, capture = false, target = container) =>
      target.addEventListener(
        type,
        (event) => {
          try {
            handler.call(this, event);
          } catch (error) {
            this._fail(error);
          }
        },
        { capture, signal: this.abort.signal },
      );
    listen(
      "pointerdown",
      () => {
        this.suppressPointerClick = false;
      },
      true,
      this.win,
    );
    listen("pointerdown", this._pointerDown, true);
    listen("pointermove", this._pointerMove, true);
    listen("pointerup", this._pointerUp, true);
    listen("pointercancel", () => this.cancel(), true);
    listen(
      "lostpointercapture",
      () => {
        if (this.gesture?.source === "scrub") this._finish(true);
      },
      true,
    );
    listen("focusin", this._focusIn, true);
    listen("focusout", this._focusOut, true);
    listen("input", this._input, true);
    listen("change", this._change, true);
    listen("keydown", this._keyDown, true);
    listen("keyup", this._keyUp, true);
    listen("click", this._click, true);
    listen("blur", () => this.cancel(), false, this.win);
  }
  get active() {
    return Boolean(this.gesture);
  }
  get activeKey() {
    return this.gesture?.key ?? null;
  }
  handles(input) {
    return Boolean(
      input?.matches?.("input[type=number][data-property]") &&
        !input.disabled &&
        this.callbacks.canHandle?.(input.dataset.property, input) !== false,
    );
  }
  _inputFor(target) {
    const input = target?.matches?.("input[data-property]")
      ? target
      : target
          ?.closest?.("[data-property-row]")
          ?.querySelector("input[data-property]");
    return this.handles(input) ? input : null;
  }
  _value(input) {
    const supplied = this.callbacks.getValue?.(input.dataset.property, input);
    const value = Number(
      supplied ?? input.dataset.propertyValue ?? input.value,
    );
    if (!Number.isFinite(value))
      throw new Error("This property has no finite numeric value.");
    return value;
  }
  _payload(g = this.gesture) {
    return {
      key: g.key,
      value: g.value,
      initialValue: g.initialValue,
      token: g.token,
      source: g.source,
      element: g.element,
    };
  }
  _begin(input, source) {
    if (this.gesture?.element === input) return this.gesture;
    if (this.gesture) this._finish(true);
    const value = this._value(input),
      g = {
        key: input.dataset.property,
        element: input,
        source,
        value,
        initialValue: value,
        changed: false,
        invalid: false,
        precision: Number(input.dataset.propertyPrecision || 2),
        step: Number(input.dataset.propertyStep || input.step) || 1,
        token: undefined,
      };
    this.gesture = g;
    try {
      g.token = this.callbacks.begin?.(this._payload(g));
      if (g.token?.then)
        throw new Error(
          "Property begin must return a synchronous transaction token.",
        );
    } catch (error) {
      this.gesture = null;
      throw error;
    }
    this.container.dispatchEvent(
      new this.win.CustomEvent("property-edit-start", {
        detail: { key: g.key, source },
      }),
    );
    return g;
  }
  _limit(g, value, round = true) {
    const min = g.element.min === "" ? -Infinity : Number(g.element.min),
      max = g.element.max === "" ? Infinity : Number(g.element.max);
    value = Math.max(min, Math.min(max, value));
    return round ? Number(formatPropertyValue(value, g.precision)) : value;
  }
  _preview(g, value, { display = true, round = true } = {}) {
    value = this._limit(g, value, round);
    if (!Number.isFinite(value)) return;
    g.invalid = false;
    g.element.setCustomValidity("");
    g.element.removeAttribute("aria-invalid");
    if (g.value !== value) {
      g.value = value;
      g.changed = g.value !== g.initialValue;
      this.callbacks.preview?.(this._payload(g));
    }
    if (display) g.element.value = formatPropertyValue(value, g.precision);
  }
  _cleanup(g) {
    this.doc.body.classList.remove("styk-property-scrubbing");
    if (
      g.pointerId !== undefined &&
      this.container.hasPointerCapture(g.pointerId)
    )
      this.container.releasePointerCapture(g.pointerId);
  }
  _finish(commit) {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this._cleanup(g);
    if (commit && g.changed && !g.invalid) {
      this.callbacks.commit?.(this._payload(g));
      g.element.dataset.propertyValue = String(g.value);
      g.element.value = formatPropertyValue(g.value, g.precision);
    } else {
      this.callbacks.cancel?.(this._payload(g));
      g.element.dataset.propertyValue = String(g.initialValue);
      g.element.value = formatPropertyValue(g.initialValue, g.precision);
    }
    g.element.setCustomValidity("");
    g.element.removeAttribute("aria-invalid");
    this.container.dispatchEvent(
      new this.win.CustomEvent("property-edit-end", {
        detail: {
          key: g.key,
          committed: Boolean(commit && g.changed && !g.invalid),
        },
      }),
    );
  }
  commit() {
    this._finish(true);
  }
  cancel() {
    this._finish(false);
  }
  _fail(error) {
    try {
      this.cancel();
    } catch {
      /* Preserve the original failure. */
    }
    this.callbacks.onError?.(error);
    this.container.dispatchEvent(
      new this.win.CustomEvent("property-error", {
        detail: { message: error?.message || String(error) },
      }),
    );
  }
  _consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  _pointerDown(event) {
    const label = event.target.closest?.("[data-property-scrub]");
    if (!label || event.button !== 0) return;
    const input = this._inputFor(label);
    if (!input) return;
    this._consume(event);
    this.suppressPointerClick = true;
    if (this.gesture) this._finish(true);
    const g = this._begin(input, "scrub");
    g.pointerId = event.pointerId;
    g.lastX = event.clientX;
    g.startX = event.clientX;
    g.accumulator = g.value;
    g.moved = false;
    this.container.setPointerCapture(event.pointerId);
    label.focus({ preventScroll: true });
    this.doc.body.classList.add("styk-property-scrubbing");
  }
  _pointerMove(event) {
    const g = this.gesture;
    if (!g || g.source !== "scrub" || g.pointerId !== event.pointerId) return;
    this._consume(event);
    const dx = event.clientX - g.lastX;
    if (!g.moved && Math.abs(event.clientX - g.startX) < 2) return;
    g.lastX = event.clientX;
    g.moved = true;
    g.accumulator = this._limit(
      g,
      g.accumulator + dx * propertyStep(g.step, event),
      false,
    );
    this._preview(g, g.accumulator);
  }
  _pointerUp(event) {
    const g = this.gesture;
    if (!g || g.source !== "scrub" || g.pointerId !== event.pointerId) return;
    this._consume(event);
    const input = g.element,
      moved = g.moved;
    this._finish(true);
    if (!moved) {
      input.focus({ preventScroll: true });
      input.select();
    }
  }
  _focusIn(event) {
    const input = this._inputFor(event.target);
    if (input === event.target) this._begin(input, "input");
  }
  _focusOut(event) {
    if (
      this.gesture?.element === event.target &&
      this.gesture.source !== "scrub"
    )
      this._finish(true);
  }
  _typed(input) {
    const g =
        this.gesture?.element === input
          ? this.gesture
          : this._begin(input, "input"),
      value = input.valueAsNumber;
    const min = input.min === "" ? -Infinity : Number(input.min),
      max = input.max === "" ? Infinity : Number(input.max);
    if (!Number.isFinite(value) || value < min || value > max) {
      g.invalid = true;
      input.setAttribute("aria-invalid", "true");
      input.setCustomValidity(
        Number.isFinite(value)
          ? `Enter a value between ${min} and ${max}.`
          : "Enter a finite number.",
      );
      return;
    }
    this._preview(g, value, { display: false, round: false });
  }
  _input(event) {
    if (!this.handles(event.target)) return;
    event.stopImmediatePropagation();
    this._typed(event.target);
  }
  _change(event) {
    if (!this.handles(event.target)) return;
    event.stopImmediatePropagation();
    // Enter/Escape may format the display before a native blur/change arrives.
    // That formatting is not another user edit and must not round the model.
    if (
      !this.gesture &&
      event.target.value ===
        formatPropertyValue(
          this._value(event.target),
          Number(event.target.dataset.propertyPrecision || 2),
        )
    )
      return;
    this._typed(event.target);
    this._finish(true);
  }
  _keyDown(event) {
    const input = this._inputFor(event.target);
    if (!input) return;
    if (event.key === "Escape" && this.gesture) {
      this._consume(event);
      this.cancel();
      return;
    }
    if (event.key === "Enter") {
      this._consume(event);
      if (event.target === input) {
        this._typed(input);
        this._finish(true);
        input.blur();
      } else {
        input.focus({ preventScroll: true });
        input.select();
      }
      return;
    }
    const isLabel = event.target.matches?.("[data-property-scrub]");
    if (
      ![
        "ArrowUp",
        "ArrowDown",
        ...(isLabel ? ["ArrowLeft", "ArrowRight"] : []),
      ].includes(event.key) ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    this._consume(event);
    const g = this._begin(input, "keyboard");
    g.keyStepping = true;
    const direction = ["ArrowUp", "ArrowRight"].includes(event.key) ? 1 : -1;
    this._preview(g, g.value + direction * propertyStep(g.step, event));
  }
  _keyUp(event) {
    if (
      this.gesture?.keyStepping &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
    ) {
      this._consume(event);
      this._finish(true);
    }
  }
  _click(event) {
    if (this.suppressPointerClick && event.detail !== 0) {
      this.suppressPointerClick = false;
      this._consume(event);
      return;
    }
    const button = event.target.closest?.(
      "[data-property-key],[data-property-nav]",
    );
    if (!button || button.disabled) return;
    this._consume(event);
    if (this.gesture) this._finish(true);
    const key = button.dataset.propertyKey || button.dataset.propertyNav;
    if (button.hasAttribute("data-property-key"))
      this.callbacks.keyframe?.({ key, element: button });
    else
      this.callbacks.navigate?.({
        key,
        direction: Number(button.dataset.direction),
        element: button,
      });
  }
  destroy() {
    if (this.destroyed) return;
    this.cancel();
    this.destroyed = true;
    this.abort.abort();
    this.removeStyles();
  }
}
