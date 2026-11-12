// The canvas app. The server owns the board; the page applies the same operations locally
// so that dragging and tagging never wait for a round trip.
import { applyOp, bounds, liveFrames } from '/shared/board-model.mjs';
import { createCamera } from '/app/camera.mjs';
import { createFrameViews } from '/app/frame-views.mjs';

const $ = (id) => document.getElementById(id);
const icon = (name, size = 16) => (window.STYK_ICONS[name] ?? '').replace('width="18" height="18"', `width="${size}" height="${size}"`);
const SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10z"/></svg>';
const DEVICES = [['desktop', 'Desktop', 1280, 800], ['laptop', 'Small window', 1024, 640], ['tablet', 'Tablet', 1180, 820], ['phone', 'Phone', 390, 844]];
const STARTERS = ['5 Homes and 5 timelines', '10 export dialogs in different styles', 'A timeline a 12-year-old gets instantly', 'First-run experience, as a 3-screen flow'];
const INTENTS = {
  one: [['refine', 'Refine'], ['variants', 'Variants'], ['next', 'Next screen'], ['restyle', 'Restyle'], ['critique', 'Critique']],
  many: [['combine', 'Combine'], ['restyle', 'Restyle']],
};
const PLACEHOLDER = {
  create: 'What should we try? 5 Homes, 10 timelines in different styles…', refine: 'What should change?', variants: 'How many, and what should they explore? (optional)',
  next: 'What happens next?', restyle: 'Describe the look: warm paper, arcade, film noir…', critique: 'Anything to focus on? (optional)',
  combine: 'What should the combination keep?', element: 'What should change here?',
};
const clientId = crypto.randomUUID();
const safeStorage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* a convenience only */ } },
};

let board = await (await fetch('/api/board')).json();
const ui = {
  selected: new Set(), filter: new Set(), covers: new Map(), picking: null, picked: null, intent: 'refine', awaitingFocus: false,
  device: 'desktop', frameTheme: 'light', undo: [], redo: [], space: false,
};

const stage = $('stage'), world = $('world');
const views = createFrameViews({ world, camera: { get state() { return camera.state; } }, getBoard: () => board, onMessage });
const camera = createCamera({ stage, world, onChange: scheduleCamera });

