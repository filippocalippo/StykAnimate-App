import {appendLocalized,clearTranslation,localizedAttribute} from './localization-bindings.mjs';
import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';
/** Delegated numeric/property controls. Model transactions are supplied by the owner. */
import {dragSlop} from "./pen-input.mjs";
import {positionToValue, valueToPosition, positionPercent} from "./ui/value-scale.mjs";
/** How much one unit of input moves a value: Shift is fine (×0.1), Alt finer (×0.01), Ctrl or ⌘ coarse (×10). */
export const propertyRate = ({ shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}, coarse = 10) =>
  (shiftKey ? 0.1 : 1) * (altKey ? 0.01 : 1) * (ctrlKey || metaKey ? coarse : 1);
export const propertyStep = (step = 1, modifiers = {}) => step * propertyRate(modifiers);
/** A slider field's own travel: dragging its whole width crosses its range; Ctrl crosses it in a quarter of that. */
const RANGE_COARSE = 4;
/** Two taps on one field within this long and this close reset it to its default. */
const DOUBLE_TAP_MS = 450, DOUBLE_TAP_PX = 8;
/** The scale a slider field's input declares (data-property-scale, -knee, -exponent, min, max). */
const rangeOf = (input) => ({
  scale: input.dataset.propertyScale || "linear",
  min: Number(input.min),
  max: Number(input.max),
  knee: input.dataset.propertyKnee,
  exponent: input.dataset.propertyExponent,
  step: Number(input.dataset.propertyStep || input.step) || 0,
});
const isRange = (input) => Boolean(input?.closest?.("[data-property-row]")?.hasAttribute("data-range")) && input.min !== "" && input.max !== "";
/** Snaps `value` to the field's step grid (finer under Shift or Alt), from its minimum. */
const snap = (value, input, modifiers = {}) => {
  const step = (Number(input.dataset.propertyStep || input.step) || 0) * (modifiers.shiftKey ? 0.1 : 1) * (modifiers.altKey ? 0.01 : 1);
  if (!(step > 0)) return value;
  const min = input.min === "" ? 0 : Number(input.min);
  return min + Math.round((value - min) / step) * step;
};
/**
 * Draws a value control's state from its value: a slider field's fill (--_p), an angle's dial (--_a) and the
 * spoken value (aria-valuetext with the unit). Owners call it after they write a value; the controls call it while a
 * value is dragged, typed or stepped, so nothing else rebuilds during a gesture.
 */
export function paintValueControl(input, value = Number(input.dataset.propertyValue ?? input.value)) {
  const row = input.closest?.("[data-property-row]");
  if (!row || !Number.isFinite(value)) return;
  if (isRange(input)) {
    const fill = positionPercent(valueToPosition(value, rangeOf(input)));
    if (row.style.getPropertyValue("--_p") !== fill) row.style.setProperty("--_p", fill);
  }
  const dial = row.querySelector("[data-property-dial]");
  if (dial) {
    const turn = `${Number(value.toFixed(2))}deg`;
    if (dial.style.getPropertyValue("--_a") !== turn) dial.style.setProperty("--_a", turn);
  }
  const unit = input.dataset.propertyUnit;
  if (unit !== undefined) {
    const text = formatPropertyValue(value, Number(input.dataset.propertyPrecision || 2)) + (["%", "°", "×"].includes(unit) ? unit : unit ? ` ${unit}` : "");
    if (input.getAttribute("aria-valuetext") !== text) input.setAttribute("aria-valuetext", text);
  }
}
export const formatPropertyValue = (value, precision = 2) => {
  if (!Number.isFinite(Number(value))) return "";
  return String(
    Number(Number(value).toFixed(Math.max(0, Math.min(8, precision)))),
  );
};

// Inputs may show fewer decimals at rest (data-property-display-precision)
// than they edit with; focus reveals the edit precision, blur restores it.
const displayPrecision = (input) => {
  const value = input.dataset.propertyDisplayPrecision;
  return value === undefined ? null : Number(value);
};
const showAtRest = (input) => {
  const precision = displayPrecision(input);
  if (precision === null || input.ownerDocument.activeElement === input) return;
  input.value = formatPropertyValue(input.dataset.propertyValue, precision);
};

