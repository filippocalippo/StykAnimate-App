/**
 * The performance overlay (developer build only; docs/DEVTOOLS.md "Panels"), Ctrl+Shift+O: a small pill over the
 * stage's top-left corner that lets every input through, readable at a glance while dragging. It shows the frame time a
 * person sees and the input delay (each with its grade), the interface thread's work against the display's period,
 * late frames, what the engine's threads prepare, memory, and the frame chart of the last two seconds in miniature.
 *
 * It must cost almost nothing: one canvas, drawn four times a second from reads the tools already keep (the frame
 * recorder, the sampler's last sample), with no layout, in the thread's idle time after a frame (at the latest a
 * quarter of a second late), so a drawing never stands in front of the next frame. Its place is read when the stage's size changes (a resize
 * observer, after layout), never while drawing. Each drawing is a span, `devtools overlay`, so its cost is measured
 * by the same tools it shows.
 */
import {frameSeries} from '../frames.mjs';
import {grade, LIMITS} from '../grades.mjs';
import {drawFrameChart} from './chart.mjs';
import {element, format} from './dom.mjs';
import {palette} from './style.mjs';

const WIDTH = 236, HEIGHT = 112, CHART_MS = 2000, REDRAW_MS = 250;

export function createOverlay(runtime) {
  const {sampler} = runtime, trace = globalThis.__stykTrace;
  const canvas = element('canvas');
  const root = element('div', {id: 'styk-devtools-overlay', hidden: true, ariaHidden: 'true'}, canvas);
  document.body.append(root);
  let timer = 0, pending = 0;
  /** The width of one character of the overlay's font, measured once per font. */
  const glyph = {font: '', width: 0};
  const place = () => {
    const stage = document.getElementById('viewport')?.getBoundingClientRect();
    if (stage) { root.style.left = `${Math.round(stage.left + 8)}px`; root.style.top = `${Math.round(stage.top + 8)}px`; }
  };
  const observer = new ResizeObserver(place);

  /** Shows or hides the overlay; returns whether it is shown. */
  function show(visible = root.hidden) {
    if (visible === !root.hidden) return visible;
    root.hidden = !visible;
    clearInterval(timer); timer = 0; cancelIdleCallback(pending); pending = 0;
    runtime.watch(visible);
    const viewport = document.getElementById('viewport');
    if (visible) {
      if (viewport) observer.observe(viewport); else place();
      paint();
      timer = setInterval(() => { pending ||= requestIdleCallback(() => { pending = 0; paint(); }, {timeout: REDRAW_MS}); }, REDRAW_MS);
    } else observer.disconnect();
    return visible;
  }

  function paint() {
    const span = trace?.begin('devtools overlay') ?? 0;
    try { draw(); } finally { if (span) trace.end(span); }
  }

  function draw() {
    const ratio = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(WIDTH * ratio)) { canvas.width = Math.round(WIDTH * ratio); canvas.height = Math.round(HEIGHT * ratio); }
    const context = canvas.getContext('2d'), colours = palette(root);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.globalAlpha = .9; context.fillStyle = colours.bg;
    context.beginPath(); context.roundRect(0, 0, WIDTH, HEIGHT, 6); context.fill();
    context.globalAlpha = 1;

    const window = sampler.window(CHART_MS), f = sampler.frames({window}), inputs = sampler.inputs({ms: CHART_MS}), rate = sampler.preparationRate(CHART_MS), memory = sampler.last?.memory;
    const mb = bytes => (Number.isFinite(bytes) ? Math.round(bytes / 1048576) : '–');
    // Each line: [text, colour] pieces drawn one after another.
    const word = value => (value ? [` ${value.toUpperCase()}`, value === 'good' ? colours.good : value === 'fair' ? colours.fg : colours.bad] : ['', colours.fg]);
    const lines = [
      [[`seen ${format(f.felt, 1)} ms`, colours.fg], word(grade(f.felt, LIMITS.frame)), [`  ${format(f.perSecond, 0)} fps`, colours.dim],
        [`  late ${format(f.late)}`, f.late ? colours.bad : colours.dim]],
      [[`input p95 ${inputs.count ? `${format(inputs.p95, 1)} ms` : '–'}`, colours.fg], word(inputs.count ? grade(inputs.p95, LIMITS.input) : null), [inputs.count ? `  p50 ${format(inputs.p50, 1)}` : '', colours.dim]],
      [[`work p95 ${format(f.work.p95, 1)} ms`, colours.fg], [` = ${f.work.budgetShare === null ? '–' : Math.round(f.work.budgetShare * 100)}% of ${format(f.periodMs, 1)} ms`, (f.work.budgetShare ?? 0) > 1 ? colours.bad : colours.dim]],
      [[`engine ${rate ? `${format(rate.perSecond, 0)}/s` : '–'}`, colours.fg], [rate?.msPerFrame ? ` ${format(rate.msPerFrame, 1)} ms` : '', colours.dim],
        [`  js ${mb(memory?.jsHeap?.usedBytes)} eng ${mb(memory?.engine?.liveBytes)} gpu ${mb(memory?.gpuBytes)} MB`, colours.dim]],
    ];
    // A monospaced font: one measure gives every piece's width, and a drawing measures no text.
    context.font = `10.5px ${colours.mono}`;
    if (glyph.font !== context.font) Object.assign(glyph, {font: context.font, width: context.measureText('0000000000').width / 10});
    lines.forEach((pieces, row) => {
      let x = 7;
      for (const [text, colour] of pieces) { if (!text) continue; context.fillStyle = colour; context.fillText(text, x, 14 + row * 13); x += text.length * glyph.width; }
    });
    const width = WIDTH - 12, columnWidth = 2;
    context.save();
    context.translate(6, 60);
    drawFrameChart(context, width, HEIGHT - 66, frameSeries(window, Math.floor(width / columnWidth)), colours, {periodMs: f.periodMs ?? 1000 / 60, columnWidth, mini: true});
    context.restore();
  }

  return {show, element: root};
}