/* ---------------- operations and undo */
function send(ops) {
  fetch('/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, ops }) }).catch(() => toast('Could not reach the server.'));
}
function act(ops, inverse) {
  for (const op of ops) applyOp(board, op);
  send(ops);
  if (inverse) { ui.undo.push({ ops, inverse }); if (ui.undo.length > 200) ui.undo.shift(); ui.redo.length = 0; }
  render();
}
function history(from, to, key) {
  const entry = from.pop();
  if (!entry) return;
  const ops = entry[key];
  for (const op of ops) applyOp(board, op);
  send(ops);
  to.push(entry);
  render();
}
const undo = () => history(ui.undo, ui.redo, 'inverse');
const redo = () => history(ui.redo, ui.undo, 'ops');

/* ---------------- rendering */
// A flow is every live screen sharing a group. The canvas shows it as one card, so a
// 10-screen prototype costs one slot; its screens open full window.
function flows() {
  const groups = new Map();
  for (const frame of liveFrames(board)) {
    if (groups.has(frame.group)) groups.get(frame.group).push(frame);
    else groups.set(frame.group, [frame]);
  }
  return groups;
}
const coverOf = (members) => members.find((frame) => frame.id === ui.covers.get(members[0].group)) ?? members[0];
const visible = () => [...flows().values()].map(coverOf);
const flowOf = (frame) => flows().get(frame.group) ?? [frame];

// Screens of a flow share one place, so any of them can be the card without it jumping.
function alignFlows() {
  const moves = [];
  for (const [head, ...rest] of flows().values()) {
    for (const frame of rest) if (frame.x !== head.x || frame.y !== head.y) moves.push({ id: frame.id, x: head.x, y: head.y });
  }
  if (!moves.length) return;
  const op = { op: 'moveFrames', moves };
  applyOp(board, op);
  send([op]);
}
const selectedFrames = () => [...ui.selected].map((id) => board.frames[id]).filter((frame) => frame && !frame.deleted);
const matchesFilter = (frame) => !ui.filter.size || frame.tags.some((tag) => ui.filter.has(tag));

function render() {
  alignFlows();
  const groups = flows();
  const shown = new Set([...groups.values()].map((members) => coverOf(members).id));
  for (const frame of Object.values(board.frames)) {
    const view = views.update(frame, { shown: shown.has(frame.id), screens: groups.get(frame.group)?.length ?? 1 });
    view.element.classList.toggle('is-selected', ui.selected.has(frame.id));
    view.element.classList.toggle('is-live', ui.picking === frame.id);
    view.element.classList.toggle('is-dim', !matchesFilter(frame));
  }
  for (const id of ui.selected) if (!board.frames[id] || board.frames[id].deleted) ui.selected.delete(id);
  views.cull();
  renderTags();
  renderSelbar();
  renderCritique();
  renderComposer();
  renderStatus();
  $('empty').hidden = visible().length > 0;
}

function renderTags() {
  const nav = $('tags');
  const counts = board.tags.map((tag) => ({ tag, n: visible().filter((frame) => frame.tags.includes(tag.id)).length })).filter(({ n }) => n);
  nav.hidden = !counts.length;
  nav.replaceChildren(...counts.map(({ tag, n }) => {
    const chip = document.createElement('button');
    chip.className = 'tag-chip';
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(ui.filter.has(tag.id)));
    chip.title = 'Show only these · double-click to select them';
    chip.innerHTML = `<i class="tag-dot" style="--dot-c:var(--tint-${tag.hue})"></i><span></span><small>${n}</small>`;
    chip.querySelector('span').textContent = tag.name;
    chip.onclick = () => { ui.filter.has(tag.id) ? ui.filter.delete(tag.id) : ui.filter.add(tag.id); render(); };
    chip.ondblclick = () => { select(visible().filter((frame) => frame.tags.includes(tag.id)).map((frame) => frame.id)); };
    return chip;
  }));
}

function renderSelbar() {
  const bar = $('selbar');
  const frames = selectedFrames();
  bar.hidden = !frames.length || Boolean(ui.picking);
  if (bar.hidden) { $('tagmenu').hidden = true; return; }
  const button = (name, title, action, disabled) => `<button class="ic" type="button" data-do="${action}" aria-label="${title}" title="${title}"${disabled ? ' disabled' : ''}>${name}</button>`;
  const [frame] = frames;
  const one = frames.length === 1;
  const index = one ? frame.versions.findIndex((version) => version.n === frame.version) : -1;
  bar.innerHTML = [
    one && frame.versions.length > 1 ? `${button(icon('chevron-left', 14), 'Older version · [', 'older', index <= 0)}<span class="vers">${index + 1} / ${frame.versions.length}</span>${button(icon('chevron-right', 14), 'Newer version · ]', 'newer', index >= frame.versions.length - 1)}<span class="sep"></span>` : '',
    button(icon('flag'), 'Tag · T', 'tag'),
    one ? button(icon('cursor'), 'Pick an element · E', 'pick', !frame.version) : '',
    one ? button(icon('play'), 'Play full window · P', 'play', !frame.version) : '',
    button(frame.theme === 'dark' ? SUN : MOON, 'Switch this screen\'s theme', 'theme'),
    one ? button(icon('duplicate'), 'Copy HTML', 'copy', !frame.version) : '',
    button(icon('trash'), 'Delete · Del', 'delete'),
  ].join('');
  placeSelbar();
}

function placeSelbar() {
  const bar = $('selbar');
  if (bar.hidden) return;
  const box = bounds(selectedFrames());
  if (!box) return;
  const right = camera.toScreen(box.right, box.top);
  const left = camera.toScreen(box.left, box.top);
  const width = bar.offsetWidth;
  const x = Math.max(12, Math.min(innerWidth - width - 12, right.x - width));
  const y = Math.max(60, left.y - 80);
  bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  const menu = $('tagmenu');
  if (!menu.hidden) { menu.style.left = `${Math.min(innerWidth - 220, x)}px`; menu.style.top = `${y + 46}px`; }
}

