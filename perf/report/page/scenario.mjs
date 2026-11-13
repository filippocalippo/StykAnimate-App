// One scenario on one pair, in full: drawn only when it is opened, so a page of fifty scenarios on ten pairs stays fast.
// Like the overview, each section is a function of the scenario's context that returns its panel or null, in the order
// a person reads them: the grade and why, what changed, how it compares across pairs, then the evidence.
import {LAYERS} from '../../lib/layers.mjs';
import {bars, bullet, dotPlot, frameChart, legend, lineChart, stack, timeline} from './charts.mjs';
import {capital, facts, fill, h, mb, ms, number, panel, percent, subhead, table, tableView, words} from './dom.mjs';
import {chip, definition, glyph, limitsText, metric, short, title, word} from './grades.mjs';
import {columnIds, columnName} from './overview.mjs';

/** The layer groups in the order layers.mjs lists them: a group keeps its colour on every thread and every page. */
const GROUPS = [...new Set(Object.values(LAYERS).map(layer => layer.group))];
const groupSlot = group => (GROUPS.includes(group) ? GROUPS.indexOf(group) + 1 : GROUPS.length + 1);
const scenarioIn = (model, column, id) => model.pairs[column.pair].scenarios.find(scenario => scenario.id === id);

/** What went wrong: the scenario's own failure or skip, and the pair's when it did not complete. */
function problem({scenario, pair}) {
  const lines = [scenario.error ? h('p', {class: 'error-text'}, scenario.error) : null, scenario.skipped ? h('p', {}, `Skipped: ${scenario.skipped}`) : null,
    pair.error ? h('p', {class: 'error-text'}, `The pair did not complete: ${pair.error}`) : null].filter(Boolean);
  if (!lines.length) return null;
  return panel('problem', scenario.error ? 'Failed' : scenario.skipped ? 'Skipped' : 'Pair not completed',
    scenario.error && scenario.passes ? `The ${scenario.passes} timed pass${scenario.passes === 1 ? '' : 'es'} before the failure are kept below.` : null, lines);
}

/** The grade and the criteria behind it: each one's value against its limits. */
function grade({scenario}) {
  const criteria = scenario.judged?.criteria ?? [];
  if (!criteria.length && !scenario.grade) return scenario.skipped ? null : panel('grade', 'Grade', null, h('p', {class: 'empty'}, 'Not graded: none of its criteria was measured.'));
  return panel('grade', 'Grade', `${word(scenario.grade ?? 'ungraded')} over ${scenario.passes} timed pass${scenario.passes === 1 ? '' : 'es'}: the worst of its criteria, each the median of the passes.`,
    h('div', {class: 'criteria'}, criteria.map(row => h('div', {class: `criterion${row.metric === scenario.judged.decided ? ' decided' : ''}`},
      chip(row.grade),
      h('span', {class: 'criterion-name'}, title(scenario, row.metric), row.metric === scenario.judged.decided ? h('span', {class: 'tag'}, 'decided the grade') : null),
      h('strong', {class: 'criterion-value'}, metric(scenario, row.metric, row.value)),
      bullet(row.value, row.limits, definition(scenario, row.metric).better, 180),
      h('span', {class: 'criterion-limits'}, limitsText(scenario, row.metric, row.limits))))));
}

