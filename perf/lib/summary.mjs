/**
 * A run as text (docs/PERFORMANCE.md "Reading a run"): `overview` is the page an agent or a person reads first
 * (every scenario's grade, its judged number and where its time went), `explain` is one scenario in full.
 * Plain text, no colour: it is read in terminals, logs and by agents.
 */
import {format, METRICS} from './metrics.mjs';
import {experimentLine} from './experiment.mjs';
import {BUSY_PERCENT} from './result.mjs';

const pad = (text, width) => String(text).padEnd(width);
const percent = (part, whole) => (whole > 0 ? `${Math.round(part / whole * 100)}%` : '–');
const metric = (scenario, key) => scenario.metrics[key]?.median;
const shown = (scenario, key) => format(key, metric(scenario, key), scenario.definitions);

/** One line: which threads were busy in the profiled pass, and the interface thread's heaviest layers. */
export function whereLine(scenario) {
  const attribution = scenario.attribution;
  if (!attribution) return '';
  const parts = [];
  const main = attribution.threads.find(row => row.thread === 'interface');
  if (main) parts.push(`interface ${percent(main.busyMs, main.sampledMs)} busy (${main.layers.slice(0, 3).map(layer => `${layer.title.replace(/ \(.*\)$/, '')} ${percent(layer.ms, main.busyMs)}`).join(', ')})`);
  const engine = attribution.threads.find(row => row.thread.startsWith('engine thread'));
  if (engine && main && engine.busyMs > main.sampledMs * .02) parts.push(`engine threads ${percent(engine.busyMs, main.sampledMs)} of one core`);
  const graphics = attribution.browser?.threads.find(row => row.role === 'graphics main');
  if (graphics) parts.push(`graphics process ${percent(graphics.busyMs, attribution.browser.windowMs)} busy`);
  return parts.join(' · ');
}

/** The pair's one-line description: what the app actually ran as. */
function pairLine(pair) {
  const facts = pair.facts;
  if (!facts) return `${pair.environment.id} / ${pair.workload.id}`;
  return `${pair.environment.id} / ${pair.workload.id}: ${facts.renderer?.backend ?? 'no renderer'}${facts.renderer?.adapter ? ` (${String(facts.renderer.adapter).slice(0, 60)})` : ''}, display ${facts.display.hz} Hz, ${facts.engine?.threads ?? '?'} engine threads`
    + `${facts.cpuSlowdown > 1 ? `, processor ${facts.cpuSlowdown}× slower` : ''}; ${pair.workload.segmentsPerFrame?.toLocaleString('en') ?? '?'} segments a frame, ${pair.workload.frames ?? '?'} frames`;
}