function renderCritique() {
  const panel = $('critique');
  const frames = selectedFrames();
  const critique = frames.length === 1 ? frames[0].critique : null;
  panel.hidden = !critique?.length;
  if (panel.hidden) return;
  const signature = JSON.stringify(critique);
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  panel.innerHTML = '<header><h2>Critique</h2><button class="ic" type="button" aria-label="Close" data-close>' + icon('close') + '</button></header>';
  critique.forEach((finding) => {
    const item = document.createElement('section');
    item.className = 'finding';
    item.dataset.sev = finding.sev;
    item.innerHTML = '<h3><i></i><span></span></h3><p></p><button class="link" type="button">Apply fix</button>';
    item.querySelector('span').textContent = finding.title;
    item.querySelector('p').textContent = finding.why;
    item.querySelector('button').onclick = () => generate({ intent: 'refine', prompt: finding.fix, frames: [frames[0].id] });
    panel.append(item);
  });
  panel.querySelector('[data-close]').onclick = () => act([{ op: 'clearCritique', id: frames[0].id }]);
}

function currentIntent() {
  if (ui.picked) return 'element';
  const count = selectedFrames().filter((frame) => frame.version).length;
  if (!count) return 'create';
  const options = (count === 1 ? INTENTS.one : INTENTS.many).map(([id]) => id);
  return options.includes(ui.intent) ? ui.intent : options[0];
}

function renderComposer() {
  const intent = currentIntent();
  const frames = selectedFrames().filter((frame) => frame.version);
  const context = $('context');
  context.hidden = intent === 'create';
  if (!context.hidden) {
    const label = ui.picked ? `${frames[0]?.title} › ${ui.picked.label}` : frames.length === 1 ? frames[0].title : `${frames.length} screens`;
    const list = ui.picked ? [] : (frames.length === 1 ? INTENTS.one : INTENTS.many);
    const signature = `${label}|${intent}|${frames.length}`;
    if (context.dataset.signature !== signature) {
      context.dataset.signature = signature;
      context.innerHTML = `<span class="ctx-target"><span></span><button type="button" aria-label="Clear">${icon('close', 12)}</button></span><div class="seg" role="group" aria-label="Action"></div>`;
      context.querySelector('.ctx-target span').textContent = label;
      context.querySelector('.ctx-target button').onclick = () => { if (ui.picked) { ui.picked = null; render(); } else select([]); };
      const seg = context.querySelector('.seg');
      seg.hidden = !list.length;
      for (const [id, name] of list) {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = name;
        item.setAttribute('aria-pressed', String(id === intent));
        item.onclick = () => { ui.intent = id; render(); $('prompt').focus(); };
        seg.append(item);
      }
    }
  } else context.dataset.signature = '';
  $('prompt').placeholder = PLACEHOLDER[intent];
  $('device').hidden = intent !== 'create';
  updateSend();
}

function updateSend() {
  const intent = currentIntent();
  $('send').disabled = !$('prompt').value.trim() && intent !== 'variants' && intent !== 'critique';
}

const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
function renderStatus() {
  const runs = Object.values(board.runs);
  const running = runs.filter((run) => run.state === 'running');
  $('running').hidden = $('stop').hidden = !running.length;
  if (running.length) {
    const started = Math.min(...running.map((run) => run.startedAt));
    const planning = running.some((run) => run.phase === 'planning');
    $('running').textContent = `${planning ? 'Planning · ' : ''}${views.clock(Date.now() - started)}`;
  }
  const total = runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0);
  $('meter').textContent = total ? `${compact(total)} tokens` : '';
  $('meter').nextElementSibling.hidden = !total;
}