/** What changed since the baseline run, by compare.mjs's noise rule. */
function change({model, column, scenario}) {
  if (column.base === null) return null;
  const base = model.runs[model.pairs[column.base].run].label, head = model.runs[model.pairs[column.pair].run].label;
  const rows = column.changes?.[scenario.id] ?? [];
  const order = {worse: 0, better: 1, same: 2};
  const sorted = [...rows].sort((a, b) => Number(b.judged) - Number(a.judged) || order[a.verdict] - order[b.verdict] || Math.abs(b.ratio ?? 0) - Math.abs(a.ratio ?? 0));
  const missing = column.missing.filter(text => text.startsWith(`${scenario.id}:`));
  return panel('change', `Change from ${base}`, `${base} → ${head}. A difference counts only past twice the wider of the two runs' spreads between passes, and never under 5% of the value.`,
    rows.length ? table([{label: 'Metric'}, {label: base, numeric: true}, {label: head, numeric: true}, {label: 'Change', numeric: true}, {label: 'Verdict'}, {label: 'Counts past', numeric: true}],
      sorted.map(row => [h('span', {}, title(scenario, row.metric), row.judged ? h('span', {class: 'tag'}, 'graded') : null),
        metric(scenario, row.metric, row.base), h('strong', {}, metric(scenario, row.metric, row.head)),
        row.ratio === null ? '–' : `${row.ratio > 0 ? '+' : ''}${(row.ratio * 100).toFixed(0)}%`,
        h('span', {class: `verdict-word ${row.verdict}`}, {worse: '▲ worse', better: '▼ better', same: '= within noise'}[row.verdict]),
        `±${metric(scenario, row.metric, row.threshold)}`])) : null,
    missing.map(text => h('p', {class: 'chart-note'}, `Not compared: ${text.slice(scenario.id.length + 1).trim()}`)));
}

/** The launch step by step, for a scenario that records its steps. */
function launch({scenario}) {
  if (!scenario.detail?.phases?.length) return null;
  const steps = scenario.detail.phases;
  return panel('launch', 'Steps of the launch', 'The first launch, from the process starting; steps that overlap ran at the same time.', timeline(steps),
    tableView('Table', () => table([{label: 'Step'}, {label: 'Starts', numeric: true}, {label: 'Takes', numeric: true}], steps.map(step => [step.name, ms(step.startMs, 0), ms(step.ms)]))));
}

