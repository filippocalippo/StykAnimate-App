import {backgroundPaint, paintBackground, paintCSS} from './paint.mjs';
import {
  drawBackground,
  gradientAngleFromBackground,
} from "./pivot/background.mjs";
import { icon } from "./icons.mjs";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const hex = (value) =>
  "#" + ((value ?? 0xffffffff) & 0xffffff).toString(16).padStart(6, "0");
const alpha = (value) => (((value ?? 0xffffffff) >>> 24) / 255) * 100;
const defaults = (kind) =>
  kind === 4
    ? { x1: 0.5, y1: 0.5, x2: 0, y2: 0.7 }
    : { x1: 0.5, y1: 0, x2: 0.5, y2: 1 };

/** A background draft never mutates an asset shared by other native frames. */
export class BackgroundDialog {
  constructor({ dialog, content, resources = {}, onError = () => {} }) {
    Object.assign(this, { dialog, content, resources, onError });
    if (!document.getElementById("background-dialog-style")) {
      const style = document.createElement("style");
      style.id = "background-dialog-style";
      style.textContent =
        ".background-dialog input:not([type=color]),.background-dialog select{box-sizing:border-box;font:inherit;font-size:11px;min-width:0;border:1px solid transparent;border-radius:4px;background:#f2f2f2;padding:7px 9px;color:#2c2c2c;height:32px}.background-dialog input:focus,.background-dialog select:focus{outline:1px solid #0d99ff}.background-dialog .text-options label{min-width:0}.background-dialog .text-options input{width:100%}.background-dialog input[type=color]{height:32px;border:0;border-radius:4px;background:#f2f2f2;padding:5px}.background-dialog .text-options{gap:10px}.background-dialog [hidden]{display:none!important}";
      document.head.append(style);
    }
  }
  open({ report, frame, onUse, onCreate, onRename }) {
    this.events?.abort();
    this.events = new AbortController();
    this.loadingImages = new WeakSet();
    this.busy = false;
    const events = this.events;
    this.dialog.addEventListener(
      "close",
      () => {
        if (!this.dialog.open) events.abort();
      },
      { once: true, signal: events.signal },
    );
    Object.assign(this, { report, onUse, onCreate, onRename });
    const original = report.backgrounds?.find(
      (bg) => bg.background_id === frame.background_id,
    );
    this.content.innerHTML = `<div class="dialog-head"><h2>Background</h2><button class="icon-button" data-bg-close aria-label="Close dialog">${icon("close")}</button></div>
      <div class="dialog-body background-dialog">
        <label class="field-label" for="background-search">Library</label>
        <input id="background-search" class="inline-select" type="search" placeholder="Search backgrounds" aria-label="Search backgrounds">
        <select id="background-library" class="inline-select" aria-label="Background library"></select>
        <div class="text-options"><label>Name<input id="background-name" maxlength="160" aria-label="Background name"></label><button class="button" id="rename-background">Rename</button></div>
        <canvas id="background-preview" height="110" aria-label="Background preview" style="display:block;max-width:100%;margin:12px auto;border:1px solid #dedede;background:repeating-conic-gradient(#eee 0% 25%,#fff 0% 50%) 0 / 12px 12px"></canvas>
        <div class="text-options"><label>Fill<select id="background-kind"><option value="1">Image</option><option value="2">Solid</option><option value="3">Linear gradient</option><option value="4">Radial gradient</option></select></label><label data-bg-linear>Angle<input id="background-angle" type="number" step="any" aria-label="Gradient angle"></label></div>
        <div class="text-options" data-bg-fill><label>Color<input type="color" id="background-first"></label><label>Opacity %<input id="background-alpha" type="number" min="0" max="100" step="any"></label><label data-bg-gradient>Second color<input type="color" id="background-second"></label><label data-bg-gradient>Opacity %<input id="background-alpha-b" type="number" min="0" max="100" step="any"></label></div>
        <div data-bg-gradient><div class="text-options"><label><span data-bg-coordinate="x1">Start X</span><input id="background-x1" type="number" step="any"></label><label><span data-bg-coordinate="y1">Start Y</span><input id="background-y1" type="number" step="any"></label></div><div class="text-options"><label><span data-bg-coordinate="x2">End X</span><input id="background-x2" type="number" step="any"></label><label><span data-bg-coordinate="y2">End Y</span><input id="background-y2" type="number" step="any"></label></div></div>
        <p id="background-error" class="form-error" role="alert" hidden></p>
        <div class="dialog-actions"><button class="button" id="use-background">Use selected</button><button class="button primary" id="create-background">Apply fill</button></div>
      </div>`;
    this.$ = (id) => this.content.querySelector("#" + id);
    this.selection = original?.background_id ?? 0;
    this.populate();
    this.select(this.selection);
    const trigger=document.createElement('button');trigger.type='button';trigger.className='paint-trigger';trigger.id='background-paint';trigger.dataset.paintPicker='';trigger.setAttribute('aria-label','Background fill');
    this.$('background-preview').after(trigger);
    this.paintTrigger=trigger;
    const refresh=()=>{trigger.textContent=this.paint.type==='solid'?'Solid color':this.paint.type[0].toUpperCase()+this.paint.type.slice(1)+' gradient';trigger.style.borderLeft='24px solid '+(this.paint.type==='solid'?paintCSS(this.paint):'#0d99ff');};
    trigger.paintPicker=()=>({anchor:trigger,paint:this.paint,onChange:paint=>{this.paint=paint;this.paintDirty=true;this.$("background-kind").value=paintBackground(paint).kind;refresh();this.preview();}});refresh();
    for(const node of [this.$('background-kind').closest('.text-options'),this.$('background-first').closest('.text-options'),this.content.querySelector('div[data-bg-gradient]')])node.style.display='none';
    this.content.addEventListener(
      "click",
      (event) => {
        if (event.target.closest("[data-bg-close]")) this.dialog.close();
      },
      { signal: this.events.signal },
    );
    this.$("background-search").addEventListener(
      "input",
      () => this.populate(),
      { signal: this.events.signal },
    );
    this.$("background-library").addEventListener(
      "change",
      (event) => this.select(Number(event.target.value)),
      { signal: this.events.signal },
    );
    this.content.addEventListener(
      "input",
      (event) => {
        if (
          event.target.id === "background-kind" ||
          event.target.id === "background-search"
        )
          return;
        try {
          if (event.target.id === "background-angle") this.rotateEndpoints();
          else if (/^background-[xy][12]$/.test(event.target.id))
            this.setNumber(
              "background-angle",
              gradientAngleFromBackground({ ...this.draft(), kind: 3 }),
            );
          this.preview();
        } catch (error) {
          this.error(error);
        }
      },
      { signal: this.events.signal },
    );
    this.$("background-kind").addEventListener(
      "change",
      () => {
        const kind = Number(this.$("background-kind").value);
        for (const [key, value] of Object.entries(defaults(kind)))
          this.setNumber(
            "background-" + key,
            value,
            this.coordinateScale(kind, key),
          );
        this.setNumber("background-angle", 90);
        this.visibility();
        this.preview();
      },
      { signal: this.events.signal },
    );
    this.$("use-background").onclick = () =>
      this.run(() => onUse(this.selection));
    this.$("create-background").onclick = () =>
      this.run(() => onCreate(this.draft()));
    this.$("rename-background").onclick = () =>
      this.run(async () => {
        await onRename(this.selection, this.$("background-name").value.trim());
        this.populate();
      }, false);
    if (!this.dialog.open) this.dialog.showModal();
  }
  populate() {
    const query = this.$("background-search").value.toLowerCase();
    const backgrounds = this.report.backgrounds || [];
    this.$("background-library").innerHTML =
      `<option value="0">White</option>` +
      backgrounds
        .filter(
          (bg) =>
            bg.background_id === this.selection ||
            (bg.name || "").toLowerCase().includes(query),
        )
        .map(
          (bg) =>
            `<option value="${bg.background_id}">${esc(bg.name || `Background ${bg.background_id}`)}</option>`,
        )
        .join("");
    this.$("background-library").value = this.selection;
  }
  select(id) {
    this.selection = id;
    this.selected = this.report.backgrounds?.find(
      (bg) => bg.background_id === id,
    );
    const bg = this.selected || { kind: 2, color: 0xffffffff, name: "White" };
    this.paint=backgroundPaint(bg);this.paintDirty=Boolean(bg.paint);
    if(this.paintTrigger?.isConnected)this.paintTrigger.textContent=this.paint.type==='solid'?'Solid color':this.paint.type+' gradient';
    const kind = [2, 3, 4].includes(bg.kind) ? bg.kind : 1;
    this.$("background-kind").value = kind;
    this.$("background-kind").querySelector('[value="1"]').disabled =
      !this.selected || kind !== 1;
    this.$("background-name").value = bg.name || "";
    this.$("background-first").value = hex(bg.color ?? bg.color_a);
    this.$("background-second").value = hex(bg.color_b ?? 0xffddeeff);
    this.setNumber("background-alpha", alpha(bg.color ?? bg.color_a));
    this.setNumber("background-alpha-b", alpha(bg.color_b));
    this.setNumber("background-angle", gradientAngleFromBackground(bg));
    for (const [key, value] of Object.entries(defaults(kind)))
      this.setNumber(
        "background-" + key,
        bg[key] ?? value,
        this.coordinateScale(kind, key),
      );
    this.$("rename-background").disabled = !id || !this.onRename;
    this.visibility();
    this.preview();
  }
  visibility() {
    const kind = Number(this.$("background-kind").value);
    for (const element of this.content.querySelectorAll("[data-bg-fill]"))
      element.hidden = kind === 1;
    for (const element of this.content.querySelectorAll("[data-bg-gradient]"))
      element.hidden = kind < 3;
    for (const element of this.content.querySelectorAll("[data-bg-linear]"))
      element.hidden = kind !== 3;
    const labels =
      kind === 4
        ? [
            "Center X · px",
            "Center Y · px",
            "Inner radius · px",
            "Outer radius · px",
          ]
        : ["Start X · px", "Start Y · px", "End X · px", "End Y · px"];
    ["x1", "y1", "x2", "y2"].forEach(
      (key, index) =>
        (this.content.querySelector(
          `[data-bg-coordinate="${key}"]`,
        ).textContent = labels[index]),
    );
    this.$("create-background").disabled = kind === 1;
  }
  coordinateScale(kind, key) {
    return key === "x1" || (kind === 3 && key === "x2")
      ? this.report.canvas_width
      : this.report.canvas_height;
  }
  setNumber(id, value, factor = 1) {
    const input = this.$(id);
    input.value = Number((value * factor).toFixed(2));
    input.dataset.factor = factor;
    input.dataset.raw = value;
    input.dataset.original = input.value;
  }
  number(id) {
    const input = this.$(id);
    const value =
      input.value === input.dataset.original
        ? Number(input.dataset.raw)
        : input.valueAsNumber / Number(input.dataset.factor || 1);
    if (!Number.isFinite(value))
      throw new Error("Enter finite gradient coordinates.");
    return value;
  }
  rotateEndpoints() {
    const x1 = this.number("background-x1"),
      y1 = this.number("background-y1");
    const x2 = this.number("background-x2"),
      y2 = this.number("background-y2");
    const angle = (this.number("background-angle") * Math.PI) / 180,
      half = Math.hypot(x2 - x1, y2 - y1) / 2 || 0.5;
    const cx = (x1 + x2) / 2,
      cy = (y1 + y2) / 2;
    for (const [key, value] of Object.entries({
      x1: cx - Math.cos(angle) * half,
      y1: cy - Math.sin(angle) * half,
      x2: cx + Math.cos(angle) * half,
      y2: cy + Math.sin(angle) * half,
    }))
      this.setNumber("background-" + key, value, this.coordinateScale(3, key));
  }
  draft() {
    if(this.paintDirty && this.paint && Number(this.$('background-kind').value)!==1)return {...paintBackground(this.paint),name:this.$('background-name').value.trim()||'Background fill'};
    const kind = Number(this.$("background-kind").value);
    if (kind === 1) return this.selected;
    const argb = (colorId, opacityId) => {
      const opacity = this.number(opacityId);
      if (opacity < 0 || opacity > 100)
        throw new Error("Opacity must be between 0 and 100.");
      return (
        ((Math.round((opacity * 255) / 100) << 24) |
          parseInt(this.$(colorId).value.slice(1), 16)) >>>
        0
      );
    };
    const name =
      this.$("background-name").value.trim() ||
      (kind === 2
        ? "Solid color"
        : kind === 3
          ? "Linear gradient"
          : "Radial gradient");
    const result = {
      kind,
      name,
      color: argb("background-first", "background-alpha"),
    };
    if (kind >= 3) {
      result.color_a = result.color;
      delete result.color;
      result.color_b = argb("background-second", "background-alpha-b");
      for (const key of ["x1", "y1", "x2", "y2"])
        result[key] = this.number("background-" + key);
      if (kind === 4 && (result.x2 < 0 || result.y2 < 0))
        throw new Error("Radial gradient radii must be zero or greater.");
    }
    return result;
  }
  preview() {
    const bg = this.draft(),
      canvas = this.$("background-preview");
    canvas.width = Math.max(
      1,
      Math.min(
        400,
        Math.round(
          (110 * this.report.canvas_width) / this.report.canvas_height,
        ),
      ),
    );
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    const report = { backgrounds: [{ ...bg, background_id: 1 }] };
    const resources = {
      ...this.resources,
      image: (url) => {
        const image = this.resources.image?.(url);
        if (image && !image.complete && !this.loadingImages.has(image)) {
          this.loadingImages.add(image);
          image.addEventListener(
            "load",
            () => {
              if (canvas.isConnected && this.dialog.open) this.preview();
            },
            { once: true, signal: this.events.signal },
          );
          image.addEventListener(
            "error",
            () => {
              if (canvas.isConnected && this.dialog.open)
                this.error(
                  new Error("The background image could not be decoded."),
                );
            },
            { once: true, signal: this.events.signal },
          );
        }
        return image;
      },
    };
    drawBackground(
      context,
      report,
      { background_id: 1 },
      canvas.width,
      canvas.height,
      resources,
    );
    this.$("background-error").hidden = true;
  }
  error(error) {
    this.$("background-error").textContent = error.message;
    this.$("background-error").hidden = false;
  }
  async run(action, close = true) {
    if (this.busy) return;
    this.busy = true;
    try {
      await action();
      if (close) this.dialog.close();
    } catch (error) {
      this.error(error);
    } finally {
      this.busy = false;
    }
  }
  destroy() {
    this.events?.abort();
  }
}
