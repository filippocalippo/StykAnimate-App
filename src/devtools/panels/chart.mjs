/**
 * The frame chart, drawn on a canvas (developer build only): the display frames of a stretch, newest at the right,
 * one column per frame (or per bucket of frames, the worst of each, when there are more frames than columns).
 *
 *   - the frame's interval is the pale column behind: how long this picture stayed on screen;
 *   - in front, the interface thread's work in that frame stacked by phase: input handlers, then script (the app's
 *     paint and interface updates), then the browser's rendering;
 *   - a dashed line marks the display's period (the budget), a dotted one the late limit (one and a half periods).
 * A late frame's interval column turns the late colour and gets a cap: a triangle over the column, so it reads without
 * colour too. A frame taller than the chart is cut at its top, and its cap says so.
 *
 * The performance tab draws it large, the overlay in miniature (`mini`: no labels, narrower columns).
 */
import {PHASES} from '../frames.mjs';

/** The chart's top in milliseconds: three periods, and never less than 25 ms (a 60 Hz chart then shows 50 ms). */
export const chartTop = periodMs => Math.max(periodMs * 3, 25);

/**
 * Draws `series` (frames.mjs `frameSeries`: interval and phases per column, oldest first) into `context` of
 * `width` × `height` CSS pixels. `colours` is style.mjs `palette`. Options: `periodMs`, `columnWidth` (px per column),
 * `mini`, `hover` and `selected` (column indices to mark), `labels` ({left, right}: the time under each end).
 * Returns the layout for hit tests: {columns, columnWidth, left, columnAt(x)}.
 */
export function drawFrameChart(context, width, height, series, colours, {periodMs, columnWidth = 3, mini = false, hover = -1, selected = -1, labels = null} = {}) {
  const count = series.interval.length, bottom = mini ? height : height - 12, top = chartTop(periodMs);
  const y = ms => bottom - Math.min(1, ms / top) * (bottom - (mini ? 2 : 10));
  const columns = Math.max(1, Math.floor(width / columnWidth)), shown = Math.min(count, columns), first = count - shown;
  const left = width - shown * columnWidth, bar = Math.max(1, columnWidth - (columnWidth > 2 ? 1 : 0)), late = periodMs * 1.5;
  for (let column = 0; column < shown; column++) {
    const index = first + column, x = left + column * columnWidth, interval = series.interval[index];
    if (index === hover || index === selected) { context.fillStyle = colours.line; context.globalAlpha = index === selected ? .9 : .5; context.fillRect(x - (columnWidth > 2 ? .5 : 0), 0, columnWidth, bottom); context.globalAlpha = 1; }
    const isLate = interval > late;
    context.fillStyle = isLate ? colours.late : colours.line;
    context.globalAlpha = isLate ? .38 : .7;
    context.fillRect(x, y(interval), bar, bottom - y(interval));
    context.globalAlpha = 1;
    let below = 0;
    for (const phase of PHASES) {
      const ms = series[phase][index];
      if (!(ms > 0)) continue;
      const from = y(below), to = y(below + ms);
      context.fillStyle = colours[phase];
      context.fillRect(x, to, bar, Math.max(mini ? .5 : 1, from - to));
      below += ms;
    }
    if (isLate) {
      // The cap: a triangle over a late column, at the column's top or at the chart's top when it was cut.
      const capY = Math.max(mini ? 3 : 4, y(interval) - 1), size = Math.max(2, Math.min(4, columnWidth + 1));
      context.fillStyle = colours.late;
      context.beginPath(); context.moveTo(x + bar / 2 - size, capY - size); context.lineTo(x + bar / 2 + size, capY - size); context.lineTo(x + bar / 2, capY); context.closePath(); context.fill();
    }
  }
  // The budget and the late limit, over the bars.
  context.lineWidth = 1;
  // The period's label at the left, the late limit's at the right: at a high refresh rate the two lines are close.
  for (const [ms, dash, colour, label, right] of [[periodMs, [4, 3], colours.dim, `${periodMs.toFixed(1)} ms period`, false], [late, [1, 2], colours.late, `late > ${late.toFixed(1)} ms`, true]]) {
    const lineY = Math.round(y(ms)) + .5;
    context.strokeStyle = colour; context.setLineDash(dash);
    context.beginPath(); context.moveTo(0, lineY); context.lineTo(width, lineY); context.stroke();
    if (!mini) {
      context.fillStyle = colour; context.font = `10px ${colours.mono}`;
      context.fillText(label, right ? width - context.measureText(label).width - 3 : 3, lineY - 3);
    }
  }
  context.setLineDash([]);
  if (!mini) {
    context.fillStyle = colours.dim; context.font = `10px ${colours.mono}`;
    const topLabel = `${Math.round(top)} ms`;
    context.fillText(topLabel, width - context.measureText(topLabel).width - 3, 10);
    if (labels) {
      context.fillText(labels.left, Math.max(2, left), height - 2);
      context.fillText(labels.right, width - context.measureText(labels.right).width - 2, height - 2);
    }
  }
  return {columns, columnWidth, left, first, shown, columnAt: x => (x < left ? -1 : Math.min(count - 1, first + Math.floor((x - left) / columnWidth)))};
}

/** A small line of `values` (oldest first; NaN is a gap) filling `width` × `height`, scaled from 0 to the most seen. */
export function drawSparkline(context, width, height, values, colour) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return;
  const most = Math.max(...finite) || 1, step = width / Math.max(1, values.length - 1);
  context.strokeStyle = colour; context.lineWidth = 1.25;
  context.beginPath();
  let open = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) { open = false; return; }
    const x = index * step, yValue = height - 1 - (value / most) * (height - 3);
    if (open) context.lineTo(x, yValue); else context.moveTo(x, yValue);
    open = true;
  });
  context.stroke();
}