/** The same scenario on every pair that ran it: one metric across environments, and how it grows with the scene. */
function across({model, column: shown, scenario, holders}) {
  if (holders.length < 2) return null;
  const all = holders.map(({column}) => ({column, found: scenarioIn(model, column, scenario.id)}));
  const judged = new Set(all.flatMap(({found}) => (found.judged?.criteria ?? []).map(row => row.metric)));
  const keys = [...new Set(all.flatMap(({found}) => Object.keys(found.metrics ?? {})))].sort((a, b) => Number(judged.has(b)) - Number(judged.has(a)));
  if (!keys.length) return null;
  const picker = h('select', {id: 'across-metric', 'aria-label': 'Metric to compare'}, keys.map(key => h('option', {value: key}, `${title(scenario, key)}${judged.has(key) ? ' (graded)' : ''}`)));
  picker.value = scenario.judged?.decided && keys.includes(scenario.judged.decided) ? scenario.judged.decided : keys[0];
  const holder = h('div', {class: 'across-charts'});
  const draw = () => {
    const key = picker.value, text = value => metric(scenario, key, value);
    const criterion = all.flatMap(({found}) => found.judged?.criteria ?? []).find(row => row.metric === key);
    const better = definition(scenario, key).better;
    const edges = criterion?.limits;
    const bands = edges ? (better === 'higher'
      ? [{from: 0, to: edges[2], status: 'bad'}, {from: edges[2], to: edges[1], status: 'poor'}, {from: edges[1], to: edges[0], status: 'fair'}, {from: edges[0], to: null, status: 'good'}]
      : [{from: 0, to: edges[0], status: 'good'}, {from: edges[0], to: edges[1], status: 'fair'}, {from: edges[1], to: edges[2], status: 'poor'}, {from: edges[2], to: null, status: 'bad'}]) : null;
    const rows = all.map(({column, found}) => {
      const spread = found.metrics?.[key];
      return {label: columnIds(column), current: column === shown, median: found.error && !spread ? null : spread?.median ?? null, min: spread?.min, max: spread?.max, passes: spread?.n,
        status: found.judged?.criteria?.find(row => row.metric === key)?.grade ?? null, note: found.error ? 'failed' : found.skipped ? 'skipped' : 'not measured'};
    });
    // How it grows: per environment, its value on each workload, the workloads in order of their size.
    const workloads = [...new Map(all.map(({column}) => [column.workload.id, column.workload])).values()].sort((a, b) => (a.segmentsPerFrame ?? 0) - (b.segmentsPerFrame ?? 0));
    const environments = [...new Map(all.map(({column}) => [column.environment.id, column.environment])).values()]
      .filter(environment => all.filter(({column, found}) => column.environment.id === environment.id && Number.isFinite(found.metrics?.[key]?.median)).length > 1);
    const series = environments.slice(0, 8).map((environment, index) => ({name: environment.title ?? environment.id, slot: index + 1,
      values: workloads.map(workload => all.find(({column}) => column.environment.id === environment.id && column.workload.id === workload.id)?.found.metrics?.[key]?.median ?? null)}));
    fill(holder,
      h('h3', {class: 'chart-title'}, `${title(scenario, key)} on each pair`, h('span', {class: 'muted'}, ' · median, with the least and the most of the passes')),
      dotPlot({rows, bands, text}),
      series.length ? [h('h3', {class: 'chart-title'}, `${title(scenario, key)} as the scene grows`, h('span', {class: 'muted'}, ' · median per workload, smallest scene first')),
        series.length > 1 ? legend(series.map(line => ({label: line.name, swatch: `c${line.slot}`, line: true}))) : null,
        lineChart({labels: workloads.map(workload => `${workload.title ?? workload.id} (${(workload.segmentsPerFrame ?? 0).toLocaleString('en')})`), series, text, height: 220, xTitle: 'segments a frame'}),
        h('p', {class: 'chart-note'}, series.map(line => {
          const measured = line.values.map((value, index) => [value, workloads[index]]).filter(([value]) => Number.isFinite(value));
          const [first, last] = [measured[0], measured.at(-1)];
          return `${line.name}: ${text(first[0])} on ${first[1].title ?? first[1].id} to ${text(last[0])} on ${last[1].title ?? last[1].id}${first[0] > 0 ? ` (×${number(last[0] / first[0], last[0] / first[0] < 10 ? 1 : 0)})` : ''}.`;
        }).join(' '))] : null,
      tableView('Table', () => table([{label: 'Pair'}, {label: 'Median', numeric: true}, {label: 'Spread', numeric: true}, {label: 'Least', numeric: true}, {label: 'Most', numeric: true}, {label: 'Passes', numeric: true}],
        all.map(({column, found}) => { const spread = found.metrics?.[key]; return [columnName(column), text(spread?.median), `±${text(spread?.mad)}`, text(spread?.min), text(spread?.max), String(spread?.n ?? '–')]; }))));
  };
  picker.addEventListener('change', draw);
  draw();
  return panel('across', 'Across environments and workloads', 'The same scenario on every pair of the page. Graded metrics show their limits behind the values.',
    h('label', {class: 'field', for: 'across-metric'}, h('span', {}, 'Metric'), picker), holder);
}

/** The phases of the interface thread's work in a frame, from the series' own arrays, titled by the runner's metrics. */
function phasesOf(scenario, series) {
  return Object.keys(series).filter(key => key !== 'interval' && Array.isArray(series[key])).map(key => {
    const named = definition(scenario, `work.${key}`).title;
    return {key, title: named && named !== `work.${key}` ? named.replace(/ per frame$/, '') : capital(words(key))};
  });
}

