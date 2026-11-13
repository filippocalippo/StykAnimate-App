// The overview: the sections a person reads first, most important first. Each section is a function of the report's
// data and the current view ({columns, rows, open}) that returns its panel, or null when the runs hold nothing for it,
// so a new kind of result (the engine's own benchmarks, say) is one more function in SECTIONS.
import {bars, lineChart, bullet, legend, timeline} from './charts.mjs';
import {capital, facts, h, mb, ms, number, panel, subhead, table, tableView, words} from './dom.mjs';
import {chip, glyph, limitsText, metric, short, word} from './grades.mjs';

/** "Graphics card · Stress scene": a column's name. */
export const columnName = column => `${column.environment.title ?? column.environment.id} · ${column.workload.title ?? column.workload.id}`;
/** "gpu / stress": a column's ids, as the command line takes them. */
export const columnIds = column => `${column.environment.id} / ${column.workload.id}`;
const scenarioOf = (model, column, id) => model.pairs[column.pair].scenarios.find(scenario => scenario.id === id);
const verdictGlyph = {worse: '▲', better: '▼'};

/** A cell's sentence: everything the cell shows, for its label and tooltip. */
function cellText(model, column, scenario) {
  if (!scenario) return `${columnIds(column)}: not run`;
  const decided = scenario.judged?.decided, base = model.runs[model.pairs[column.base ?? column.pair].run].label;
  const verdict = column.verdicts?.[scenario.id];
  return `${scenario.title} on ${columnIds(column)}: ${word(scenario.status)}`
    + (scenario.error ? `, ${scenario.error}` : scenario.skipped ? `, ${scenario.skipped}` : decided ? `, ${short(scenario, decided)} ${metric(scenario, decided, scenario.judged.value)}` : '')
    + (verdict && verdict !== 'same' ? `, ${verdict} than in ${base}` : '');
}

/** 1. Every scenario's grade on every pair, grouped by area: the page's first answer. */
function glance(model, view) {
  if (!view.rows.length || !view.columns.length) return panel('glance', 'State at a glance', null, h('p', {class: 'empty'}, 'No scenario matches the filter.'));
  const present = new Set(view.columns.flatMap(column => model.pairs[column.pair].scenarios.map(scenario => scenario.status)));
  const compared = view.columns.some(column => column.base !== null);
  const head = h('tr', {}, h('th', {class: 'corner', scope: 'col'}, 'Scenario'), view.columns.map(column => {
    const pair = model.pairs[column.pair];
    return h('th', {scope: 'col', class: 'col-head'},
      h('div', {class: 'col-env'}, column.environment.title ?? column.environment.id), h('div', {class: 'col-work'}, column.workload.title ?? column.workload.id),
      h('div', {class: 'col-facts'}, [pair.facts?.renderer?.backend, pair.facts?.display?.hz ? `${pair.facts.display.hz} Hz` : null, pair.facts?.cpuSlowdown > 1 ? `CPU ÷${pair.facts.cpuSlowdown}` : null].filter(Boolean).join(' · ')),
      model.runs.length > 1 ? h('div', {class: 'col-run'}, column.base !== null ? `${model.runs[model.pairs[column.base].run].label} → ${model.runs[pair.run].label}` : model.runs[pair.run].label) : null,
      pair.busy ? h('div', {class: 'flag warn', title: 'Other programs used this share of the processor when the pair started: its numbers are slower and noisier.'}, `busy ${pair.facts.backgroundLoadPercent}%`) : null,
      pair.error ? h('div', {class: 'flag bad', title: pair.error}, 'not completed') : null);
  }));
  const body = h('tbody');
  let area = null;
  for (const row of view.rows) {
    if (row.area !== area) { area = row.area; body.append(h('tr', {class: 'area'}, h('th', {colspan: view.columns.length + 1, scope: 'rowgroup'}, capital(words(area ?? 'other'))))); }
    body.append(h('tr', {},
      h('th', {scope: 'row', class: 'row-head'}, h('button', {type: 'button', class: 'row-open', onclick: () => view.open(row.id)},
        h('span', {class: 'row-title'}, row.title), h('span', {class: 'row-id'}, row.id))),
      view.columns.map(column => {
        const scenario = scenarioOf(model, column, row.id);
        if (!scenario) return h('td', {class: 'cell-empty', title: cellText(model, column, null)}, h('span', {'aria-label': 'not run'}, '·'));
        const decided = scenario.judged?.decided, verdict = column.verdicts?.[row.id];
        const shown = scenario.status === 'failed' ? 'failed' : scenario.status === 'skipped' ? 'skipped' : decided ? metric(scenario, decided, scenario.judged.value) : '–';
        return h('td', {}, h('button', {type: 'button', class: `cell st-${scenario.status}`, title: cellText(model, column, scenario), 'aria-label': cellText(model, column, scenario),
          onclick: () => view.open(row.id, model.columns.indexOf(column))},
        glyph(scenario.status), h('span', {class: 'cell-value'}, shown), verdictGlyph[verdict] ? h('span', {class: `verdict ${verdict}`}, verdictGlyph[verdict]) : null));
      })));
  }
  return panel('glance', 'State at a glance', 'Each scenario\'s grade on each environment and workload, with the number that decided it. Open a row or a cell for the scenario in full.',
    h('ul', {class: 'legend grades'}, model.statuses.filter(status => present.has(status)).map(status => h('li', {}, chip(status))),
      compared ? [h('li', {}, h('span', {class: 'verdict worse'}, '▲'), ' worse than the baseline'), h('li', {}, h('span', {class: 'verdict better'}, '▼'), ' better, beyond the runs\' noise')] : null),
    h('div', {class: 'table-wrap matrix-wrap'}, h('table', {class: 'matrix'}, h('thead', {}, head), body)));
}

