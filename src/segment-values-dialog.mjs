import { PropertyControls, formatPropertyValue } from "./property-controls.mjs";
import {
  parseSegmentValues,
  formatSegmentValues,
} from "./editor-handle-commands.mjs";
import { icon } from "./icons.mjs";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const keys = ["angle", "bend", "length"];
const CSS = `
dialog.segment-values-dialog{width:min(380px,calc(100vw - 32px));max-width:380px}
.segment-values-dialog .dialog-head{border-bottom:1px solid #e5e5e5;padding:15px 18px}
.segment-values-dialog .dialog-head h2{font-size:13px}
.segment-values-dialog .dialog-body{padding:16px 18px}
.segment-values-caption{font-size:11px;color:#767676;margin:0 0 14px}
.segment-values-fields{display:grid;gap:9px}
.segment-values-fields .field{min-height:36px;background:#f5f5f5;display:flex;align-items:center;border:1px solid transparent;border-radius:5px;padding:0 9px!important;gap:8px!important}
.segment-values-fields .field:focus-within{border-color:#0d99ff;background:#fff}
.segment-values-fields .property-scrub{font-size:11px!important;min-width:64px}
.segment-values-fields input{background:transparent;flex:1;width:0;font:12px inherit;border:0;outline:none;padding:8px 0;appearance:textfield;text-align:right}
.segment-values-fields small{font-size:10px;color:#999;min-width:17px;text-align:right}
.segment-values-relative{display:flex;gap:7px;align-items:center;font-size:11px;margin:15px 0 8px}
.segment-values-relative input{accent-color:#0d99ff;margin:0}
.segment-values-help{font-size:10px!important;line-height:1.5;margin:0 0 15px}
.segment-values-clipboard-tools{display:flex;gap:7px}.segment-values-clipboard-tools .button{flex:1;font-size:11px;justify-content:center}
.segment-values-dialog .form-error{font-size:11px;margin:10px 0 0;line-height:1.4}
.segment-values-dialog [hidden]{display:none!important}
#segment-values-status{font-size:10px;min-height:14px;margin:8px 0 0}
.segment-clipboard-fallback{margin-top:12px;display:grid;gap:7px}
.segment-clipboard-fallback label{font-size:11px}
#segment-clipboard-input{width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:4px;padding:8px;font:12px inherit;min-height:52px;resize:vertical}
.segment-clipboard-fallback .button{justify-self:end;font-size:11px}
.segment-values-dialog .dialog-actions{border-top:1px solid #e5e5e5;margin:0;padding:12px 18px}
`;