/** The frames of the first timed pass: the chart, how they spread, what the interface thread did in them, input latency. */
function frames({scenario}) {
  const detail = scenario.detail, summary = detail?.frames;
  if (!summary?.count && !detail?.series?.interval?.length) return null;
  const series = detail.series, phases = series ? phasesOf(scenario, series) : [];
  return panel('frames', 'Frames', `The first timed pass, ${ms(detail.ms, 0)} long: each frame's interval, and the interface thread's work in it by phase.`,
    summary?.count ? facts([['Frames', `${number(summary.count, 0)} at ${number(summary.perSecond)}/s`], ['Display period', ms(summary.periodMs, 2)],
      ['Late', `${number(summary.late, 0)}${summary.lateShare !== null ? ` (${percent(summary.lateShare, 1)})` : ''}`], ['Over 16.7 ms', number(summary.over16, 0)], ['Over 33.3 ms', number(summary.over33, 0)], ['Over 100 ms', number(summary.over100, 0)],
      ['Seen (weighted)', ms(summary.felt)], ['Median · p95 · p99', `${ms(summary.p50)} · ${ms(summary.p95)} · ${ms(summary.p99)}`], ['Longest', ms(summary.worst)]]) : null,
    series?.interval?.length ? frameChart(series, {periodMs: summary?.periodMs, phases}) : null,
    series?.interval?.length ? tableView('Table of the frames', () => table([{label: 'Point', numeric: true}, {label: 'Interval', numeric: true}, ...phases.map(phase => ({label: phase.title, numeric: true}))],
      series.interval.map((value, index) => [String(index + 1), ms(value), ...phases.map(phase => ms(series[phase.key][index]))]))) : null,
    summary?.work ? [subhead('The interface thread per frame', `p95 is ${percent(summary.work.budgetShare, 1)} of the display period`),
      table([{label: 'Phase'}, {label: 'Mean', numeric: true}, {label: 'p95', numeric: true}, {label: 'Longest', numeric: true}, {label: 'Share of the work', numeric: true}],
        [...Object.entries(summary.phases ?? {}).map(([key, value]) => [phasesOf(scenario, {[key]: []})[0].title, ms(value.mean, 2), ms(value.p95, 2), ms(value.worst), percent(value.share, 1)]),
          [h('strong', {}, 'All work'), h('strong', {}, ms(summary.work.mean, 2)), h('strong', {}, ms(summary.work.p95, 2)), h('strong', {}, ms(summary.work.worst)), '']])] : null,
    detail.inputs?.count ? [subhead('Input to frame', 'from each input to the end of the frame that answered it'),
      facts([['Inputs', number(detail.inputs.count, 0)], ['Median', ms(detail.inputs.p50)], ['p95', ms(detail.inputs.p95)], ['Longest', ms(detail.inputs.worst)], ['Dropped', number(detail.inputs.dropped, 0)]])] : null);
}

/** Every metric with its spread over the passes. */
function metrics({scenario}) {
  const entries = Object.entries(scenario.metrics ?? {});
  if (!entries.length) return null;
  const judged = new Set((scenario.judged?.criteria ?? []).map(row => row.metric));
  return panel('metrics', 'Metrics', `The median of ${scenario.passes} timed pass${scenario.passes === 1 ? '' : 'es'}; the spread is the median distance from it, then the least and the most.`,
    table([{label: 'Metric'}, {label: 'Median', numeric: true}, {label: 'Spread', numeric: true}, {label: 'Least', numeric: true}, {label: 'Most', numeric: true}],
      entries.sort(([a], [b]) => Number(judged.has(b)) - Number(judged.has(a))).map(([key, value]) => [
        h('span', {}, title(scenario, key), judged.has(key) ? h('span', {class: 'tag'}, 'graded') : null, h('span', {class: 'key-name'}, key)),
        h('strong', {}, metric(scenario, key, value.median)), `±${metric(scenario, key, value.mad)}`, metric(scenario, key, value.min), metric(scenario, key, value.max)])));
}

/** A cell with a value and a bar of its share of the column's largest. */
const barCell = (text, value, max) => h('span', {class: 'cell-with-bar'}, h('span', {class: 'cell-bar', style: `width:${max > 0 ? (value / max * 100).toFixed(1) : 0}%`}), h('span', {}, text));

