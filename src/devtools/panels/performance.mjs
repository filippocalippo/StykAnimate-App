/**
 * The Performance tab (developer build only; docs/DEVTOOLS.md "Panels"): where a frame's time goes, live while a
 * person uses the app, or frozen on a stretch the recording holds (Record, Last 5 s).
 *
 *   Frames        the frame chart (chart.mjs); a column under the pointer, or clicked, shows that frame's numbers and
 *                 the spans that began in it;
 *   Now           frames per second, the frame time a person sees, late frames, interface work per frame, input
 *                 delay, paints per second; a held stretch adds its grade against the limits (grades.mjs);
 *   Interface     the heaviest span groups (interface updates by surface, input handlers by target, paint, stage draw);
 *   Engine calls  the heaviest calls into the engine (boundary.mjs);
 *   Engine        frames its threads prepared and the time of one, queues, the frame cache;
 *   Memory        JavaScript, the engine's memory in use and reserved, the stage's GPU memory, each with its history.
 *
 * Every number is the runtime's summary of the stretch (`runtime.summarize`, capture.mjs `analyze`), the sampler's
 * reads or the boundary meter's: the tab only lays them out. Live, the chart redraws four times a second and the rest
 * twice; nothing is rebuilt, only text, bar transforms and canvases change.
 */
import {recentEvents, summarize} from '../capture.mjs';
import {frameBounds, frameSeries, PHASES} from '../frames.mjs';
import {grade, LIMITS} from '../grades.mjs';
import {drawFrameChart, drawSparkline} from './chart.mjs';
import {element, format, megabytes, milliseconds, percent, rankedList, setText, sizedCanvas, tile} from './dom.mjs';
import {steadyOrder} from './rank.mjs';
import {recordingBar} from './recording.mjs';
import {palette} from './style.mjs';

/** The live view's stretches (ms): the chart shows the last three seconds, the numbers and the lists the last two. */
const CHART_MS = 3000, LIVE_MS = 2000;
const PHASE_NAMES = {handlers: 'input handlers', script: 'script', render: 'rendering'};
/** Spans shown elsewhere or wrapping others: the engine's calls have their own list, an animation frame holds the paint and the updates. */
const ownSpan = row => (row.thread === 'interface' || row.thread === 'tasks') && row.name !== 'animation frame' && !row.name.startsWith('engine ') && !row.name.startsWith('edit session call');
/** The counters a held stretch's memory lines are drawn from (sampler.mjs `SAMPLED`), in megabytes. */
const MEMORY = [
  {key: 'jsHeapBytes', counter: 'memory jsHeap MB', label: 'JavaScript heap', title: 'The page\'s JavaScript objects (the interface, the read view)'},
  {key: 'engineLiveBytes', counter: 'memory engine live MB', label: 'Engine in use', title: 'What the engine\'s allocator has handed out now'},
  {key: 'engineHeapBytes', counter: 'memory engine heap MB', label: 'Engine reserved', title: 'The engine\'s linear memory: it grows to what was needed at once and never shrinks'},
  {key: 'gpuBytes', counter: 'memory gpu MB', label: 'GPU (stage)', title: 'What the stage holds on the graphics card: targets, layers, effects, glyphs'},
];