/* ---------------- selection */
function select(ids) {
  ui.selected = new Set(ids);
  ui.picked = null;
  stopPicking();
  render();
}
function stopPicking() {
  if (ui.picking) views.setMode(ui.picking, 'view');
  ui.picking = null;
  // Focus left inside a screen would swallow every shortcut.
  if (document.activeElement?.tagName === 'IFRAME') { document.activeElement.blur(); window.focus(); }
}
function startPick(id) {
  stopPicking();
  ui.picking = id;
  ui.selected = new Set([id]);
  views.setMode(id, 'pick');
  render();
  toast('Click the part you want to change');
}

async function onMessage(id, message) {
  if (message.t === 'escape') { stopPicking(); render(); }
  if (message.t === 'pick' && ui.picking === id) {
    const html = await views.screenHtml(board.frames[id]);
    const template = document.createElement('template');
    template.innerHTML = html;
    let node = template.content;
    for (const index of message.path.split('.').map(Number)) node = node?.children[index];
    if (!node) return;
    const element = node.outerHTML;
    const marker = `<!--pick-${crypto.randomUUID()}-->`;
    node.replaceWith(document.createComment(marker.slice(4, -3)));
    const [before, after] = template.innerHTML.split(marker);
    stopPicking();
    ui.picked = { html: element, before, after, label: message.label };
    render();
    $('prompt').focus();
  }
}

/* ---------------- generating */
async function generate(body) {
  ui.awaitingFocus = ['create', 'variants', 'next', 'combine'].includes(body.intent);
  const response = await fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!response?.ok) {
    ui.awaitingFocus = false;
    toast((await response?.json().catch(() => null))?.error ?? 'Could not reach the server.');
    return false;
  }
  return true;
}

async function submit() {
  const intent = currentIntent();
  const prompt = $('prompt').value.trim();
  if (!prompt && intent !== 'variants' && intent !== 'critique') return;
  const device = DEVICES.find(([id]) => id === ui.device);
  const frames = selectedFrames().filter((frame) => frame.version).map((frame) => frame.id);
  const sent = await generate({
    intent, prompt, frames, theme: ui.frameTheme,
    size: { w: device[2], h: device[3] },
    element: ui.picked ? { html: ui.picked.html, before: ui.picked.before, after: ui.picked.after } : undefined,
  });
  if (!sent) return;
  $('prompt').value = '';
  $('prompt').style.height = '';
  ui.picked = null;
  render();
}

function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3200);
}

/* ---------------- server events */
const events = new EventSource('/api/events');
events.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (event.type === 'stream') { views.stream(event.id, event.html); return; }
  if (event.origin === clientId) return;
  const { op } = event;
  applyOp(board, op);
  // A next screen joins a flow; show it being made instead of hiding it in the stack.
  if (op.op === 'addFrame' && board.runs[op.frame.run]?.intent === 'next') {
    ui.covers.set(op.frame.group, op.frame.id);
    ui.selected = new Set([op.frame.id]);
  }
  if (op.op === 'addFrame' && ui.awaitingFocus) {
    clearTimeout(generate.focus);
    generate.focus = setTimeout(() => {
      ui.awaitingFocus = false;
      camera.fit(bounds(visible().filter((frame) => frame.run === op.frame.run)), { maxZoom: 0.75 });
    }, 120);
  }
  if (op.op === 'upsertRun' && op.run.state && op.run.state !== 'running') {
    if (op.run.state === 'done' && op.run.ms) toast(`Done in ${views.clock(op.run.ms)} · ${compact(op.run.tokens ?? 0)} tokens`);
    if (op.run.state === 'failed') toast(op.run.error ?? 'That run failed.');
  }
  render();
};
events.onerror = () => { if (events.readyState === EventSource.CLOSED) toast('Lost the server. Reload to reconnect.'); };

/* ---------------- pointer */
let gesture = null;
const point = (event) => ({ x: event.clientX, y: event.clientY });