/** The app's own spans of the first pass, and its slowest single ones. */
function spans({scenario}) {
  const rows = scenario.detail?.spans ?? [], slowest = scenario.detail?.slowest ?? [];
  if (!rows.length && !slowest.length) return null;
  const max = Math.max(...rows.map(row => row.totalMs ?? 0));
  return panel('spans', 'Spans', 'What the app\'s own instrumentation recorded in the first timed pass, by name, heaviest first.',
    rows.length ? table([{label: 'Span'}, {label: 'Thread'}, {label: 'Count', numeric: true}, {label: 'Total', numeric: true}, {label: 'Median', numeric: true}, {label: 'p95', numeric: true}, {label: 'Longest', numeric: true}],
      rows.map(row => [h('span', {class: 'code-name'}, row.name), row.thread, number(row.count, 0), barCell(ms(row.totalMs), row.totalMs, max), ms(row.p50, 2), ms(row.p95, 2), ms(row.worst)]), {limit: 12}) : null,
    slowest.length ? [subhead('The slowest single spans'), table([{label: 'Span'}, {label: 'Thread'}, {label: 'Took', numeric: true}, {label: 'Detail'}],
      slowest.map(row => [h('span', {class: 'code-name'}, row.name), row.thread, ms(row.ms), row.args ? Object.entries(row.args).map(([key, value]) => `${key} ${value}`).join(', ') : '']))] : null);
}

/** The calls from the interface into the engine in the first pass. */
function engineCalls({scenario}) {
  const rows = scenario.detail?.boundary ?? [];
  if (!rows.length) return null;
  const max = Math.max(...rows.map(row => row.totalMs ?? 0)), total = rows.reduce((sum, row) => sum + (row.totalMs ?? 0), 0);
  return panel('engine-calls', 'Calls into the engine', `The interface thread waited ${ms(total)} inside the engine in the first pass, over ${number(rows.reduce((sum, row) => sum + row.calls, 0), 0)} calls (the heaviest kinds shown).`,
    table([{label: 'Call'}, {label: 'Calls', numeric: true}, {label: 'Total', numeric: true}, {label: 'Each, mean', numeric: true}, {label: 'Longest', numeric: true}],
      rows.map(row => [h('span', {class: 'code-name'}, row.name), number(row.calls, 0), barCell(ms(row.totalMs), row.totalMs, max), ms(row.calls ? row.totalMs / row.calls : NaN, 2), ms(row.worstMs)]), {limit: 12}));
}

/** What the engine's threads prepared, and the app's counters over the pass. */
function engineThreads({scenario}) {
  const preparation = scenario.detail?.preparation, counters = Object.entries(scenario.detail?.counters ?? {});
  if (!preparation && !counters.length) return null;
  return panel('engine-threads', 'The engine\'s threads', 'Frames the engine\'s threads prepared ahead of the stage in the first pass, and the app\'s counters while it ran.',
    preparation ? facts(Object.entries(preparation).map(([key, value]) => [capital(words(key)), typeof value === 'number' ? number(value, 2) : String(value ?? '–')])) : null,
    counters.length ? table([{label: 'Counter'}, {label: 'At the end', numeric: true}, {label: 'Least', numeric: true}, {label: 'Most', numeric: true}, {label: 'Samples', numeric: true}],
      counters.map(([name, value]) => [name, number(value.last, 1), number(value.min, 1), number(value.max, 1), number(value.samples, 0)])) : null);
}

