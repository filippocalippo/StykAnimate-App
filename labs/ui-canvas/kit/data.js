/* Sample content every concept shows: the same projects, lessons and help pages,
   so only the design differs between the five. Nothing here is read from disk. */
(function () {
  "use strict";
  const S = window.Styk;
  const st = S.stand;
  const INK = "#15161c", RED = "#e5484d", BLUE = "#0d99ff", VIOLET = "#7c5cff", MINT = "#12c98a", ORANGE = "#ff6a2b", G = 452;

  /* ---------------- projects */
  const scenes = {
    rooftop: { ground: G, speed: 1.1,
      back: [{ t: "box", x: 70, y: 250, w: 150, h: 202, c: "#eceef3" }, { t: "box", x: 250, y: 320, w: 110, h: 132, c: "#f1f3f7" }, { t: "box", x: 700, y: 210, w: 180, h: 242, c: "#eceef3" }],
      figs: [{ c: INK, k: 1.3, keys: [st("guard", 400, G, 1.3), st("punch", 420, G, 1.3)] },
        { c: RED, k: 1.3, keys: [st("guard", 600, G, 1.3, true), st("hit", 620, G, 1.3, true)] }] },
    walk: { ground: G, figs: [{ c: INK, k: 1.5, keys: [st("walkA", 480, G, 1.5), st("walkB", 480, G, 1.5)] }] },
    volcano: { ground: G, bg: "#fff7ef",
      back: [{ t: "path", d: "M520 452 660 190 720 190 900 452Z", fill: "#8a5a44" }, { t: "path", d: "M650 208 660 190 720 190 734 214 706 238 682 220Z", fill: ORANGE },
        { t: "burst", x: 690, y: 150, r: 62, c: ORANGE, c2: "#ffd36a", n: 9 }],
      figs: [{ c: BLUE, k: 1.2, keys: [st("run", 270, G, 1.2, true), st("runB", 250, G, 1.2, true)] }] },
    duel: { ground: G, speed: 1.2,
      figs: [{ c: INK, k: 1.3, hold: { len: 96, c: "#9aa0ae", a: -30 }, keys: [st("sword", 380, G, 1.3), st("slash", 410, G, 1.3)] },
        { c: INK, k: 1.3, hold: { len: 96, c: "#9aa0ae", a: -30 }, keys: [st("slash", 590, G, 1.3, true), st("sword", 600, G, 1.3, true)] }] },
    shorts: { size: [540, 960], bg: "#15161c", ground: 760, groundC: "#3a3f4f", groundX: 80,
      figs: [{ c: "#ffffff", k: 2.1, keys: [st("victory", 270, 760, 2.1), st("jump", 270, 700, 2.1)] }],
      props: [{ t: "text", x: 270, y: 250, s: 120, c: BLUE, v: "GO!" }] },
    dance: { ground: G, bg: "#f6f3ff", groundC: "#ddd5ff", speed: 1.4,
      figs: [{ c: VIOLET, k: 1.5, keys: [st("victory", 480, G, 1.5), st("wave", 480, G, 1.5), st("jump", 480, G - 40, 1.5), st("pointLeft", 480, G, 1.5)] }] },
    tennis: { ground: G, bg: "#f2fbf6", groundC: "#bfe9d6",
      back: [{ t: "path", d: "M480 452V372", c: "#9aa0ae", w: 5 }],
      figs: [{ c: INK, k: 1.2, hold: { len: 54, c: MINT, a: -20, w: 9 }, keys: [st("serve", 230, G, 1.2), st("slash", 250, G, 1.2)] },
        { c: INK, k: 1.2, hold: { len: 54, c: ORANGE, a: -20, w: 9 }, keys: [st("guard", 730, G, 1.2, true), st("sword", 720, G, 1.2, true)] }],
      props: [{ t: "ball", x: 430, y: 200, r: 13, c: "#f5a524" }] },
    untitled: { ground: G, figs: [{ c: BLUE, k: 1.4, keys: [st("stand", 420, G, 1.4)] }], props: [{ t: "ball", x: 620, y: 428, r: 22, c: "#f5a524" }] },
    kick: { ground: G, speed: 1.2,
      figs: [{ c: INK, k: 1.3, keys: [st("guard", 390, G, 1.3), st("kick", 400, G, 1.3)] }, { c: BLUE, k: 1.3, keys: [st("guard", 610, G, 1.3, true), st("hit", 640, G, 1.3, true)] }] },
    parkour: { ground: G, back: [{ t: "box", x: 560, y: 352, w: 150, h: 100, r: 6, c: "#e7e9ef" }, { t: "box", x: 710, y: 282, w: 150, h: 170, r: 6, c: "#eceef3" }],
      figs: [{ c: INK, k: 1.25, keys: [st("run", 300, G, 1.25), st("runB", 330, G, 1.25), st("jump", 470, G - 110, 1.25)] }] },
    firststeps: { ground: G, figs: [{ c: BLUE, k: 1.5, keys: [st("wave", 480, G, 1.5), st("waveB", 480, G, 1.5)] }] },
    missing: { bg: "#eceef3", figs: [] },
  };
  S.SCENES = scenes;
  const HOME = "Documents\\StykAnimate\\";
  S.PROJECTS = [
    { id: "rooftop", name: "Rooftop fight", scene: scenes.rooftop, frames: 248, fps: 24, secs: 10.3, bytes: "1.8 MB", edited: "12 minutes ago", when: "Today 14:02", order: 1, folder: "Fight scenes", pinned: true, ext: "styk" },
    { id: "walk", name: "Walk cycle test", scene: scenes.walk, frames: 24, fps: 24, secs: 1.0, bytes: "84 KB", edited: "Yesterday", when: "Yesterday 18:40", order: 2, folder: "Tests", ext: "styk" },
    { id: "volcano", name: "Volcano – science project", scene: scenes.volcano, frames: 412, fps: 24, secs: 17.2, bytes: "6.4 MB", edited: "2 days ago", when: "Wed 16:15", order: 3, folder: "School", pinned: true, ext: "styk" },
    { id: "untitled", name: "Untitled animation", scene: scenes.untitled, frames: 9, fps: 12, secs: 0.8, bytes: "31 KB", edited: "Recovered · 12:04", when: "Today 12:04", order: 4, folder: null, state: "recovered", ext: "styk" },
    { id: "duel", name: "Sword duel", scene: scenes.duel, frames: 180, fps: 12, secs: 15.0, bytes: "212 KB", edited: "Last week", when: "24 Sep", order: 5, folder: "Fight scenes", ext: "piv", from: "Pivot" },
    { id: "shorts", name: "Shorts intro", scene: scenes.shorts, frames: 96, fps: 24, secs: 4.0, bytes: "640 KB", edited: "Last week", when: "23 Sep", order: 6, folder: null, ext: "styk" },
    { id: "kick", name: "Kick combo", scene: scenes.kick, frames: 132, fps: 24, secs: 5.5, bytes: "910 KB", edited: "2 weeks ago", when: "18 Sep", order: 7, folder: "Fight scenes", ext: "styk" },
    { id: "dance", name: "Dance loop", scene: scenes.dance, frames: 48, fps: 24, secs: 2.0, bytes: "190 KB", edited: "2 weeks ago", when: "16 Sep", order: 8, folder: "Tests", ext: "styk" },
    { id: "tennis", name: "Stick tennis", scene: scenes.tennis, frames: 320, fps: 24, secs: 13.3, bytes: "2.2 MB", edited: "3 weeks ago", when: "9 Sep", order: 9, folder: "School", ext: "styk" },
    { id: "parkour", name: "Parkour run", scene: scenes.parkour, frames: 206, fps: 24, secs: 8.6, bytes: "1.1 MB", edited: "Last month", when: "30 Aug", order: 10, folder: "Tests", ext: "nodes", from: "Stick Nodes" },
    { id: "dragon", name: "Dragon boss", scene: scenes.missing, frames: 0, fps: 24, secs: 0, bytes: "—", edited: "File not found", when: "12 Aug", order: 11, folder: "Fight scenes", state: "missing", ext: "styk" },
  ].map((p) => Object.assign({ state: "ok", size: p.scene.size || [960, 540], path: HOME + (p.folder ? p.folder + "\\" : "") + p.name + "." + p.ext }, p));
  S.FOLDERS = ["Fight scenes", "School", "Tests"];
  S.meta = (p) => (p.state === "missing" ? "File moved or deleted" : `${p.frames} frames · ${p.secs.toFixed(1)} s`);

  /* ---------------- lessons */
  const cover = (o) => Object.assign({ bg: "none" }, o);
  const T = (name) => `var(--tint-${name})`;
  const covers = {
    first: cover({ figs: [{ c: T("select"), k: 1.9, handles: true, handleR: 8, keys: [st("wave", 480, 500, 1.9), st("waveB", 480, 500, 1.9)] }] }),
    onion: cover({ figs: [{ c: T("time"), k: 1.9, op: 0.18, keys: [st("walkA", 330, 500, 1.9)] }, { c: T("time"), k: 1.9, op: 0.4, keys: [st("walkB", 440, 500, 1.9)] }, { c: T("time"), k: 1.9, keys: [st("walkA", 560, 500, 1.9)] }] }),
    play: cover({ figs: [{ c: T("time"), k: 1.9, keys: [st("victory", 330, 500, 1.9), st("jump", 330, 450, 1.9)] }], props: [{ t: "path", d: "M600 190 760 280 600 370Z", fill: T("time"), c: T("time"), w: 26 }] }),
    tween: cover({ speed: 1.3, figs: [{ c: T("time"), k: 1.8, op: 0.16, keys: [st("run", 280, 500, 1.8)] }, { c: T("time"), k: 1.8, op: 0.36, keys: [st("runB", 420, 500, 1.8)] }, { c: T("time"), k: 1.8, keys: [st("run", 580, 500, 1.8), st("runB", 600, 500, 1.8)] }] }),
    walk: cover({ ground: 500, groundC: T("select"), groundX: 150, figs: [{ c: T("select"), k: 1.9, keys: [st("walkA", 480, 500, 1.9), st("walkB", 480, 500, 1.9)] }] }),
    easing: cover({ props: [{ t: "path", d: "M170 430C420 430 420 120 790 120", c: T("time"), w: 12 }, { t: "ball", x: 170, y: 430, r: 26, c: T("time") }, { t: "ball", x: 790, y: 120, r: 26, c: T("time") }, { t: "path", d: "M170 430H420M790 120H540", c: T("time"), w: 5, dash: "2 14", op: 0.6 }] }),
    build: cover({ figs: [{ c: T("library"), k: 1.9, handles: true, handleR: 8, keys: [st("stand", 480, 500, 1.9)] }] }),
    pivot: cover({ figs: [{ c: "var(--text-1)", k: 1.6, keys: [st("stand", 290, 480, 1.6)] }, { c: T("library"), k: 1.6, keys: [st("wave", 680, 480, 1.6), st("waveB", 680, 480, 1.6)] }],
      props: [{ t: "path", d: "M410 300H560M520 258l42 42-42 42", c: T("library"), w: 14 }] }),
    clip: cover({ figs: [{ c: T("library"), k: 1.5, keys: [st("victory", 480, 440, 1.5), st("jump", 480, 400, 1.5)] }], props: [{ t: "path", d: "M300 90H660A30 30 0 0 1 690 120V440A30 30 0 0 1 660 470H300A30 30 0 0 1 270 440V120A30 30 0 0 1 300 90Z", c: T("library"), w: 10, dash: "4 22" }] }),
    draw: cover({ props: [{ t: "path", d: "M150 380C240 200 330 470 430 300S620 160 700 280 800 400 830 200", c: T("draw"), w: 30 }, { t: "path", d: "M190 150c40-40 90-40 130 0", c: T("draw"), w: 14, op: 0.45 }] }),
    fx: cover({ back: [{ t: "burst", x: 620, y: 250, r: 150, c: T("fx"), c2: "var(--tint-fx-soft)", n: 11 }], figs: [{ c: T("fx"), k: 1.6, keys: [st("hit", 330, 480, 1.6, true), st("guard", 320, 480, 1.6, true)] }] }),
    camera: cover({ figs: [{ c: T("camera"), k: 1.5, keys: [st("run", 470, 440, 1.5), st("runB", 490, 440, 1.5)] }],
      props: [{ t: "path", d: "M250 170V110H330M710 170V110H630M250 370V430H330M710 370V430H630", c: T("camera"), w: 14 }] }),
    sound: cover({ figs: [{ c: T("library"), k: 1.4, keys: [st("victory", 250, 440, 1.4), st("wave", 250, 440, 1.4)] }],
      props: [{ t: "path", d: "M440 270v0M490 220v100M540 170v200M590 240v60M640 130v280M690 210v120M740 250v40M790 190v160", c: T("library"), w: 20 }] }),
    export: cover({ props: [{ t: "path", d: "M270 110H690A30 30 0 0 1 720 140V400A30 30 0 0 1 690 430H270A30 30 0 0 1 240 400V140A30 30 0 0 1 270 110Z", fill: "var(--tint-export)", c: "var(--tint-export)", w: 2 }, { t: "path", d: "M440 210 550 270 440 330Z", fill: "var(--tint-export-ink)", c: "var(--tint-export-ink)", w: 18 }] }),
  };
  S.TRACKS = [
    { id: "start", name: "Start here", line: "Pose a figure, add frames, press Play" },
    { id: "motion", name: "Make it move well", line: "Smooth motion, timing and walk cycles" },
    { id: "figures", name: "Your own figures", line: "Build, import and reuse characters" },
    { id: "fx", name: "Effects, camera and sound", line: "Give a scene impact" },
    { id: "finish", name: "Finish and share", line: "Export for any platform" },
  ];
  S.LESSONS = [
    { id: "first", track: "start", title: "First steps", line: "Pose Blue, add frames and play your first animation.", mins: 3, steps: 6, tint: "select", ws: "Animate", scene: covers.first, live: true },
    { id: "onion", track: "start", title: "Frames and onion skin", line: "See the previous pose while you set the next one.", mins: 4, steps: 5, tint: "time", ws: "Animate", scene: covers.onion },
    { id: "play", track: "start", title: "Play, loop and speed", line: "Preview your work and set how fast it runs.", mins: 2, steps: 4, tint: "time", ws: "Animate", scene: covers.play },
    { id: "tween", track: "motion", title: "Smooth motion with the Tweener", line: "Let StykAnimate fill in the frames between two poses.", mins: 5, steps: 7, tint: "time", ws: "Animate", scene: covers.tween },
    { id: "walk", track: "motion", title: "A walk cycle", line: "Four poses that loop into a walk.", mins: 8, steps: 9, tint: "select", ws: "Animate", scene: covers.walk },
    { id: "easing", track: "motion", title: "Easing and inbetweens", line: "Make movements start and stop naturally.", mins: 4, steps: 5, tint: "time", ws: "Animate", scene: covers.easing },
    { id: "build", track: "figures", title: "Build your own figure", line: "Draw sticks and joints in the Build workspace.", mins: 6, steps: 8, tint: "library", ws: "Build", scene: covers.build },
    { id: "pivot", track: "figures", title: "Bring in Pivot and Stick Nodes files", line: "Open your old animations and figures.", mins: 3, steps: 4, tint: "library", ws: "Animate", scene: covers.pivot },
    { id: "clip", track: "figures", title: "Movieclips", line: "Reuse an animated group anywhere in a scene.", mins: 5, steps: 6, tint: "library", ws: "Animate", scene: covers.clip },
    { id: "draw", track: "figures", title: "Draw frame by frame", line: "Brushes, fills and drawing layers.", mins: 6, steps: 7, tint: "draw", ws: "Draw", scene: covers.draw },
    { id: "fx", track: "fx", title: "Explosions and auras", line: "Add particle effects to a hit.", mins: 5, steps: 6, tint: "fx", ws: "Animate", scene: covers.fx },
    { id: "camera", track: "fx", title: "Camera moves and shake", line: "Follow the action and sell the impact.", mins: 5, steps: 6, tint: "camera", ws: "Animate", scene: covers.camera },
    { id: "sound", track: "fx", title: "Add sound", line: "Import audio and line it up with your frames.", mins: 4, steps: 5, tint: "library", ws: "Animate", scene: covers.sound },
    { id: "export", track: "finish", title: "Export for YouTube, Shorts and GIF", line: "Pick a format and share your animation.", mins: 3, steps: 4, tint: "export", ws: "Animate", scene: covers.export },
  ];
  // Progress lives in memory: finishing the live lesson marks it done until the page reloads.
  S.progress = { done: new Set(), partial: {} };
  S.lessonState = (l) => (S.progress.done.has(l.id) ? "done" : S.progress.partial[l.id] ? "started" : "new");
  S.nextLesson = () => S.LESSONS.find((l) => !S.progress.done.has(l.id)) || S.LESSONS[0];
  S.doneCount = () => S.progress.done.size;

  /* The one lesson every concept can run. `wait` names the editor event that completes a step. */
  S.FIRST_STEPS = [
    { id: "stage", target: "artboard", side: "right", title: "This is your stage", short: "The stage", say: "Everything inside the dashed frame ends up in your animation.",
      body: "Everything inside the dashed frame ends up in your animation. Blue is already here, waiting for a pose." },
    { id: "pose", target: "figure", side: "right", wait: "pose", demo: "pose", title: "Pose Blue", short: "Pose", verb: "Drag a red joint", say: "Drag a red joint to bend an arm or a leg.",
      body: "Drag a <b>red joint</b> to bend an arm or a leg. The <b>orange dot</b> moves the whole figure.", done: "That's a pose." },
    { id: "add", target: "add-frame", side: "top", wait: "addFrame", demo: "addFrame", title: "Keep the pose", short: "Add frame", verb: "Press Add frame", say: "Press Add frame to keep this pose and start the next one.",
      body: "A frame is one pose. Press <b>Add frame</b> to keep this one and start the next.", done: "Frame 2 is ready." },
    { id: "pose2", target: "figure", side: "right", wait: "pose", demo: "pose2", title: "Move a little more", short: "Pose again", verb: "Drag a joint again", say: "Move Blue a little more. The faint shape is your last frame.",
      body: "Change the pose again. The <b>faint shape</b> is your previous frame, so you can judge the distance. That's onion skin.", done: "Two poses make motion." },
    { id: "play", target: "play", side: "top", wait: "play", demo: "play", title: "Watch it move", short: "Play", verb: "Press Play", say: "Press Play, or the Space bar, to watch it.",
      body: "Press <b>Play</b> or the <kbd>Space</kbd> bar. StykAnimate fills in the motion between your frames.", done: "It moves!" },
    { id: "export", target: "export", side: "bottom", title: "Share it when you're ready", short: "Export", say: "Export turns your animation into a video or a GIF.",
      body: "<b>Export</b> turns your animation into a video or a GIF for YouTube, Shorts, TikTok or a chat." },
  ];

  /* ---------------- help */
  S.DOCS = [
    { group: "Get going", items: [
      { id: "keys", icon: "keyboard", title: "Keyboard shortcuts", line: "Every key, and how to change them" },
      { id: "pivot", icon: "import", title: "Coming from Pivot", line: "What's the same, what's new, how to open .piv files" },
      { id: "timeline", icon: "timeline", title: "Simple and Advanced timeline", line: "Frames, layers, keys and inbetweens" } ] },
    { group: "Reference", items: [
      { id: "formats", icon: "file", title: "File formats", line: "Projects, figures, movieclips and exports" },
      { id: "library", icon: "library", title: "Library and community figures", line: "Save, reuse and download figures" },
      { id: "perf", icon: "activity", title: "Slow playback?", line: "Preview quality and large scenes" } ] },
    { group: "More", items: [
      { id: "new", icon: "sparkle", title: "What's new in 1.2.5", line: "Release notes" },
      { id: "feedback", icon: "message", title: "Send feedback", line: "Report a problem or suggest something" } ] },
  ];
  S.ALL_DOCS = S.DOCS.flatMap((g) => g.items);
  S.SHORTCUTS = [
    ["Animate", [["Play or pause", "Space"], ["Add frame", "A"], ["Next frame", "."], ["Previous frame", ","], ["Onion skin", "O"], ["Select and pose", "V"], ["Pan the canvas", "H"]]],
    ["Edit", [["Undo", "Ctrl+Z"], ["Redo", "Ctrl+Shift+Z"], ["Duplicate", "Ctrl+D"], ["Copy frames", "Ctrl+C"], ["Paste frames", "Ctrl+V"]]],
    ["Project", [["New animation", "Ctrl+N"], ["Open", "Ctrl+O"], ["Save", "Ctrl+S"], ["Export", "Ctrl+Shift+E"], ["Search commands", "Ctrl+P"]]],
  ];
  S.docArticle = () => `<h2>Keyboard shortcuts</h2><p class="lede">The keys you will use most. Change any of them in Settings › Shortcuts.</p>` +
    S.SHORTCUTS.map(([g, rows]) => `<h3>${g}</h3><table class="doc-keys">${rows.map(([a, k]) => `<tr><td>${a}</td><td>${k.split("+").map((x) => `<kbd>${x}</kbd>`).join(" ")}</td></tr>`).join("")}</table>`).join("") +
    `<p class="doc-foot">Was this page helpful? <a href="#" onclick="return false">Yes</a> · <a href="#" onclick="return false">No</a></p>`;
})();