/** The whole run on a page. */
export function overview(result) {
  const lines = [`StykAnimate performance run "${result.label}"`,
    `${result.build.commit ?? 'no commit'}${result.build.dirty ? ' + uncommitted changes' : ''} (${result.build.branch ?? '?'}), engine build ${result.build.engine?.sha256 ?? '?'} · ${result.machine.cpu}, ${result.machine.threads} threads, ${result.machine.memoryGB} GB`,
    `${result.pairs.length} launch${result.pairs.length === 1 ? '' : 'es'}, ${result.passes} timed pass${result.passes === 1 ? '' : 'es'}${result.profile ? ' and a profiled pass' : ''} per scenario, ${Math.round(result.seconds)} s in all`,
    ...(result.unfinished ? [`NOT FINISHED: ${result.unfinished} more launch${result.unfinished === 1 ? ' was' : 'es were'} planned when this was written (the run was still going, or was stopped)`] : []), ''];
  for (const pair of result.pairs) {
    lines.push(`== ${pairLine(pair)}`);
    if (pair.error) lines.push(`   NOT COMPLETED: ${pair.error}`);
    if (experimentLine(pair.facts)) lines.push(`   ${experimentLine(pair.facts)}`);
    if (pair.facts?.backgroundLoadPercent > BUSY_PERCENT) lines.push(`   the machine was busy with other work (${pair.facts.backgroundLoadPercent}% of its processor) when this started: its numbers are slower and noisier than they would be`);
    for (const scenario of pair.scenarios) {
      if (scenario.skipped) { lines.push(`   ${pad(scenario.id, 22)} skipped: ${scenario.skipped}`); continue; }
      if (scenario.error) { lines.push(`   ${pad(scenario.id, 22)} FAILED: ${scenario.error}`); continue; }
      // What decided the grade, then the numbers that go with it.
      const decided = scenario.judged?.decided, title = (scenario.definitions[decided] ?? METRICS[decided])?.short ?? decided;
      const numbers = scenario.kind === 'gesture'
        ? `frame seen ${shown(scenario, 'frame.felt')} (p95 ${shown(scenario, 'frame.p95')}), interface work p95 ${shown(scenario, 'work.p95')}${metric(scenario, 'input.p95') !== undefined ? `, input p95 ${shown(scenario, 'input.p95')}` : ''}`
        : `longest task ${shown(scenario, 'longTasks.longest')}`;
      lines.push(`   ${pad(scenario.id, 22)} ${pad((scenario.grade ?? '–').toUpperCase(), 5)} ${pad(`${title} ${shown(scenario, decided)}`, 28)} ${numbers}`);
      const where = whereLine(scenario);
      if (where) lines.push(`   ${' '.repeat(22)} ${where}`);
    }
    const memory = pair.memory.at(-1);
    if (memory?.total) lines.push(`   memory at the end: ${memory.total} MB in all (page ${memory.page ?? '–'}, graphics ${memory.graphics ?? '–'}); engine ${memory.engine ?? '–'} MB in use, JavaScript ${memory.jsHeap ?? '–'} MB`);
    lines.push('');
  }
  lines.push('Grades: GOOD, FAIR, POOR, BAD against fixed limits (docs/PERFORMANCE.md). One scenario in full: npm run perf -- show <run> <scenario>.');
  return `${lines.join('\n')}\n`;
}