/** One thread of the profiled pass: its time by layer, its engine modules, its heaviest functions and their callers. */
function threadBlock(thread) {
  const groups = new Map();
  for (const layer of thread.layers) groups.set(layer.group, (groups.get(layer.group) ?? 0) + layer.ms);
  const ordered = [...thread.layers].sort((a, b) => groupSlot(a.group) - groupSlot(b.group) || b.ms - a.ms);
  return h('div', {class: 'block thread'},
    subhead(capital(thread.thread), `busy ${ms(thread.busyMs, 0)} of ${ms(thread.sampledMs, 0)} watched (${percent(thread.busyMs, thread.sampledMs)})`),
    thread.perThreadBusyMs?.length ? h('p', {class: 'chart-note'}, `Each thread busy: ${thread.perThreadBusyMs.map(value => ms(value, 0)).join(', ')}.`) : null,
    stack(ordered.map(layer => ({label: layer.title, value: layer.ms, slot: groupSlot(layer.group), text: ms(layer.ms, 0), sub: `${percent(layer.ms, thread.busyMs)} of busy, ${layer.group}`})), thread.busyMs),
    legend([...groups].sort((a, b) => groupSlot(a[0]) - groupSlot(b[0])).map(([group, value]) => ({label: `${capital(group)} ${percent(value, thread.busyMs)}`, swatch: `c${groupSlot(group)}`}))),
    table([{label: 'Layer'}, {label: 'Group'}, {label: 'Time', numeric: true}, {label: 'Of busy', numeric: true}],
      thread.layers.map(layer => [layer.title, layer.group, ms(layer.ms, 0), percent(layer.ms, thread.busyMs)]), {limit: 8}),
    thread.modules?.length ? [subhead('Engine modules'), table([{label: 'Module'}, {label: 'Time', numeric: true}, {label: 'Of busy', numeric: true}],
      thread.modules.map(row => [h('span', {class: 'code-name'}, row.name), ms(row.ms, 0), percent(row.ms, thread.busyMs)]), {limit: 6})] : null,
    thread.functions?.length ? [subhead('Heaviest functions', 'own time, with who called them'), table([{label: 'Own time', numeric: true}, {label: 'Of busy', numeric: true}, {label: 'Function'}, {label: 'Layer'}],
      thread.functions.map(fn => [ms(fn.selfMs, 0), percent(fn.selfMs, thread.busyMs),
        h('span', {class: 'fn'}, h('span', {class: 'code-name'}, fn.name), fn.where ? h('span', {class: 'fn-where'}, fn.where) : null,
          fn.callers?.length ? h('span', {class: 'fn-callers'}, `called from ${fn.callers.join(' ← ')}`) : null),
        LAYERS[fn.layer]?.title ?? fn.layer]), {limit: 10, className: 'functions'})] : null);
}

/** The profiled pass: the threads the profiler sampled, then every process's threads from the browser's trace. */
function profiled({scenario}) {
  const attribution = scenario.attribution;
  if (!attribution) return null;
  const browser = attribution.browser;
  return panel('profiled', 'Where the time went', `The profiled pass${attribution.repeats > 1 ? `, the operation ${attribution.repeats} times over` : ''}. Its instruments slow the app: read shares, not absolute times.`,
    (attribution.threads ?? []).map(threadBlock),
    browser ? h('div', {class: 'block'},
      subhead('Threads of every process', `from the browser's trace over ${ms(browser.windowMs, 0)}`),
      table([{label: 'Role'}, {label: 'Process / thread'}, {label: 'Busy', numeric: true}, {label: 'Processor', numeric: true}, {label: 'Of the window', numeric: true}],
        browser.threads.map(row => [row.role, `${row.process} / ${row.thread}`, barCell(ms(row.busyMs, 0), row.busyMs, browser.windowMs), ms(row.cpuMs, 0), percent(row.busyMs, browser.windowMs)]), {limit: 10}),
      h('div', {class: 'pair-columns'},
        browser.interface?.length ? h('div', {}, subhead('The interface thread, by kind of work'), bars(browser.interface.map(row => ({label: row.title, value: row.ms, text: ms(row.ms, 0)})))) : null,
        browser.graphics?.length ? h('div', {}, subhead('The graphics process, by kind of work'), bars(browser.graphics.map(row => ({label: row.title, value: row.ms, text: ms(row.ms, 0), slot: 2})))) : null),
      browser.counts ? [subhead('How often the browser redid the interface'), facts(Object.entries(browser.counts).map(([key, value]) => [capital(words(key)), number(value, 0)]))] : null) : null,
    attribution.processes?.length ? h('div', {class: 'block'}, subhead('Processor time by process', 'over the profiled pass'),
      table([{label: 'Process'}, {label: 'Processor', numeric: true}, {label: 'Private memory', numeric: true}, {label: 'Working set', numeric: true}],
        attribution.processes.map(row => [row.type, barCell(ms(row.cpuMs, 0), row.cpuMs, Math.max(...attribution.processes.map(item => item.cpuMs))), mb(row.privateBytes / 1048576), mb(row.workingSetBytes / 1048576)]))) : null);
}