/** 2. What most needs work: worst state first, then furthest past its limit, with the number and where the time went. */
function needsWork(model, view) {
  const shown = new Set(view.columns.map(column => model.columns.indexOf(column))), ids = new Set(view.rows.map(row => row.id));
  const items = model.ranking.filter(item => shown.has(item.column) && ids.has(item.scenario));
  const list = h('ol', {class: 'ranking'});
  const draw = count => list.replaceChildren(...items.slice(0, count).map(item => {
    const column = model.columns[item.column], scenario = scenarioOf(model, column, item.scenario);
    return h('li', {}, h('button', {type: 'button', class: 'rank-item', onclick: () => view.open(item.scenario, item.column)},
      h('span', {class: 'rank-grade'}, chip(item.status)),
      h('span', {class: 'rank-what'}, h('span', {class: 'rank-title'}, scenario.title), h('span', {class: 'rank-id'}, `${scenario.id} · ${columnIds(column)}`)),
      item.error ? h('span', {class: 'rank-number error-text'}, item.error)
        : h('span', {class: 'rank-number'}, h('span', {class: 'rank-value'}, `${short(scenario, item.metric)} `, h('strong', {}, metric(scenario, item.metric, item.value))),
          item.limits ? bullet(item.value, item.limits, item.better) : null,
          item.limits ? h('span', {class: 'rank-limits'}, limitsText(scenario, item.metric, item.limits)) : null),
      item.where ? h('span', {class: 'rank-where'}, item.where) : null));
  }));
  draw(10);
  return panel('needs-work', 'Needs work', items.length ? 'The scenarios not graded good, worst first; within a grade, the furthest past its good limit. The last line is where the profiled pass found the time.' : null,
    items.length ? list : h('p', {class: 'empty'}, 'Every scenario shown is good.'),
    items.length > 10 ? h('button', {type: 'button', class: 'more', onclick: event => { draw(items.length); event.currentTarget.remove(); }}, `Show all ${items.length}`) : null);
}

/** 3. The launch of the app, step by step, for every pair that measured it (a scenario with `detail.phases`). */
function startup(model, view) {
  const launches = view.columns.flatMap(column => model.pairs[column.pair].scenarios.filter(scenario => scenario.detail?.phases?.length).map(scenario => ({column, scenario})));
  if (!launches.length) return null;
  const max = Math.max(...launches.flatMap(({scenario}) => scenario.detail.phases.map(step => step.startMs + step.ms)));
  return panel('startup', 'Startup', 'The steps of the first launch, from the process starting to the editor ready for input, on one time scale.',
    launches.map(({column, scenario}) => h('div', {class: 'block'},
      h('div', {class: 'block-head'}, h('button', {type: 'button', class: 'link', onclick: () => view.open(scenario.id, model.columns.indexOf(column))}, `${scenario.title}, ${columnName(column)}`),
        chip(scenario.status), scenario.metrics.duration ? h('span', {class: 'muted'}, `median ${metric(scenario, 'duration', scenario.metrics.duration.median)} of ${scenario.passes} launches`) : null),
      timeline(scenario.detail.phases, {max}),
      scenario.notes?.length ? h('p', {class: 'chart-note'}, scenario.notes.join(' ')) : null)));
}