/** One native model gesture spans this dialog. Field gestures only update its preview. */
export class SegmentValuesDialog {
  constructor({
    dialog,
    content,
    editor,
    clipboard = globalThis.navigator?.clipboard,
    onClose = () => {},
    onError = () => {},
  }) {
    Object.assign(this, {
      dialog,
      content,
      editor,
      clipboard,
      onClose,
      onError,
    });
    this.relative = false;
    if (!document.getElementById("segment-values-style")) {
      const style = document.createElement("style");
      style.id = "segment-values-style";
      style.textContent = CSS;
      document.head.append(style);
    }
  }
  open({ relative = this.relative, editMode = false, isolate = false } = {}) {
    if (this.session) this.cancel();
    const editor = this.editor,
      segment = editor.figure?.segments[editor.selectedJoint];
    if (!segment)
      throw new Error("Select a segment handle to edit its values.");
    if (editor.dragging)
      throw new Error(
        "Finish the current gesture before editing segment values.",
      );
    this.relative = Boolean(relative);
    this.options = { relative: this.relative, editMode, isolate };
    if (!editor.beginSegmentValueEdit(this.options))
      throw new Error("This segment cannot be edited.");
    this.session = {
      drag: editor._drag,
      report: editor.report,
      uid: editor.selectedUid,
      joint: editor.selectedJoint,
      frame: editor.frameIndex,
      tick: editor.tick,
    };
    this.events = new AbortController();
    const signal = this.events.signal;
    this.dialog.classList.add("segment-values-dialog");
    this.content.innerHTML = `<div class="dialog-head"><h2>Segment values</h2><button class="icon-button" data-segment-close aria-label="Close segment values">${icon("close")}</button></div>
      <div class="dialog-body"><p class="segment-values-caption">${esc(editor.figure.name || "Figure")} · Segment ${segment.segment_id}${editMode ? " · Handle Edit" : ""}</p>
      <div class="segment-values-fields">${keys.map((key) => `<div class="property-row" data-property-row="${key}"><label class="field"><span class="property-scrub" data-property-scrub tabindex="0" role="button" aria-label="Scrub segment ${key}">${key[0].toUpperCase() + key.slice(1)}</span><input id="segment-${key}" type="number" step="any" data-property="${key}" data-property-step="1" data-property-precision="3" ${key === "length" ? 'min="1.401298464324817e-45"' : ""} aria-label="Segment ${key}"><small>${key === "length" ? "px" : "°"}</small></label></div>`).join("")}</div>
      <label class="segment-values-relative"><input id="segment-relative" type="checkbox" ${this.relative ? "checked" : ""}>Relative angle</label>
      <p class="segment-values-help" id="segment-values-reference"></p>
      <div class="segment-values-clipboard-tools"><button class="button" id="segment-values-copy">${icon("copy")}Copy values</button><button class="button" id="segment-values-paste">${icon("clipboard")}Paste values</button></div>
      <p id="segment-values-status" role="status"></p><p id="segment-values-error" class="form-error" role="alert" hidden></p>
      <div class="segment-clipboard-fallback" id="segment-clipboard-fallback" hidden><label for="segment-clipboard-input">Angle : Bend : Length</label><textarea id="segment-clipboard-input" maxlength="100" spellcheck="false" placeholder="30:-15:42.5"></textarea><button class="button" id="segment-clipboard-use">Use values</button></div></div>
      <div class="dialog-actions"><button class="button" id="segment-values-cancel">Cancel</button><button class="button primary" id="segment-values-apply">Apply</button></div>`;
    this.$ = (id) => this.content.querySelector("#" + id);
    this.sync();
    // This observer runs before the delegated controller consumes the input.
    this.content.addEventListener(
      "input",
      (event) => {
        if (event.target.matches("input[data-property]"))
          this.$("segment-values-apply").disabled =
            !Number.isFinite(event.target.valueAsNumber) ||
            !event.target.validity.valid;
      },
      { capture: true, signal },
    );
    this.controls = new PropertyControls(this.content, {
      canHandle: (key) => keys.includes(key),
      getValue: (key) => this.values()[key],
      begin: ({ key }) => ({ key, value: this.values()[key] }),
      preview: ({ key, value }) => this.preview({ [key]: value }),
      commit: () => {},
      cancel: ({ token }) => {
        if (token && this.current()) this.preview({ [token.key]: token.value });
      },
      onError: (error) => this.error(error),
    });
    this.content.addEventListener(
      "property-edit-end",
      () => {
        if (this.current()) {
          this.sync();
          this.$("segment-values-apply").disabled = false;
        }
      },
      { signal },
    );
    this.$("segment-relative").addEventListener(
      "change",
      () => {
        this.relative = this.$("segment-relative").checked;
        this.options.relative = this.relative;
        this.sync();
      },
      { signal },
    );
    this.$("segment-values-copy").addEventListener("click", () => this.copy(), {
      signal,
    });
    this.$("segment-values-paste").addEventListener(
      "click",
      () => this.paste(),
      { signal },
    );
    this.$("segment-clipboard-use").addEventListener(
      "click",
      () => this.usePastedText(this.$("segment-clipboard-input").value),
      { signal },
    );
    this.$("segment-values-apply").addEventListener(
      "click",
      () => this.apply(),
      { signal },
    );
    this.$("segment-values-cancel").addEventListener(
      "click",
      () => this.cancel(),
      { signal },
    );
    this.content.addEventListener(
      "click",
      (event) => {
        if (event.target.closest("[data-segment-close]")) this.cancel();
      },
      { signal },
    );
    this.content.addEventListener(
      "keydown",
      (event) => {
        const input = event.target.matches("input,textarea");
        if (
          (event.ctrlKey || event.metaKey) &&
          !input &&
          ["c", "v"].includes(event.key.toLowerCase())
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.key.toLowerCase() === "c" ? this.copy() : this.paste();
        }
      },
      { signal },
    );
    this.content.addEventListener(
      "paste",
      (event) => {
        if (event.target.id === "segment-clipboard-input") return;
        const text = event.clipboardData?.getData("text/plain");
        if (text?.includes(":")) {
          event.preventDefault();
          this.finishField();
          this.usePastedText(text);
        }
      },
      { signal },
    );
    this.dialog.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        this.cancel();
      },
      { signal },
    );
    this.dialog.addEventListener("close", () => this.finish(false), { signal });
    if (!this.dialog.open) this.dialog.showModal();
    // Focus a label, rather than auto-selecting a numeric field: Escape then
    // cancels the dialog until the user explicitly starts a field gesture.
    this.content.querySelector("[data-property-scrub]").focus();
    return this;
  }
  current() {
    const s = this.session,
      e = this.editor;
    return Boolean(
      s &&
        e._drag === s.drag &&
        e.report === s.report &&
        e.selectedUid === s.uid &&
        e.selectedJoint === s.joint &&
        e.frameIndex === s.frame &&
        e.tick === s.tick,
    );
  }
  assertCurrent() {
    if (!this.current())
      throw new Error("The selection changed. Reopen segment values.");
  }
  values() {
    this.assertCurrent();
    return this.editor.segmentValues(this.options);
  }
  sync() {
    const values = this.values();
    for (const key of keys) {
      const input = this.$("segment-" + key);
      input.value = formatPropertyValue(values[key], 3);
      input.dataset.propertyValue = String(values[key]);
      input.removeAttribute("aria-invalid");
      input.setCustomValidity("");
    }
    this.$("segment-values-reference").textContent = this.relative
      ? "Angle is measured from the incoming segment’s end tangent. Length is independent of figure scale."
      : "Angle is measured from the canvas X axis. Length is independent of figure scale.";
  }
  preview(values) {
    this.assertCurrent();
    for (const [key, value] of Object.entries(values)) {
      if (
        !Number.isFinite(value) ||
        !Number.isFinite(
          Math.fround(key === "length" ? value : (value * Math.PI) / 180),
        )
      )
        throw new Error(
          "Enter finite values supported by the native figure format.",
        );
      if (key === "length" && !(Math.fround(value) > 0))
        throw new Error("Segment length must be greater than zero.");
    }
    this.editor.setSegmentValues(values, this.options);
    this.$("segment-values-error").hidden = true;
  }
  finishField() {
    const active = this.content.ownerDocument.activeElement;
    if (active?.matches("input[data-property]")) active.blur();
  }
  async copy() {
    const signal = this.events.signal;
    try {
      this.finishField();
      const text = formatSegmentValues(this.values());
      this.editor._segmentValuesClipboard = text;
      if (!this.clipboard?.writeText)
        throw new Error(
          "Clipboard writing is unavailable. Copy the selected values below.",
        );
      await this.clipboard.writeText(text);
      if (!signal.aborted)
        this.$("segment-values-status").textContent = "Segment values copied.";
    } catch (error) {
      if (!signal.aborted) {
        if (this.current()) {
          this.fallback(formatSegmentValues(this.values()), true);
          this.error(
            new Error("Copy the selected Angle:Bend:Length values below."),
          );
        } else this.error(error);
      }
    }
  }
  async paste() {
    const signal = this.events.signal;
    try {
      this.finishField();
      if (!this.clipboard?.readText)
        throw new Error("Clipboard reading is unavailable.");
      const text = await this.clipboard.readText();
      if (!signal.aborted) this.usePastedText(text);
    } catch (error) {
      if (!signal.aborted) {
        this.fallback("", false);
        this.error(
          new Error("Paste Angle:Bend:Length below to use clipboard values."),
        );
      }
    }
  }
  usePastedText(text) {
    try {
      this.finishField();
      const values = parseSegmentValues(text),
        count = Object.keys(values).length;
      if (count) {
        this.preview(values);
        this.sync();
        this.$("segment-values-status").textContent =
          `Pasted ${count} ${count === 1 ? "value" : "values"}.`;
      } else {
        this.$("segment-values-error").hidden = true;
        this.$("segment-values-status").textContent =
          "No numeric segment values found. Existing values are unchanged.";
      }
      return Boolean(count);
    } catch (error) {
      this.error(error);
      return false;
    }
  }
  fallback(text, select) {
    this.$("segment-clipboard-fallback").hidden = false;
    this.$("segment-clipboard-input").value = text;
    this.$("segment-clipboard-input").focus();
    if (select) this.$("segment-clipboard-input").select();
  }
  error(error) {
    if (!this.session) return;
    this.$("segment-values-error").textContent = error.message;
    this.$("segment-values-error").hidden = false;
    this.onError(error);
  }
  apply() {
    try {
      this.finishField();
      this.assertCurrent();
      this.controls?.destroy();
      this.controls = null;
      this.editor.commitDrag();
      this.finish(true);
    } catch (error) {
      this.error(error);
    }
  }
  cancel() {
    this.finish(false);
  }
  finish(applied) {
    if (!this.session) return;
    const session = this.session;
    this.controls?.destroy();
    this.controls = null;
    if (!applied && this.editor._drag === session.drag)
      this.editor.cancelDrag();
    this.session = null;
    this.events.abort();
    this.dialog.classList.remove("segment-values-dialog");
    if (this.dialog.open) this.dialog.close();
    this.onClose({ applied });
  }
  destroy() {
    this.finish(false);
  }
}
