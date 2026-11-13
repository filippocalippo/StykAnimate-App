// The page's charts, drawn as SVG at the width of their box (dom.mjs `chart`). Each has a hover and keyboard readout,
// and every value it draws is also in a table nearby: a tooltip adds, it never hides a number.
//
// Marks follow one style: thin bars and 2 px lines, 8 px markers ringed in the surface colour, hairline grids, colours
// by role (`c1`…`c4` categorical, `st-*` grades) from the page's tokens, so both themes come from the stylesheet.
import {chart, h, hideTip, ms, number, s, showTip} from './dom.mjs';
import {glyph} from './grades.mjs';

/** A round axis from 0 to at least `top`: its end and its ticks. */
export function axis(top, count = 4) {
  const raw = Math.max(top, 1e-9) / count, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * power).find(candidate => candidate >= raw * .999);
  const max = Math.ceil(top / step - 1e-9) * step || step;
  return {max, ticks: Array.from({length: Math.round(max / step) + 1}, (_, index) => Number((index * step).toPrecision(12)))};
}
const tick = value => (Math.abs(value) >= 10000 ? `${number(value / 1000, 0)}K` : number(value, 2));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Horizontal gridlines and their labels for a value axis. */
function grid(ticks, y, left, right, unit) {
  return s('g', {class: 'grid'}, ticks.map(value => s('g', {},
    s('line', {x1: left, x2: right, y1: y(value), y2: y(value)}),
    s('text', {x: left - 6, y: y(value), dy: '0.32em', 'text-anchor': 'end'}, `${tick(value)}${value === ticks.at(-1) && unit ? ` ${unit}` : ''}`))));
}

/**
 * Pointer and keyboard readout over a plot: `pick(x)` turns a position into an index, `show(index)` returns
 * {x, title, rows} for the crosshair and the tooltip. Arrow keys step through the indexes when the chart has focus.
 */
function readout(svg, {left, top, width, height, count, pick, show}) {
  const line = s('line', {class: 'crosshair', y1: top, y2: top + height, visibility: 'hidden'});
  const hit = s('rect', {class: 'hit', x: left, y: top, width, height});
  let current = 0;
  const reveal = (index, clientX, clientY) => {
    current = clamp(index, 0, count - 1);
    const shown = show(current);
    line.setAttribute('x1', shown.x); line.setAttribute('x2', shown.x); line.setAttribute('visibility', 'visible');
    if (clientX === undefined) { const box = svg.getBoundingClientRect(); clientX = box.left + shown.x; clientY = box.top + top; }
    showTip(clientX, clientY, shown.title, shown.rows);
  };
  const conceal = () => { line.setAttribute('visibility', 'hidden'); hideTip(); };
  hit.addEventListener('pointermove', event => { const box = svg.getBoundingClientRect(); reveal(pick(event.clientX - box.left), event.clientX, event.clientY); });
  hit.addEventListener('pointerleave', conceal);
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('focus', () => reveal(current));
  svg.addEventListener('blur', conceal);
  svg.addEventListener('keydown', event => {
    const steps = {ArrowRight: 1, ArrowLeft: -1, PageDown: 10, PageUp: -10, Home: -Infinity, End: Infinity};
    if (!(event.key in steps)) return;
    event.preventDefault();
    reveal(clamp(current + steps[event.key], 0, count - 1));
  });
  svg.append(line, hit);
}

/**
 * The frames of a pass: per frame its interval (a grey column) and the interface thread's work stacked by phase
 * inside it, against the display's period and the 16.7 and 33.3 ms lines (60 and 30 frames a second). `phases` are
 * [{key, title}] of the series' work arrays. A few very long frames would flatten the rest, so past 120 ms the axis
 * stops near the typical frames and the chart says what goes beyond it.
 *
 * Both are drawn as the recorder keeps them (src/devtools/early.js): a frame's interval is the time since the frame
 * before, while its script and rendering run after it starts, so a heavy frame's cost shows as a long interval on the
 * next column. The note under the chart says so.
 */
