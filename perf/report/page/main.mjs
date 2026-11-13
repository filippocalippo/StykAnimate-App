// The page's start: reads the report's data, draws the controls, and shows the overview or one scenario.
//
// The address says what is shown, so a link can point at one scenario on one pair:
//   #env=gpu&workload=stress&scenario=pose.drag-joint
// `env` and `workload` narrow the overview to those pairs and choose the pair a scenario opens on; `scenario` opens it.
// The search and "needs work" filters narrow the overview's scenarios and are not part of the address.
import {h, hideTip, release} from './dom.mjs';
import {renderOverview, runLine} from './overview.mjs';
import {renderScenario} from './scenario.mjs';

const model = JSON.parse(document.getElementById('report-data').textContent);
const state = {env: '', workload: '', scenario: '', query: '', needsWork: false};
const overviewRoot = document.getElementById('overview'), sectionsRoot = document.getElementById('overview-sections'), scenarioRoot = document.getElementById('scenario');
// Where the overview was when a scenario opened from it: closing the scenario returns there, filters and scroll.
let overviewScroll = 0, overviewFilters = {env: '', workload: ''};

const unique = list => [...new Map(list.map(item => [item.id, item])).values()];
const environments = unique(model.columns.map(column => column.environment)), workloads = unique(model.columns.map(column => column.workload));

function readAddress() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.env = params.get('env') ?? ''; state.workload = params.get('workload') ?? ''; state.scenario = params.get('scenario') ?? '';
}
/** The address for the current state; `push` adds a history entry (opening a scenario), else it replaces the current one. */
function writeAddress(push) {
  const params = new URLSearchParams();
  for (const key of ['env', 'workload', 'scenario']) if (state[key]) params.set(key, state[key]);
  const hash = params.toString() ? `#${params}` : '';
  if (hash === location.hash || (!hash && !location.hash)) return;
  if (push) location.hash = hash || '#';
  else { history.replaceState(null, '', hash || `${location.pathname}${location.search}`); show(); }
}

/** The pairs and scenarios the overview shows under the filters. */
function currentView() {
  const columns = model.columns.filter(column => (!state.env || column.environment.id === state.env) && (!state.workload || column.workload.id === state.workload));
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const notGood = new Set(['failed', 'bad', 'poor', 'fair']);
  const rows = model.rows.filter(row => {
    const text = `${row.id} ${row.title} ${row.area} ${row.description ?? ''}`.toLowerCase();
    if (!words.every(word => text.includes(word))) return false;
    if (!state.needsWork) return true;
    return columns.some(column => notGood.has(model.pairs[column.pair].scenarios.find(scenario => scenario.id === row.id)?.status));
  });
  return {columns, rows, open, close, neighbours, narrow};
}

/** Narrows the overview to one pair, or back to every pair when it already shows only that one. */
function narrow(column) {
  const only = state.env === column.environment.id && state.workload === column.workload.id;
  state.env = only ? '' : column.environment.id; state.workload = only ? '' : column.workload.id;
  writeAddress(false);
}

function open(id, column) {
  if (!state.scenario) { overviewScroll = scrollY; overviewFilters = {env: state.env, workload: state.workload}; }
  state.scenario = id;
  if (Number.isInteger(column)) { state.env = model.columns[column].environment.id; state.workload = model.columns[column].workload.id; }
  writeAddress(true);
}
function close() {
  Object.assign(state, overviewFilters, {scenario: ''});
  writeAddress(true);
}
/**
 * The scenarios before and after `id` in the overview's order (its filtered list, or all when the filter hides `id`),
 * among those the pair on show ran: stepping through scenarios stays on one pair.
 */
function neighbours(id) {
  const column = model.columns[wantedColumn()], filtered = currentView().rows;
  const ran = row => row.id === id || !column || model.pairs[column.pair].scenarios.some(scenario => scenario.id === row.id);
  const rows = (filtered.some(row => row.id === id) ? filtered : model.rows).filter(ran);
  const index = rows.findIndex(row => row.id === id);
  return [rows[index - 1] ?? null, rows[index + 1] ?? null];
}

/** The pair a scenario opens on: the one the address names, else the first that matches the environment or workload asked for. */
function wantedColumn() {
  const exact = model.columns.findIndex(column => column.environment.id === state.env && column.workload.id === state.workload);
  if (exact >= 0) return exact;
  return model.columns.findIndex(column => (!state.env || column.environment.id === state.env) && (!state.workload || column.workload.id === state.workload));
}