const STYLES = `
.property-row {display:flex;align-items:center;gap:4px;min-width:0;}
.property-row.is-animatable {grid-column:1/-1;}
.property-row.is-wide {grid-column:1/-1;}
.property-row>.field {flex:1;min-width:0;}
.property-row.is-animatable>.field>.property-scrub {min-width:42px;}
.property-row .property-scrub {cursor:ew-resize;touch-action:none;user-select:none;border-radius:2px;outline-offset:2px;}
/* A mask rather than a glyph: the bundled Inter subsets have no arrows. */
.property-row .property-scrub::after {content:"";display:inline-block;width:1em;height:.6em;margin-inline-start:3px;vertical-align:.05em;background:currentColor;opacity:.35;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 12' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 6h16M6 2 2 6l4 4M14 2l4 4-4 4'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 12' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 6h16M6 2 2 6l4 4M14 2l4 4-4 4'/%3E%3C/svg%3E") center/contain no-repeat;forced-color-adjust:none;}
.property-row .property-scrub:hover {color:var(--theme-accent, #0d99ff);}
.property-row .property-scrub:hover::after,.property-row .property-scrub:focus-visible::after {opacity:1;color:var(--theme-accent, #0d99ff);}
.property-row .property-scrub:focus-visible {outline:2px solid var(--theme-accent, #80caff);}
.property-row .field>input {min-width:35px;}
.property-row .field>input[aria-invalid=true] {color:var(--theme-danger, #d24646);}
.property-row:has(.property-scrub:active)>.field {border-color:var(--theme-accent, #0d99ff);}
.property-context-heading {display:flex;align-items:center;gap:9px;padding:14px 12px 12px;border-bottom:1px solid var(--border,#e5e5e5);}
.property-context-heading>span {display:grid;place-items:center;width:26px;height:26px;border-radius:5px;background:var(--theme-field, #f2f2f2);color:var(--theme-secondary, #555);flex-shrink:0;}
.property-context-heading strong {font-weight:600;font-size:12px;display:block;}
.property-context-heading small {display:block;color:var(--theme-muted, #888);font-size:10px;margin-top:3px;}
.property-context-caption {font-size:10px;color:var(--theme-muted, #888);line-height:1.45;margin:8px 0 0;}
.property-frame-summary {display:flex;justify-content:space-between;align-items:center;padding:0 0 10px;color:var(--theme-muted, #777);font-size:11px;}
.property-context-actions {display:flex;gap:6px;margin-top:8px;}
.property-context-actions>.button {flex:1;min-width:0;}
.property-opacity-grid {margin-top:8px;}
.segment-gradient-fields {margin-top:3px;}
#inspector [data-action="mirror-segment-vertical"]>.icon,#inspector [data-action="mirror-branch-vertical"]>.icon {transform:rotate(90deg);}
.property-color-line>.color-row {flex:1;min-width:0;margin:0;}
.property-background-line {margin-top:8px;}
.property-background-name {flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:4px;background:var(--theme-field, #f2f2f2);padding:8px;font-size:11px;color:var(--theme-secondary, #666);}
.property-layer-name {width:100%;height:30px;border:1px solid transparent;border-radius:4px;background:var(--theme-field, #f2f2f2);padding:0 8px;font-size:11px;outline:none;}
.property-layer-name:focus {border-color:var(--theme-accent, #0d99ff);background:var(--theme-panel, #fff);}
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
    element.textContent = `@layer legacy{${STYLES}}`;
    appendLocalized(doc.head, element);
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
      throw messageError(new TypeError(''), "errors.propertyControls.propertyControlsNeedAContainer", {});
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
        if (["scrub", "dial"].includes(this.gesture?.source)) this._finish(true);
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
      input?.matches?.("input:is([type=number],[type=range])[data-property]") &&
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
      throw messageError(new Error(''), "errors.propertyControls.thisPropertyHasNoFiniteNumericValue", {});
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
    this._settled = null;
    try {
      g.token = this.callbacks.begin?.(this._payload(g));
      if (g.token?.then)
        throw messageError(new Error(''), "errors.propertyControls.propertyBeginMustReturnASynchronousTransactionToken", {});
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
    clearTranslation(g.element,'validation-message');
    g.element.setCustomValidity("");
    g.element.removeAttribute("aria-invalid");
    if (g.value !== value) {
      g.value = value;
      g.changed = g.value !== g.initialValue;
      this.callbacks.preview?.(this._payload(g));
    }
    if (display) g.element.value = formatPropertyValue(value, g.precision);
    paintValueControl(g.element, value);
  }
  /** Sets a field with a default (data-property-default) back to it, as one edit: a double click, or a menu's Reset value. */
  reset(input) {
    if (!this.handles(input) || input.dataset.propertyDefault === undefined) return false;
    const value = Number(input.dataset.propertyDefault);
    if (!Number.isFinite(value)) return false;
    const g = this.gesture?.element === input ? this.gesture : this._begin(input, "reset");
    this._preview(g, value, { round: false });
    this._finish(true);
    if (this.doc.activeElement === input) input.select?.();
    return true;
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
      // Commit handlers may replace the row, which fires a re-entrant change
      // on the detached input — and Enter's blur fires change too. Quantized
      // model values (percent to 0-255) cannot be told apart from an edit by
      // comparing formatted text, so mark the element and let _change consume
      // exactly one consequential event instead.
      g.element.dataset.propertyValue = String(g.value);
      g.element.value = formatPropertyValue(g.value, g.precision);
      this._settled = g.element;
      this.callbacks.commit?.(this._payload(g));
    } else {
      this.callbacks.cancel?.(this._payload(g));
      g.element.dataset.propertyValue = String(g.initialValue);
      g.element.value = formatPropertyValue(g.initialValue, g.precision);
      paintValueControl(g.element, g.initialValue);
    }
    g.element.closest?.("[data-property-row]")?.removeAttribute("data-scrubbing");
    clearTranslation(g.element,'validation-message');
    g.element.setCustomValidity("");
    g.element.removeAttribute("aria-invalid");
    showAtRest(g.element);
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
  /**
   * A press on a value control. The label scrubs (Properties' fields); a slider field ([data-range]) scrubs from
   * anywhere on it except its value while that is being typed; an angle's dial turns to the pointer. A press and
   * release without a drag types the value; a second tap on the same field soon after resets it to its default.
   */
  _pointerDown(event) {
    if (event.button !== 0) return;
    const target = event.target;
    const row = target.closest?.("[data-property-row]");
    if (!row || target.closest("button, select, a, [data-property-ignore]")) {
      this._lastTap = null;
      return;
    }
    const input = this._inputFor(row);
    if (!input) return;
    const tap = this._lastTap;
    this._lastTap = null;
    if (tap?.row === row && event.timeStamp - tap.time < DOUBLE_TAP_MS && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < DOUBLE_TAP_PX && input.dataset.propertyDefault !== undefined) {
      this._consume(event);
      this.suppressPointerClick = true;
      this.reset(input);
      return;
    }
    const dial = target.closest("[data-property-dial]");
    const label = target.closest("[data-property-scrub]");
    const typing = target === input && this.doc.activeElement === input;
    if (!dial && !label && !(row.hasAttribute("data-range") && !typing)) return;
    this._consume(event);
    this.suppressPointerClick = true;
    if (this.gesture) this._finish(true);
    const g = this._begin(input, dial ? "dial" : "scrub");
    g.pointerId = event.pointerId;
    g.lastX = event.clientX;
    g.startX = event.clientX;
    g.startY = event.clientY;
    g.row = row;
    // A pen tap on a label focuses its field; only a real drag scrubs.
    g.slop = dragSlop(event, 2);
    g.accumulator = g.value;
    g.moved = false;
    g.typed = this.doc.activeElement === input;
    if (isRange(input)) {
      g.range = rangeOf(input);
      g.position = valueToPosition(g.value, g.range);
      g.travel = Math.max(48, row.getBoundingClientRect().width);
    }
    if (dial) g.dial = dial;
    this.container.setPointerCapture(event.pointerId);
    row.setAttribute("data-scrubbing", "");
    // The label holds focus while dragging (arrow keys keep stepping it); the value is typed after a tap.
    (label ?? row.querySelector("[data-property-scrub]") ?? input).focus?.({ preventScroll: true });
    if (!dial) this.doc.body.classList.add("styk-property-scrubbing");
    if (dial) this._turn(g, event);
  }
  /** An angle from its dial's centre to the pointer, in degrees (screen y down, as the stage's angles), Shift in 15° steps. */
  _turn(g, event) {
    const box = g.dial.getBoundingClientRect();
    let angle = Math.atan2(event.clientY - (box.top + box.height / 2), event.clientX - (box.left + box.width / 2)) * 180 / Math.PI;
    if (event.shiftKey) angle = Math.round(angle / 15) * 15;
    g.moved = true;
    this._preview(g, angle);
  }
  _pointerMove(event) {
    const g = this.gesture;
    if (!g || !["scrub", "dial"].includes(g.source) || g.pointerId !== event.pointerId) return;
    this._consume(event);
    if (g.source === "dial") {
      this._turn(g, event);
      return;
    }
    const dx = event.clientX - g.lastX;
    if (!g.moved && Math.abs(event.clientX - g.startX) < g.slop) return;
    g.lastX = event.clientX;
    g.moved = true;
    if (g.range) {
      // A slider field moves along its own travel: the unrounded position accumulates, so a slow drag never sticks
      // and the value never jumps when a modifier is pressed or released.
      g.position = Math.max(0, Math.min(1, g.position + (dx / g.travel) * propertyRate(event, RANGE_COARSE)));
      this._preview(g, snap(positionToValue(g.position, g.range), g.element, event));
      return;
    }
    g.accumulator = this._limit(
      g,
      g.accumulator + dx * propertyStep(g.step, event),
      false,
    );
    this._preview(g, g.accumulator);
  }
  _pointerUp(event) {
    const g = this.gesture;
    if (!g || !["scrub", "dial"].includes(g.source) || g.pointerId !== event.pointerId) return;
    this._consume(event);
    const input = g.element,
      moved = g.moved;
    this._finish(true);
    if (!moved) {
      // A tap types the value; a second tap soon after resets it (above).
      this._lastTap = { row: g.row, time: event.timeStamp, x: event.clientX, y: event.clientY };
      input.focus({ preventScroll: true });
      input.select();
    }
  }
  _focusIn(event) {
    const input = this._inputFor(event.target);
    if (input !== event.target) return;
    if (displayPrecision(input) !== null && !this.gesture) {
      input.value = formatPropertyValue(this._value(input), Number(input.dataset.propertyPrecision || 2));
      input.select();
    }
    this._begin(input, "input");
  }
  _focusOut(event) {
    const input = event.target;
    if (this.gesture?.element === input && !["scrub", "dial"].includes(this.gesture.source))
      this._finish(true);
    if (input?.matches?.("input[data-property-display-precision]"))
      this.win.queueMicrotask(() => showAtRest(input));
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
      localizedAttribute(input,'validation-message',Number.isFinite(value)?'propertyControls.enterValueBetween':'propertyControls.enterAFiniteNumber',Number.isFinite(value)?{min,max}:{});
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
    if (event.target === this._settled) {
      this._settled = null;
      return;
    }
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
        "PageUp",
        "PageDown",
        ...(isLabel ? ["ArrowLeft", "ArrowRight", "Home", "End"] : []),
      ].includes(event.key) ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    this._consume(event);
    const g = this._begin(input, "keyboard");
    g.keyStepping = true;
    if (event.key === "Home" || event.key === "End") {
      const limit = event.key === "Home" ? input.min : input.max;
      if (limit !== "") this._preview(g, Number(limit));
      return;
    }
    const direction = ["ArrowUp", "ArrowRight", "PageUp"].includes(event.key) ? 1 : -1;
    if (event.key.startsWith("Page")) {
      // The coarse step: a tenth of a slider field's travel, or ten steps.
      if (isRange(input)) {
        const range = rangeOf(input), position = valueToPosition(g.value, range) + direction * 0.1;
        this._preview(g, snap(positionToValue(position, range), input));
      } else this._preview(g, g.value + direction * 10 * g.step);
      return;
    }
    this._preview(g, g.value + direction * propertyStep(g.step, event));
  }
  _keyUp(event) {
    if (
      this.gesture?.keyStepping &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key)
    ) {
      this._consume(event);
      this._finish(true);
    }
  }
  _click(event) {
    if (this.suppressPointerClick && event.detail !== 0) {
      this.suppressPointerClick = false;
      this._consume(event);
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.cancel();
    this.destroyed = true;
    this.abort.abort();
    this.removeStyles();
  }
}
