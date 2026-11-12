/**
 * The developer tools' panels and the performance overlay (developer build only; docs/DEVTOOLS.md "Panels").
 *
 * One floating panel with a tab per tool (Profiler, Logs, Parameters, Inspector, Jobs), marked "Developer", and an
 * input-transparent overlay over the stage. Ctrl+Shift+D shows the panel, Ctrl+Shift+O the overlay. Nothing samples or
 * redraws while they are closed; open, they refresh at most four times a second and never wait on the engine.
 * These panels are developer-only English text, outside the localized catalogue.
 */
import {analyze, perfettoTrace, spanKey, summarize} from './capture.mjs';
import {commandLog, documentSummary, framePage, historyPage, treePage} from './inspector.mjs';
import {filterLogs} from './control.mjs';
import {frameWindow} from './frames.mjs';

const STYLE = `
#styk-devtools, #styk-devtools-overlay { --dt-bg: var(--surface-raised, #1b1c23); --dt-fg: var(--text-1, #e8e9ee); --dt-dim: var(--text-3, #8b90a0);
  --dt-line: var(--line-2, #3a3f4f); --dt-accent: var(--accent, #0d99ff); --dt-warn: var(--warning-text, #e0a400); --dt-bad: var(--danger-text, #ff5c5c);
  font: 12px/1.4 var(--font-ui, system-ui, sans-serif); color: var(--dt-fg); }
#styk-devtools { position: fixed; z-index: 2147483000; right: 12px; bottom: 12px; width: min(760px, calc(100vw - 24px)); height: min(460px, calc(100vh - 24px));
  display: flex; flex-direction: column; background: var(--dt-bg); border: 1px solid var(--dt-line); border-radius: var(--radius-md, 8px);
  box-shadow: 0 12px 40px rgba(0,0,0,.35); resize: both; overflow: hidden; min-width: 360px; min-height: 200px; }
#styk-devtools[hidden], #styk-devtools-overlay[hidden] { display: none; }
#styk-devtools.dt-docked { position: static; width: 100%; height: 100%; min-width: 0; min-height: 0; border: 0; border-radius: 0; box-shadow: none; resize: none; background: transparent; }
#styk-devtools.dt-docked header { cursor: default; }
#styk-devtools header { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-bottom: 1px solid var(--dt-line); cursor: move; user-select: none; }
#styk-devtools .dt-mark { font-weight: 700; font-size: 10px; letter-spacing: .06em; color: #111; background: var(--dt-warn); border-radius: 4px; padding: 1px 6px; margin-right: 6px; }
#styk-devtools header button { all: unset; cursor: pointer; padding: 3px 8px; border-radius: 5px; color: var(--dt-dim); }
#styk-devtools header button[aria-selected="true"] { color: var(--dt-fg); background: var(--surface-hover, rgba(127,127,127,.18)); }
#styk-devtools header .dt-close { margin-left: auto; }
#styk-devtools .dt-body { flex: 1; overflow: auto; padding: 8px; }
#styk-devtools .dt-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
#styk-devtools button.dt-button { all: unset; cursor: pointer; padding: 2px 9px; border: 1px solid var(--dt-line); border-radius: 5px; }
#styk-devtools button.dt-button:hover { border-color: var(--dt-accent); }
#styk-devtools input, #styk-devtools select { font: inherit; color: inherit; background: var(--surface-sunken, rgba(0,0,0,.2)); border: 1px solid var(--dt-line); border-radius: 4px; padding: 1px 4px; }
#styk-devtools table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
#styk-devtools th, #styk-devtools td { text-align: left; padding: 1px 6px; border-bottom: 1px solid var(--dt-line); white-space: nowrap; }
#styk-devtools td.num, #styk-devtools th.num { text-align: right; }
#styk-devtools .dt-mono, #styk-devtools pre { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
#styk-devtools pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
#styk-devtools .dt-dim { color: var(--dt-dim); }
#styk-devtools .dt-warn { color: var(--dt-warn); } #styk-devtools .dt-error { color: var(--dt-bad); }
#styk-devtools .dt-link { cursor: pointer; color: var(--dt-accent); }
#styk-devtools canvas.dt-timeline { width: 100%; height: 150px; display: block; border: 1px solid var(--dt-line); border-radius: 4px; cursor: crosshair; }
#styk-devtools-overlay { position: fixed; z-index: 2147482999; pointer-events: none; padding: 6px 8px; border-radius: 6px; background: rgba(12,13,18,.78);
  color: #f2f3f7; font: 11px/1.35 var(--font-mono, ui-monospace, monospace); white-space: pre; }
#styk-devtools-overlay canvas { display: block; width: 220px; height: 40px; margin-top: 4px; }
`;

