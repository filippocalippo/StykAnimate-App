/* Runs inside each sandboxed screen. It draws what the parent sends, expands the macros on
   the hub kit (src tokens, icons, figures, sample data and the working stand-in editor), and
   reports clicks. It holds no state of its own beyond the markup it was last given. */
(function () {
  "use strict";
  const S = window.Styk;
  const root = document.getElementById("root");
  const box = document.createElement("div");
  box.id = "pick-box";
  document.body.append(box);
  const send = (message) => parent.postMessage(message, "*");

  /* ---------------- macros: one tag for what would be dozens of lines of markup */
  const number = (node, name, fallback) => { const v = Number(node.getAttribute(name)); return Number.isFinite(v) && node.hasAttribute(name) ? v : fallback; };
  const define = (name, render) => customElements.define(name, class extends HTMLElement {
    connectedCallback() { if (!this.done) { this.done = true; render(this); } }
  });
  define("x-i", (n) => { n.innerHTML = S.icon(n.getAttribute("n") || "", number(n, "s", 16)) || S.icon("circle", number(n, "s", 16)); });
  define("x-fig", (n) => {
    const k = number(n, "k", 1), name = n.getAttribute("p") || "stand";
    const W = 240 * k, H = 260 * k;
    const pose = S.stand(S.POSES[name] ? name : "stand", W / 2, H - 16 * k, k);
    if (!n.style.width && !n.style.height) { n.style.width = `${W}px`; n.style.height = `${H}px`; }
    n.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${S.figureMarkup(pose, { k, color: n.getAttribute("c") || "var(--text-1)", handles: n.hasAttribute("joints"), handleR: 6 * k })}</svg>`;
  });
  define("x-scene", (n) => { n.append(S.thumb(S.SCENES[n.getAttribute("n")] || S.SCENES.walk, {})); });
  define("x-project", (n) => { n.append(S.projectCard(S.PROJECTS[number(n, "n", 0) % S.PROJECTS.length], {})); });
  define("x-tl", (n) => {
    const frames = Math.min(120, number(n, "frames", 48)), cur = number(n, "cur", 12), layers = Math.min(12, number(n, "layers", 4));
    const cells = (fill) => `<div class="xtl-cells">${Array.from({ length: frames }, (_, i) => fill(i)).join("")}</div>`;
    const row = (name, dot, fill, system) => `<div class="xtl-row"${system ? " data-system" : ""}><div class="xtl-name">${dot ? `<span class="dot" data-tint="${dot}"></span>` : ""}<b>${name}</b></div>${cells(fill)}</div>`;
    const names = ["Blue", "Red", "Background", "Sword", "Dust", "Sky", "Crowd", "Light", "Rain", "Text", "Logo", "Extra"];
    const tints = ["select", "fx", "draw", "library", "time", "select"];
    const tick = Math.max(1, Math.ceil(frames / 12));
    let html = `<div class="xtl-ruler"><div class="xtl-name">Frames</div><div class="xtl-cells">${Array.from({ length: Math.ceil(frames / tick) }, (_, i) => `<span class="xtl-tick">${i * tick + 1}</span>`).join("")}</div></div>`;
    html += row("Camera", null, (i) => `<i${i === 0 ? " data-key" : ""}></i>`, true) + row("Scene", null, (i) => `<i${i === 0 ? " data-key" : ""}></i>`, true);
    for (let l = 0; l < layers; l++) html += row(names[l], tints[l % tints.length], (i) => ((i + l * 3) % 6 === 0 ? "<i data-key></i>" : (i + l * 3) % 6 < 4 ? "<i data-span></i>" : "<i></i>"));
    n.innerHTML = html;
    for (const track of n.querySelectorAll(".xtl-row .xtl-cells")) track.insertAdjacentHTML("beforeend", `<span class="xtl-head" style="left:${(cur / frames) * 100}%"></span>`);
  });

  // The whole app. Children with slot="..." replace one region of the working stand-in.
  const REGIONS = { band: ".ed-band", rail: ".ed-rail", "stage-head": ".ed-stage-head", inspector: ".ed-right", timeline: ".ed-timeline" };
  customElements.define("x-editor", class extends HTMLElement {
    connectedCallback() {
      if (this.editor) return;
      const slots = [...this.children];
      this.replaceChildren();
      const home = this.hasAttribute("home");
      this.editor = new S.Editor(this, { home, name: this.getAttribute("name") || "Rooftop fight" });
      this.editor.setWorkspace(this.getAttribute("ws") || "animate", true);
      if (this.getAttribute("tab")) this.editor.selectTab(this.getAttribute("tab"));
      this.applySlots(slots);
      this.applyHide();
    }
    applyHide() {
      const hidden = (this.getAttribute("hide") || "").split(/\s+/).filter(Boolean);
      for (const region of hidden) {
        const node = this.querySelector(REGIONS[region]);
        if (node) node.hidden = true;
      }
      // The work area is a grid: a hidden region must give its track back to the stage.
      const work = this.editor.work;
      if (hidden.includes("inspector")) work.style.gridTemplateColumns = "minmax(0, 1fr)";
      if (hidden.includes("timeline")) work.style.gridTemplateRows = "minmax(0, 1fr)";
    }
    // Streaming redraws only the slot being written, not the whole editor.
    applySlots(slots) {
      this.placed = this.placed || new Map();
      for (const node of slots) {
        const name = node.getAttribute("slot");
        const previous = this.placed.get(name);
        const key = node.outerHTML;
        if (previous && previous.key === key) continue;
        node.setAttribute("data-slot-replaced", name);
        if (name === "top") { previous ? previous.node.replaceWith(node) : this.editor.slotTop.append(node); }
        else {
          const target = previous ? previous.node : this.querySelector(REGIONS[name]);
          if (!target) continue;
          // Regions are laid out by their own class, so the replacement inherits it.
          if (!previous) { const place = target.className.split(" ")[0]; node.style.gridArea = getComputedStyle(target).gridArea; node.dataset.region = place; }
          target.replaceWith(node);
        }
        this.placed.set(name, { key, node });
      }
      // A replacement sets its own height, and the stage takes whatever is left.
      if (this.placed.has("timeline")) this.editor.work.style.gridTemplateRows = "minmax(0, 1fr) auto";
    }
  });

  /* ---------------- drawing */
  // Stamps every authored element with its path, so a pick survives macros moving it.
  const stamp = (parentNode, path) => {
    [...parentNode.children].forEach((child, index) => {
      const here = path ? `${path}.${index}` : String(index);
      child.setAttribute("data-p", here);
      if (!child.tagName.startsWith("X-") || child.tagName === "X-EDITOR") stamp(child, here);
    });
  };
  // A half-written tag at the end of a stream would print as text.
  const trimPartial = (html) => { const last = html.lastIndexOf("<"); return last > html.lastIndexOf(">") ? html.slice(0, last) : html; };

  let sources = [];
  function render(html, streaming) {
    const template = document.createElement("template");
    template.innerHTML = streaming ? trimPartial(html) : html;
    if (!streaming) stamp(template.content, "");
    const next = [...template.content.children];
    next.forEach((node, index) => {
      const key = node.outerHTML, old = root.children[index];
      if (sources[index] === key && old) return;
      sources[index] = key;
      if (old && old.tagName === "X-EDITOR" && node.tagName === "X-EDITOR" && old.editor) old.applySlots([...node.children]);
      else if (old) old.replaceWith(node);
      else root.append(node);
    });
    while (root.children.length > next.length) root.lastElementChild.remove();
    sources.length = next.length;
  }

  /* ---------------- modes */
  let mode = "view";
  const pickable = (node) => node && node.closest && node.closest("[data-p]:not(style)");
  const outline = (node) => {
    if (!node) { box.style.display = "none"; return; }
    const r = node.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  document.addEventListener("pointermove", (event) => { if (mode === "pick") outline(pickable(event.target)); });
  document.addEventListener("click", (event) => {
    if (mode === "pick") {
      event.preventDefault(); event.stopPropagation();
      const node = pickable(event.target);
      if (node) send({ t: "pick", path: node.getAttribute("data-p"), label: node.tagName.toLowerCase() });
      return;
    }
    const go = event.target.closest && event.target.closest("[data-go]");
    if (go) { event.preventDefault(); send({ t: "go", to: go.getAttribute("data-go") }); return; }
    const toggle = event.target.closest && event.target.closest("[data-toggle]");
    if (toggle) { const target = document.getElementById(toggle.getAttribute("data-toggle")); if (target) target.hidden = !target.hidden; return; }
    const link = event.target.closest && event.target.closest("a[href]");
    if (link) event.preventDefault();
  }, true);
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send({ t: "escape" });
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.target.closest("input, textarea")) send({ t: "key", key: event.key });
  });

  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data || {};
    if (data.t === "render") { document.documentElement.dataset.theme = data.theme || "light"; render(data.html || "", data.streaming); }
    if (data.t === "mode") { mode = data.mode; document.documentElement.dataset.mode = mode; outline(null); }
  });
  send({ t: "ready" });
})();