stage.addEventListener('pointerdown', (event) => {
  if ($('tagmenu').hidden === false) $('tagmenu').hidden = true;
  const start = point(event);
  stage.setPointerCapture(event.pointerId);
  if (event.button === 1 || ui.space) {
    event.preventDefault();
    gesture = { kind: 'pan', start, camera: { ...camera.state } };
    stage.classList.add('is-panning');
    return;
  }
  if (event.button !== 0) return;
  const element = event.target.closest('.fr');
  const id = element?.dataset.id;
  if (ui.picking && ui.picking !== id) stopPicking();
  if (!id) {
    if (!event.shiftKey) select([]);
    gesture = { kind: 'marquee', start, base: new Set(ui.selected) };
    return;
  }
  if (event.target.closest('.fr-resize')) {
    const frame = board.frames[id];
    gesture = { kind: 'resize', id, start, w: frame.w, h: frame.h };
    return;
  }
  if (event.shiftKey) { ui.selected.has(id) ? ui.selected.delete(id) : ui.selected.add(id); render(); }
  else if (!ui.selected.has(id)) select([id]);
  const moves = selectedFrames().flatMap(flowOf).map((frame) => ({ id: frame.id, x: frame.x, y: frame.y }));
  gesture = { kind: 'move', start, moves, moved: false };
});

stage.addEventListener('pointermove', (event) => {
  if (!gesture) return;
  const now = point(event);
  const z = camera.state.z, dx = now.x - gesture.start.x, dy = now.y - gesture.start.y;
  if (gesture.kind === 'pan') camera.set({ x: gesture.camera.x + dx, y: gesture.camera.y + dy });
  if (gesture.kind === 'move' && (gesture.moved || Math.hypot(dx, dy) > 3)) {
    gesture.moved = true;
    for (const move of gesture.moves) {
      const frame = board.frames[move.id];
      frame.x = Math.round(move.x + dx / z);
      frame.y = Math.round(move.y + dy / z);
      views.update(frame);
    }
    placeSelbar();
  }
  if (gesture.kind === 'resize') {
    const frame = board.frames[gesture.id];
    frame.w = Math.max(320, Math.round(gesture.w + dx / z));
    frame.h = Math.max(320, Math.round(gesture.h + dy / z));
    views.update(frame);
    placeSelbar();
    gesture.moved = true;
  }
  if (gesture.kind === 'marquee') {
    const left = Math.min(gesture.start.x, now.x), top = Math.min(gesture.start.y, now.y), width = Math.abs(dx), height = Math.abs(dy);
    Object.assign($('marquee').style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    $('marquee').hidden = false;
    const a = camera.toWorld(left, top), b = camera.toWorld(left + width, top + height);
    const hit = visible().filter((frame) => matchesFilter(frame) && frame.x < b.x && frame.x + frame.w > a.x && frame.y < b.y && frame.y + frame.h > a.y).map((frame) => frame.id);
    ui.selected = new Set([...gesture.base, ...hit]);
    render();
  }
});

function endGesture() {
  if (!gesture) return;
  stage.classList.remove('is-panning');
  $('marquee').hidden = true;
  if (gesture.kind === 'pan') saveCamera();
  if (gesture.kind === 'move' && gesture.moved) {
    const moves = gesture.moves.map(({ id }) => ({ id, x: board.frames[id].x, y: board.frames[id].y }));
    act([{ op: 'moveFrames', moves }], [{ op: 'moveFrames', moves: gesture.moves }]);
  }
  if (gesture.kind === 'resize' && gesture.moved) {
    const frame = board.frames[gesture.id];
    act([{ op: 'patchFrame', id: frame.id, patch: { w: frame.w, h: frame.h } }], [{ op: 'patchFrame', id: frame.id, patch: { w: gesture.w, h: gesture.h } }]);
  }
  gesture = null;
}
stage.addEventListener('pointerup', endGesture);
stage.addEventListener('pointercancel', endGesture);
stage.addEventListener('dblclick', (event) => {
  // Pointer capture retargets this event to the stage, so ask what is really under it.
  const id = document.elementFromPoint(event.clientX, event.clientY)?.closest('.fr')?.dataset.id;
  if (id && board.frames[id].version) present(board.frames[id]);
});
stage.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) camera.zoomAt(Math.exp(-event.deltaY * 0.0022), event.clientX, event.clientY);
  else camera.set({ x: camera.state.x - event.deltaX, y: camera.state.y - event.deltaY });
  saveCamera();
}, { passive: false });