export function frameChart(series, {periodMs, phases}) {
  const count = series.interval.length;
  const totals = series.interval.map((interval, index) => Math.max(interval ?? 0, phases.reduce((sum, phase) => sum + (series[phase.key][index] ?? 0), 0)));
  const ascending = [...totals].sort((a, b) => a - b), highest = ascending.at(-1) ?? 0;
  const cap = highest <= 120 ? highest : Math.min(highest, Math.max(ascending[Math.floor(ascending.length * .98)] * 1.3, 60));
  const {max, ticks} = axis(Math.max(cap, 36));
  const beyond = totals.filter(value => value > max);
  const frameName = index => (series.bucket > 1 ? `Frames ${index * series.bucket + 1}–${Math.min((index + 1) * series.bucket, count * series.bucket)} (the longest)` : `Frame ${index + 1}`);
  const box = chart('frames', width => {
    const height = 230, left = 46, right = width < 520 ? 70 : 104, top = 12, bottom = 22;
    const plotWidth = Math.max(40, width - left - right), plotHeight = height - top - bottom, base = top + plotHeight;
    const y = value => base - Math.min(Math.max(value, 0), max) / max * plotHeight;
    const step = plotWidth / count, bar = Math.max(step - (step >= 4 ? 1 : 0), .7);
    const columns = (values, from = () => 0) => values.map((value, index) => {
      if (!(value > 0)) return '';
      const start = from(index), x = left + index * step;
      return `M${x.toFixed(1)} ${y(start + value).toFixed(1)}h${bar.toFixed(2)}V${y(start).toFixed(1)}h${(-bar).toFixed(2)}Z`;
    }).join('');
    const svg = s('svg', {width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Frame chart: ${count} points; the table below lists them.`});
    svg.append(grid(ticks, y, left, left + plotWidth, 'ms'));
    svg.append(s('path', {class: 'frame-bar', d: columns(series.interval)}));
    const below = new Array(count).fill(0);
    phases.forEach((phase, slot) => {
      const values = series[phase.key];
      svg.append(s('path', {class: `bar c${slot + 1}`, d: columns(values, index => below[index])}));
      values.forEach((value, index) => { below[index] += value > 0 ? value : 0; });
    });
    // Frames past the axis: a mark at the top of each.
    svg.append(s('path', {class: 'clipped', d: totals.map((value, index) => (value > max ? `M${(left + index * step + bar / 2 - 3).toFixed(1)} ${top - 1}h6l-3 5Z` : '')).join('')}));
    // The reference lines, labelled in the right margin; labels that would touch move apart.
    const lines = [{value: periodMs, label: `display ${number(periodMs, 1)} ms`, cls: 'ref period'}, {value: 1000 / 60, label: '16.7 ms · 60/s', cls: 'ref'}, {value: 1000 / 30, label: '33.3 ms · 30/s', cls: 'ref'}]
      .filter(line => Number.isFinite(line.value) && line.value <= max).sort((a, b) => a.value - b.value);
    if (lines.length > 1 && Math.abs(lines[0].value - lines[1].value) < .6) { lines[1].label = `${lines[1].label} · display`; lines.shift(); }
    let previous = Infinity;
    for (const line of lines) {
      const at = y(line.value), labelAt = Math.min(at, previous - 11);
      previous = labelAt;
      svg.append(s('line', {class: line.cls, x1: left, x2: left + plotWidth + 4, y1: at, y2: at}),
        s('text', {class: 'ref-label', x: left + plotWidth + 6, y: labelAt, dy: '0.32em'}, line.label));
    }
    svg.append(s('line', {class: 'baseline', x1: left, x2: left + plotWidth, y1: base, y2: base}),
      s('text', {class: 'axis-label', x: left, y: height - 6}, series.bucket > 1 ? `1 to ${count * series.bucket} (each point the longest of ${series.bucket})` : `frame 1 to ${count}`));
    readout(svg, {left, top, width: plotWidth, height: plotHeight, count, pick: x => Math.floor((x - left) / step),
      show: index => ({x: left + index * step + bar / 2, title: frameName(index), rows: [
        {value: ms(series.interval[index]), label: 'interval', swatch: 'frame-key'},
        ...phases.map((phase, slot) => ({value: ms(series[phase.key][index]), label: phase.title, swatch: `c${slot + 1}`})),
      ]})});
    return svg;
  });
  return h('div', {class: 'chart-block'},
    legend([{label: 'Frame interval', swatch: 'frame-key'}, ...phases.map((phase, slot) => ({label: phase.title, swatch: `c${slot + 1}`}))]),
    box,
    h('p', {class: 'chart-note'}, "A column's interval is the time since the frame before; its script and rendering run after the frame starts, so a heavy frame lengthens the next interval."
      + (beyond.length ? ` ${beyond.length} point${beyond.length === 1 ? '' : 's'} go past the top of the axis (marked); the longest is ${ms(Math.max(...beyond))}.` : '')));
}

/** A legend: a key per series, in the order the marks are drawn. `line` keys a line, else a block. */
export const legend = items => h('ul', {class: 'legend'}, items.map(item => h('li', {}, h('span', {class: `key ${item.line ? 'line ' : ''}${item.swatch}`}), item.label)));

/**
 * Lines over categories (`labels` along x), one per series {name, values, slot}: memory along a run, a cost against
 * the size of the scene. `text` writes a value. Markers on every point while there are few; names at the line ends
 * when they do not touch, else the legend above carries them.
 */
export function lineChart({labels, series, text, height = 200, xTitle = ''}) {
  const values = series.flatMap(line => line.values).filter(Number.isFinite);
  const {max, ticks} = axis(Math.max(...values, 1e-6));
  return chart('lines', width => {
    const ends = width >= 420, left = 52, right = ends ? 104 : 14, top = 10;
    const plotWidth = Math.max(40, width - left - right);
    const flat = plotWidth / Math.max(labels.length, 1) >= 72, bottom = (flat ? 22 : 74) + (xTitle ? 14 : 0), plotHeight = height - top - bottom;
    const x = index => left + (labels.length === 1 ? plotWidth / 2 : index * plotWidth / (labels.length - 1));
    const y = value => top + plotHeight - value / max * plotHeight;
    const svg = s('svg', {width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Line chart of ${series.map(line => line.name).join(', ')}`});
    svg.append(grid(ticks, y, left, left + plotWidth));
    labels.forEach((label, index) => {
      const shown = String(label).length > 18 ? `${String(label).slice(0, 17)}…` : String(label);
      svg.append(flat ? s('text', {class: 'x-label', x: x(index), y: top + plotHeight + 15, 'text-anchor': 'middle'}, shown)
        : s('text', {class: 'x-label', 'text-anchor': 'end', transform: `translate(${x(index) + 3} ${top + plotHeight + 10}) rotate(-38)`}, shown));
    });
    if (xTitle) svg.append(s('text', {class: 'axis-label', x: left + plotWidth / 2, y: height - 3, 'text-anchor': 'middle'}, xTitle));
    svg.append(s('line', {class: 'baseline', x1: left, x2: left + plotWidth, y1: top + plotHeight, y2: top + plotHeight}));
    for (const line of series) {
      const points = line.values.map((value, index) => (Number.isFinite(value) ? [x(index), y(value)] : null));
      const d = points.map((point, index) => (point ? `${index && points[index - 1] ? 'L' : 'M'}${point[0].toFixed(1)} ${point[1].toFixed(1)}` : '')).join('');
      svg.append(s('path', {class: `line c${line.slot}`, d}));
      if (labels.length <= 24) svg.append(s('g', {class: `dots c${line.slot}`}, points.filter(Boolean).map(([cx, cy]) => s('circle', {cx, cy, r: 4}))));
    }
    // Names at the line ends, only when no two would touch.
    const lastPoints = series.map(line => ({line, at: [...line.values].reverse().find(Number.isFinite)})).filter(item => item.at !== undefined).map(item => ({...item, y: y(item.at)})).sort((a, b) => a.y - b.y);
    if (ends && lastPoints.every((item, index) => !index || item.y - lastPoints[index - 1].y >= 12)) {
      for (const item of lastPoints) svg.append(s('text', {class: 'end-label', x: left + plotWidth + 8, y: item.y, dy: '0.32em'}, item.line.name));
    }
    readout(svg, {left: left - 8, top, width: plotWidth + 16, height: plotHeight, count: labels.length,
      pick: px => Math.round((px - left) / (labels.length === 1 ? 1 : plotWidth / (labels.length - 1))),
      show: index => ({x: x(index), title: String(labels[index]), rows: series.map(line => ({value: text(line.values[index]), label: line.name, swatch: `c${line.slot}`}))})});
    return svg;
  });
}