/** The memory series a checkpoint has, in the order they are drawn. */
const MEMORY_SERIES = [['page', 'Page'], ['graphics', 'Graphics process'], ['engine', 'Engine in use'], ['jsHeap', 'JavaScript heap']];

/** 4. Memory after every scenario, per pair: what grows along a run and what a document costs. */
function memory(model, view) {
  const charted = view.columns.map(column => ({column, pair: model.pairs[column.pair]})).filter(({pair}) => pair.memory?.length > 1);
  if (!charted.length) return null;
  const used = MEMORY_SERIES.filter(([key]) => charted.some(({pair}) => pair.memory.some(point => Number.isFinite(point[key]))));
  return panel('memory', 'Memory along the run', 'Checkpoints after the app started and after every scenario, in megabytes. The page holds the engine and the JavaScript heap; the total adds the graphics process and the browser.',
    legend(used.map(([, name], index) => ({label: name, swatch: `c${index + 1}`, line: true}))),
    h('div', {class: 'multiples'}, charted.map(({column, pair}) => h('div', {class: 'multiple'},
      h('h3', {}, columnName(column), h('span', {class: 'muted'}, ` · ends at ${mb(pair.memory.at(-1)?.total)} in all`)),
      lineChart({labels: pair.memory.map(point => point.after), text: mb, height: 210,
        series: used.map(([key, name], index) => ({name, slot: index + 1, values: pair.memory.map(point => point[key] ?? null)}))}),
      tableView('Table', () => {
        const keys = [...new Set(pair.memory.flatMap(point => Object.keys(point)))].filter(key => key !== 'after');
        return table([{label: 'after'}, ...keys.map(key => ({label: `${words(key)} MB`, numeric: true}))], pair.memory.map(point => [point.after, ...keys.map(key => number(point[key], 1))]));
      })))));
}

