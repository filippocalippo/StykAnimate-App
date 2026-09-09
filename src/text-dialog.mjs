import {segmentPaint, hexColor, paintCSS} from './paint.mjs';
import { readTextFigureOptions } from "./native-text-authoring.mjs";
import { drawTextPreview } from "./text-preview.mjs";
import { icon } from "./icons.mjs";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const hex = (rgb) =>
  "#" + rgb.map((n) => n.toString(16).padStart(2, "0")).join("");
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const defaults = {
  text: "Make it move.",
  fontSize: 64,
  fontSizeKnown: true,
  fontOrigin: "bundled",
  fontFamily: "Noto Sans",
  lineHeight: 1.2,
  bold: false,
  italic: false,
  alignment: "left",
  color: [43, 43, 43],
  opacity: 1,
  gradientColor: null,
  outlineWidth: 0,
  outlineColor: [0, 0, 0],
  embeddedScale: 100,
};
const CSS = `
dialog.text-authoring-dialog{width:min(880px,calc(100vw - 32px));max-width:880px;color:var(--text,#292929);padding:0}
.text-authoring-dialog .dialog-head{padding:16px 20px;border-bottom:1px solid var(--border,#e5e5e5)}
.text-authoring-dialog .dialog-head h2{font-size:14px;margin:0}
.text-authoring-dialog .dialog-body{padding:0;max-height:calc(100dvh - 160px);overflow:auto}
.text-authoring-layout{display:grid;grid-template-columns:320px minmax(0,1fr)}
.text-authoring-fields{padding:18px 20px;border-right:1px solid var(--border,#e5e5e5);display:grid;gap:14px;align-content:start}
.text-authoring-fields label{font-size:11px;display:grid;gap:7px;min-width:0;color:var(--text,#292929)}
.text-authoring-fields input,.text-authoring-fields select,.text-authoring-fields textarea{box-sizing:border-box;width:100%;min-width:0;background:var(--input-bg,#f5f5f5);color:var(--text,#292929);border:1px solid transparent;border-radius:5px;font:inherit;font-size:12px;padding:7px 8px}
.text-authoring-fields input:focus,.text-authoring-fields select:focus,.text-authoring-fields textarea:focus{outline:1px solid #0d99ff;border-color:#0d99ff}
.text-authoring-fields input:disabled{opacity:.55}
.text-authoring-fields textarea{resize:vertical;min-height:92px;max-height:240px;line-height:1.5}
.text-authoring-fields input[type=color]{height:30px;padding:3px;cursor:pointer}
.text-authoring-fields input[type=checkbox]{width:14px;height:14px;margin:0;accent-color:#0d99ff}
.text-authoring-fields .text-control-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:end}
.text-authoring-fields .text-control-row.three{grid-template-columns:1fr 1fr 1fr}
.text-authoring-fields .text-check{display:flex;gap:7px;align-items:center;min-height:30px}
.text-font-tools{display:flex;gap:6px}.text-font-tools .button{flex:1;justify-content:center;font-size:11px;padding:6px}
.text-authoring-fields .text-font{margin:0;font-size:10px;line-height:1.5;color:var(--muted,#737373)}
.text-authoring-preview{padding:18px 20px;display:flex;flex-direction:column;min-width:0;gap:12px;background:var(--panel,#fff)}
.text-preview-heading{display:flex;justify-content:space-between;font-size:11px;color:var(--muted,#737373)}
.text-preview-surface{position:relative;flex:1;min-height:240px;border:1px solid var(--border,#e5e5e5);border-radius:7px;background:repeating-conic-gradient(#fafafa 0% 25%,#f0f0f0 0% 50%) 0/16px 16px;overflow:hidden}
#text-preview{display:block;width:100%;height:100%;position:absolute;inset:0}
.text-preview-note{font-size:11px;line-height:1.5;color:var(--muted,#737373);min-height:32px;margin:0}
.text-authoring-footer{display:flex;justify-content:space-between;gap:12px;align-items:center;border-top:1px solid var(--border,#e5e5e5);padding:12px 20px}
.text-authoring-footer .dialog-actions{margin:0 0 0 auto;padding-top:0;flex-shrink:0}
.text-authoring-footer .form-error{margin:0;font-size:11px;line-height:1.4;max-width:540px}
.text-authoring-dialog [hidden]{display:none!important}
@media(max-width:680px){.text-authoring-layout{grid-template-columns:minmax(0,1fr)}.text-authoring-fields{border-right:0}.text-authoring-preview{border-top:1px solid var(--border,#e5e5e5)}.text-preview-surface{min-height:200px}.text-authoring-footer{align-items:flex-end}.text-authoring-footer .dialog-actions{gap:5px}}
`;