/**
 * One value per row with its spread: a marker at the median (shaped by the row's grade when the metric is judged),
 * a line from the least to the most, and behind them the grade bands of the criterion (`bands`: [{from, to, status}]).
 * Rows without a value say why (`note`); the row of the pair on show (`current`) is in bold.
 */
export function dotPlot({rows, bands = null, text}) {
  const values = rows.flatMap(row => [row.max, row.median]).filter(Number.isFinite);
  const bandEdges = (bands ?? []).flatMap(band => [band.from, band.to]).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  // The axis reaches the values and at least the first limit, so a reader sees where good ends.
  const {max, ticks} = axis(Math.max(...values, bandEdges[0] ? bandEdges[0] * 1.15 : 0, 1e-6) * 1.05);
  return chart('dots', width => {
    const labelWidth = Math.min(200, Math.round(width * .36)), valueWidth = 78, left = labelWidth + 8, right = valueWidth, rowHeight = 30, top = bands ? 18 : 6, bottom = 22;
    const plotWidth = Math.max(40, width - left - right), height = top + rows.length * rowHeight + bottom;
    const x = value => left + Math.min(Math.max(value, 0), max) / max * plotWidth;
    const svg = s('svg', {width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Each pair\'s value with its spread; the table below lists them.'});
    for (const band of bands ?? []) {
      const from = x(band.from ?? 0), to = x(Math.min(band.to ?? max, max));
      if (to - from < .5) continue;
      svg.append(s('rect', {class: `wash st-${band.status}`, x: from, y: top, width: to - from, height: rows.length * rowHeight}));
      if (band.to !== null && band.to < max) svg.append(s('text', {class: 'band-label', x: to, y: top - 5, 'text-anchor': 'middle'}, tick(band.to)));
    }
    ticks.forEach(value => svg.append(s('text', {class: 'x-label', x: x(value), y: height - 6, 'text-anchor': 'middle'}, tick(value))));
    svg.append(s('line', {class: 'baseline', x1: left, x2: left + plotWidth, y1: top + rows.length * rowHeight, y2: top + rows.length * rowHeight}));
    rows.forEach((row, index) => {
      const middle = top + index * rowHeight + rowHeight / 2;
      const group = s('g', {class: `dot-row${row.current ? ' current' : ''}`});
      group.append(s('text', {class: 'row-label', x: 0, y: middle, dy: '0.32em'}, row.label.length > labelWidth / 6.4 ? `${row.label.slice(0, Math.floor(labelWidth / 6.4) - 1)}…` : row.label));
      if (Number.isFinite(row.median)) {
        if (Number.isFinite(row.min) && Number.isFinite(row.max) && row.max > row.min) group.append(s('line', {class: 'whisker', x1: x(row.min), x2: x(row.max), y1: middle, y2: middle}));
        const marker = row.status ? glyph(row.status) : s('svg', {class: 'glyph', viewBox: '0 0 10 10', width: 10, height: 10}, s('circle', {cx: 5, cy: 5, r: 4.2, class: 'c1'}));
        marker.setAttribute('x', x(row.median) - 5); marker.setAttribute('y', middle - 5);
        group.append(s('circle', {class: 'ring', cx: x(row.median), cy: middle, r: 7}), marker,
          s('text', {class: 'row-value', x: width - 2, y: middle, dy: '0.32em', 'text-anchor': 'end'}, text(row.median)));
      } else group.append(s('text', {class: 'row-note', x: left, y: middle, dy: '0.32em'}, row.note ?? 'not measured'));
      const hit = s('rect', {class: 'hit', x: 0, y: middle - rowHeight / 2, width, height: rowHeight});
      hit.addEventListener('pointermove', event => showTip(event.clientX, event.clientY, row.label, Number.isFinite(row.median)
        ? [{value: text(row.median), label: 'median'}, {value: `${text(row.min)} to ${text(row.max)}`, label: `least to most, ${row.passes ?? '?'} passes`}] : [{value: row.note ?? 'not measured', label: ''}]));
      hit.addEventListener('pointerleave', hideTip);
      group.append(hit);
      svg.append(group);
    });
    return svg;
  });
}