let cameraFrame = 0, cameraSave = 0;
function scheduleCamera() {
  $('zoom').textContent = `${Math.round(camera.state.z * 100)}%`;
  placeSelbar();
  cameraFrame ||= requestAnimationFrame(() => { cameraFrame = 0; views.cull(); });
}
function saveCamera() {
  clearTimeout(cameraSave);
  cameraSave = setTimeout(() => safeStorage.set('ui-canvas-camera', JSON.stringify(camera.state)), 300);
}

/* ---------------- selection bar */
$('selbar').addEventListener('click', async (event) => {
  const action = event.target.closest('[data-do]')?.dataset.do;
  if (!action) return;
  const frames = selectedFrames();
  const [frame] = frames;
  if (action === 'older' || action === 'newer') stepVersion(frame, action === 'older' ? -1 : 1);
  if (action === 'tag') openTagMenu();
  if (action === 'pick') startPick(frame.id);
  if (action === 'play') present(frame);
  if (action === 'theme') {
    const next = frame.theme === 'dark' ? 'light' : 'dark';
    act(frames.map((item) => ({ op: 'patchFrame', id: item.id, patch: { theme: next } })), frames.map((item) => ({ op: 'patchFrame', id: item.id, patch: { theme: item.theme } })));
  }
  if (action === 'copy') { await navigator.clipboard.writeText(await views.screenHtml(frame)); toast('HTML copied'); }
  if (action === 'delete') removeSelected();
});

function stepVersion(frame, delta) {
  const index = frame.versions.findIndex((version) => version.n === frame.version) + delta;
  const version = frame.versions[index];
  if (version) act([{ op: 'setVersion', id: frame.id, n: version.n }], [{ op: 'setVersion', id: frame.id, n: frame.version }]);
}
function removeSelected() {
  const ids = selectedFrames().flatMap(flowOf).map((frame) => frame.id);
  if (!ids.length) return;
  act([{ op: 'deleteFrames', ids }], [{ op: 'restoreFrames', ids }]);
  toast(`${ids.length === 1 ? 'Screen' : `${ids.length} screens`} deleted · Ctrl+Z to undo`);
}

function toggleTag(tagId) {
  const frames = selectedFrames();
  const on = frames.every((frame) => frame.tags.includes(tagId));
  act(frames.map((frame) => ({ op: 'setFrameTags', id: frame.id, tags: on ? frame.tags.filter((id) => id !== tagId) : [...new Set([...frame.tags, tagId])] })),
    frames.map((frame) => ({ op: 'setFrameTags', id: frame.id, tags: [...frame.tags] })));
}

function openTagMenu() {
  const menu = $('tagmenu');
  const frames = selectedFrames();
  menu.replaceChildren();
  board.tags.forEach((tag, index) => {
    const row = document.createElement('button');
    row.className = 'tag-row';
    row.type = 'button';
    const on = frames.every((frame) => frame.tags.includes(tag.id));
    row.innerHTML = `<i class="tag-dot" style="--dot-c:var(--tint-${tag.hue})"></i><span></span>${on ? `<span class="tick">${icon('check', 14)}</span>` : index < 9 ? `<kbd>${index + 1}</kbd>` : ''}`;
    row.querySelector('span').textContent = tag.name;
    row.onclick = () => { toggleTag(tag.id); openTagMenu(); };
    menu.append(row);
  });
  const input = document.createElement('input');
  input.placeholder = 'New tag';
  input.maxLength = 24;
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') menu.hidden = true;
    if (event.key !== 'Enter' || !input.value.trim()) return;
    const name = input.value.trim();
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || crypto.randomUUID().slice(0, 8);
    // The three default tags hold library, time and fx.
    const hues = ['select', 'draw', 'camera', 'library', 'time', 'fx'];
    act([{ op: 'addTag', tag: { id, name, hue: hues[(board.tags.length - 3) % hues.length] } }]);
    toggleTag(id);
    openTagMenu();
  };
  menu.append(input);
  menu.hidden = false;
  placeSelbar();
  input.focus();
}

