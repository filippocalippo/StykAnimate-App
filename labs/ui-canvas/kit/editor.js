/* A working stand-in for the editor, drawn like the app (top band, tool rail, stage,
   inspector, Simple timeline). It is enough to teach on: joints drag as in Pivot,
   Add frame keeps a pose, onion skin shows the last one and Play tweens the frames.
   Lessons listen to its events and ask it where things are. */
(function () {
  "use strict";
  const S = window.Styk;
  const { el, icon } = S;
  const W = 960, H = 540, K = 1.45, GROUND = 452;
  const INBETWEENS = 9;

  class Editor {
    constructor(host, opts = {}) {
      S.emitter(this);
      this.opts = opts;
      this.name = opts.name || "First steps";
      this.build(host);
      this.reset();
      addEventListener("resize", () => this.emit("layout"));
      // File and Help are the two menus that lead back to the hub and to the lessons.
      this.on("menu", ({ name, anchor }) => {
        if (name === "file") S.menu([{ text: S.hubLabel || "Home", icon: "home", run: () => S.go("hub") }, "-", { text: "New animation", icon: "new-file", kbd: "Ctrl+N" }, { text: "Open…", icon: "folder", kbd: "Ctrl+O" }, { text: "Open recent", icon: "clock", sub: true }, "-",
          { text: "Save", icon: "save", kbd: "Ctrl+S" }, { text: "Save as…", kbd: "Ctrl+Shift+S" }, "-", { text: "Export…", icon: "export", kbd: "Ctrl+Shift+E" }], anchor);
        else if (name === "help") S.menu([{ text: "Lessons", icon: "learn", run: () => S.go(S.learnState || "hub") }, { text: "Start “First steps”", icon: "play", run: () => S.go("lesson") }, "-", { text: "Keyboard shortcuts", icon: "keyboard", run: S.docSheet },
          { text: "What’s new", icon: "sparkle" }, { text: "Send feedback", icon: "message" }], anchor);
        else S.toast("Only File and Help open in this mockup");
      });
      document.addEventListener("keydown", (e) => {
        if (!this.root.offsetParent || e.target.closest("input, textarea")) return;
        if (e.code === "Space") { e.preventDefault(); this.toggle(); }
        if (e.key === "a" || e.key === "A") this.addFrame();
      });
    }

    reset() {
      this.stop(true);
      this.frames = [S.stand("stand", 430, GROUND, K)];
      this.cur = 0; this.onion = true; this.demoing = false;
      this.setWorkspace("animate", true);
      this.render();
    }

    /* ---------------- structure */
    build(host) {
      const b = (name, label, more = {}) => el("button", Object.assign({ class: "icon-btn", "aria-label": label, title: label, html: icon(name, 18) }, more));
      const wsItem = (id, label, tint, ic) => el("button", { class: "seg-item", "data-ws": id, "aria-pressed": "false", onclick: () => this.setWorkspace(id) },
        ic ? el("span", { class: "seg-ico", html: icon(ic, 15) }) : el("span", { class: "dot", "data-tint": tint }), el("span", { text: label }));
      this.ws = el("div", { class: "seg seg-lg ed-ws", role: "group", "aria-label": "Editing workspace", "data-tour": "workspace" },
        this.opts.home ? wsItem("home", "Home", null, "home") : null, wsItem("animate", "Animate", "select"), wsItem("draw", "Draw", "draw"), wsItem("build", "Build", "library"));
      this.docName = el("b", { text: this.name });
      this.exportBtn = el("button", { class: "btn btn-lg", "data-variant": "primary", "data-tour": "export", html: `${icon("export", 16)}<span>Export</span>`, onclick: () => { this.emit("export"); S.toast("Export would open here"); } });
      const band = el("header", { class: "ed-band" },
        el("div", { class: "ed-band-start" },
          el("button", { class: "ed-brand", "aria-label": "Main menu" }, el("img", { src: "../../symbol.svg", alt: "", width: 17, height: 21 }), el("span", { html: icon("chevron-down", 12) })),
          el("nav", { class: "ed-menubar", "aria-label": "Application menu" }, ["File", "Edit", "View", "Joint", "Animation", "Help"].map((m) => el("button", { text: m, "data-menu": m.toLowerCase(), onclick: (e) => this.emit("menu", { name: m.toLowerCase(), anchor: e.currentTarget }) }))),
          el("button", { class: "ed-doc" }, this.docName, el("span", { class: "dot", "data-tone": "success" }), el("span", { text: "Saved" }))),
        el("div", { class: "ed-band-center" }, this.ws),
        el("div", { class: "ed-band-end" }, b("undo", "Undo"), b("redo", "Redo"),
          el("button", { class: "btn", "data-variant": "ghost", html: `${icon("save", 16)}<span>Save</span>` }), this.exportBtn, S.windowControls()));

      // stage
      this.msgSlot = el("div", { class: "ed-msg-slot" });
      const toggle = (ic, label, on, chev) => el("button", { class: "ed-toggle", "aria-pressed": String(!!on), html: `${icon(ic, 16)}<span>${label}</span>${chev ? icon("chevron-down", 12) : ""}` });
      const head = el("div", { class: "ed-stage-head" },
        el("div", { class: "ed-crumb" }, el("span", { html: icon("scene", 16) }), el("b", { text: "Scene" }), el("span", { text: "960 × 540" }), el("i", { class: "ed-crumb-chip" })),
        this.msgSlot,
        el("div", { class: "ed-view" }, toggle("joints", "Joints", true), toggle("motion-path", "Paths", false, true), toggle("grid", "Grid", false, true), toggle("fx", "Effects", true),
          el("button", { class: "ed-zoom", html: `<b>87%</b>${icon("chevron-down", 12)}` }), b("fit", "Fit canvas")));
      const tool = (ic, label, id, tick) => el("button", { class: "ed-tool" + (tick ? " has-more" : ""), "aria-label": label, title: label, "data-tool": id, "aria-pressed": String(id === "select"), html: icon(ic, 20), onclick: () => this.setTool(id) });
      this.rail = el("nav", { class: "ed-rail", "aria-label": "Tools", "data-tour": "rail" },
        el("span", { class: "ed-rail-grip", html: icon("grip", 14) }), tool("plus", "Add", "add", true), el("i", { class: "ed-rail-sep" }), tool("cursor", "Select and pose", "select"), tool("nodes", "Edit joints", "rig", true), tool("hand", "Pan canvas", "hand"));
      this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      this.svg.setAttribute("class", "ed-scene");
      this.artboard = el("div", { class: "ed-artboard", "data-tour": "artboard" }, this.svg);
      this.desk = el("div", { class: "ed-desk" }, this.rail, this.artboard);
      const stage = el("main", { class: "ed-stage", "aria-label": "Stage" }, head, this.desk);

      // inspector
      this.tabs = el("div", { class: "seg ed-tabs", role: "tablist" });
      this.panels = el("div", { class: "ed-panels" });
      this.right = el("aside", { class: "ed-right island", "aria-label": "Inspector", "data-tour": "inspector" }, el("div", { class: "ed-tabs-row" }, this.tabs), this.panels);
      this.tabList = [];
      this.fieldX = el("b", { text: "430" }); this.fieldY = el("b", { text: "292" });
      const field = (label, value, unit) => el("div", { class: "ed-field" }, el("span", { text: label }), value.nodeType ? value : el("b", { text: value }), unit ? el("span", { text: unit }) : null);
      const sect = (ic, tint, title) => el("div", { class: "ed-sect" }, el("span", { class: "ed-sect-ico", "data-tint": tint, html: icon(ic, 14) }), el("b", { text: title }));
      const quick = (ic, label) => el("button", { class: "ed-quick" }, el("span", { html: icon(ic, 16) }), el("small", { text: label }));
      this.addTab("properties", "Properties", el("div", { class: "ed-props" },
        el("div", { class: "ed-target" }, el("span", { html: icon("person", 16) }), el("b", { text: "Blue" }), el("button", { class: "icon-btn", "aria-label": "Selection actions", html: icon("more", 16) })),
        el("div", { class: "ed-quicks" }, quick("flip", "Flip"), quick("bring-to-front", "Front"), quick("send-to-back", "Back"), quick("duplicate", "Duplicate"), quick("trash", "Delete")),
        sect("arrows-move", "select", "Transform"),
        el("div", { class: "ed-fields" }, field("X", this.fieldX, "px"), field("Y", this.fieldY, "px"), field("Angle", "0°"), field("Scale", "100%")),
        sect("palette", "draw", "Appearance"),
        el("div", { class: "ed-fields" }, el("div", { class: "ed-field" }, el("i", { class: "ed-swatch" }), el("b", { text: "0D99FF" })), field("Opacity", "100%")),
        sect("layers", "library", "Arrange"),
        el("div", { class: "ed-fields" }, el("div", { class: "ed-field" }, el("b", { text: "Layer 1" }), el("span", { class: "push", html: icon("chevron-down", 12) })), field("Order", "0"))));
      this.addTab("vfx", "VFX", el("div", { class: "ed-empty", text: "Effects for the selection" }));
      this.addTab("library", "Library", el("div", { class: "ed-empty", text: "Your saved figures" }));
      this.selectTab("properties");

      // timeline
      this.playBtn = el("button", { class: "ed-play", "aria-label": "Play", title: "Play / pause · Space", "data-tour": "play", html: icon("play", 18), onclick: () => this.toggle() });
      this.addBtn = el("button", { class: "btn", "data-variant": "ghost", "data-tour": "add-frame", html: `${icon("plus", 16)}<span>Add frame</span>`, onclick: () => this.addFrame() });
      this.time = el("span", { class: "ed-time", text: "00:00:00" });
      this.onionBtn = el("button", { class: "icon-btn", "aria-label": "Onion skin", title: "Onion skin · O", "aria-pressed": "true", "data-tour": "onion", html: icon("onion", 18), onclick: () => { this.onion = !this.onion; this.onionBtn.setAttribute("aria-pressed", String(this.onion)); this.render(); } });
      const thead = el("div", { class: "ed-tl-head" },
        el("div", { class: "ed-tl-start" }, el("div", { class: "seg ed-tl-mode" }, el("button", { class: "seg-item", "aria-pressed": "true", text: "Simple" }), el("button", { class: "seg-item", "aria-pressed": "false", text: "Advanced" })), this.addBtn),
        el("div", { class: "ed-transport" }, b("first", "First frame", { onclick: () => this.selectFrame(0) }), b("previous", "Previous frame", { onclick: () => this.selectFrame(this.cur - 1) }), this.playBtn,
          b("next", "Next frame", { onclick: () => this.selectFrame(this.cur + 1) }), b("loop", "Loop playback", { "aria-pressed": "true" }), this.time, el("span", { class: "ed-fps", text: "24 fps" })),
        el("div", { class: "ed-tl-end" }, el("span", { class: "ed-zoomline" }), b("fit", "Fit timeline"), this.onionBtn, b("music", "Audio"), b("more", "More")));
      this.frameInfo = el("div", { class: "ed-frame-info" });
      const stepper = el("div", { class: "ed-stepper" }, el("span", { html: icon("minus", 14) }), el("b", { text: "1" }), el("span", { html: icon("plus", 14) }));
      const side = el("div", { class: "ed-tl-side" }, this.frameInfo,
        el("div", { class: "ed-tl-row" }, el("span", { class: "muted", text: "Inbetweens" }), stepper, el("div", { class: "ed-field grow" }, el("span", { text: "Easing" }), el("b", { text: "Linear" }), el("span", { class: "push", html: icon("chevron-down", 12) }))),
        el("div", { class: "ed-tl-row" }, el("button", { class: "ed-text-btn", text: "Copy" }), el("button", { class: "ed-text-btn", text: "Paste" }), el("button", { class: "icon-btn", "aria-label": "Delete frame", html: icon("trash", 16), onclick: () => this.deleteFrame() })),
        el("div", { class: "ed-tl-row" }, el("span", { html: icon("layers", 16) }), el("b", { text: "Layer" }), el("span", { class: "dot", "data-tint": "select" }), el("b", { text: "Layer 1" }), el("span", { html: icon("chevron-down", 12) })));
      this.strip = el("div", { class: "ed-strip", "data-tour": "filmstrip" });
      this.timeline = el("section", { class: "ed-timeline island", "aria-label": "Timeline", "data-tour": "timeline" }, thead, el("div", { class: "ed-tl-body" }, side, this.strip));

      this.slotTop = el("div", { class: "ed-slot-top" });
      this.work = el("div", { class: "ed-work" }, stage, this.right, this.timeline);
      this.root = el("div", { class: "ed" }, band, this.slotTop, this.work);
      host.append(this.root);
      this.wirePointer();
    }

    addTab(id, label, panel) {
      const tab = el("button", { class: "seg-item", role: "tab", "aria-selected": "false", "data-tab": id, text: label, onclick: () => this.selectTab(id) });
      panel.classList.add("ed-panel"); panel.dataset.panel = id; panel.hidden = true;
      this.tabList.push({ id, tab, panel });
      this.tabs.append(tab); this.panels.append(panel);
      return tab;
    }
    removeTab(id) {
      const i = this.tabList.findIndex((t) => t.id === id);
      if (i < 0) return;
      this.tabList[i].tab.remove(); this.tabList[i].panel.remove(); this.tabList.splice(i, 1);
      this.selectTab("properties");
    }
    selectTab(id) { for (const t of this.tabList) { t.tab.setAttribute("aria-selected", String(t.id === id)); t.panel.hidden = t.id !== id; } }

    setWorkspace(id, quiet) {
      this.workspace = id;
      for (const n of this.ws.children) n.setAttribute("aria-pressed", String(n.dataset.ws === id));
      if (!quiet) this.emit("workspace", id);
    }
    setTool(id) {
      if (id === "add") { S.toast("Add figure, text or image"); return; }
      for (const n of this.rail.querySelectorAll(".ed-tool")) n.setAttribute("aria-pressed", String(n.dataset.tool === id));
      this.emit("tool", id);
    }
    setName(name) { this.name = name; this.docName.textContent = name; }
    // The stage header's one message (experience.md 4.3). Pass null to clear it.
    message(node) { this.msgSlot.replaceChildren(...(node ? [node] : [])); }

    /* ---------------- drawing */
    get pose() { return this.frames[this.cur]; }
    render(live) {
      const p = live || this.pose, playing = !!live;
      let s = `<path d="M150 ${GROUND}H810" stroke="#e2e5ec" stroke-width="4" stroke-linecap="round"/>`;
      if (this.onion && !playing && this.cur > 0) s += `<g class="ed-onion">${S.figureMarkup(this.frames[this.cur - 1], { k: K, color: "#0d99ff", opacity: 0.2 })}</g>`;
      s += `<g class="ed-fig">${S.figureMarkup(p, { k: K, handles: !playing, handleR: 7 })}</g>`;
      this.svg.innerHTML = s;
      if (!playing) { this.fieldX.textContent = Math.round(p.x); this.fieldY.textContent = Math.round(p.y); }
      if (!live) this.renderStrip();
    }
    renderStrip() {
      const n = this.frames.length;
      this.frameInfo.innerHTML = `<b>Frame ${this.cur + 1} of ${n}</b><span>holds 0.08 s</span><span class="push">${(n * 2 / 24).toFixed(1)} s in all</span>`;
      this.strip.replaceChildren(...this.frames.map((p, i) => el("button", { class: "ed-card", "aria-current": String(i === this.cur), "data-frame": i, onclick: () => this.selectFrame(i) },
        el("span", { class: "ed-card-art", html: `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="M150 ${GROUND}H810" stroke="#e2e5ec" stroke-width="5"/>${S.figureMarkup(p, { k: K })}</svg>` }),
        el("span", { class: "ed-card-n", text: i === this.cur ? `${i + 1} · 1 inbetween` : String(i + 1) }), el("i", { class: "ed-card-bar" }))),
        el("button", { class: "ed-card ed-card-ghost", "aria-label": "Add frame", onclick: () => this.addFrame() }, el("span", { class: "ed-card-art", html: icon("plus", 20) })));
      const last = this.strip.children[this.cur];
      if (last && last.scrollIntoView) this.strip.scrollLeft = Math.max(0, last.offsetLeft - this.strip.clientWidth + last.offsetWidth + 190);
    }

    /* ---------------- commands */
    addFrame() {
      if (this.demoing) return;
      this.stop(true);
      this.frames.splice(this.cur + 1, 0, Object.assign({}, this.pose));
      this.cur++;
      this.render();
      this.emit("addFrame", this.cur);
    }
    deleteFrame() { if (this.frames.length > 1) { this.frames.splice(this.cur, 1); this.cur = Math.min(this.cur, this.frames.length - 1); this.render(); } }
    selectFrame(i) { this.stop(true); this.cur = S.clamp(i, 0, this.frames.length - 1); this.render(); this.emit("frame", this.cur); }
    toggle() { if (this.playing) this.stop(); else this.play(); }
    play() {
      if (this.playing || this.demoing) return;
      this.playing = true;
      this.playBtn.innerHTML = icon("pause", 18); this.playBtn.setAttribute("aria-pressed", "true");
      const n = this.frames.length, per = (INBETWEENS + 1) / 24 * 1000, hold = 380, total = Math.max(1, n - 1) * per + hold;
      let t0 = 0;
      const tick = (now) => {
        if (!t0) t0 = now;
        const t = (now - t0) % total, pos = Math.min(n - 1, t / per), i = Math.min(n - 1, Math.floor(pos));
        const p = n > 1 && i < n - 1 ? S.lerpPose(this.frames[i], this.frames[i + 1], S.ease(pos - i)) : this.frames[i];
        this.render(p);
        const f = Math.floor(t / 1000 * 24);
        this.time.textContent = `00:00:${String(f % 100).padStart(2, "0")}`;
        for (const c of this.strip.children) if (c.dataset.frame != null) c.setAttribute("aria-current", String(+c.dataset.frame === Math.round(pos)));
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
      this.emit("play");
    }
    stop(quiet) {
      if (!this.playing) return;
      cancelAnimationFrame(this.raf); this.playing = false;
      this.playBtn.innerHTML = icon("play", 18); this.playBtn.setAttribute("aria-pressed", "false");
      this.time.textContent = "00:00:00";
      this.render();
      if (!quiet) this.emit("stop");
    }

    /* ---------------- posing */
    toScene(e) {
      const m = this.svg.getScreenCTM().inverse();
      return { x: e.clientX * m.a + e.clientY * m.c + m.e, y: e.clientX * m.b + e.clientY * m.d + m.f };
    }
    dragTo(id, pt, from) {
      if (id === "origin") return Object.assign({}, from, { x: S.clamp(pt.x, 60, W - 60), y: S.clamp(pt.y, 120, H - 20) });
      const g = S.solve(from, K)[id];
      const a = Math.atan2(pt.y - g.y0, pt.x - g.x0) * 180 / Math.PI;
      let d = ((a - from[id] + 540) % 360) - 180;
      return S.rotateBranch(from, id, d);
    }
    wirePointer() {
      let drag = null;
      this.svg.addEventListener("pointerdown", (e) => {
        const j = e.target.closest && e.target.closest(".ed-joint");
        if (!j || this.playing || this.demoing) return;
        e.preventDefault();
        this.svg.setPointerCapture(e.pointerId);
        drag = { id: j.dataset.joint, start: Object.assign({}, this.pose), moved: 0, x: e.clientX, y: e.clientY };
        this.root.classList.add("is-posing");
        this.emit("grab", drag.id);
      });
      this.svg.addEventListener("pointermove", (e) => {
        if (!drag) return;
        drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x, e.clientY - drag.y));
        this.frames[this.cur] = this.dragTo(drag.id, this.toScene(e), this.frames[this.cur]);
        this.render(); this.emit("posing", drag.id);
      });
      const end = () => {
        if (!drag) return;
        const d = drag; drag = null;
        this.root.classList.remove("is-posing");
        if (d.moved > 8) this.emit(d.id === "origin" ? "move" : "pose", d.id);
        if (d.moved > 8 && d.id === "origin") this.emit("pose", d.id);
      };
      this.svg.addEventListener("pointerup", end);
      this.svg.addEventListener("pointercancel", end);
    }

    /* ---------------- where things are */
    node(name) {
      if (name === "figure") return this.svg.querySelector(".ed-fig");
      if (name.startsWith("joint")) return this.svg.querySelector(`[data-joint="${name.split(":")[1] || "armR2"}"]`);
      if (name === "frame") return this.strip.children[this.cur];
      return this.root.querySelector(`[data-tour="${name}"]`);
    }
    rect(name, pad = 0) {
      const n = this.node(name);
      if (!n) return null;
      const r = n.getBoundingClientRect(), p = name === "figure" ? 14 : pad;
      return new DOMRect(r.left - p, r.top - p, r.width + p * 2, r.height + p * 2);
    }

    /* ---------------- "show me": a ghost pointer performs the action, then undoes it */
    async demo(kind) {
      if (this.demoing || this.playing || this.root.classList.contains("is-posing")) return;
      this.demoing = true; this.root.classList.add("is-demo");
      const cur = el("div", { class: "ghost-cursor", html: icon("pointer", 26) });
      document.body.append(cur);
      const at = (x, y) => { cur.style.transform = `translate(${x}px, ${y}px)`; };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const center = (r) => [r.left + r.width / 2, r.top + r.height / 2];
      const glide = async (x, y, ms = 620) => { cur.style.transition = `transform ${ms}ms cubic-bezier(.65,0,.35,1)`; at(x, y); await wait(ms + 40); };
      const d0 = this.desk.getBoundingClientRect();
      cur.style.transition = "none"; at(d0.left + d0.width * 0.72, d0.top + d0.height * 0.7); cur.getBoundingClientRect(); cur.classList.add("on");
      try {
        if (kind === "pose" || kind === "pose2") {
          const id = kind === "pose" ? "armR1" : "legR1", tip = kind === "pose" ? "armR2" : "legR2", turn = kind === "pose" ? -96 : -46;
          const handle = () => center(this.svg.querySelector(`[data-joint="${id}"]`).getBoundingClientRect());
          void tip;
          await glide(...handle());
          cur.classList.add("down"); await wait(180);
          const from = Object.assign({}, this.pose), t0 = performance.now(), dur = 900;
          cur.style.transition = "none";
          await new Promise((res) => {
            const step = (now) => {
              const u = Math.min(1, (now - t0) / dur);
              this.frames[this.cur] = S.rotateBranch(from, id, turn * S.ease(u));
              this.render(); at(...handle());
              if (u < 1) requestAnimationFrame(step); else res();
            };
            requestAnimationFrame(step);
          });
          cur.classList.remove("down"); await wait(650);
          const back = Object.assign({}, this.pose), t1 = performance.now();
          await new Promise((res) => {
            const step = (now) => {
              const u = Math.min(1, (now - t1) / 420);
              this.frames[this.cur] = S.lerpPose(back, from, S.ease(u)); this.render();
              if (u < 1) requestAnimationFrame(step); else res();
            };
            requestAnimationFrame(step);
          });
          this.frames[this.cur] = from; this.render();
        } else {
          const target = kind === "addFrame" ? this.addBtn : this.playBtn;
          await glide(...center(target.getBoundingClientRect()));
          cur.classList.add("down"); target.classList.add("is-demo-press"); await wait(260);
          cur.classList.remove("down"); target.classList.remove("is-demo-press"); await wait(420);
        }
      } finally {
        cur.classList.remove("on"); await wait(180); cur.remove();
        this.demoing = false; this.root.classList.remove("is-demo");
        this.emit("demoEnd", kind);
      }
    }
  }
  S.Editor = Editor;
})();