/**
 * Steps in time, each a bar from its start for its length (the launch of the app). `max` puts several on one scale.
 */
export function timeline(steps, {max = Math.max(...steps.map(step => step.startMs + step.ms))} = {}) {
  const {max: end, ticks} = axis(max, 5);
  return chart('timeline', width => {
    const labelWidth = Math.min(190, Math.round(width * .34)), left = labelWidth + 8, right = 64, rowHeight = 22, top = 4, bottom = 22;
    const plotWidth = Math.max(40, width - left - right), height = top + steps.length * rowHeight + bottom;
    const x = value => left + value / end * plotWidth;
    const svg = s('svg', {width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': steps.map(step => `${step.name} from ${Math.round(step.startMs)} ms for ${Math.round(step.ms)} ms`).join('; ')});
    ticks.forEach(value => svg.append(s('line', {class: 'grid-v', x1: x(value), x2: x(value), y1: top, y2: top + steps.length * rowHeight}),
      s('text', {class: 'x-label', x: x(value), y: height - 6, 'text-anchor': 'middle'}, `${tick(value)}${value === ticks.at(-1) ? ' ms' : ''}`)));
    steps.forEach((step, index) => {
      const middle = top + index * rowHeight + rowHeight / 2, from = x(step.startMs), length = Math.max(step.ms / end * plotWidth, 1.5);
      svg.append(s('text', {class: 'row-label', x: 0, y: middle, dy: '0.32em'}, step.name),
        s('rect', {class: 'bar c1', x: from, y: middle - 6, width: length, height: 12, rx: 2}),
        s('text', {class: 'row-value', x: from + length + 5, y: middle, dy: '0.32em'}, ms(step.ms, step.ms < 10 ? 1 : 0)));
    });
    return svg;
  });
}

/**
 * Where a value sits against a criterion's limits: the four grade bands and a mark at the value. Drawn small beside
 * the text that states the same numbers, so it is hidden from screen readers.
 */
export function bullet(value, limits, better = 'lower', width = 150) {
  const higher = better === 'higher';
  const end = higher ? Math.max(limits[0] * 1.04, value * 1.02) : Math.max(limits[2] * 1.1, value * 1.05);
  const edges = higher ? [0, limits[2], limits[1], limits[0], end] : [0, limits[0], limits[1], limits[2], end];
  const grades = higher ? ['bad', 'poor', 'fair', 'good'] : ['good', 'fair', 'poor', 'bad'];
  const x = at => Math.min(at, end) / end * width;
  return s('svg', {class: 'bullet', width, height: 14, viewBox: `0 0 ${width} 14`, 'aria-hidden': 'true'},
    grades.map((grade, index) => s('rect', {class: `wash st-${grade}`, x: x(edges[index]), y: 2, width: Math.max(0, x(edges[index + 1]) - x(edges[index])), height: 10})),
    Number.isFinite(value) ? s('rect', {class: 'mark', x: clamp(x(value) - 1, 0, width - 2), y: 0, width: 2, height: 14}) : null);
}

/** Horizontal bars with labels and values: shares of a whole, ranked. `rows` [{label, value, text, slot}]. */
export function bars(rows, {max = Math.max(...rows.map(row => row.value), 1e-9)} = {}) {
  return h('div', {class: 'bars'}, rows.map(row => h('div', {class: 'bars-row'},
    h('span', {class: 'bars-label'}, row.label),
    h('span', {class: 'bars-track'}, h('span', {class: `bars-fill c${row.slot ?? 1}`, style: `width:${clamp(row.value / max * 100, 0, 100).toFixed(2)}%`})),
    h('span', {class: 'bars-value'}, row.text))));
}

/** One whole split into parts (a thread's time by layer), coloured by `slot`; hover names each part. */
export function stack(parts, total) {
  return h('div', {class: 'stack', 'aria-hidden': 'true'}, parts.filter(part => part.value > 0).map(part => {
    const piece = h('span', {class: `stack-part c${part.slot}`, style: `flex-basis:${(part.value / total * 100).toFixed(3)}%`});
    piece.addEventListener('pointermove', event => showTip(event.clientX, event.clientY, part.label, [{value: part.text, label: part.sub ?? ''}]));
    piece.addEventListener('pointerleave', hideTip);
    return piece;
  }));
}