/** One scenario of one pair in full: every metric, the frame's phases, spans, calls into the engine, and the profiled pass's attribution. */
export function explain(pair, scenario) {
  const lines = [`${scenario.id}: ${scenario.title}  [${pairLine(pair)}]`, scenario.description, ''];
  if (scenario.skipped) return `${lines.join('\n')}skipped: ${scenario.skipped}\n`;
  if (scenario.error) lines.push(`FAILED: ${scenario.error}`, '');
  lines.push(`Grade ${(scenario.grade ?? '–').toUpperCase()} (${scenario.passes} timed passes), the worst of:`,
    ...(scenario.judged?.criteria ?? []).map(row => `  ${pad((row.grade ?? '–').toUpperCase(), 5)} ${pad((scenario.definitions[row.metric] ?? METRICS[row.metric])?.title ?? row.metric, 50)} ${pad(format(row.metric, row.value, scenario.definitions), 11)}`
      + ` good to ${row.limits[0].toFixed(0)}, fair to ${row.limits[1].toFixed(0)}, poor to ${row.limits[2].toFixed(0)}`), '');
  lines.push('Metrics (median of the passes; spread is the median deviation, then least to most):');
  for (const [key, value] of Object.entries(scenario.metrics)) {
    const title = (scenario.definitions[key] ?? METRICS[key])?.title ?? key;
    lines.push(`  ${pad(title, 46)} ${pad(format(key, value.median, scenario.definitions), 12)} ±${format(key, value.mad, scenario.definitions)}  (${format(key, value.min, scenario.definitions)} to ${format(key, value.max, scenario.definitions)})`);
  }
  const detail = scenario.detail;
  if (detail?.frames?.count) {
    const {frames} = detail;
    lines.push('', `Frames (first pass): ${frames.count} at ${frames.perSecond}/s against a ${frames.periodMs?.toFixed(2)} ms display period; ${frames.late} late, ${frames.over16} over 16.7 ms, ${frames.over33} over 33.3 ms, ${frames.over100} over 100 ms`,
      `  interface thread per frame: mean ${frames.work.mean} ms, p95 ${frames.work.p95} ms (${Math.round((frames.work.budgetShare ?? 0) * 100)}% of the period), worst ${frames.work.worst} ms`,
      ...Object.entries(frames.phases).map(([phase, value]) => `    ${pad(phase, 9)} mean ${value.mean} ms, p95 ${value.p95} ms, ${Math.round((value.share ?? 0) * 100)}% of the work`));
  }
  if (detail?.phases?.length) {
    lines.push('', 'The start, step by step (first launch; ms from the launch):', ...detail.phases.map(step => `  ${pad(step.name, 44)} at ${pad(step.startMs, 7)} ${step.ms} ms`));
    if (detail.marks?.length) lines.push('', 'Spans until ready (first launch; ms from the launch):', ...detail.marks.map(mark => `  ${pad(`${mark.name} (${mark.thread})`.slice(0, 60), 60)} at ${pad(mark.startMs, 7)} ${mark.ms} ms`));
  }
  if (detail?.spans?.length) {
    lines.push('', 'Spans of the interface (first pass), heaviest first:', `  ${pad('span', 44)} ${pad('count', 6)} ${pad('total ms', 9)} ${pad('p50', 8)} ${pad('p95', 8)} worst`,
      ...detail.spans.filter(row => row.thread === 'interface' || row.thread === 'tasks').slice(0, 14).map(row => `  ${pad(row.name.slice(0, 44), 44)} ${pad(row.count, 6)} ${pad(row.totalMs, 9)} ${pad(row.p50, 8)} ${pad(row.p95, 8)} ${row.worst}`));
  }
  if (detail?.boundary?.length) {
    lines.push('', 'Calls from the interface into the engine (first pass):', ...detail.boundary.slice(0, 10).map(row => `  ${pad(row.name.slice(0, 50), 50)} ${pad(`${row.calls}×`, 8)} ${pad(`${row.totalMs} ms`, 12)} worst ${row.worstMs} ms`));
  }
  if (detail?.preparation?.frames) lines.push('', `Engine threads prepared ${detail.preparation.frames} frames, ${detail.preparation.msPerFrame} ms each on average.`);
  const attribution = scenario.attribution;
  if (attribution) {
    lines.push('', `Profiled pass (${attribution.repeats > 1 ? `the operation ${attribution.repeats} times; ` : ''}its instruments slow the app, so read shares, not absolute times):`);
    for (const thread of attribution.threads) {
      lines.push(`  ${thread.thread}: busy ${thread.busyMs} ms of ${thread.sampledMs} ms watched (${percent(thread.busyMs, thread.sampledMs)})`,
        ...thread.layers.slice(0, 7).map(layer => `    ${pad(layer.title, 46)} ${pad(`${layer.ms} ms`, 11)} ${percent(layer.ms, thread.busyMs)}`));
      if (thread.modules?.length) lines.push(`    engine modules: ${thread.modules.slice(0, 6).map(row => `${row.name} ${row.ms} ms`).join(', ')}`);
      lines.push('    heaviest functions (own time):', ...thread.functions.slice(0, 8).map(fn => `      ${pad(`${fn.selfMs} ms`, 10)} ${fn.name.slice(0, 90)}${fn.where ? `  ${fn.where}` : ''}${fn.callers.length ? `\n${' '.repeat(17)}called from ${fn.callers.slice(0, 3).join(' ← ').slice(0, 150)}` : ''}`));
    }
    const browser = attribution.browser;
    if (browser) {
      lines.push('', '  Threads of every process, by the browser\'s own trace:', ...browser.threads.slice(0, 10).map(row => `    ${pad(`${row.role} (${row.process} / ${row.thread})`.slice(0, 60), 60)} busy ${pad(`${row.busyMs} ms`, 11)} cpu ${row.cpuMs} ms`));
      if (browser.interface.length) lines.push('  The interface thread, by kind of work:', ...browser.interface.map(row => `    ${pad(row.title, 46)} ${row.ms} ms`));
      if (browser.graphics.length) lines.push('  The graphics process, by kind of work:', ...browser.graphics.map(row => `    ${pad(row.title, 46)} ${row.ms} ms`));
      lines.push(`  The browser recalculated style ${browser.counts.styleRecalculations}×, laid out ${browser.counts.layouts}×, painted ${browser.counts.paints}×, rasterized the interface ${browser.counts.interfaceRasters}×, collected garbage ${browser.counts.garbageCollections}×.`);
    }
    if (attribution.writes?.rows.length) {
      const {writes} = attribution;
      lines.push(`  The interface was written ${writes.writes} times in one pass, on ${writes.elements} elements; ${writes.unchanged} of the writes put back the value already there. Most written:`,
        ...writes.rows.slice(0, 12).map(row => `    ${pad(row.element.slice(0, 52), 52)} ${pad(`${row.attributes + row.text + row.children}×`, 7)} ${[row.attributes ? `attributes ${row.attributes} (${row.names.join(', ')})` : '', row.text ? `text ${row.text}` : '', row.children ? `children ${row.children}` : ''].filter(Boolean).join(', ')}`
          + `${row.nodes > 1 ? ` on ${row.nodes} elements` : ''}${row.unchanged ? `; ${row.unchanged === row.attributes + row.text + row.children ? 'all' : row.unchanged} unchanged` : ''}`));
    }
    if (attribution.processes.length) lines.push('  Processor time by process: ' + attribution.processes.map(row => `${row.type} ${row.cpuMs} ms`).join(', '));
  }
  if (scenario.notes.length) lines.push('', 'Notes:', ...scenario.notes.map(note => `  ${note}`));
  return `${lines.join('\n')}\n`;
}