const TABS = ['Profiler', 'Logs', 'Parameters', 'Inspector', 'Jobs'];
/** The dock panel's id. Only the developer build defines it; a layout naming it opens in the shipping build without it. */
export const DEVELOPER_PANEL = 'developer';
const element = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
};
const button = (label, onclick, title = '') => element('button', {className: 'dt-button', textContent: label, onclick, title, type: 'button'});
const format = (value, digits = 2) => (value === null || value === undefined || Number.isNaN(value) ? '–' : typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toFixed(digits)) : String(value));
const megabytes = bytes => (Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1048576).toFixed(1)} MB` : '–');
const table = (head, rows, numeric = []) => element('table', {},
  element('thead', {}, element('tr', {}, ...head.map((name, i) => element('th', {textContent: name, className: numeric.includes(i) ? 'num' : ''})))),
  element('tbody', {}, ...rows.map(row => element('tr', {}, ...row.map((cell, i) => cell instanceof Node ? element('td', {}, cell) : element('td', {textContent: format(cell), className: numeric.includes(i) ? 'num' : ''}))))));

export function createPanels(runtime) {
  const {early, sampler, capture} = runtime;
  document.head.append(element('style', {id: 'styk-devtools-style', textContent: STYLE}));
  const tabs = new Map();
  const body = element('div', {className: 'dt-body'});
  const header = element('header', {}, element('span', {className: 'dt-mark', textContent: 'DEVELOPER'}));
  for (const name of TABS) {
    const tab = button(name, () => show(name));
    tab.className = ''; tab.setAttribute('role', 'tab');
    tabs.set(name, tab); header.append(tab);
  }
  header.append(Object.assign(button('×', () => toggle(false), 'Close (Ctrl+Shift+D)'), {className: 'dt-close'}));
  // Docked when the app has its dock host (src/shell/dock-host.mjs): a panel like any other, defined at run time so the
  // shipping build's catalogue and default layouts never name it. Without a dock host (a bare page), a floating window.
  const shell = typeof runtime.app.shell?.define === 'function' && runtime.app.workspace?.show ? runtime.app.shell : null;
  const root = element('section', {id: 'styk-devtools', hidden: true, role: shell ? 'region' : 'dialog', ariaLabel: 'Developer tools'}, header, body);
  if (shell) root.classList.add('dt-docked');
  const overlayText = element('div'), spark = element('canvas', {width: 440, height: 80});
  const overlayRoot = element('div', {id: 'styk-devtools-overlay', hidden: true, ariaHidden: 'true'}, overlayText, spark);
  document.body.append(root, overlayRoot);
  if (!shell) dragBy(header, root);

  let current = 'Profiler', timer = 0, overlayTimer = 0;
  const state = {lastCapture: null, selected: null, logFilter: {level: 'debug', module: '', text: ''}, treePath: [], treeCursor: 0, view: {from: 0, to: 1}};
  let active = false;
  if (shell) {
    shell.define({id: DEVELOPER_PANEL, title: 'Developer', icon: 'bug', docks: ['right', 'left', 'bottom'], floatable: true, min: 320, pref: 440, max: 960,
      // Nowhere until opened: a layout without it (every layout of the shipping build) keeps its shape.
      defaultDock: 'hidden', root: () => root, onVisibility: visible => setActive(visible)});
  }

  /** Shows or hides the panel: the dock host places it (and calls setActive), or the floating window shows itself. */
  function toggle(visible = !active, tab) {
    if (tab) current = tab;
    if (shell) {
      if (visible) runtime.app.workspace.show(DEVELOPER_PANEL); else runtime.app.workspace.hide(DEVELOPER_PANEL);
      return visible;
    }
    root.hidden = !visible;
    setActive(visible);
    return visible;
  }
  /** Refreshes only while the panel is on screen: closed, collapsed or parked, it samples nothing. */
  function setActive(visible) {
    active = Boolean(visible);
    clearInterval(timer); timer = 0;
    if (active) { show(current); timer = setInterval(() => refresh(false), 500); }
  }
  function show(name) {
    if (!TABS.includes(name)) name = 'Profiler';
    current = name;
    for (const [tabName, tab] of tabs) tab.setAttribute('aria-selected', String(tabName === name));
    refresh(true);
  }
  /** Redraws the open tab; `full` rebuilds it, otherwise only the live parts change. */
  function refresh(full) {
    if (!active) return;
    try { ({Profiler: profiler, Logs: logs, Parameters: parameters, Inspector: inspector, Jobs: jobs})[current](full); }
    catch (error) { body.replaceChildren(element('pre', {className: 'dt-error', textContent: String(error?.stack ?? error)})); }
  }

  // --- Profiler ----------------------------------------------------------------------------------------------------
  let profilerParts = null;
  function profiler(full) {
    if (full || !profilerParts) {
      const status = element('span', {className: 'dt-dim'});
      const startStop = button('Record', () => {
        if (capture.running) { state.lastCapture = runtime.stopCapture(); state.selected = null; state.view = {from: 0, to: 1}; profiler(true); }
        else { runtime.startCapture('panel'); profiler(true); }
      }, 'Record spans until you stop');
      const recent = button('Last 5 s', () => { state.lastCapture = runtime.recent(5000); state.selected = null; state.view = {from: 0, to: 1}; profiler(true); },
      'What the ring holds of the last five seconds (a hitch, after it happened)');
      const exportButton = button('Export Perfetto', () => {
        if (!state.lastCapture) return;
        const taken = state.lastCapture;
        download(`StykAnimate-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(perfettoTrace(taken.events, {origin: taken.startedAt, metadata: {label: taken.label}})));
      }, 'Chrome trace JSON: open it at ui.perfetto.dev');
      const canvas = element('canvas', {className: 'dt-timeline'});
      const detail = element('div');
      const stats = element('div');
      profilerParts = {status, startStop, canvas, detail, stats};
      body.replaceChildren(element('div', {className: 'dt-row'}, startStop, recent, exportButton, status), canvas, detail, stats);
      startStop.textContent = capture.running ? 'Stop' : 'Record';
      exportButton.disabled = !state.lastCapture;
      wireTimeline(canvas);
      if (state.lastCapture) {
        const summary = analyze(state.lastCapture, {periodMs: sampler.displayPeriod().periodMs});
        stats.replaceChildren(
          element('div', {className: 'dt-row dt-dim', textContent: `${state.lastCapture.events.length} events over ${format((state.lastCapture.stoppedAt - state.lastCapture.startedAt) / 1000, 1)} s`
            + `${state.lastCapture.dropped ? `, ${state.lastCapture.dropped} dropped (ring full)` : ''}. Display frames: p50 ${format(summary.frames?.p50)} ms, p95 ${format(summary.frames?.p95)} ms, `
            + `worst ${format(summary.frames?.worst)} ms, ${format(summary.frames?.late)} late.`}),
          table(['Span', 'Count', 'Total ms', 'p50', 'p95', 'Worst'], summary.spans.slice(0, 40).map(row => [row.name, row.count, row.totalMs, row.p50, row.p95, row.worst]), [1, 2, 3, 4, 5]));
      }
    }
    profilerParts.status.textContent = capture.running ? `Recording… ${format((performance.now() - capture.running.startedAt) / 1000, 1)} s, ${early.ring.total - capture.running.from} events` : '';
    drawTimeline();
  }
  function wireTimeline(canvas) {
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect(), at = (event.clientX - rect.left) / rect.width, {from, to} = state.view, span = to - from;
      const scale = event.deltaY > 0 ? 1.25 : 0.8, next = Math.min(1, Math.max(1e-4, span * scale)), pivot = from + at * span;
      state.view = {from: Math.max(0, Math.min(1 - next, pivot - at * next)), to: 0}; state.view.to = state.view.from + next;
      drawTimeline();
    }, {passive: false});
    canvas.addEventListener('click', event => {
      const hit = canvas.hit?.(event.offsetX, event.offsetY);
      state.selected = hit ?? null;
      showSelected();
      drawTimeline();
    });
  }
  function showSelected() {
    const event = state.selected;
    if (!event || !state.lastCapture) { profilerParts.detail.replaceChildren(); return; }
    const key = spanKey(event), same = state.lastCapture.events.filter(other => other.duration >= 0 && spanKey(other) === key);
    const children = state.lastCapture.events.filter(other => other.thread === event.thread && other.depth === event.depth + 1 && other.start >= event.start && other.start + other.duration <= event.start + event.duration + 1e-6);
    profilerParts.detail.replaceChildren(element('pre', {textContent:
      `${key} on ${event.thread}: ${format(event.duration, 3)} ms at ${format(event.start - state.lastCapture.startedAt, 1)} ms${event.args ? `\nargs ${JSON.stringify(event.args)}` : ''}\n`
      + `${same.length} like it: p50 ${format(summarize(same).spans[0]?.p50)} ms, worst ${format(summarize(same).spans[0]?.worst)} ms`
      + (children.length ? `\nchildren: ${children.map(child => `${spanKey(child)} ${format(child.duration, 3)} ms`).join(', ')}` : '')}));
  }
  /** Lanes per thread, spans as bars by depth, counters as lines; wheel zooms, click selects. */
  function drawTimeline() {
    const canvas = profilerParts?.canvas;
    if (!canvas || !canvas.isConnected) return;
    const ratio = devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const taken = state.lastCapture ?? (capture.running ? runtime.recent(performance.now() - capture.running.startedAt) : null);
    const style = getComputedStyle(root);
    context.font = '10px ui-monospace, monospace';
    if (!taken) { context.fillStyle = style.getPropertyValue('--dt-dim'); context.fillText('Record, or take the last 5 s, to see spans here.', 8, 16); canvas.hit = null; return; }
    const total = Math.max(1, taken.stoppedAt - taken.startedAt), t0 = taken.startedAt + state.view.from * total, t1 = taken.startedAt + state.view.to * total;
    const x = t => ((t - t0) / (t1 - t0)) * width;
    const lanes = [...new Set(taken.events.filter(e => e.duration >= 0).map(e => e.thread))];
    const laneHeight = Math.max(18, (height - 4) / Math.max(1, lanes.length)), rows = [];
    lanes.forEach((lane, index) => {
      const top = 2 + index * laneHeight;
      context.fillStyle = style.getPropertyValue('--dt-dim'); context.fillText(lane, 2, top + 9);
      for (const event of taken.events) {
        if (event.thread !== lane || event.duration < 0) continue;
        const left = x(event.start), right = x(event.start + event.duration);
        if (right < 0 || left > width) continue;
        const y = top + 11 + event.depth * 7, w = Math.max(1, right - left);
        context.fillStyle = event === state.selected ? '#ffffff' : event.name === 'display frame' ? (event.duration > 25 ? '#e5484d' : '#3e9b4f') : event.name === 'long task' ? '#e0a400' : hue(event.name);
        context.fillRect(left, y, w, 6);
        if (w > 3) rows.push([left, y, w, event]);
      }
    });
    canvas.hit = (px, py) => { for (let i = rows.length - 1; i >= 0; i--) { const [left, y, w, event] = rows[i]; if (px >= left - 1 && px <= left + w + 1 && py >= y - 1 && py <= y + 7) return event; } return null; };
    context.fillStyle = style.getPropertyValue('--dt-dim');
    context.fillText(`${format(t0 - taken.startedAt, 1)} ms`, 2, height - 3);
    const end = `${format(t1 - taken.startedAt, 1)} ms`;
    context.fillText(end, width - context.measureText(end).width - 2, height - 3);
  }

  // --- Logs --------------------------------------------------------------------------------------------------------
  let logParts = null, logSeen = -1;
  function logs(full) {
    if (full || !logParts) {
      const level = element('select', {}, ...early.LEVELS.map(name => element('option', {value: name, textContent: name, selected: state.logFilter.level === name})));
      const module = element('input', {placeholder: 'module', value: state.logFilter.module, size: 12});
      const text = element('input', {placeholder: 'search', value: state.logFilter.text, size: 20});
      const list = element('div', {className: 'dt-mono'});
      const update = () => { state.logFilter = {level: level.value, module: module.value, text: text.value}; logSeen = -1; logs(false); };
      level.onchange = update; module.oninput = update; text.oninput = update;
      const copy = button('Copy JSON lines', () => navigator.clipboard?.writeText(currentLogs().map(row => JSON.stringify(row)).join('\n')));
      logParts = {list};
      body.replaceChildren(element('div', {className: 'dt-row'}, level, module, text, copy, element('span', {className: 'dt-dim', textContent: `${early.logs.dropped ? `${early.logs.dropped} trimmed · ` : ''}newest last`})), list);
      logSeen = -1;
    }
    if (logSeen === early.logs.sequence) return;
    logSeen = early.logs.sequence;
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    logParts.list.replaceChildren(...currentLogs().slice(-500).map(row => element('div', {className: row.level === 'error' ? 'dt-error' : row.level === 'warn' ? 'dt-warn' : ''},
      `${format(row.at / 1000, 3)} ${row.level.padEnd(5)} [${row.module}] ${row.message}`)));
    if (atBottom) body.scrollTop = body.scrollHeight;
  }
  const currentLogs = () => filterLogs(early.logs.rows, {least: early.LEVELS.indexOf(state.logFilter.level), levels: early.LEVELS, module: state.logFilter.module, text: state.logFilter.text});

  // --- Parameters --------------------------------------------------------------------------------------------------
  function parameters(full) {
    if (!full) return;
    const rows = [...early.parameters.registry.values()].map(entry => {
      let input;
      if (typeof entry.default === 'boolean') input = element('input', {type: 'checkbox', checked: entry.value});
      else if (entry.options) input = element('select', {}, ...entry.options.map(option => element('option', {value: option, textContent: option, selected: option === entry.value})));
      else input = element('input', {type: typeof entry.default === 'number' ? 'number' : 'text', value: entry.value, min: entry.min ?? '', max: entry.max ?? '', step: entry.step ?? 'any', size: 8});
      input.onchange = () => { runtime.setParameter(entry.name, input.type === 'checkbox' ? input.checked : input.value); parameters(true); };
      return [element('span', {textContent: entry.name, title: entry.description}), input, entry.default, entry.min, entry.max,
        button('Reset', () => { runtime.setParameter(entry.name, entry.default); parameters(true); })];
    });
    const profile = element('input', {placeholder: 'profile name', size: 14});
    const saved = runtime.profiles();
    body.replaceChildren(
      element('div', {className: 'dt-row'}, profile, button('Save set', () => { if (profile.value) runtime.saveProfile(profile.value); parameters(true); }),
        ...saved.map(name => button(`Load ${name}`, () => { runtime.loadProfile(name); parameters(true); })),
        button('Reset all', () => { for (const entry of early.parameters.registry.values()) runtime.setParameter(entry.name, entry.default); parameters(true); })),
      rows.length ? table(['Parameter', 'Value', 'Default', 'Min', 'Max', ''], rows, [2, 3, 4]) : element('div', {className: 'dt-dim', textContent: 'No live parameter has registered yet: each registers when its code first runs.'}),
      element('div', {className: 'dt-dim', textContent: 'The current values persist for this developer profile; the shipping build always uses the defaults.'}));
  }

  // --- Inspector ---------------------------------------------------------------------------------------------------
  function inspector(full) {
    if (!full) return;
    const editor = runtime.app.editor;
    if (!editor) { body.replaceChildren(element('div', {className: 'dt-dim', textContent: 'The editor is not ready.'})); return; }
    const summary = documentSummary(editor);
    const crumbs = element('div', {className: 'dt-row dt-mono'}, element('span', {className: 'dt-link', textContent: 'document', onclick: () => { state.treePath = []; state.treeCursor = 0; inspector(true); }}));
    state.treePath.forEach((key, index) => crumbs.append(' / ', element('span', {className: 'dt-link', textContent: String(key), onclick: () => { state.treePath = state.treePath.slice(0, index + 1); state.treeCursor = 0; inspector(true); }})));
    let page;
    try { page = treePage(editor.report, {path: state.treePath, cursor: state.treeCursor}); }
    catch (error) { state.treePath = []; page = treePage(editor.report, {}); }
    const tree = page.rows.length ? table(['Key', 'Value'], page.rows.map(row => [row.container ? element('span', {className: 'dt-link', textContent: String(row.key), onclick: () => { state.treePath = [...state.treePath, row.key]; state.treeCursor = 0; inspector(true); }}) : String(row.key), row.preview]))
      : element('pre', {textContent: page.value ?? '(empty)'});
    const pager = element('div', {className: 'dt-row dt-dim'}, `${page.kind}, ${page.size} entries`,
      page.cursor > 0 ? button('Previous', () => { state.treeCursor = Math.max(0, page.cursor - 50); inspector(true); }) : null,
      page.next !== null ? button('Next', () => { state.treeCursor = page.next; inspector(true); }) : null);
    const history = historyPage(editor), frame = framePage(editor), calls = commandLog(early.ring, {limit: 30});
    const saveLog = button('Save command log', () => download('StykAnimate-commands.json', JSON.stringify(commandLog(early.ring, {limit: 100000}), null, 1)));
    body.replaceChildren(
      element('pre', {textContent: `${summary.name ?? '(untitled)'} · revision ${summary.revision}${summary.dirty ? ' (unsaved)' : ''} · tick ${summary.tick}/${summary.totalTicks} · ${summary.figureTypes} figure types · ${summary.keyframes} keyframes · ${summary.layers ?? '?'} layers · selection ${JSON.stringify(summary.selection)}`}),
      element('div', {className: 'dt-row'}, button('Refresh', () => inspector(true))),
      crumbs, pager, tree,
      element('h4', {textContent: `Evaluated frame, tick ${frame.tick} (${frame.size} figures)`}),
      table(['uid', 'type', 'joints', 'visible', 'layer'], frame.rows.slice(0, 20).map(row => [row.uid, row.type, row.joints, String(row.visible), row.layer])),
      element('h4', {textContent: `History (${history.size})`}),
      table(['Stack', 'Label'], history.rows.slice(0, 30).map(row => [row.stack, row.label])),
      element('div', {className: 'dt-row'}, element('h4', {textContent: 'Edit session calls, newest first'}), saveLog),
      table(['Method', 'ms'], calls.map(row => [row.method, row.ms]), [1]));
  }

  // --- Jobs --------------------------------------------------------------------------------------------------------
  function jobs() {
    const jobsNow = sampler.jobs(), memory = sampler.memory(), engine = jobsNow.engine ?? {};
    body.replaceChildren(
      element('h4', {textContent: 'Engine'}),
      table(['Threads', 'Lost', 'Prepared', 'Prepare total ms', 'Worst ms', 'Inline', 'Cached frames', 'Cached', 'Pictures pending', 'Busy'],
        [[`${engine.workers ?? '–'}${engine.threaded ? '' : ' (no workers)'}`, engine.workersLost, engine.prepared, engine.preparedTotalMs, engine.preparedWorstMs, engine.inline, engine.cachedFrames, megabytes(engine.cachedBytes), engine.imagesPending, String(engine.busy)]]),
      element('h4', {textContent: 'Interface'}),
      table(['Playing', 'Buffering', 'Importing', 'Stage frames', 'Geometry ms', 'Submit ms', 'Long tasks', 'Slow inputs', 'Worst input ms'],
        [[String(jobsNow.playing), String(jobsNow.buffering), String(jobsNow.importing), jobsNow.stage?.frames, jobsNow.stage?.lastSendMs, jobsNow.stage?.lastDrawMs, jobsNow.browser.longTasks, jobsNow.browser.slowInputs, jobsNow.browser.worstInputMs]]),
      element('h4', {textContent: 'Memory'}),
      table(['JS heap', 'Engine memory', 'Engine live', 'Engine peak', 'Frame cache', 'GPU (stage)'],
        [[megabytes(memory.jsHeap?.usedBytes), megabytes(memory.engineMemoryBytes), megabytes(memory.engine?.liveBytes), megabytes(memory.engine?.peakBytes), megabytes(memory.engine?.frameCacheBytes), megabytes(memory.gpuBytes)]]),
      element('h4', {textContent: `Threads (${jobsNow.threads.live} live of ${jobsNow.threads.started} started)`}),
      table(['#', 'Name', 'Script', 'Age s', 'Sent', 'Received', 'Errors'], sampler.threads().map(row => [row.id, row.name, row.url, row.ageMs / 1000, row.sent, row.received, row.errors]), [0, 3, 4, 5, 6]));
  }

  // --- Overlay -----------------------------------------------------------------------------------------------------
  function overlay(visible = overlayRoot.hidden) {
    if (visible === !overlayRoot.hidden) return visible;
    overlayRoot.hidden = !visible;
    clearInterval(overlayTimer); overlayTimer = 0;
    runtime.watch(visible);
    if (visible) { paintOverlay(); overlayTimer = setInterval(paintOverlay, 250); }
    return visible;
  }
  function paintOverlay() {
    const stage = document.getElementById('viewport')?.getBoundingClientRect();
    if (stage) { overlayRoot.style.left = `${stage.left + 8}px`; overlayRoot.style.top = `${stage.top + 8}px`; }
    const snapshot = sampler.snapshot(), f = snapshot.frames, jobsNow = snapshot.jobs, memory = snapshot.memory;
    overlayText.textContent = [
      `frame p50 ${format(f.p50, 1)} ms  p95 ${format(f.p95, 1)}  worst ${format(f.worst, 1)}  work p95 ${format(f.work.p95, 1)}`,
      `late ${format(f.late)}/${f.count} (>${format(f.lateOverMs, 0)} ms)  paint p95 ${format(snapshot.paint.p95, 1)} ms${snapshot.presentation?.fps ? `  play ${format(snapshot.presentation.fps, 1)}/${format(snapshot.presentation.targetFps, 0)} fps` : ''}`,
      `queues  pictures ${format(jobsNow.engine?.imagesPending)}  cached ${format(jobsNow.engine?.cachedFrames)}  threads ${jobsNow.threads.live}${jobsNow.engine?.busy ? '  busy' : ''}`,
      `memory  js ${megabytes(memory.jsHeap?.usedBytes)}  engine ${megabytes(memory.engine?.liveBytes)}  gpu ${megabytes(memory.gpuBytes)}`,
    ].join('\n');
    const values = frameWindow(early.frames, Math.max(0, early.frames.total - 110)).interval, context = spark.getContext('2d'), w = spark.width, h = spark.height, late = f.lateOverMs ?? 25;
    context.clearRect(0, 0, w, h);
    const top = Math.max(50, ...values);
    values.forEach((ms, i) => { context.fillStyle = ms > late ? '#e5484d' : '#3e9b4f'; const bar = (ms / top) * h; context.fillRect(i * 4, h - bar, 3, bar); });
    context.fillStyle = 'rgba(255,255,255,.4)'; context.fillRect(0, h - (16.7 / top) * h, w, 1);
  }

  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
    if (event.code === 'KeyD') { event.preventDefault(); event.stopPropagation(); toggle(); }
    else if (event.code === 'KeyO') { event.preventDefault(); event.stopPropagation(); overlay(); }
  }, true);

  return {toggle, overlay, refresh, element: root};
}

/** A stable colour per span name. */
function hue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 55%)`;
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  const link = element('a', {href: url, download: name});
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Lets the header move the panel. */
function dragBy(handle, panel) {
  handle.addEventListener('pointerdown', event => {
    if (event.target !== handle && !event.target.classList?.contains('dt-mark')) return;
    const rect = panel.getBoundingClientRect(), dx = event.clientX - rect.left, dy = event.clientY - rect.top;
    const move = moved => { panel.style.left = `${Math.max(0, moved.clientX - dx)}px`; panel.style.top = `${Math.max(0, moved.clientY - dy)}px`; panel.style.right = 'auto'; panel.style.bottom = 'auto'; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
}