/** 5. What the numbers rest on: the runs, what each pair actually ran as, what failed, and the limits behind the grades. */
function trust(model, view) {
  const runs = table([{label: 'Run'}, {label: 'Recorded'}, {label: 'Commit'}, {label: 'Engine build'}, {label: 'Machine'}, {label: 'Passes'}, {label: 'Took', numeric: true}],
    model.runs.map(run => [run.label, new Date(run.at).toLocaleString('en-GB', {dateStyle: 'medium', timeStyle: 'short'}),
      `${run.build?.commit ?? '?'}${run.build?.dirty ? ' + uncommitted changes' : ''} (${run.build?.branch ?? '?'}, version ${run.build?.version ?? '?'})`,
      run.build?.engine ? `${run.build.engine.sha256 ?? '?'} (${run.build.engine.profile ?? '?'}, ${mb((run.build.engine.wasmBytes ?? NaN) / 1048576)})` : 'none',
      `${run.machine?.cpu ?? '?'}, ${run.machine?.threads ?? '?'} threads, ${run.machine?.memoryGB ?? '?'} GB, ${run.machine?.platform ?? ''} ${run.machine?.release ?? ''}, Node ${run.machine?.node ?? '?'}`,
      `${run.passes} timed${run.profile ? ' + 1 profiled' : ''}, suite ${run.suite}`, `${number(run.seconds, 0)} s`]));
  const pairIndexes = view.columns.flatMap(column => (column.base !== null ? [column.base, column.pair] : [column.pair]));
  const pairs = table([{label: 'Pair'}, ...(model.runs.length > 1 ? [{label: 'Run'}] : []), {label: 'Renderer'}, {label: 'Display'}, {label: 'Engine threads', numeric: true}, {label: 'Processor'}, {label: 'Machine busy', numeric: true}, {label: 'Window'}, {label: 'App ready', numeric: true}, {label: 'Scene'}],
    pairIndexes.map(index => {
      const pair = model.pairs[index], factsOf = pair.facts ?? {};
      return [h('span', {}, h('strong', {}, `${pair.environment.id} / ${pair.workload.id}`), pair.error ? h('div', {class: 'error-text'}, `Not completed: ${pair.error}`) : null),
        ...(model.runs.length > 1 ? [model.runs[pair.run].label] : []),
        factsOf.renderer ? `${factsOf.renderer.backend ?? '?'}${factsOf.renderer.adapter ? `, ${factsOf.renderer.adapter}` : ''}` : '–',
        factsOf.display ? `${factsOf.display.hz} Hz (${number(factsOf.display.periodMs, 2)} ms)` : '–',
        factsOf.engine ? `${factsOf.engine.threads ?? '?'}${factsOf.engine.threaded === false ? ' (not threaded)' : ''}` : '–',
        factsOf.cpuSlowdown > 1 ? `${factsOf.cpuSlowdown}× slower` : 'full speed',
        Number.isFinite(factsOf.backgroundLoadPercent) ? h('span', {class: pair.busy ? 'flag warn' : null}, `${factsOf.backgroundLoadPercent}%`) : 'not recorded',
        factsOf.window ? `${factsOf.window.width}×${factsOf.window.height} at ${factsOf.window.devicePixelRatio}×, ${factsOf.browser ?? ''}` : '–',
        ms(pair.startup?.readyMs, 0),
        `${pair.workload.segmentsPerFrame?.toLocaleString('en') ?? '?'} segments a frame, ${pair.workload.frames ?? '?'} frames`];
    }));
  const failures = pairIndexes.flatMap(index => {
    const pair = model.pairs[index], where = `${pair.environment.id} / ${pair.workload.id}${model.runs.length > 1 ? ` (${model.runs[pair.run].label})` : ''}`;
    return [...(pair.error ? [[where, 'the pair', pair.error]] : []), ...pair.scenarios.filter(scenario => scenario.error).map(scenario => [where, scenario.id, scenario.error]),
      ...pair.scenarios.filter(scenario => scenario.skipped).map(scenario => [where, scenario.id, `skipped: ${scenario.skipped}`])];
  });
  const limits = table([{label: 'Criterion'}, {label: 'Good'}, {label: 'Fair'}, {label: 'Poor'}, {label: 'Judges'}],
    model.limits.map(row => {
      const scenario = {definitions: {[row.metric]: row.definition}}, sign = row.definition.better === 'higher' ? '≥' : '≤';
      return [h('span', {}, row.definition.title ?? row.metric, h('span', {class: 'muted'}, ` (${row.metric}, ${row.definition.better ?? 'lower'} is better)`)),
        ...row.limits.map(limit => `${sign} ${metric(scenario, row.metric, limit)}`), row.scenarios.join(', ')];
    }));
  return panel('facts', 'What the numbers rest on', `A grade is the worst of a scenario's criteria; past the poor limit it is bad. A machine busier than ${model.busyPercent}% with other work makes numbers slower and noisier.`,
    h('h3', {}, 'Runs'), runs, h('h3', {}, 'Pairs: what the app ran as'), pairs,
    h('h3', {}, 'What failed or was skipped'), failures.length ? table([{label: 'Pair'}, {label: 'What'}, {label: 'Why'}], failures) : h('p', {class: 'empty'}, 'Nothing failed and nothing was skipped.'),
    h('h3', {}, 'Limits behind the grades'), limits,
    h('p', {class: 'chart-note'}, `Page made ${new Date(model.generated).toLocaleString('en-GB', {dateStyle: 'medium', timeStyle: 'short'})} from ${model.runs.map(run => run.label).join(', ')}.`));
}

/**
 * 6. The engine by itself (perf/engine/): how large a scene one thread builds in a frame's time, what each engine
 * operation costs per thousand segments, how costs grow with the scene, and the benchmarks on each workload.
 */