/** Draws what the state says: the overview, or one scenario. */
function show() {
  hideTip();
  syncControls();
  if (state.scenario) {
    const wasHidden = scenarioRoot.hidden;
    overviewRoot.hidden = true; scenarioRoot.hidden = false;
    release(scenarioRoot);
    const shown = renderScenario(scenarioRoot, model, {id: state.scenario, wanted: wantedColumn()}, currentView());
    document.title = `${state.scenario} · ${pageTitle}`;
    if (wasHidden) scrollTo(0, 0);
    if (shown !== null && (model.columns[shown].environment.id !== state.env || model.columns[shown].workload.id !== state.workload)) {
      // The address named a pair that did not run this scenario: it now says the pair shown.
      state.env = model.columns[shown].environment.id; state.workload = model.columns[shown].workload.id;
      history.replaceState(null, '', `#${new URLSearchParams({env: state.env, workload: state.workload, scenario: state.scenario})}`);
      syncControls();
    }
    return;
  }
  const wasHidden = overviewRoot.hidden;
  release(scenarioRoot); scenarioRoot.replaceChildren(); scenarioRoot.hidden = true; overviewRoot.hidden = false;
  release(sectionsRoot);
  renderOverview(sectionsRoot, model, currentView());
  document.title = pageTitle;
  if (wasHidden) scrollTo(0, overviewScroll);
}

const controls = {};
function syncControls() {
  controls.env.value = state.env; controls.workload.value = state.workload;
  controls.env.closest('label').classList.toggle('active', Boolean(state.env));
  controls.workload.closest('label').classList.toggle('active', Boolean(state.workload));
}

/** Light, dark or the system's: remembered in this browser when it can be. */
function themeControl() {
  const choices = ['system', 'light', 'dark'];
  let theme = 'system';
  try { theme = localStorage.getItem('styk-perf-report-theme') ?? 'system'; } catch { /* storage refused: the system's theme */ }
  const button = h('button', {type: 'button', class: 'theme', id: 'theme'});
  const apply = () => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme);
    button.textContent = `Theme: ${theme}`;
  };
  button.addEventListener('click', () => {
    theme = choices[(choices.indexOf(theme) + 1) % choices.length];
    try { localStorage.setItem('styk-perf-report-theme', theme); } catch { /* not remembered */ }
    apply();
  });
  apply();
  return button;
}

function drawControls() {
  const select = (id, label, all, items) => {
    const element = h('select', {id}, h('option', {value: ''}, all), items.map(item => h('option', {value: item.id}, item.title && item.title !== item.id ? `${item.title} (${item.id})` : item.id)));
    return [element, h('label', {class: 'field', for: id}, h('span', {}, label), element)];
  };
  const [env, envField] = select('filter-env', 'Environment', 'All environments', environments);
  const [workload, workloadField] = select('filter-workload', 'Workload', 'All workloads', workloads);
  const query = h('input', {id: 'filter-query', type: 'search', placeholder: 'Scenario, area or word  ( / )', autocomplete: 'off', spellcheck: 'false'});
  const needsWork = h('input', {id: 'filter-needs-work', type: 'checkbox'});
  Object.assign(controls, {env, workload, query, needsWork});
  env.addEventListener('change', () => { state.env = env.value; writeAddress(false); });
  workload.addEventListener('change', () => { state.workload = workload.value; writeAddress(false); });
  // The overview redraws once typing pauses: a page of fifty scenarios on ten pairs takes about 0.1 s to redraw.
  let pause = 0;
  query.addEventListener('input', () => {
    clearTimeout(pause);
    pause = setTimeout(() => { state.query = query.value; if (state.scenario) close(); else show(); }, 120);
  });
  needsWork.addEventListener('change', () => { state.needsWork = needsWork.checked; if (!state.scenario) show(); });
  document.getElementById('controls').replaceChildren(
    h('label', {class: 'field search', for: 'filter-query'}, h('span', {}, 'Find'), query), envField, workloadField,
    h('label', {class: 'check', for: 'filter-needs-work'}, needsWork, h('span', {}, 'Only what needs work')), themeControl());
  document.getElementById('runs').replaceChildren(...runLine(model));
}

/** Keys: / finds, Escape goes back to the overview, j and k step through the scenarios. */
function keys(event) {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
  if (event.key === '/' && !typing) { event.preventDefault(); controls.query.focus(); return; }
  if (event.key === 'Escape' && state.scenario && !typing) { close(); return; }
  if (typing || event.ctrlKey || event.metaKey || event.altKey || !state.scenario) return;
  const [previous, next] = neighbours(state.scenario);
  if (event.key === 'j' && next) open(next.id, wantedColumn());
  if (event.key === 'k' && previous) open(previous.id, wantedColumn());
}

const pageTitle = document.title;
drawControls();
readAddress();
addEventListener('hashchange', () => { readAddress(); show(); });
addEventListener('keydown', keys);
addEventListener('scroll', hideTip, {passive: true});
show();
