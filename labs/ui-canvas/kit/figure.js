/* A small Pivot-style stick figure: poses in absolute angles, a solver, SVG markup,
   tweening and the scene thumbnails the hub draws. Prototype artwork only. */
(function () {
  "use strict";
  const S = (window.Styk = window.Styk || {});

  // id, parent, length. Angles are absolute, in degrees: 0 right, 90 down, -90 up.
  const SEG = [
    ["spine", null, 62], ["head", "spine", 34],
    ["armL1", "spine", 36], ["armL2", "armL1", 34],
    ["armR1", "spine", 36], ["armR2", "armR1", 34],
    ["legL1", null, 46], ["legL2", "legL1", 44],
    ["legR1", null, 46], ["legR2", "legR1", 44],
  ];
  const IDS = SEG.map((s) => s[0]);
  const PARENT = Object.fromEntries(SEG.map((s) => [s[0], s[1]]));
  const LEN = Object.fromEntries(SEG.map((s) => [s[0], s[2]]));
  const DRAW = ["armL1", "armL2", "legL1", "legL2", "spine", "legR1", "legR2", "armR1", "armR2"];
  S.SEG_IDS = IDS;

  const base = { x: 0, y: 0, spine: -90, head: -90, armL1: 114, armL2: 100, armR1: 66, armR2: 80, legL1: 104, legL2: 96, legR1: 76, legR2: 84 };
  const P = (o) => Object.assign({}, base, o);
  S.POSES = {
    stand: P({}),
    wave: P({ armR1: -28, armR2: -84, armL1: 110, armL2: 100 }),
    waveB: P({ armR1: -22, armR2: -58, armL1: 110, armL2: 100 }),
    point: P({ armR1: -8, armR2: -4, armL1: 112, armL2: 80 }),
    pointUp: P({ armR1: -52, armR2: -58, armL1: 110, armL2: 92 }),
    pointLeft: P({ armL1: 186, armL2: 182, armR1: 70, armR2: 96 }),
    pointDown: P({ armR1: 48, armR2: 62, armL1: 110, armL2: 92 }),
    victory: P({ armL1: -128, armL2: -108, armR1: -52, armR2: -72, legL1: 106, legL2: 100, legR1: 74, legR2: 80 }),
    jump: P({ armL1: -140, armL2: -110, armR1: -40, armR2: -70, legL1: 128, legL2: 64, legR1: 52, legR2: 116 }),
    walkA: P({ spine: -86, head: -86, armL1: 62, armL2: 46, armR1: 116, armR2: 100, legL1: 116, legL2: 124, legR1: 62, legR2: 84 }),
    walkB: P({ spine: -86, head: -86, armL1: 116, armL2: 100, armR1: 62, armR2: 46, legL1: 62, legL2: 84, legR1: 116, legR2: 124 }),
    run: P({ spine: -72, head: -74, armL1: 152, armL2: 84, armR1: 30, armR2: -52, legL1: 138, legL2: 196, legR1: 28, legR2: 108 }),
    runB: P({ spine: -72, head: -74, armL1: 30, armL2: -52, armR1: 152, armR2: 84, legL1: 28, legL2: 108, legR1: 138, legR2: 196 }),
    punch: P({ spine: -78, head: -80, armL1: 128, armL2: 16, armR1: -6, armR2: -4, legL1: 122, legL2: 108, legR1: 58, legR2: 100 }),
    guard: P({ spine: -84, head: -84, armL1: 124, armL2: -30, armR1: 40, armR2: -62, legL1: 116, legL2: 104, legR1: 64, legR2: 96 }),
    kick: P({ spine: -104, head: -98, armL1: 164, armL2: 200, armR1: 52, armR2: -28, legL1: 96, legL2: 90, legR1: -12, legR2: -18 }),
    hit: P({ spine: -122, head: -134, armL1: -166, armL2: -142, armR1: -64, armR2: -28, legL1: 72, legL2: 102, legR1: 48, legR2: 82 }),
    crouch: P({ spine: -68, head: -76, armL1: 96, armL2: 20, armR1: 60, armR2: -10, legL1: 150, legL2: 62, legR1: 34, legR2: 112 }),
    sword: P({ spine: -82, head: -84, armL1: 120, armL2: 60, armR1: -30, armR2: -72, legL1: 120, legL2: 106, legR1: 60, legR2: 98 }),
    slash: P({ spine: -70, head: -72, armL1: 140, armL2: 100, armR1: 30, armR2: 36, legL1: 128, legL2: 110, legR1: 50, legR2: 100 }),
    serve: P({ spine: -94, head: -100, armL1: -110, armL2: -96, armR1: -60, armR2: -120, legL1: 104, legL2: 96, legR1: 78, legR2: 86 }),
  };
  S.pose = (name, x, y, more) => Object.assign({}, S.POSES[name], { x, y }, more);
  // Facing left: mirror every angle around the vertical axis.
  S.flipPose = (p) => { const o = { x: p.x, y: p.y }; for (const id of IDS) o[id] = 180 - p[id]; return o; };

  const rad = Math.PI / 180;
  S.solve = (p, k = 1) => {
    const out = {}, hip = { x: p.x, y: p.y };
    for (const id of IDS) {
      const par = PARENT[id], a = par ? { x: out[par].x1, y: out[par].y1 } : hip;
      // Arms hang from the shoulders, a little under the top of the spine.
      const start = par === "spine" && id !== "head"
        ? { x: out.spine.x0 + (out.spine.x1 - out.spine.x0) * 0.9, y: out.spine.y0 + (out.spine.y1 - out.spine.y0) * 0.9 } : a;
      const l = LEN[id] * k;
      out[id] = { x0: start.x, y0: start.y, x1: start.x + Math.cos(p[id] * rad) * l, y1: start.y + Math.sin(p[id] * rad) * l };
    }
    return out;
  };
  const f = (n) => Math.round(n * 10) / 10;

  // The figure as SVG. Options: color, k (scale), w (stroke), opacity, handles ("joints" | false), dash (ghost outline).
  S.figureMarkup = (p, o = {}) => {
    const k = o.k || 1, w = (o.w || 10) * k, c = o.color || "#0d99ff", g = S.solve(p, k);
    let s = `<g fill="none" stroke="${c}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"${o.opacity ? ` opacity="${o.opacity}"` : ""}>`;
    for (const id of DRAW) { const q = g[id]; s += `<path d="M${f(q.x0)} ${f(q.y0)}L${f(q.x1)} ${f(q.y1)}"/>`; }
    const h = g.head;
    s += `<circle cx="${f((h.x0 + h.x1) / 2)}" cy="${f((h.y0 + h.y1) / 2)}" r="${f((LEN.head * k) / 2)}" fill="${c}" stroke="none"/>`;
    s += "</g>";
    if (o.hold) {
      const a = (p.armR2 + (o.hold.a || 0)) * rad, q = g.armR2;
      s += `<path d="M${f(q.x1)} ${f(q.y1)}L${f(q.x1 + Math.cos(a) * o.hold.len)} ${f(q.y1 + Math.sin(a) * o.hold.len)}" stroke="${o.hold.c}" stroke-width="${o.hold.w || 7}" stroke-linecap="round"/>`;
    }
    if (o.handles) {
      const r = o.handleR || 5.5;
      for (const id of IDS) { const q = g[id]; s += `<circle class="ed-joint" data-joint="${id}" cx="${f(q.x1)}" cy="${f(q.y1)}" r="${r}" fill="#f0263c" stroke="#5c0612" stroke-width="1.5"/>`; }
      s += `<circle class="ed-joint ed-origin" data-joint="origin" cx="${f(p.x)}" cy="${f(p.y)}" r="${r + 0.5}" fill="#ff9d1b" stroke="#6b3a00" stroke-width="1.5"/>`;
    }
    return s;
  };
  // A named pose standing on the ground line: the lowest foot rests on `groundY`.
  S.stand = (name, x, groundY, k = 1, flip = false, more) => {
    let p = S.pose(name, x, 0, more);
    if (flip) p = S.flipPose(p);
    const g = S.solve(p, k), low = Math.max(g.legL2.y1, g.legR2.y1, g.legL1.y1, g.legR1.y1);
    p.y = groundY - low - 5.5 * k;
    return p;
  };

  const turn = (a, b, t) => { let d = ((b - a + 540) % 360) - 180; return a + d * t; };
  S.lerpPose = (a, b, t) => { const o = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; for (const id of IDS) o[id] = turn(a[id], b[id], t); return o; };
  S.ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  // Rotating a segment carries everything attached to it, as in Pivot.
  S.rotateBranch = (p, id, delta) => {
    const o = Object.assign({}, p);
    const walk = (n) => { o[n] = p[n] + delta; for (const c of IDS) if (PARENT[c] === n) walk(c); };
    walk(id);
    return o;
  };

  /* ---------------- scenes: what a project thumbnail shows */
  const propMarkup = (q) => {
    if (q.t === "ball") return `<circle cx="${q.x}" cy="${q.y}" r="${q.r}" fill="${q.c}"/>`;
    if (q.t === "line") return `<path d="M${q.x} ${q.y}L${q.x2} ${q.y2}" stroke="${q.c}" stroke-width="${q.w || 8}" stroke-linecap="round" fill="none"/>`;
    if (q.t === "box") return `<rect x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" rx="${q.r || 0}" fill="${q.c}"/>`;
    if (q.t === "burst") {
      let d = ""; const n = q.n || 12;
      for (let i = 0; i < n * 2; i++) { const a = (i / (n * 2)) * Math.PI * 2, r = i % 2 ? q.r * 0.52 : q.r; d += `${i ? "L" : "M"}${f(q.x + Math.cos(a) * r)} ${f(q.y + Math.sin(a) * r)}`; }
      return `<path d="${d}Z" fill="${q.c}"/><circle cx="${q.x}" cy="${q.y}" r="${f(q.r * 0.34)}" fill="${q.c2 || "#ffd36a"}"/>`;
    }
    if (q.t === "path") return `<path d="${q.d}" fill="${q.fill || "none"}" stroke="${q.c || "none"}" stroke-width="${q.w || 6}" stroke-linecap="round" stroke-linejoin="round"${q.dash ? ` stroke-dasharray="${q.dash}"` : ""}${q.op ? ` opacity="${q.op}"` : ""}/>`;
    if (q.t === "text") return `<text x="${q.x}" y="${q.y}" font-family="Inter Tight, Inter, sans-serif" font-weight="800" font-size="${q.s}" fill="${q.c}" text-anchor="middle">${q.v}</text>`;
    return "";
  };
  S.sceneMarkup = (sc, t = 0) => {
    const [W, H] = sc.size || [960, 540];
    let s = sc.bg === "none" ? "" : `<rect width="${W}" height="${H}" fill="${sc.bg || "#ffffff"}"/>`;
    for (const q of sc.back || []) s += propMarkup(q);
    if (sc.ground) s += `<path d="M${sc.groundX || 60} ${sc.ground}H${W - (sc.groundX || 60)}" stroke="${sc.groundC || "#d9dce5"}" stroke-width="5" stroke-linecap="round"/>`;
    for (const fig of sc.figs || []) {
      const n = fig.keys.length, pos = (t * (sc.speed || 1)) % n, i = Math.floor(pos), u = S.ease(pos - i);
      const p = n > 1 ? S.lerpPose(fig.keys[i], fig.keys[(i + 1) % n], u) : fig.keys[0];
      s += S.figureMarkup(p, { color: fig.c || "#15161c", k: fig.k || 1, w: fig.w, hold: fig.hold, opacity: fig.op, handles: fig.handles, handleR: fig.handleR });
    }
    for (const q of sc.props || []) s += propMarkup(q);
    return s;
  };
  // A thumbnail element; it plays its scene while the pointer is over `hover` (default: itself).
  S.thumb = (sc, opts = {}) => {
    const [W, H] = sc.size || [960, 540];
    const box = document.createElement("div");
    box.className = "thumb" + (opts.class ? " " + opts.class : "");
    box.style.aspectRatio = `${W} / ${H}`;
    const draw = (t) => { box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${S.sceneMarkup(sc, t)}</svg>`; };
    draw(0);
    let raf = 0, t0 = 0;
    const tick = (now) => { if (!t0) t0 = now; draw((now - t0) / 420); raf = requestAnimationFrame(tick); };
    const start = () => { if (!raf && (sc.figs || []).some((g) => g.keys.length > 1)) { t0 = 0; raf = requestAnimationFrame(tick); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; if (!opts.autoplay) draw(0); };
    box.play = start; box.stop = stop;
    if (opts.autoplay) start();
    else setTimeout(() => { const h = opts.hover || box.closest("[data-thumb-hover]") || box; h.addEventListener("mouseenter", start); h.addEventListener("mouseleave", stop); }, 0);
    return box;
  };
})();