/** What the scenario itself noted. */
const notes = ({scenario}) => (scenario.notes?.length ? panel('scenario-notes', 'Notes', null, h('ul', {class: 'plain'}, scenario.notes.map(note => h('li', {}, note)))) : null);

/** The scenario view's sections, in the order of the page. */
export const SCENARIO_SECTIONS = [problem, grade, change, launch, across, frames, metrics, spans, engineCalls, engineThreads, profiled, notes];

/**
 * Draws scenario `id` on column `wanted` (an index; another column that ran it when that one did not) into `root`.
 * `view.open(id, column)` moves to another scenario or pair, `view.close()` goes back, `view.neighbours(id)` gives the
 * scenarios before and after in the overview's order. Returns the column shown, or null when no pair ran the scenario.
 */
export function renderScenario(root, model, {id, wanted}, view) {
  const holders = model.columns.map((column, index) => ({column, index})).filter(({column}) => scenarioIn(model, column, id));
  const back = h('button', {type: 'button', class: 'back', onclick: view.close}, '← Overview');
  if (!holders.length) { root.replaceChildren(h('nav', {class: 'scenario-nav'}, back), panel('missing', 'No such scenario', null, h('p', {}, `No pair on this page ran "${id}".`))); return null; }
  const chosen = holders.find(item => item.index === wanted) ?? holders[0], column = chosen.column, pair = model.pairs[column.pair], scenario = scenarioIn(model, column, id);
  const context = {model, column, columnIndex: chosen.index, pair, scenario, holders};
  const sections = SCENARIO_SECTIONS.map(section => section(context)).filter(Boolean);
  const [previous, next] = view.neighbours(id);
  const step = (row, label) => (row ? h('button', {type: 'button', class: 'step', title: `${label}: ${row.title} (${label === 'Previous' ? 'k' : 'j'})`, onclick: () => view.open(row.id, chosen.index)}, label === 'Previous' ? `↑ ${row.title}` : `↓ ${row.title}`) : null);
  root.replaceChildren(
    h('nav', {class: 'scenario-nav', 'aria-label': 'Scenario'}, back, h('span', {class: 'nav-steps'}, step(previous, 'Previous'), step(next, 'Next'))),
    h('section', {class: 'panel scenario-head', 'aria-labelledby': 'scenario-title'},
      h('div', {class: 'scenario-titles'}, h('h2', {id: 'scenario-title'}, scenario.title), chip(scenario.status)),
      h('p', {class: 'scenario-id'}, h('span', {class: 'code-name'}, scenario.id), ` · ${capital(words(scenario.area ?? ''))} · ${scenario.kind === 'gesture' ? 'a gesture, judged by its frames' : scenario.kind === 'operation' ? 'an operation, judged by how long it takes' : scenario.kind ?? ''}`),
      scenario.description ? h('p', {class: 'description'}, scenario.description) : null,
      h('div', {class: 'pair-picker', role: 'group', 'aria-label': 'Environment and workload'}, holders.map(({column: other, index}) => {
        const found = scenarioIn(model, other, id), decided = found.judged?.decided;
        return h('button', {type: 'button', class: `pair-chip st-${found.status}`, 'aria-pressed': String(index === chosen.index), onclick: () => view.open(id, index), title: `${columnName(other)}: ${word(found.status)}`},
          glyph(found.status), h('span', {}, columnIds(other)), h('span', {class: 'pair-value'}, found.error ? 'failed' : found.skipped ? 'skipped' : decided ? `${short(found, decided)} ${metric(found, decided, found.judged.value)}` : ''));
      })),
      h('nav', {class: 'contents', 'aria-label': 'Sections'}, sections.map(section => h('button', {type: 'button', class: 'link', onclick: () => section.scrollIntoView({block: 'start'})}, section.querySelector('h2')?.textContent ?? '')))),
    ...sections);
  return chosen.index;
}