/** The columns of the memory table: a checkpoint's own numbers, then the page split by owner (`owners`, src/devtools/memory.mjs). */
const MEMORY_COLUMNS = [['total', 'all'], ['page', 'page'], ['graphics', 'graphics'], ['engineReserved', 'eng.res'], ['engine', 'eng.use'], ['jsHeap', 'js']];
const OWNER_PARTS = [['engine memory', 'engine'], ['JavaScript heap', 'heap'], ['array buffers', 'buffers'], ['pictures', 'pictures'], ['workers', 'workers'], ['unexplained', 'unexpl.']];

/**
 * A run's memory checkpoints as text (`npm run perf -- memory`): per pair, the memory after every scenario in megabytes,
 * the page split by owner beside it, and with `detail` what each part of the last checkpoint (or of `after`) holds.
 */
export function memoryText(result, {env = null, workload = null, after = null, detail = false} = {}) {
  const lines = [`Memory of ${result.label} (megabytes; the page split by owner: docs/DEVTOOLS.md "Memory by owner")`, ''];
  const cell = value => pad(Number.isFinite(value) ? Math.round(value) : '–', 8);
  for (const pair of result.pairs) {
    if ((env && pair.environment.id !== env) || (workload && pair.workload.id !== workload) || !pair.memory?.length) continue;
    lines.push(`${pair.environment.id} / ${pair.workload.id}`,
      `  ${pad('after', 26)} ${MEMORY_COLUMNS.map(([, name]) => pad(name, 8)).join(' ')} | ${OWNER_PARTS.map(([, name]) => pad(name, 8)).join(' ')}`);
    for (const point of pair.memory) {
      lines.push(`  ${pad(point.after.slice(0, 26), 26)} ${MEMORY_COLUMNS.map(([key]) => cell(point[key])).join(' ')} | ${OWNER_PARTS.map(([key]) => cell(point.owners?.[key])).join(' ')}`);
    }
    const chosen = after ? pair.memory.find(point => point.after === after) : pair.memory.at(-1);
    if (detail && chosen?.owners) {
      lines.push('', `  After ${chosen.after}, by owner:`);
      for (const [part] of OWNER_PARTS) {
        const rows = chosen.owners.rows?.[part];
        if (chosen.owners[part] === undefined) continue;
        lines.push(`    ${pad(part, 24)} ${cell(chosen.owners[part])}`);
        for (const row of rows ?? []) lines.push(`      ${pad(`${row.name}${row.count ? ` (${row.count})` : ''}`.slice(0, 48), 48)} ${Number.isFinite(row.mb) ? row.mb.toFixed(1) : '–'}`);
      }
      if (chosen.owners.graphics?.length) lines.push(`    in the graphics process: ${chosen.owners.graphics.map(row => `${row.name} ${row.mb} (${row.count})`).join(', ')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
