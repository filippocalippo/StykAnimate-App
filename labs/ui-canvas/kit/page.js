/* What every concept page shares: small DOM helpers, the prototype bar above the
   app window (concept switcher, state jumps, theme, notes), menus, toasts, the
   popover placer and the cards the hubs draw. */
(function () {
  "use strict";
  const S = window.Styk;

  S.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  S.icon = (name, size = 16) => (window.STYK_ICONS[name] || "").replace('width="18" height="18"', `width="${size}" height="${size}"`);
  S.el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const { el, icon } = S;
  S.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  S.emitter = (o) => {
    const subs = {};
    o.on = (name, fn) => { (subs[name] = subs[name] || []).push(fn); return () => { subs[name] = subs[name].filter((x) => x !== fn); }; };
    o.emit = (name, data) => { for (const fn of (subs[name] || []).slice()) fn(data); };
    return o;
  };

  S.setTheme = (t) => { document.documentElement.dataset.theme = t; try { localStorage.setItem("styk-hub-theme", t); } catch {} };
  try { const t = localStorage.getItem("styk-hub-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}

  S.CONCEPTS = [
    { n: 1, file: "1-home.html", name: "Home", hub: "Sidebar home", tour: "Spotlight tour" },
    { n: 2, file: "2-shelf.html", name: "Shelf", hub: "Project manager", tour: "Lesson panel" },
    { n: 3, file: "3-path.html", name: "Path", hub: "Learning path", tour: "Blue, the guide" },
    { n: 4, file: "4-launcher.html", name: "Launcher", hub: "Quick start", tour: "Quiet hints" },
    { n: 5, file: "5-home-tab.html", name: "Home tab", hub: "Home inside the editor", tour: "Lesson strip" },
  ];

  /* ---------------- the prototype bar (not part of the app) */
  S.mountProto = ({ n, notes, states, go }) => {
    const me = S.CONCEPTS.find((c) => c.n === n);
    document.title = `${n} · ${me.name} · StykAnimate hub concepts`;
    const stateBtns = states.map((s) => el("button", { class: "px-state", "data-state": s.id, text: s.label, onclick: () => S.go(s.id) }));
    S.go = (id, arg) => {
      S.closeMenu(); S.closeSheet();
      for (const b of stateBtns) b.classList.toggle("on", b.dataset.state === id);
      try { history.replaceState(null, "", "#" + id); } catch {}
      go(id, arg);
    };
    const sheet = el("aside", { class: "px-notes", hidden: true, "aria-label": "About this concept" });
    sheet.innerHTML = `<header><small>Concept ${n} of 5</small><h2>${S.esc(me.name)}</h2><p>${S.esc(me.hub)} + ${S.esc(me.tour.toLowerCase())}</p></header>${notes}`;
    const notesBtn = el("button", { class: "px-btn", "aria-expanded": "false", html: `${icon("lightbulb", 15)}<span>About this concept</span>`, onclick: () => toggle() });
    const toggle = (on = sheet.hidden) => { sheet.hidden = !on; notesBtn.setAttribute("aria-expanded", String(on)); };
    sheet.prepend(el("button", { class: "px-close", "aria-label": "Close", html: icon("close", 16), onclick: () => toggle(false) }));
    const bar = el("header", { class: "px-bar" },
      el("a", { class: "px-brand", href: "index.html", title: "All concepts" }, el("img", { src: "../../symbol.svg", alt: "", width: 16, height: 20 }), el("span", { text: "Hub concepts" })),
      el("nav", { class: "px-switch", "aria-label": "Concepts" }, S.CONCEPTS.map((c) =>
        el("a", { href: c.file, class: c.n === n ? "on" : "", "aria-current": c.n === n ? "page" : null, title: `${c.hub} + ${c.tour.toLowerCase()}` }, el("b", { text: String(c.n) }), el("span", { text: c.name })))),
      el("div", { class: "px-end" },
        el("span", { class: "px-label", text: "Jump to" }), el("div", { class: "px-states" }, stateBtns),
        el("button", { class: "px-btn px-icon", "aria-label": "Light or dark", title: "Light or dark", html: icon("droplet", 15), onclick: () => S.setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") }),
        notesBtn));
    document.body.prepend(bar);
    document.body.append(sheet);
    const first = (location.hash || "").slice(1);
    requestAnimationFrame(() => S.go(states.some((s) => s.id === first) ? first : states[0].id));
  };

  /* ---------------- popovers */
  // Puts `pop` beside the rectangle `r` on the preferred side that has room; returns the side used.
  S.place = (pop, r, { side = "right", gap = 14, pad = 12 } = {}) => {
    const w = pop.offsetWidth, h = pop.offsetHeight, W = innerWidth, H = innerHeight, top0 = S.topInset || 0;
    const fits = { right: r.right + gap + w + pad <= W, left: r.left - gap - w - pad >= 0, bottom: r.bottom + gap + h + pad <= H, top: r.top - gap - h - pad >= top0 };
    const order = [side, ...["right", "bottom", "left", "top"].filter((s) => s !== side)];
    const use = order.find((s) => fits[s]) || side;
    let x, y;
    if (use === "right" || use === "left") { x = use === "right" ? r.right + gap : r.left - gap - w; y = r.top + r.height / 2 - h / 2; }
    else { y = use === "bottom" ? r.bottom + gap : r.top - gap - h; x = r.left + r.width / 2 - w / 2; }
    x = S.clamp(x, pad, W - w - pad); y = S.clamp(y, top0 + pad, H - h - pad);
    pop.style.left = Math.round(x) + "px"; pop.style.top = Math.round(y) + "px";
    pop.dataset.side = use;
    // Where the arrow sits along the popover's edge, so it keeps pointing at the target after clamping.
    const along = use === "right" || use === "left" ? r.top + r.height / 2 - y : r.left + r.width / 2 - x;
    pop.style.setProperty("--arrow", S.clamp(along, 18, (use === "right" || use === "left" ? h : w) - 18) + "px");
    return use;
  };

  let openMenu = null;
  S.closeMenu = () => { if (openMenu) { openMenu.remove(); openMenu = null; } };
  S.menu = (items, anchor, side = "bottom") => {
    S.closeMenu();
    const m = el("div", { class: "menu", role: "menu" });
    for (const it of items) {
      if (it === "-") { m.append(el("div", { class: "menu-sep" })); continue; }
      if (it.label) { m.append(el("div", { class: "menu-label", text: it.label })); continue; }
      m.append(el("button", { class: "menu-item" + (it.danger ? " danger" : ""), role: "menuitem", onclick: () => { S.closeMenu(); (it.run || (() => S.toast(it.toast || it.text)))(); } },
        el("span", { class: "menu-ico", html: it.icon ? icon(it.icon, 16) : "" }), el("span", { text: it.text }), it.kbd ? el("kbd", { text: it.kbd }) : null, it.sub ? el("span", { class: "menu-sub", html: icon("chevron-right", 14) }) : null));
    }
    document.body.append(m);
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    const x = S.clamp(side === "bottom-end" ? r.right - m.offsetWidth : r.left, 8, innerWidth - m.offsetWidth - 8);
    const y = r.bottom + 6 + m.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - 6 - m.offsetHeight) : r.bottom + 6;
    m.style.left = x + "px"; m.style.top = y + "px";
    openMenu = m;
    return m;
  };
  document.addEventListener("pointerdown", (e) => { if (openMenu && !openMenu.contains(e.target)) S.closeMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { S.closeMenu(); S.closeSheet(); } });

  /* A help page as a sheet over the right side of the window, so reading never leaves the app. */
  let sheet = null;
  S.closeSheet = () => { if (sheet) { sheet.remove(); sheet = null; } };
  S.docSheet = () => {
    S.closeSheet();
    sheet = el("aside", { class: "sheet doc-view", "aria-label": "Help", html: S.docArticle() });
    sheet.prepend(el("button", { class: "icon-btn sheet-close", "aria-label": "Close", html: icon("close", 16), onclick: S.closeSheet }));
    document.body.append(sheet);
  };

  let toastTimer = 0;
  S.toast = (text) => {
    let t = document.querySelector(".toast");
    if (!t) { t = el("div", { class: "toast", role: "status" }); document.body.append(t); }
    t.textContent = text; t.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2200);
  };

  /* ---------------- pieces the hubs share */
  S.windowControls = () => el("div", { class: "win-ctl", "aria-hidden": "true" },
    el("span", { html: icon("window-minimize", 14) || '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M5 12h14"/></svg>' }),
    el("span", { html: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>' }),
    el("span", { class: "x", html: icon("close", 15) }));

  S.projectMenu = (p, anchor, extra = {}) => S.menu([
    { text: "Open", icon: "folder", kbd: "Enter", run: extra.open },
    { text: "Open in a new window", icon: "externalLink" },
    "-",
    { text: p.pinned ? "Unpin" : "Pin to the top", icon: "pin" },
    { text: "Rename…", icon: "text", kbd: "F2" },
    { text: "Duplicate", icon: "duplicate", kbd: "Ctrl+D" },
    { text: "Move to folder", icon: "folder-plus", sub: true },
    "-",
    { text: "Show in folder", icon: "search" },
    { text: "Remove from this list", icon: "eye-off" },
    { text: "Delete file…", icon: "trash", danger: true },
  ], anchor, "bottom-end");

  S.badge = (text, tone) => el("span", { class: "badge", "data-tone": tone || null, text });

  // A project as a grid card. opts: open(p), select(p), compact
  S.projectCard = (p, opts = {}) => {
    const art = el("div", { class: "pcard-art" });
    if (p.state === "missing") art.append(el("div", { class: "pcard-missing", html: icon("alert", 22) }));
    else art.append(S.thumb(p.scene));
    const tags = el("div", { class: "pcard-tags" });
    if (p.pinned) tags.append(el("span", { class: "pcard-pin", title: "Pinned", html: icon("pin", 13) }));
    if (p.state === "recovered") tags.append(S.badge("Recovered", "warn"));
    if (p.from) tags.append(S.badge(p.from));
    art.append(tags);
    const more = el("button", { class: "icon-btn pcard-more", "aria-label": `More for ${p.name}`, html: icon("more", 16), onclick: (e) => { e.stopPropagation(); S.projectMenu(p, more, { open: () => opts.open && opts.open(p) }); } });
    const card = el("div", { class: "pcard" + (p.state === "missing" ? " is-missing" : ""), tabindex: "0", role: "button", "data-thumb-hover": true, "data-project": p.id,
      onclick: () => (opts.select ? opts.select(p, card) : opts.open && opts.open(p)),
      ondblclick: () => opts.open && opts.open(p),
      oncontextmenu: (e) => { e.preventDefault(); S.projectMenu(p, { x: e.clientX, y: e.clientY }, { open: () => opts.open && opts.open(p) }); },
      onkeydown: (e) => { if (e.key === "Enter") opts.open && opts.open(p); } },
      art, el("div", { class: "pcard-txt" }, el("b", { text: p.name }), el("span", { text: p.state === "missing" ? "File moved or deleted" : p.edited })), more);
    return card;
  };

  S.cover = (l, opts = {}) => {
    const c = el("div", { class: "cover", "data-tint": l.tint });
    c.append(S.thumb(l.scene, { autoplay: opts.autoplay }));
    return c;
  };
  S.lessonMeta = (l) => `${l.mins} min · ${l.steps} steps`;
  S.lessonStatus = (l) => {
    const s = S.lessonState(l);
    if (s === "done") return el("span", { class: "lstate done", html: `${icon("check", 13)}<span>Done</span>` });
    return el("span", { class: "lstate", text: S.lessonMeta(l) });
  };
  S.lessonCard = (l, opts = {}) => el("button", { class: "lcard", "data-thumb-hover": true, "data-lesson": l.id, onclick: () => opts.start && opts.start(l) },
    S.cover(l), el("div", { class: "lcard-txt" }, el("b", { text: l.title }), el("p", { text: l.line }), el("div", { class: "lcard-foot" }, S.lessonStatus(l), el("span", { class: "lcard-ws", text: l.ws }))));

  // Lessons other than the first open a small "not built in this mockup" note.
  S.startLesson = (l) => { if (l.live) S.go("lesson"); else S.toast(`“${l.title}” would start here. Try “First steps”, the lesson this mockup runs.`); };

  /* The New animation sheet: a name, a shape and a speed. */
  S.newDialog = (onCreate) => {
    const shapes = [["landscape", "Landscape", "960 × 540"], ["vertical", "Vertical", "1080 × 1920"], ["squareframe", "Square", "1080 × 1080"]];
    let shape = 0, fps = 24;
    const name = el("input", { class: "field-input", value: "Untitled animation", "aria-label": "Name" });
    const tiles = shapes.map(([ic, label, size], i) => el("button", { class: "shape-tile", "aria-pressed": String(i === 0), onclick: () => { shape = i; tiles.forEach((t, j) => t.setAttribute("aria-pressed", String(j === i))); } },
      el("span", { class: "shape-ico", html: icon(ic, 26) }), el("b", { text: label }), el("small", { text: size })));
    const rates = [12, 24, 30, 60].map((r) => el("button", { class: "seg-item", "aria-pressed": String(r === 24), text: String(r), onclick: () => { fps = r; rates.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === String(r)))); } }));
    const close = () => veil.remove();
    const dlg = el("div", { class: "dialog", role: "dialog", "aria-label": "New animation" },
      el("div", { class: "dialog-head" }, el("h2", { text: "New animation" }), el("button", { class: "icon-btn", "aria-label": "Close", html: icon("close", 16), onclick: close })),
      el("label", { class: "form-row" }, el("span", { text: "Name" }), name),
      el("div", { class: "form-row" }, el("span", { text: "Shape" }), el("div", { class: "shape-tiles" }, tiles)),
      el("div", { class: "form-row" }, el("span", { text: "Speed" }), el("div", { class: "seg" }, rates), el("small", { class: "form-hint", text: "frames per second" })),
      el("div", { class: "dialog-foot" }, el("button", { class: "btn", "data-variant": "ghost", text: "Cancel", onclick: close }),
        el("button", { class: "btn", "data-variant": "primary", text: "Create", onclick: () => { close(); onCreate && onCreate({ name: name.value, shape: shapes[shape][1], fps }); } })));
    const veil = el("div", { class: "veil", onpointerdown: (e) => { if (e.target === veil) close(); } }, dlg);
    document.body.append(veil);
    name.select();
  };
})();