/* ---------------- play: full window, where a flow is clickable */
let presentFrame = null;
const presentView = { iframe: null, ready: false };

function fitPresent() {
  const { iframe } = presentView;
  if (!iframe || !presentFrame) return;
  const holder = $('present-holder');
  const { w, h } = presentFrame;
  const scale = Math.min(holder.clientWidth / w, holder.clientHeight / h, 2);
  iframe.style.width = `${w}px`;
  iframe.style.height = `${h}px`;
  iframe.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
function renderPresentBar() {
  const screens = flowOf(presentFrame);
  $('present-title').textContent = screens.length > 1 ? `${screens.length} screens` : presentFrame.title;
  const nav = $('present-screens');
  nav.hidden = screens.length < 2;
  nav.replaceChildren(...screens.map((frame) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = frame.title;
    item.setAttribute('aria-current', String(frame.id === presentFrame.id));
    item.onclick = () => showScreen(frame);
    return item;
  }));
  nav.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function present(frame) {
  presentFrame = frame;
  const holder = $('present-holder');
  holder.replaceChildren();
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.title = 'Prototype';
  iframe.src = '/frame/app/index.html';
  holder.append(iframe);
  presentView.iframe = iframe;
  presentView.ready = false;
  $('present').hidden = false;
  fitPresent();
  renderPresentBar();
}
function showScreen(frame) {
  presentFrame = frame;
  fitPresent();
  renderPresentBar();
  drawPresent();
}
function stepScreen(delta) {
  const screens = flowOf(presentFrame);
  const next = screens[screens.findIndex((frame) => frame.id === presentFrame.id) + delta];
  if (next) showScreen(next);
}
async function drawPresent() {
  if (!presentFrame || !presentView.ready) return;
  const frame = presentFrame;
  const html = await views.screenHtml(frame);
  if (frame === presentFrame) presentView.iframe.contentWindow.postMessage({ t: 'render', html, theme: frame.theme }, '*');
}
function closePresent() {
  const frame = presentFrame;
  $('present').hidden = true;
  $('present-holder').replaceChildren();
  presentFrame = null;
  presentView.iframe = null;
  // Leave the card on the screen you were looking at, so the composer acts on that one.
  if (!frame) return;
  ui.covers.set(frame.group, frame.id);
  select([frame.id]);
}
addEventListener('message', (event) => {
  if (!presentView.iframe || event.source !== presentView.iframe.contentWindow) return;
  const { t, to, key } = event.data ?? {};
  if (t === 'ready') { presentView.ready = true; drawPresent(); }
  if (t === 'escape') closePresent();
  if (t === 'key') stepScreen(key === 'ArrowLeft' ? -1 : 1);
  if (t === 'go') {
    const target = flowOf(presentFrame).find((other) => other.screenId === to);
    if (target) showScreen(target); else toast(`"${to}" isn't drawn yet`);
  }
});

/* ---------------- keyboard */
addEventListener('keydown', (event) => {
  const typing = event.target.matches?.('textarea, input, select');
  const ctrl = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') {
    if (!$('present').hidden) { closePresent(); return; }
    if (!$('tagmenu').hidden) { $('tagmenu').hidden = true; return; }
    if (typing) { event.target.blur(); return; }
    if (ui.picked) { ui.picked = null; render(); return; }
    if (ui.picking) { stopPicking(); render(); return; }
    select([]);
    return;
  }
  if (!$('present').hidden) {
    if (event.key === 'ArrowLeft') stepScreen(-1);
    if (event.key === 'ArrowRight') stepScreen(1);
    return;
  }
  if (typing) return;
  if (ctrl && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if (ctrl && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
  if (ctrl && event.key.toLowerCase() === 'a') { event.preventDefault(); select(visible().filter(matchesFilter).map((frame) => frame.id)); return; }
  if (ctrl) return;
  if (event.code === 'Space') { event.preventDefault(); ui.space = true; stage.classList.add('can-pan'); return; }
  const frames = selectedFrames();
  const [frame] = frames;
  const key = event.key.toLowerCase();
  if (key === '/' || event.key === 'Enter') { event.preventDefault(); $('prompt').focus(); }
  else if (event.key === '!' || (event.shiftKey && event.code === 'Digit1')) camera.fit(bounds(visible()));
  else if (key === 'f') camera.fit(bounds(frames.length ? frames : visible()));
  else if (event.key === 'Delete' || event.key === 'Backspace') removeSelected();
  else if (key === 't' && frames.length) openTagMenu();
  else if (key === 'e' && frames.length === 1 && frame.version) startPick(frame.id);
  else if (key === 'p' && frames.length === 1 && frame.version) present(frame);
  else if (event.key === '[' && frames.length === 1) stepVersion(frame, -1);
  else if (event.key === ']' && frames.length === 1) stepVersion(frame, 1);
  else if (/^[1-9]$/.test(event.key) && frames.length && board.tags[Number(event.key) - 1]) toggleTag(board.tags[Number(event.key) - 1].id);
  else if (key === '=' || key === '+') camera.zoomAt(1.25, innerWidth / 2, innerHeight / 2);
  else if (key === '-') camera.zoomAt(0.8, innerWidth / 2, innerHeight / 2);
});
addEventListener('keyup', (event) => { if (event.code === 'Space') { ui.space = false; stage.classList.remove('can-pan'); } });
addEventListener('blur', () => { ui.space = false; stage.classList.remove('can-pan'); });

/* ---------------- composer controls */
const prompt = $('prompt');
prompt.addEventListener('input', () => {
  prompt.style.height = 'auto';
  prompt.style.height = `${prompt.scrollHeight}px`;
  updateSend();
});
prompt.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } });
$('composer').addEventListener('submit', (event) => { event.preventDefault(); submit(); });
$('send').innerHTML = icon('arrow-up', 16);
$('device').innerHTML = DEVICES.map(([id, label, w, h]) => `<option value="${id}">${label} · ${w}×${h}</option>`).join('');
$('device').onchange = (event) => { ui.device = event.target.value; };
for (const text of STARTERS) {
  const item = document.createElement('button');
  item.type = 'button'; item.textContent = text;
  item.onclick = () => { prompt.value = text; prompt.dispatchEvent(new Event('input')); prompt.focus(); };
  $('starters').append(item);
}
$('stop').onclick = () => {
  for (const run of Object.values(board.runs)) if (run.state === 'running') fetch('/api/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run: run.id }) });
};
$('fit').innerHTML = icon('fit', 16);
$('fit').onclick = () => camera.fit(bounds(visible()));
$('zoom').onclick = () => camera.zoomAt(1 / camera.state.z, innerWidth / 2, innerHeight / 2);
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  ui.frameTheme = theme;
  $('theme').innerHTML = theme === 'dark' ? SUN : MOON;
  safeStorage.set('ui-canvas-theme', theme);
}
$('theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

/* ---------------- start */
setTheme(safeStorage.get('ui-canvas-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
const saved = (() => { try { return JSON.parse(safeStorage.get('ui-canvas-camera')); } catch { return null; } })();
camera.set(saved?.z ? saved : { x: innerWidth / 2, y: innerHeight / 2, z: 1 });
render();
if (!saved && visible().length) camera.fit(bounds(visible()));
setInterval(() => { views.tick(); if (Object.values(board.runs).some((run) => run.state === 'running')) renderStatus(); }, 1000);
addEventListener('resize', () => { views.cull(); placeSelbar(); fitPresent(); });
window.uiCanvas = { get board() { return board; }, ui };