export function createPerformanceTab({runtime, recording, panel}) {
  const {early, sampler} = runtime;
  const bar = recordingBar(recording);
  const section = (title, ...children) => {
    const note = element('span');
    return {note, element: element('section', {className: 'dt-section'}, element('h3', {}, title, note), ...children)};
  };

  // --- frames ------------------------------------------------------------------------------------------------------
  /** What the chart shows: {window, periodMs, frozen, origin}; `layout` is the last drawing's, for hit tests. */
  let view = null, layout = null, series = null, hover = -1, selected = null;
  const chart = sizedCanvas('dt-frames', (context, width, height) => {
    if (!view?.window) return;
    const columnWidth = 3;
    series = frameSeries(view.window, Math.max(1, Math.floor(width / columnWidth)), {indices: true});
    const position = selected ? series.index.findIndex(index => view.window.at[index] === selected.at) : -1;
    const oldest = series.index.length ? view.window.at[series.index[0]] : null;
    layout = drawFrameChart(context, width, height, series, palette(panel), {periodMs: view.periodMs, columnWidth, hover, selected: position,
      labels: oldest === null ? null : view.frozen ? {left: '0 s', right: `${format((view.window.at.at(-1) - view.origin) / 1000, 1)} s`} : {left: `${format((oldest - view.origin) / 1000, 1)} s`, right: 'now'}});
  });
  const legendValues = Object.fromEntries(PHASES.map(phase => [phase, element('span')]));
  const swatch = name => element('i', {style: `background: var(--dt-${name})`});
  const legend = element('div', {className: 'dt-legend'},
    ...PHASES.map(phase => element('span', {}, swatch(phase), `${PHASE_NAMES[phase]} `, legendValues[phase])),
    element('span', {}, element('i', {style: 'background: var(--dt-line)'}), 'time on screen'),
    element('span', {}, element('i', {style: 'background: var(--dt-late)'}), '▼ late (over 1.5 periods)'));
  const detail = element('div', {className: 'dt-frame-detail dt-dim', textContent: 'Point at a frame for its numbers; click to keep it.'});
  const frames = section('Frames', chart.canvas, legend, detail);

  /** The frame under column `position` of the chart, described: when, its interval and phases, the spans that began in it. */
  const describe = position => {
    const index = series?.index[position];
    if (index === undefined || !view) return null;
    const window = view.window, at = window.at[index], {from, to} = frameBounds(window, index);
    const events = view.frozen ? recording.state.taken.events.filter(event => event.start >= from && event.start <= to) : recentEvents(early.ring, from, to);
    const spans = summarize(events).spans.filter(row => row.name !== 'animation frame').slice(0, 6);
    const work = window.handlers[index] + window.script[index] + window.render[index], late = window.interval[index] > view.periodMs * 1.5;
    const when = view.frozen ? `at ${format((at - view.origin) / 1000, 2)} s` : `${format((performance.now() - at) / 1000, 2)} s ago`;
    return {at, text: `Frame ${when}: on screen ${milliseconds(window.interval[index], 2)}${late ? ' (LATE)' : ''}; interface work ${milliseconds(work, 2)} = `
      + `${PHASES.map(phase => `${PHASE_NAMES[phase]} ${format(window[phase][index], 2)}`).join(' + ')}${series.bucket > 1 ? ` (the slowest of ${series.bucket} frames)` : ''}\n`
      + (spans.length ? spans.map(row => `${row.thread === 'interface' ? '' : `[${row.thread}] `}${row.name}${row.count > 1 ? ` ×${row.count}` : ''} ${format(row.totalMs, 2)}`).join(' · ') : 'No span began in it.')};
  };
  const showDetail = () => {
    const shown = hover >= 0 ? describe(hover) : selected;
    setText(detail, shown?.text ?? 'Point at a frame for its numbers; click to keep it.');
  };
  chart.canvas.onpointermove = event => { hover = layout?.columnAt(event.offsetX) ?? -1; showDetail(); chart.redraw(); };
  chart.canvas.onpointerleave = () => { hover = -1; showDetail(); chart.redraw(); };
  chart.canvas.onclick = event => {
    const position = layout?.columnAt(event.offsetX) ?? -1, found = position >= 0 ? describe(position) : null;
    selected = found && found.at !== selected?.at ? found : null;
    showDetail(); chart.redraw();
  };

  // --- the numbers -------------------------------------------------------------------------------------------------
  const tiles = {
    fps: tile('Frames per second', 'Display frames a second; the display\'s own rate is under it'),
    felt: tile('Frame time seen', 'Each frame weighted by how long it stayed on screen: what a person sees. Graded against 16.7, 33.3 and 100 ms'),
    late: tile('Late frames', 'Frames that took over one and a half display periods'),
    work: tile('Interface work / frame', 'What the interface thread spent on a frame: input handlers, script and rendering'),
    input: tile('Input delay', 'From an input to the end of the frame that showed it. Graded on the p95 against 34, 67 and 150 ms'),
    paints: tile('Paints per second', 'The app\'s paint of the stage (src/app.mjs loop)'),
  };
  const verdict = element('div', {className: 'dt-verdict', hidden: true});
  const now = section('Now', verdict, element('div', {className: 'dt-tiles'}, ...Object.values(tiles).map(item => item.element)));

  // --- the lists ---------------------------------------------------------------------------------------------------
  const spans = rankedList(['Span', 'ms/s', 'n/s', 'p95', 'max'], {empty: 'No interface span in this stretch.',
    titles: ['The bar is its milliseconds per second against the heaviest', 'Milliseconds of each second spent in it (inclusive of what it called)', 'Times a second', '95th percentile of one, ms', 'The longest one, ms']});
  const calls = rankedList(['Call', 'calls', 'ms', 'max'], {limit: 8, empty: 'No call into the engine in this stretch (or the engine is not loaded).',
    titles: ['The bar is its total against the heaviest', 'Calls in the stretch', 'Milliseconds inside the engine in all', 'The longest call, ms']});
  const interfaceSection = section('Where the interface\'s time goes', spans.element);
  const boundarySection = section('Calls into the engine', calls.element);
  let spanOrder = [], callOrder = [];

  // --- engine and memory -------------------------------------------------------------------------------------------
  const engineTiles = {
    prepared: tile('Frames prepared', 'Frames the engine\'s threads prepared, and the mean time of one'),
    inline: tile('Prepared here', 'Frames prepared on the interface thread because no engine thread had them ready'),
    pending: tile('Pictures pending', 'Pictures waiting to be decoded or uploaded'),
    cache: tile('Frame cache', 'Prepared frames the engine keeps, and their memory'),
    threads: tile('Threads', 'The engine\'s preparation threads and the page\'s workers'),
  };
  const engineSection = section('Engine', element('div', {className: 'dt-tiles'}, ...Object.values(engineTiles).map(item => item.element)));
  const memory = MEMORY.map(spec => {
    const cell = tile(spec.label, spec.title);
    let values = [];
    const spark = sizedCanvas('dt-spark', (context, width, height) => drawSparkline(context, width, height, values, palette(panel).accent));
    cell.element.append(spark.canvas);
    return {...spec, cell, update(next, text, sub) { values = next; cell.update(text, sub); spark.redraw(); }};
  });
  const memorySection = section('Memory', element('div', {className: 'dt-memory'}, ...memory.map(item => item.cell.element)));

  const root = element('div', {}, bar.element, frames.element, now.element, interfaceSection.element, boundarySection.element, engineSection.element, memorySection.element);

  /** The numbers, the verdict and the lists of a summary covering `seconds`. */
  function showSummary(summary, seconds) {
    const f = summary.frames ?? {}, inputs = summary.inputs ?? {}, paint = summary.spans.find(row => row.name === 'paint');
    const period = f.periodMs ?? view?.periodMs;
    tiles.fps.update(format(f.perSecond, 1), period ? `of ${format(1000 / period, 0)} Hz (${format(period, 2)} ms)` : '');
    tiles.felt.update(milliseconds(f.felt), `p95 ${format(f.p95, 1)} · worst ${format(f.worst, 1)}`, grade(f.felt, LIMITS.frame));
    tiles.late.update(f.late === null || f.late === undefined ? '–' : `${f.late} (${percent(f.lateShare)})`, `> ${format(f.lateOverMs, 1)} ms · ${format(f.over33, 0)} > 33.3 ms`);
    tiles.work.update(milliseconds(f.work?.p95, 2), `p95 · ${percent(f.work?.budgetShare)} of period · mean ${format(f.work?.mean, 2)}`);
    tiles.input.update(inputs.count ? milliseconds(inputs.p95) : '–', inputs.count ? `p95 · p50 ${format(inputs.p50, 1)} · ${inputs.count} inputs` : 'no input in this stretch', inputs.count ? grade(inputs.p95, LIMITS.input) : null);
    tiles.paints.update(format(seconds > 0 ? (paint?.count ?? 0) / seconds : null, 1), paint ? `p95 ${format(paint.p95, 2)} ms each` : 'no paint');
    for (const phase of PHASES) setText(legendValues[phase], f.phases?.[phase] ? `${format(f.phases[phase].mean, 2)} ms` : '');
    const own = summary.spans.filter(ownSpan).map(row => ({key: row.name, value: row.totalMs / seconds, row}));
    const ranked = steadyOrder(spanOrder, own);
    spanOrder = ranked.order;
    const heaviest = Math.max(...ranked.rows.map(item => item.value), 1e-9);
    spans.update(ranked.rows.map(({value, row}) => ({name: row.name, title: `${row.name} (${row.thread})`, share: value / heaviest,
      cells: [format(value, 1), format(row.count / seconds, 1), format(row.p95, 2), format(row.worst, 2)]})));
    const boundary = (summary.boundary ?? []).map(row => ({key: row.name, value: row.totalMs, row}));
    const callsRanked = steadyOrder(callOrder, boundary, {limit: 8});
    callOrder = callsRanked.order;
    const heaviestCall = Math.max(...callsRanked.rows.map(item => item.value), 1e-9);
    calls.update(callsRanked.rows.map(({value, row}) => ({name: row.name, share: value / heaviestCall, cells: [row.calls, format(row.totalMs, 2), format(row.worstMs, 2)]})));
  }

  /** The engine's numbers: live from the sampler, or a held stretch's from its preparation and counters. */
  function showEngine(held) {
    if (held) {
      const preparation = held.summary.preparation, counters = held.summary.counters ?? {}, seconds = held.summary.ms / 1000;
      engineTiles.prepared.update(preparation ? `${format(seconds > 0 ? preparation.frames / seconds : null, 1)}/s` : '–', preparation ? `${preparation.frames} frames, ${format(preparation.msPerFrame, 2)} ms each` : 'not measured for this stretch');
      engineTiles.inline.update(format(preparation?.inline ?? null), 'in this stretch');
      engineTiles.pending.update(format(counters['engine imagesPending']?.max ?? null), 'the most at once');
      engineTiles.cache.update(format(counters['engine cachedFrames']?.last ?? null), `frames at the end · the most ${format(counters['engine cachedFrames']?.max ?? null)}`);
      engineTiles.threads.update(format(runtime.engine?.workers ?? null), `engine threads · ${format(counters['threads live']?.max ?? null)} workers at most`);
      return;
    }
    const rate = sampler.preparationRate(LIVE_MS), jobs = sampler.last?.jobs, engine = jobs?.engine;
    engineTiles.prepared.update(rate ? `${format(rate.perSecond, 1)}/s` : '–', rate ? `${format(rate.msPerFrame, 2)} ms each${engine?.busy ? ' · busy' : ''}` : engine?.busy ? 'busy: read skipped' : 'no engine');
    engineTiles.inline.update(format(rate?.inline ?? null), 'in the last 2 s');
    engineTiles.pending.update(format(engine?.imagesPending ?? null), jobs?.playback && !jobs.playback.error ? `playback ready ${format(jobs.playback.readyFrames)}` : '');
    engineTiles.cache.update(format(engine?.cachedFrames ?? null), megabytes(engine?.cachedBytes));
    engineTiles.threads.update(format(engine?.workers ?? null), `engine threads${engine?.workersLost ? `, ${engine.workersLost} lost` : ''} · ${format(jobs?.threads.live ?? null)} workers`);
  }

  /** Memory: live from the sampler's last minute, or a held stretch's counters. */
  function showMemory(held) {
    if (held) {
      for (const item of memory) {
        const values = held.taken.events.filter(event => event.duration === -2 && event.name === item.counter).map(event => event.value), counter = held.summary.counters?.[item.counter];
        item.update(values, counter ? `${format(counter.last, 1)} MB` : '–', counter ? `from ${format(counter.min, 1)} to ${format(counter.max, 1)} MB` : 'not sampled');
      }
      return;
    }
    const history = sampler.series(60000, MEMORY.map(item => item.key));
    for (const item of memory) {
      const values = history[item.key].map(bytes => bytes / 1048576), last = history[item.key].at(-1), most = Math.max(...values.filter(Number.isFinite));
      item.update(values, megabytes(last), Number.isFinite(most) ? `the most ${format(most, 1)} MB in the last minute` : 'not known');
    }
  }

  let heldShown = null, ticks = 0;
  /** The view of a held stretch, drawn once when it changes. */
  function showHeld(held) {
    heldShown = held.taken;
    spanOrder = []; callOrder = []; selected = null; hover = -1;
    const taken = held.taken, frozenWindow = taken.frames;
    view = {window: frozenWindow, periodMs: held.summary.frames?.periodMs ?? sampler.displayPeriod().periodMs, frozen: true, origin: taken.startedAt};
    setText(frames.note, `${held.source === 'recent' ? 'the last' : 'recorded'} ${format(held.summary.ms / 1000, 1)} s · ${frozenWindow?.interval.length ?? 0} frames${frozenWindow?.interval.length ? '' : ' (nothing watched the frames then)'}`);
    chart.redraw(); showDetail();
    const judged = held.judged;
    verdict.hidden = false;
    const word = element('span', {className: 'dt-grade', textContent: judged.grade ?? 'not graded'});
    word.dataset.grade = judged.grade ?? '';
    verdict.replaceChildren(word,
      judged.criteria.length ? judged.criteria.map(row => `${row.metric === 'frame.felt' ? 'frame time seen' : 'input delay p95'} ${milliseconds(row.value)} is ${row.grade} (good to ${format(row.limits[0], 1)}, fair to ${format(row.limits[1], 1)}, poor to ${format(row.limits[2], 0)} ms)`).join('; ')
        + `. The worse decides, as in a profiling run.` : 'Nothing to grade: no frames or inputs were recorded.');
    setText(now.note, 'of the held stretch');
    setText(interfaceSection.note, 'inclusive time of each span group');
    setText(boundarySection.note, 'in the held stretch');
    showSummary(held.summary, held.summary.ms / 1000);
    showEngine(held); showMemory(held);
  }

  function refresh() {
    bar.update();
    const held = recording.state;
    if (held.taken && !recording.running) { if (heldShown !== held.taken) showHeld(held); return; }
    if (heldShown) { heldShown = null; spanOrder = []; callOrder = []; selected = null; verdict.hidden = true; }
    const {periodMs, measured} = sampler.displayPeriod(), at = performance.now();
    view = {window: sampler.window(CHART_MS), periodMs, frozen: false, origin: at};
    setText(frames.note, `last ${CHART_MS / 1000} s · display ${format(1000 / periodMs, 0)} Hz${measured ? '' : ' (assumed until measured)'}`);
    chart.redraw();
    if (hover >= 0) showDetail();
    if (ticks++ % 2) return;
    setText(now.note, `last ${LIVE_MS / 1000} s`);
    setText(interfaceSection.note, `last ${LIVE_MS / 1000} s, inclusive time of each span group`);
    setText(boundarySection.note, `last ${LIVE_MS / 1000} s`);
    showSummary(runtime.summarize(runtime.recent(LIVE_MS)), LIVE_MS / 1000);
    showEngine(null); showMemory(null);
  }
  recording.onChange(() => { if (root.isConnected) refresh(); });

  return {name: 'Performance', root, refresh, interval: 250};
}
