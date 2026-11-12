// The DOM for each screen. Live iframes are a bounded pool: only frames near the viewport
// hold one, and the least recently seen is released past the cap. Screens stay crisp and the
// page stays light however large the board grows.
const MAX_LIVE = 30, MARGIN = 300, CACHE = 80;

const escapeText = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

export function createFrameViews({ world, camera, getBoard, onMessage }) {
  const views = new Map();
  const htmlCache = new Map();

  async function screenHtml(frame) {
    if (!frame.version) return '';
    const key = `${frame.id}:${frame.version}`;
    if (htmlCache.has(key)) return htmlCache.get(key);
    const response = await fetch(`/api/screen/${frame.id}/${frame.version}`);
    const html = response.ok ? await response.text() : '';
    htmlCache.set(key, html);
    if (htmlCache.size > CACHE) htmlCache.delete(htmlCache.keys().next().value);
    return html;
  }

  function post(view, message) { if (view.ready) view.iframe.contentWindow.postMessage(message, '*'); }

  async function draw(view) {
    if (!view.iframe) return;
    const frame = getBoard().frames[view.id];
    if (!frame) return;
    if (view.stream !== null) { post(view, { t: 'render', html: view.stream, theme: frame.theme, streaming: true }); return; }
    const version = frame.version;
    const html = await screenHtml(frame);
    if (version === getBoard().frames[view.id]?.version) post(view, { t: 'render', html, theme: frame.theme });
  }

  function mount(view) {
    const iframe = document.createElement('iframe');
    // No same-origin, popups or forms: generated markup can reach nothing but its parent's messages.
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.title = 'Screen';
    iframe.src = '/frame/app/index.html';
    view.iframe = iframe;
    view.ready = false;
    view.body.prepend(iframe);
  }
  function unmount(view) { view.iframe?.remove(); view.iframe = null; view.ready = false; }

  function create(frame) {
    const element = document.createElement('article');
    element.className = 'fr';
    element.dataset.id = frame.id;
    element.innerHTML = '<header class="fr-head"></header><div class="fr-body"><div class="fr-state" hidden></div><div class="fr-shield"></div></div><div class="fr-resize"></div>';
    world.append(element);
    const view = { id: frame.id, element, head: element.querySelector('.fr-head'), body: element.querySelector('.fr-body'), state: element.querySelector('.fr-state'), iframe: null, ready: false, stream: null, seen: 0, sig: '' };
    views.set(frame.id, view);
    return view;
  }

  function paintState(view, frame) {
    const { state } = view;
    const elapsed = clock(Date.now() - (frame.startedAt ?? Date.now()));
    let kind = null, html = '';
    if (frame.status === 'queued') { kind = 'thinking'; html = '<b>Queued</b><span>Starts when a slot frees up</span>'; }
    else if (frame.status === 'thinking') { kind = 'thinking'; html = `<b>Thinking · ${elapsed}</b><div class="bar"></div>`; }
    else if (frame.status === 'streaming') { kind = 'writing'; html = `<span>Writing · ${elapsed}</span>`; }
    else if (frame.status === 'error') { kind = 'error'; html = `<b>This one didn't work</b><span>${escapeText(frame.error)}</span>`; }
    state.hidden = !kind;
    if (kind) { state.dataset.kind = kind; state.innerHTML = html; }
  }

  function update(frame, options) {
    const view = views.get(frame.id) ?? create(frame);
    view.options = options ?? view.options;
    const { shown, screens } = view.options;
    const { element } = view;
    element.hidden = !shown;
    element.classList.toggle('has-flow', screens > 1);
    element.style.left = `${frame.x}px`;
    element.style.top = `${frame.y}px`;
    element.style.width = `${frame.w}px`;
    view.body.style.height = `${frame.h}px`;
    const board = getBoard();
    const tags = frame.tags.map((id) => board.tags.find((tag) => tag.id === id)).filter(Boolean);
    const count = frame.versions.length;
    view.head.innerHTML = `<span class="fr-title">${escapeText(frame.title)}</span>${screens > 1 ? `<span class="fr-count">${screens} screens</span>` : ''}${count > 1 ? `<span class="fr-idea" style="flex:none">v${frame.versions.findIndex((v) => v.n === frame.version) + 1}</span>` : ''}${tags.map((tag) => `<span class="fr-tag" style="--dot-c:var(--tint-${tag.hue})"><i></i>${escapeText(tag.name)}</span>`).join('')}<span class="fr-idea">${escapeText(frame.idea)}</span>`;
    paintState(view, frame);
    const sig = `${frame.version}|${frame.theme}`;
    if (frame.status !== 'streaming' && view.stream !== null && frame.version) view.stream = null;
    if (sig !== view.sig) { view.sig = sig; draw(view); }
    return view;
  }

  function cull() {
    const { x, y, z } = camera.state;
    const left = -x / z - MARGIN / z, top = -y / z - MARGIN / z, right = left + (innerWidth + MARGIN * 2) / z, bottom = top + (innerHeight + MARGIN * 2) / z;
    const stamp = performance.now();
    const visible = [];
    for (const view of views.values()) {
      const frame = getBoard().frames[view.id];
      if (!frame || view.element.hidden) { unmount(view); continue; }
      if (frame.x < right && frame.x + frame.w > left && frame.y < bottom && frame.y + frame.h > top) { view.seen = stamp; visible.push(view); }
    }
    for (const view of visible.slice(0, MAX_LIVE)) if (!view.iframe) mount(view);
    const live = [...views.values()].filter((view) => view.iframe).sort((a, b) => b.seen - a.seen);
    for (const view of live.slice(MAX_LIVE)) unmount(view);
  }

  function setMode(id, mode) { const view = views.get(id); if (view) post(view, { t: 'mode', mode }); }

  addEventListener('message', (event) => {
    for (const view of views.values()) {
      if (view.iframe?.contentWindow !== event.source) continue;
      if (event.data?.t === 'ready') { view.ready = true; draw(view); }
      onMessage(view.id, event.data ?? {});
      return;
    }
  });

  return {
    update, cull, setMode, screenHtml, clock, views,
    stream(id, html) { const view = views.get(id); if (view) { view.stream = html; draw(view); } },
    tick() { for (const view of views.values()) { const frame = getBoard().frames[view.id]; if (frame?.status === 'queued' || frame?.status === 'thinking' || frame?.status === 'streaming') paintState(view, frame); } },
  };
}