/** An isolated draft. Only Apply invokes the editor callback; previews use a worker. */
export class TextDialog {
  constructor({ dialog, content, onClose = () => {}, fontService = null }) {
    Object.assign(this, { dialog, content, onClose, fontService });
    if (!document.getElementById("text-authoring-style")) {
      const style = document.createElement("style");
      style.id = "text-authoring-style";
      style.textContent = CSS;
      document.head.append(style);
    }
    this.sequence = 0;
    this.generation = 0;
  }
  async open({ figure = null, initialOptions = {}, onApply }) {
    this.cleanup();
    this.events = new AbortController();
    this.pending = new Map();
    this.fonts = new Map();
    this.installed = [];
    this.source = figure;
    this.onApply = onApply;
    this.initial = {
      ...defaults,
      ...(figure
        ? readTextFigureOptions(figure, {
            assetIndex: initialOptions.assetIndex,
          })
        : {}),
      ...initialOptions,
    };
    this.result = null;
    this.lastKey = "";
    this.applying = false;
    const o = this.initial;
    this.paint = o.paint ?? segmentPaint({color_rgb:o.color,transparency:Math.round((1-o.opacity)*255),secondary:o.gradientColor?{rgb:o.gradientColor,a:Math.round((1-o.opacity)*255)}:null});
    this.fontId =
      !figure ||
      (figure._styk?.textAuthoring &&
        (figure._styk.textAuthoring.assetIndex ?? 0) === o.assetIndex &&
        o.fontFamily === "Noto Sans" &&
        ["bundled", undefined].includes(figure._styk.textAuthoring.fontOrigin))
        ? "bundled"
        : "embedded";
    this.dialog.classList.add("text-authoring-dialog");
    this.content.innerHTML = `<div class="dialog-head"><h2>${figure ? "Edit text" : "Create text"}</h2><button class="icon-button" data-text-close aria-label="Close text editor">${icon("close")}</button></div>
      <div class="dialog-body"><div class="text-authoring-layout"><div class="text-authoring-fields">
      <label>Text<textarea id="text-content" maxlength="16384" spellcheck="false">${esc(o.text)}</textarea></label>
      <label>Font<select id="text-font" aria-label="Font">${figure ? `<option value="embedded">${esc(o.fontFamily)} · embedded outlines</option>` : ""}<option value="bundled">Noto Sans · bundled</option></select></label>
      <div class="text-font-tools"><button class="button" id="text-font-file-button">${icon("folder")}Open font…</button><button class="button" id="text-local-fonts" ${this.fontService?.listFonts || typeof globalThis.queryLocalFonts === "function" ? "" : "hidden"}>Installed fonts…</button><input type="file" id="text-font-file" accept=".ttf,.otf,font/ttf,font/otf" hidden></div>
      <div id="text-installed-picker" hidden><label>Find a font<input id="text-font-search" type="search" placeholder="Family or style"></label><label>Installed font<select id="text-installed-font" aria-label="Installed font"></select></label></div>
      <p class="text-font" id="text-font-note"></p>
      <div class="text-control-row"><label><span id="text-size-label">Size · px</span><input id="text-size" type="number" min="1" max="2048" step="any" value="${o.fontSize}"></label><label>Line height<input id="text-line-height" type="number" min="0.5" max="5" step="0.1" value="${o.lineHeight}"></label></div>
      <div class="text-control-row"><label class="text-check"><input id="text-bold" type="checkbox" ${o.bold ? "checked" : ""}>Bold</label><label class="text-check"><input id="text-italic" type="checkbox" ${o.italic ? "checked" : ""}>Italic</label></div>
      <label>Alignment<select id="text-alignment"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
      <div class="text-control-row"><label>Fill<input id="text-color" type="color" value="${hex(o.color)}"></label><label>Opacity · %<input id="text-opacity" type="number" min="0" max="100" step="any" value="${o.opacity * 100}"></label></div>
      <div class="text-control-row" hidden><label class="text-check"><input id="text-gradient-enabled" type="checkbox" ${o.gradientColor ? "checked" : ""}>Gradient</label><label>End color<input id="text-gradient-color" type="color" value="${hex(o.gradientColor || [121, 98, 235])}"></label></div>
      <div class="text-control-row"><label>Outline · px<input id="text-outline-width" type="number" min="0" max="128" step="any" value="${o.outlineWidth}"></label><label>Outline color<input id="text-outline-color" type="color" value="${hex(o.outlineColor)}"></label></div>
      </div><div class="text-authoring-preview"><div class="text-preview-heading"><span>Live preview · Fit</span><span id="text-preview-state" aria-live="polite">Preparing…</span></div><div class="text-preview-surface"><canvas id="text-preview" aria-label="Portable vector text preview"></canvas></div><p class="text-preview-note" id="text-preview-note">Text is saved as vector outlines and stays portable across computers.</p></div></div></div>
      <div class="text-authoring-footer"><p id="text-error" class="form-error" role="alert" hidden></p><div class="dialog-actions"><button class="button" data-text-close>Cancel</button><button class="button primary" id="create-text" disabled>${figure ? "Apply changes" : "Create text"}</button></div></div>`;
    this.$ = (id) => this.content.querySelector("#" + id);
    this.$("text-color").paintPicker = () => ({anchor:this.$("text-color"),paint:this.paint,onChange:paint=>{
      this.paint=paint;this.$("text-color").value=hexColor(paint.stops[0].color);this.$("text-opacity").value=paint.stops[0].opacity*100;
      this.$("text-gradient-enabled").checked=paint.type!=='solid';this.$("text-gradient-color").value=hexColor(paint.stops.at(-1).color);this.schedule();
    }});

    this.$("text-font").value = this.fontId;
    this.$("text-alignment").value = o.alignment;
    this.fontVisibility(true);
    this.worker = new Worker(
      new URL("./text-authoring-worker.mjs", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error)
        request.reject(
          Object.assign(new Error(data.error.message), data.error),
        );
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      const error = new Error(
        event.message || "The text worker stopped. Reopen the text editor.",
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.showError(error);
    };
    const signal = this.events.signal;
    this.content.addEventListener(
      "click",
      (event) => {
        if (event.target.closest("[data-text-close]")) this.close();
      },
      { signal },
    );
    this.content.addEventListener(
      "input",
      (event) => {
        if (
          [
            "text-font-file",
            "text-font-search",
            "text-installed-font",
            "text-font",
          ].includes(event.target.id)
        )
          return;
        this.schedule();
      },
      { signal },
    );
    this.$("text-font").addEventListener(
      "change",
      () => {
        this.fontId = this.$("text-font").value;
        this.fontVisibility(true);
        this.schedule(0);
      },
      { signal },
    );
    this.$("text-font-file-button").addEventListener(
      "click",
      () => this.$("text-font-file").click(),
      { signal },
    );
    this.$("text-font-file").addEventListener(
      "change",
      async () => {
        const file = this.$("text-font-file").files[0];
        if (!file) return;
        try {
          this.beginFontChange();
          if (file.size > MAX_FONT_BYTES)
            throw new Error("Choose a font smaller than 32 MB.");
          await this.addFont(await file.arrayBuffer(), file.name);
        } catch (error) {
          this.showError(error);
        }
        if (!signal.aborted) this.$("text-font-file").value = "";
      },
      { signal },
    );
    this.$("text-local-fonts").addEventListener(
      "click",
      () => this.listInstalledFonts(),
      { signal },
    );
    this.$("text-font-search").addEventListener(
      "input",
      () => this.populateInstalledFonts(),
      { signal },
    );
    this.$("text-installed-font").addEventListener(
      "change",
      () => this.chooseInstalledFont(),
      { signal },
    );
    this.$("create-text").addEventListener("click", () => this.apply(), {
      signal,
    });
    this.dialog.addEventListener(
      "close",
      () => {
        this.cleanup();
        this.onClose();
      },
      { signal },
    );
    this.dialog.addEventListener(
      "cancel",
      (event) => {
        if (this.applying) {
          event.preventDefault();
          return;
        }
        this.close();
      },
      { signal },
    );
    this.resize = new ResizeObserver(() => {
      if (this.result) drawTextPreview(this.$("text-preview"), this.result);
    });
    this.resize.observe(this.$("text-preview"));
    if (!this.dialog.open) this.dialog.showModal();
    this.$("text-content").focus();
    try {
      await this.request("source", { figure });
      if (!signal.aborted) await this.compile();
    } catch (error) {
      if (!signal.aborted) this.showError(error);
    }
  }
  request(type, data = {}, transfer = []) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...data }, transfer);
    });
  }
  fontVisibility(resetSize = false) {
    const embedded = this.fontId === "embedded",
      face = this.fonts.get(this.fontId);
    const unknownSize = embedded && !this.initial.fontSizeKnown;
    this.$("text-size-label").textContent = unknownSize
      ? "Scale · %"
      : "Size · px";
    this.$("text-size").min = unknownSize ? ".01" : "1";
    this.$("text-size").max = unknownSize ? "4000" : "2048";
    if (resetSize)
      this.$("text-size").value = unknownSize ? 100 : this.initial.fontSize;
    for (const key of ["bold", "italic"]) {
      this.$("text-" + key).disabled = this.fontId !== "bundled";
      if (embedded || face)
        this.$("text-" + key).checked = (face || this.initial)[key];
    }
    this.$("text-font-note").textContent = embedded
      ? `${this.initial.fontFamily}. Existing glyphs stay unchanged. ${unknownSize ? "Pivot stores outlines without the original font size. " : ""}Choose a font for new characters or exact new spacing.`
      : face
        ? `${face.family} · ${face.style}. This face’s outlines will be embedded.`
        : "Noto Sans · 4 bundled styles. No font installation required.";
  }
  options() {
    const value = (key) =>
      this.$(key).value.trim() === "" ? NaN : Number(this.$(key).value);
    return {
      text: this.$("text-content").value,
      name:
        this.source?.name ||
        this.$("text-content").value.trim().slice(0, 60) ||
        "Text",
      figureTypeId: this.initial.figureTypeId || 1,
      assetIndex: this.initial.assetIndex,
      fontSize:
        this.fontId === "embedded" && !this.initial.fontSizeKnown
          ? this.initial.fontSize
          : value("text-size"),
      embeddedScale:
        this.fontId === "embedded" && !this.initial.fontSizeKnown
          ? value("text-size")
          : 100,
      bold: this.$("text-bold").checked,
      italic: this.$("text-italic").checked,
      lineHeight: value("text-line-height"),
      alignment: this.$("text-alignment").value,
      color: rgb(this.$("text-color").value),
      opacity: value("text-opacity") / 100,
      paint: this.paint,
      gradientColor: this.$("text-gradient-enabled").checked
        ? rgb(this.$("text-gradient-color").value)
        : null,
      outlineWidth: value("text-outline-width"),
      outlineColor: rgb(this.$("text-outline-color").value),
    };
  }
  schedule(delay = 100) {
    this.paint.stops[0].opacity=Number(this.$('text-opacity').value)/100;

    clearTimeout(this.timer);
    this.generation++;
    this.result = null;
    this.$("create-text").disabled = true;
    this.$("text-preview-state").textContent = "Updating…";
    this.timer = setTimeout(() => this.compile(), delay);
  }
  async compile() {
    clearTimeout(this.timer);
    // One in-flight outline layout and one replaceable latest draft. Typing into
    // a complex font cannot accumulate a queue of obsolete worker compilations.
    if (this.compilePromise) {
      this.compileAgain = true;
      return this.compilePromise;
    }
    const signal = this.events.signal;
    const job = (async () => {
      do {
        this.compileAgain = false;
        await this.compileOnce();
      } while (this.compileAgain && !signal.aborted);
      return signal.aborted ? null : this.result;
    })();
    this.compilePromise = job;
    try {
      return await job;
    } finally {
      if (this.compilePromise === job) this.compilePromise = null;
    }
  }
  async compileOnce() {
    const generation = ++this.generation,
      options = this.options(),
      fontId = this.fontId;
    const key = JSON.stringify([options, fontId]);
    this.$("create-text").disabled = true;
    try {
      const figure = await this.request("compile", { options, fontId });
      if (generation !== this.generation || this.events.signal.aborted)
        return null;
      this.result = figure;
      this.lastKey = key;
      this.$("text-error").hidden = true;
      this.$("text-preview-state").textContent = "Ready";
      this.$("text-preview-note").textContent = figure._styk.textAuthoring
        .spacingEstimated
        ? "New spacing is estimated from the embedded glyphs. Choose the original font for exact spacing."
        : "Text is saved as vector outlines and stays portable across computers.";
      drawTextPreview(this.$("text-preview"), figure);
      this.$("create-text").disabled = this.applying;
      return figure;
    } catch (error) {
      if (generation === this.generation && !this.events.signal.aborted) {
        this.result = null;
        this.showError(error);
        this.$("text-preview-state").textContent = "Check text";
      }
      return null;
    }
  }
  async addFont(buffer, name) {
    const signal = this.events.signal;
    this.beginFontChange();
    const face = await this.request("font", { buffer, name }, [buffer]);
    if (signal.aborted) return;
    this.fonts.set(face.id, face);
    this.fontId = face.id;
    this.$("text-font").add(
      new Option(`${face.family} · ${face.style}`, face.id),
    );
    this.$("text-font").value = face.id;
    this.fontVisibility(true);
    await this.compile();
  }
  async listInstalledFonts() {
    const signal = this.events.signal;
    try {
      // Local Font Access is requested only from this explicit user gesture.
      const native = typeof this.fontService?.listFonts === "function";
      const fonts = native
        ? await this.fontService.listFonts()
        : await globalThis.queryLocalFonts();
      if (signal.aborted) return;
      this.installed = (Array.isArray(fonts) ? fonts : fonts?.fonts || [])
        .slice(0, 5000)
        .map((font, index) => ({
          font,
          index,
          native,
          label:
            font.fullName ||
            `${font.family || font.name} ${font.style || ""}`.trim(),
        }));
      this.installed.sort((a, b) => a.label.localeCompare(b.label));
      this.$("text-installed-picker").hidden = false;
      this.populateInstalledFonts();
      this.$("text-font-search").focus();
      if (!this.installed.length)
        throw new Error(
          "No accessible outline fonts were found. Open a TTF or OTF font file.",
        );
    } catch (error) {
      if (!signal.aborted)
        this.showError(
          new Error(
            error.name === "NotAllowedError"
              ? "Font access was not granted. You can still open a TTF or OTF file."
              : error.message,
          ),
        );
    }
  }
  populateInstalledFonts() {
    const query = this.$("text-font-search").value.toLowerCase(),
      select = this.$("text-installed-font");
    select.replaceChildren(new Option("Choose a font…", ""));
    for (const entry of this.installed)
      if (entry.label.toLowerCase().includes(query))
        select.add(new Option(entry.label, String(entry.index)));
  }
  async chooseInstalledFont() {
    const entry = this.installed.find(
      (font) => String(font.index) === this.$("text-installed-font").value,
    );
    if (!entry) return;
    const signal = this.events.signal;
    try {
      this.beginFontChange();
      let data = entry.native
        ? await this.fontService.readFont(entry.font.id)
        : await entry.font.blob();
      if (signal.aborted) return;
      data = data?.bytes ?? data;
      if (data instanceof Blob) {
        if (data.size > MAX_FONT_BYTES)
          throw new Error("Choose a font smaller than 32 MB.");
        data = await data.arrayBuffer();
      }
      if (ArrayBuffer.isView(data))
        data = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        );
      if (Array.isArray(data)) data = Uint8Array.from(data).buffer;
      if (!(data instanceof ArrayBuffer))
        throw new Error("The font service did not return font bytes.");
      if (!signal.aborted) await this.addFont(data, entry.label);
    } catch (error) {
      if (!signal.aborted) this.showError(error);
    }
  }
  showError(error) {
    if (!this.events || this.events.signal.aborted) return;
    this.$("text-error").textContent = error.message;
    this.$("text-error").hidden = false;
    if (this.$("text-preview-state").textContent === "Reading font…")
      this.$("text-preview-state").textContent = "Choose a font";
  }
  beginFontChange() {
    clearTimeout(this.timer);
    this.generation++;
    this.result = null;
    this.$("create-text").disabled = true;
    this.$("text-preview-state").textContent = "Reading font…";
  }
  async apply() {
    if (this.applying) return;
    const key = JSON.stringify([this.options(), this.fontId]);
    const figure =
      this.result && key === this.lastKey ? this.result : await this.compile();
    if (!figure) return;
    this.applying = true;
    this.$("create-text").disabled = true;
    this.$("create-text").textContent = "Applying…";
    try {
      await this.onApply(figure);
      this.applying = false;
      this.close();
    } catch (error) {
      this.applying = false;
      this.showError(error);
      this.$("create-text").disabled = false;
      this.$("create-text").textContent = this.source
        ? "Apply changes"
        : "Create text";
    }
  }
  close() {
    if (this.applying) return;
    this.dialog.close();
    // Native close events are queued; release the worker immediately so a rapid
    // Escape/reopen cannot keep the previous authoring session alive.
    this.cleanup();
    this.onClose();
  }
  cleanup() {
    clearTimeout(this.timer);
    this.generation++;
    this.compilePromise = null;
    this.compileAgain = false;
    this.events?.abort();
    this.resize?.disconnect();
    this.worker?.terminate();
    for (const request of this.pending?.values() || [])
      request.reject(new DOMException("Text editor closed.", "AbortError"));
    this.pending?.clear();
    this.dialog.classList.remove("text-authoring-dialog");
  }
  destroy() {
    this.cleanup();
  }
}