function engine(model) {
  const run = model.engine;
  if (!run) return null;
  const whole = value => number(value, 0);
  const reach = row => (row.segments ? `up to ${whole(row.segments.median)} segments (${whole(row.segments.min)} to ${whole(row.segments.max)} over the rounds)`
    : row.bound === 'above' ? 'beyond the largest scene measured' : row.bound === 'below' ? 'not at the smallest scene measured' : 'not measured');
  const costs = [...new Set(run.capacity.map(row => row.what))];
  const rates = [...new Set(run.capacity.map(row => row.rate))];
  const scaling = run.scaling, sloped = scaling?.rows.filter(row => Number.isFinite(row.perThousand)) ?? [];
  return panel('engine', 'The engine alone',
    `The engine by itself on one thread, with no window and no graphics card (run "${run.label}", ${run.rounds} rounds${run.busy ? '; the machine was busy with other work, so these are slower and noisier than they would be' : ''}). `
      + 'What each part of the engine costs, how that grows with the scene, and how large a scene one thread builds in a frame\'s time. The app spreads playback, opening and saving over its worker threads.',
    costs.length ? h('div', {class: 'block'}, subhead('How large a scene fits in a frame', 'one thread, figures of 50 segments'),
      table([{label: 'What'}, ...rates.map(rate => ({label: `Within ${(1000 / rate).toFixed(1)} ms (${rate} frames a second)`}))],
        costs.map(what => [capital(what), ...rates.map(rate => { const row = run.capacity.find(found => found.what === what && found.rate === rate); return row ? reach(row) : '–'; })]))) : null,
    sloped.length ? h('div', {class: 'block'}, subhead('What a thousand segments cost', 'the slope of each cost against the size of the scene'),
      bars(sloped.map(row => ({label: row.title, value: row.perThousand, text: `${number(row.perThousand, 2)} ms`, slot: 1})))) : null,
    scaling ? h('div', {class: 'block'}, subhead('How each cost grows with the scene', 'median milliseconds at each size'),
      lineChart({labels: scaling.sizes.map(whole), text: ms, height: 240, xTitle: 'segments a frame',
        series: scaling.rows.map((row, index) => ({name: row.name, slot: index % 8 + 1, values: row.points}))}),
      table([{label: 'Cost'}, ...scaling.sizes.map(size => ({label: whole(size), numeric: true})), {label: 'Per 1,000', numeric: true}, {label: 'Growth'}],
        scaling.rows.map(row => [row.title, ...row.points.map(value => number(value, value < 10 ? 2 : 1)), Number.isFinite(row.perThousand) ? `${number(row.perThousand, 2)} ms` : '–',
          row.verdict ? `${row.verdict}${row.exponent === null ? '' : ` (exponent ${number(row.exponent, 2)})`}` : '–']))) : null,
    run.workloads.map(workload => h('div', {class: 'block'},
      subhead(`${workload.title ?? workload.id}: ${whole(workload.segmentsPerFrame)} segments a frame`, `${whole(workload.figures)} figures, ${whole(workload.frames)} frames${Number.isFinite(workload.openMB) ? `; the engine holds ${mb(workload.openMB)} once it is open` : ''}`),
      table([{label: 'Benchmark'}, {label: 'Part of the engine'}, {label: 'Median', numeric: true}, {label: 'Spread', numeric: true}, {label: 'Its parts'}, {label: 'Peak memory', numeric: true}],
        workload.benchmarks.map(benchmark => (benchmark.error
          ? [benchmark.title, benchmark.layer, 'failed', '', benchmark.error, '']
          : [h('span', {title: benchmark.description}, benchmark.title), benchmark.layer, benchmark.cells[0]?.text ?? '–', benchmark.cells[0] ? `±${benchmark.cells[0].spread}` : '',
            benchmark.cells.slice(1).map(cell => `${cell.key} ${cell.text}`).join(' · '), Number.isFinite(benchmark.peakMB) ? mb(benchmark.peakMB) : '–']))))));
}

/** The overview's sections, in the order of the page. */
export const SECTIONS = [glance, needsWork, startup, memory, engine, trust];

/** Draws the overview into `root` for `view`. */
export function renderOverview(root, model, view) {
  root.replaceChildren(...SECTIONS.map(section => section(model, view)).filter(Boolean));
}

/** The facts line under the page's title: the runs the page is made from. */
export function runLine(model) {
  return model.runs.map((run, index) => facts([
    [model.runs.length > 1 ? (index ? 'Compared run' : 'Baseline') : 'Run', run.label],
    ['Recorded', new Date(run.at).toLocaleString('en-GB', {dateStyle: 'medium', timeStyle: 'short'})],
    ['Commit', `${run.build?.commit ?? '?'}${run.build?.dirty ? ' + changes' : ''}`],
    ['Machine', `${run.machine?.cpu ?? '?'}, ${run.machine?.threads ?? '?'} threads`],
  ]));
}

