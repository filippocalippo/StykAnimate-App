/**
 * The Profiler tab (developer build only; docs/DEVTOOLS.md "Panels"): the spans of the stretch the recording holds, on
 * a timeline with a lane per thread, and their statistics.
 *
 * Lanes, top to bottom: `interface` (the app's spans, nested by depth), `display` (display frames; a late one in the
 * late colour and taller), `input` (the browser's slow inputs, from input to paint), `long tasks`, `phases` (the
 * app's start, step by step), `tasks` (an open, a save), then any other thread. The wheel zooms around the pointer; a
 * click selects a span and shows its arguments, the spans like it and its children. While a capture runs, the
 * timeline shows its last five seconds.
 */
import {spanKey, summarize} from '../capture.mjs';
import {LIMITS} from '../grades.mjs';
import {element, format, sizedCanvas, table} from './dom.mjs';
import {recordingBar} from './recording.mjs';
import {palette} from './style.mjs';

const LANES = ['interface', 'display', 'input', 'long tasks', 'phases', 'tasks'];
const ROW = 7, LABEL = 11;

export function createProfilerTab({runtime, recording, panel}) {
  const bar = recordingBar(recording);
  let viewRange = {from: 0, to: 1}, selected = null, shownTaken = null, hits = [];
  const timeline = sizedCanvas('dt-timeline', (context, width, height) => drawTimeline(context, width, height));
  const detail = element('div');
  const stats = element('div');
  const root = element('div', {}, bar.element, timeline.canvas, detail, stats);

  /** The stretch to draw: the held one, or the running capture's last five seconds. */
  const current = () => recording.state.taken && !recording.running ? recording.state.taken
    : recording.running ? runtime.recent(Math.min(5000, performance.now() - recording.running.startedAt)) : null;

  timeline.canvas.onwheel = event => {
    event.preventDefault();
    const at = event.offsetX / Math.max(1, timeline.size().width), {from, to} = viewRange, span = to - from;
    const next = Math.min(1, Math.max(1e-4, span * (event.deltaY > 0 ? 1.25 : 0.8))), pivot = from + at * span;
    const start = Math.max(0, Math.min(1 - next, pivot - at * next));
    viewRange = {from: start, to: start + next};
    timeline.redraw();
  };
  timeline.canvas.onclick = event => {
    selected = hit(event.offsetX, event.offsetY);
    showSelected();
    timeline.redraw();
  };
  const hit = (x, y) => {
    for (let index = hits.length - 1; index >= 0; index--) { const [left, top, w, event] = hits[index]; if (x >= left - 1 && x <= left + w + 1 && y >= top - 1 && y <= top + ROW) return event; }
    return null;
  };

  function showSelected() {
    const taken = current();
    if (!selected || !taken) { detail.replaceChildren(); return; }
    const event = selected, key = spanKey(event), same = summarize(taken.events.filter(other => other.duration >= 0 && spanKey(other) === key)).spans[0];
    const children = taken.events.filter(other => other.thread === event.thread && other.depth === event.depth + 1 && other.start >= event.start && other.start + other.duration <= event.start + event.duration + 1e-6);
    detail.replaceChildren(element('pre', {textContent:
      `${key} on ${event.thread}: ${format(event.duration, 3)} ms at ${format(event.start - taken.startedAt, 1)} ms${event.args ? `\nargs ${JSON.stringify(event.args)}` : ''}\n`
      + `${same?.count ?? 0} like it: p50 ${format(same?.p50)} ms, worst ${format(same?.worst)} ms`
      + (children.length ? `\nchildren: ${children.map(child => `${spanKey(child)} ${format(child.duration, 3)} ms`).join(', ')}` : '')}));
  }

  /** The span table of the held stretch, built once per stretch. */
  function showStats() {
    const held = recording.state;
    shownTaken = held.taken;
    viewRange = {from: 0, to: 1}; selected = null; detail.replaceChildren();
    if (!held.summary) { stats.replaceChildren(); return; }
    const {summary, taken} = held;
    stats.replaceChildren(
      element('div', {className: 'dt-row dt-dim', textContent: `${taken.events.length} events over ${format(summary.ms / 1000, 1)} s${taken.dropped ? `, ${taken.dropped} dropped (ring full)` : ''}. `
        + `Display frames: p50 ${format(summary.frames?.p50)} ms, p95 ${format(summary.frames?.p95)} ms, worst ${format(summary.frames?.worst)} ms, ${format(summary.frames?.late)} late.`}),
      table(['Span', 'Thread', 'Count', 'Total ms', 'p50', 'p95', 'Worst'], summary.spans.slice(0, 40).map(row => [row.name, row.thread, row.count, row.totalMs, row.p50, row.p95, row.worst]), [2, 3, 4, 5, 6]));
  }

  /** Lanes per thread, spans as bars by depth, the time at each end. */
  function drawTimeline(context, width, height) {
    const taken = current(), colours = palette(panel);
    context.font = `10px ${colours.mono}`;
    if (!taken) { context.fillStyle = colours.dim; context.fillText('Record, or take the last 5 s, to see spans here.', 8, 16); hits = []; return; }
    const total = Math.max(1, taken.stoppedAt - taken.startedAt), t0 = taken.startedAt + viewRange.from * total, t1 = taken.startedAt + viewRange.to * total;
    const x = time => ((time - t0) / (t1 - t0)) * width;
    const depth = new Map();
    for (const event of taken.events) if (event.duration >= 0) depth.set(event.thread, Math.max(depth.get(event.thread) ?? 0, event.depth));
    const lanes = [...LANES.filter(lane => depth.has(lane)), ...[...depth.keys()].filter(lane => !LANES.includes(lane))];
    const tops = new Map();
    let top = 2;
    for (const lane of lanes) { tops.set(lane, top); top += LABEL + (depth.get(lane) + 1) * ROW + 3; }
    const wanted = `${Math.max(60, top + 12)}px`;
    // A change of height lays the panel out once and redraws through the resize observer.
    if (timeline.canvas.style.height !== wanted) { timeline.canvas.style.height = wanted; return; }
    const period = runtime.sampler.displayPeriod().periodMs;
    hits = [];
    for (const lane of lanes) { context.fillStyle = colours.dim; context.fillText(lane, 2, tops.get(lane) + 9); }
    for (const event of taken.events) {
      if (event.duration < 0) continue;
      const left = x(event.start), right = x(event.start + event.duration);
      if (right < 0 || left > width) continue;
      const late = (event.name === 'display frame' && event.duration > period * 1.5) || (event.thread === 'input' && event.duration > LIMITS.input[0]);
      const y = tops.get(event.thread) + LABEL + event.depth * ROW - (late ? 2 : 0), w = Math.max(1, right - left);
      context.fillStyle = event === selected ? colours.fg : late ? colours.late : event.name === 'display frame' ? colours.good : event.name === 'long task' ? colours.warn : hue(event.name);
      context.fillRect(left, y, w, ROW - 1 + (late ? 2 : 0));
      if (w > 3) hits.push([left, y, w, event]);
    }
    context.fillStyle = colours.dim;
    context.fillText(`${format(t0 - taken.startedAt, 1)} ms`, 2, height - 3);
    const end = `${format(t1 - taken.startedAt, 1)} ms`;
    context.fillText(end, width - context.measureText(end).width - 2, height - 3);
  }

  let ticks = 0;
  function refresh() {
    bar.update();
    const held = recording.state.taken && !recording.running ? recording.state.taken : null;
    if (held !== shownTaken) { showStats(); timeline.redraw(); }
    // A running capture's timeline moves; twice a second is enough to follow it.
    if (recording.running && ticks++ % 2 === 0) timeline.redraw();
  }
  recording.onChange(() => { if (root.isConnected) refresh(); });

  return {name: 'Profiler', root, refresh, interval: 250};
}

/** A stable colour per span name. */
function hue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 52%)`;
}
