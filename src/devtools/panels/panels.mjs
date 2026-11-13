/**
 * The developer tools' panel and the performance overlay (developer build only; docs/DEVTOOLS.md "Panels").
 *
 * One panel marked DEVELOPER, Ctrl+Shift+D, with a tab per tool: Performance (opens first), Profiler, Logs,
 * Parameters, Inspector, Jobs. The overlay over the stage is Ctrl+Shift+O. This module is the panel itself: the dock
 * panel or floating window, the tab bar, and when a tab refreshes. The rest of the folder:
 *   style.mjs       the stylesheet over the app's tokens, and the colours the canvases read from it;
 *   dom.mjs         elements, live tables and ranked lists that update in place, canvases that follow their size;
 *   chart.mjs       the frame chart (the Performance tab's, and the overlay's in miniature);
 *   rank.mjs        the order that keeps a live list from reshuffling on noise;
 *   recording.mjs   the stretch held by Record or Last 5 s, shared by the Performance and Profiler tabs;
 *   performance.mjs, profiler.mjs, logs.mjs, parameters.mjs, inspector.mjs, jobs.mjs   one tab each;
 *   overlay.mjs     the overlay.
 * A tab is {name, root, shown?(), refresh?(), interval?}: `root` is built once and kept while other tabs show;
 * `shown` runs when it comes on screen, `refresh` every `interval` ms while it is on screen.
 *
 * The panel and the overlay are watchers (src/devtools/devtools.mjs `watch`): while either is on screen the frame
 * recorder, the boundary meter and the sampler run. Closed, collapsed or parked, nothing samples, ticks or redraws.
 * Each refresh is a span, `devtools panel` (the overlay's `devtools overlay`), so the tools' own cost is measured.
 * These panels are developer-only English text, outside the localized catalogue.
 */
import {button, dragBy, element} from './dom.mjs';
import {createInspectorTab} from './inspector.mjs';
import {createJobsTab} from './jobs.mjs';
import {createLogsTab} from './logs.mjs';
import {createOverlay} from './overlay.mjs';
import {createParametersTab} from './parameters.mjs';
import {createPerformanceTab} from './performance.mjs';
import {createProfilerTab} from './profiler.mjs';
import {createRecording} from './recording.mjs';
import {STYLE} from './style.mjs';

/** The dock panel's id. Only the developer build defines it; a layout naming it opens in the shipping build without it. */
export const DEVELOPER_PANEL = 'developer';

export function createPanels(runtime) {
  const trace = globalThis.__stykTrace;
  document.head.append(element('style', {id: 'styk-devtools-style', textContent: STYLE}));
  const body = element('div', {className: 'dt-body'});
  const header = element('header', {role: 'tablist'}, element('span', {className: 'dt-mark', textContent: 'DEVELOPER'}));
  // Docked when the app has its dock host (src/shell/dock-host.mjs): a panel like any other, defined at run time so the
  // shipping build's catalogue and default layouts never name it. Without a dock host (a bare page), a floating window.
  const shell = typeof runtime.app.shell?.define === 'function' && runtime.app.workspace?.show ? runtime.app.shell : null;
  const root = element('section', {id: 'styk-devtools', hidden: true, role: shell ? 'region' : 'dialog', ariaLabel: 'Developer tools'}, header, body);
  if (shell) root.classList.add('dt-docked');

  const recording = createRecording(runtime);
  const context = {runtime, recording, panel: root};
  const tabs = [createPerformanceTab, createProfilerTab, createLogsTab, createParametersTab, createInspectorTab, createJobsTab].map(create => create(context));
  for (const tab of tabs) {
    tab.button = Object.assign(button(tab.name, () => show(tab.name)), {className: ''});
    tab.button.setAttribute('role', 'tab');
    header.append(tab.button);
  }
  header.append(Object.assign(button('×', () => toggle(false), 'Close (Ctrl+Shift+D)'), {className: 'dt-close', ariaLabel: 'Close the developer tools'}));
  const overlay = createOverlay(runtime);
  document.body.append(root);
  if (!shell) dragBy(header, root);

  let current = tabs[0], active = false, timer = 0;
  if (shell) {
    shell.define({id: DEVELOPER_PANEL, title: 'Developer', icon: 'bug', docks: ['right', 'left', 'bottom'], floatable: true, min: 320, pref: 440, max: 960,
      // Nowhere until opened: a layout without it (every layout of the shipping build) keeps its shape.
      defaultDock: 'hidden', root: () => root, onVisibility: visible => setActive(visible)});
  }

  /** Shows or hides the panel, on `tab` if named: the dock host places it (and calls setActive), or the floating window shows itself. */
  function toggle(visible = !active, tab) {
    if (tab) current = tabs.find(item => item.name === tab) ?? current;
    if (shell) {
      // Already on screen, the dock host calls nothing back: the named tab is shown here.
      const already = active;
      if (visible) runtime.app.workspace.show(DEVELOPER_PANEL); else runtime.app.workspace.hide(DEVELOPER_PANEL);
      if (visible && already && tab) show(tab);
      return visible;
    }
    root.hidden = !visible;
    setActive(visible);
    return visible;
  }
  /** The panel came on screen or left it: it watches (the recorders run) and refreshes only while on screen. */
  function setActive(visible) {
    visible = Boolean(visible);
    if (visible !== active) { active = visible; runtime.watch(visible); }
    if (active) show(current.name);
    else { clearInterval(timer); timer = 0; }
  }
  function show(name) {
    const tab = tabs.find(item => item.name === name) ?? tabs[0];
    current = tab;
    for (const item of tabs) item.button.setAttribute('aria-selected', String(item === tab));
    if (body.firstChild !== tab.root || body.childNodes.length !== 1) body.replaceChildren(tab.root);
    clearInterval(timer); timer = 0;
    if (!active) return;
    run(() => { tab.shown?.(); tab.refresh?.(); });
    if (tab.refresh) timer = setInterval(() => run(tab.refresh), tab.interval ?? 500);
  }
  /** Runs a tab's work as a span of the tools' own; a tab that throws shows why instead of refreshing again. */
  function run(work) {
    const span = trace?.begin('devtools panel') ?? 0;
    try { work(); }
    catch (error) { clearInterval(timer); timer = 0; body.replaceChildren(element('pre', {className: 'dt-failure dt-error', textContent: String(error?.stack ?? error)})); }
    finally { if (span) trace.end(span); }
  }

  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
    if (event.code === 'KeyD') { event.preventDefault(); event.stopPropagation(); toggle(); }
    else if (event.code === 'KeyO') { event.preventDefault(); event.stopPropagation(); overlay.show(); }
  }, true);

  return {toggle, overlay: overlay.show, element: root, recording, get active() { return active; }};
}
