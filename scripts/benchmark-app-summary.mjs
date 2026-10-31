// Medians across the runs of benchmark-app.mjs, one column per label, and a scoreboard of the performance targets.
//   node scripts/benchmark-app-summary.mjs <dir> <label> [<label> ...] [--base=<label>]
// The labels name sets of runs (`main` for the old JavaScript app, `baseline`, `now`, ...). Writes summary.json and
// summary.md next to the results. The first part is one table per file; the scoreboard follows: every target, its value
// per label on each file, whether it meets the target and whether it clears the floor against the base label
// (`main` when a label has that name, else the first). docs/performance/APP-BENCHMARK.md explains how to read it.
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const baseOption = args.find(a => a.startsWith('--base='))?.slice(7);
const [dir, ...labels] = args.filter(a => !a.startsWith('--'));
if (!dir || !labels.length) { console.error('usage: benchmark-app-summary.mjs <dir> <label> [<label> ...] [--base=<label>]'); process.exit(2); }
const base = baseOption ?? (labels.includes('main') ? 'main' : labels[0]);
const runs = readdirSync(dir).filter(f => f.endsWith('.json') && f.includes('--') && !f.startsWith('summary')).map(f => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
const median = values => { const a = values.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const get = (o, p) => p.split('.').reduce((v, k) => v?.[k], o);
const sum = (r, paths) => { const v = paths.map(p => get(r, p)); return v.every(x => x === undefined || x === null) ? null : v.reduce((s, x) => s + (x ?? 0), 0); };
const worst = (r, paths) => { const v = paths.map(p => get(r, p)).filter(Number.isFinite); return v.length ? Math.max(...v) : null; };
const TYPES = ['browser', 'renderer', 'gpu', 'utility', 'other'];

// Rows of each file's table. The first group is what the baselines have always shown; the rest was added later.
const DOC = [
  ['Startup to usable (ms)', 'startup.readyMs'],
  ['Open file (ms)', 'open.openMs'],
  ['Memory after open, settled (MiB)', 'open.settledMiB'],
  ['Memory peak, whole session (MiB)', 'memory.peakMiB'],
  ['Play: time to first frame (ms)', 'playCold.startMs'],
  ['Play (first): delivered fps', 'playCold.deliveredFps'],
  ['Play (first): frame interval p95 (ms)', 'playCold.frameIntervals.p95'],
  ['Play (first): worst frame interval (ms)', 'playCold.frameIntervals.max'],
  ['Play (first): stutters (>1.5 frames)', 'playCold.stutters'],
  ['Play (first): buffering (ms)', 'playCold.bufferingMs'],
  ['Play (again): delivered fps', 'playWarm.deliveredFps'],
  ['Play (again): worst frame interval (ms)', 'playWarm.frameIntervals.max'],
  ['Play (again): stutters', 'playWarm.stutters'],
  ['Play: worst UI freeze (ms)', 'playCold.uiFrameGaps.max'],
  ['Scrub frame-by-frame p50 (ms)', 'scrub.latency.p50'],
  ['Scrub frame-by-frame p95 (ms)', 'scrub.latency.p95'],
  ['Jump to a far frame p50 (ms)', 'jump.latency.p50'],
  ['Jump to a far frame p95 (ms)', 'jump.latency.p95'],
  ['Next-frame key p50 (ms)', 'step.latency.p50'],
  ['Next-frame key p95 (ms)', 'step.latency.p95'],
  ['Joint drag: input→frame p50 (ms)', 'poseDrag.latency.p50'],
  ['Joint drag: input→frame p95 (ms)', 'poseDrag.latency.p95'],
  ['Joint drag: input→frame p99 (ms)', 'poseDrag.latency.p99'],
  ['Joint drag: frames drawn per second', 'poseDrag.paintsPerSec.p50'],
  ['Joint drag: worst UI freeze (ms)', 'poseDrag.uiFrameGaps.max'],
  ['Joint drag: release → committed (ms)', 'poseDrag.commitMs.p50'],
  ['Figure move: input→frame p95 (ms)', 'moveDrag.latency.p95'],
  ['Undo p50 (ms)', 'poseDrag.undoMs.p50'],
  ['Redo p50 (ms)', 'poseDrag.redoMs.p50'],
  ['Flicker: scrub (bad pictures)', r => (get(r, 'flicker.flicker-scrub.transients') ?? 0) + (get(r, 'flicker.flicker-scrub.blanks') ?? 0)],
  ['Flicker: playback (bad pictures)', r => (get(r, 'flicker.flicker-play.transients') ?? 0) + (get(r, 'flicker.flicker-play.blanks') ?? 0)],
  ['Flicker: drag (bad pictures)', r => (get(r, 'flicker.flicker-drag.transients') ?? 0) + (get(r, 'flicker.flicker-drag.blanks') ?? 0)],
  ['Save as .styk (ms)', 'save.ms'],
  // ---- added
  ['Flicker: scrub, artifacts only', r => artifacts(r, 'flicker-scrub')],
  ['Flicker: scrub, the animation\'s own (content)', r => content(r, 'flicker-scrub')],
  ['Flicker: playback, artifacts only', r => artifacts(r, 'flicker-play')],
  ['Flicker: playback, the animation\'s own (content)', r => content(r, 'flicker-play')],
  ['Flicker: drag, artifacts only', r => artifacts(r, 'flicker-drag')],
  ['Flicker: idle, artifacts only', r => artifacts(r, 'flicker-idle')],
  ['Draws per animation frame', 'draws.drawsPerFrame'],
  ['Zoom (wheel): input→paint p50 (ms)', 'zoomPan.zoom.latency.p50'],
  ['Zoom (wheel): input→paint p95 (ms)', 'zoomPan.zoom.latency.p95'],
  ['Zoom (wheel): input→paint p99 (ms)', 'zoomPan.zoom.latency.p99'],
  ['Zoom (wheel): frames per second', 'zoomPan.zoom.paintsPerSec'],
  ['Zoom (wheel): worst UI freeze (ms)', 'zoomPan.zoom.uiFrameGaps.max'],
  ['Pan (drag): input→paint p50 (ms)', 'zoomPan.pan.latency.p50'],
  ['Pan (drag): input→paint p95 (ms)', 'zoomPan.pan.latency.p95'],
  ['Pan (drag): input→paint p99 (ms)', 'zoomPan.pan.latency.p99'],
  ['Pan (drag): frames per second', 'zoomPan.pan.paintsPerSec'],
  ['Pan (drag): worst UI freeze (ms)', 'zoomPan.pan.uiFrameGaps.max'],
  ['Select click: input→paint p50 (ms)', 'select.latency.p50'],
  ['Select click: input→paint p95 (ms)', 'select.latency.p95'],
  ['Onion skins: scrub p50 (ms)', 'onion.scrub.latency.p50'],
  ['Onion skins: scrub p95 (ms)', 'onion.scrub.latency.p95'],
  ['Onion skins: scrub longest task (ms)', 'onion.scrub.longestTaskMs'],
  ['Onion skins: next-frame key p95 (ms)', 'onion.step.latency.p95'],
  ['Onion skins: play stutters', 'onion.play.stutters'],
  ['Onion skins: play worst UI freeze (ms)', 'onion.play.uiFrameGaps.max'],
  ['Timeline + inspector play: playhead delay p95 (ms)', 'timelineInspector.playhead.delay.p95'],
  ['Timeline + inspector play: playhead updates missed', 'timelineInspector.playhead.missed'],
  ['Timeline + inspector play: inspector delay p95 (ms)', 'timelineInspector.inspector.delay.p95'],
  ['Timeline + inspector play: inspector updates missed', 'timelineInspector.inspector.missed'],
  ['Timeline + inspector play: stutters', 'timelineInspector.play.stutters'],
  ['Timeline + inspector play: long tasks', 'timelineInspector.play.longTasks'],
  ['Timeline + inspector play: worst UI freeze (ms)', 'timelineInspector.play.uiFrameGaps.max'],
  ['Tab switch: action→first paint p50 (ms)', 'tabs.all.p50'],
  ['Tab switch: action→first paint p95 (ms)', 'tabs.all.p95'],
  ['Memory after switching tabs, settled (MiB)', 'tabs.settledMiB'],
  ['Export dialog usable (ms)', 'export.dialogMs'],
  ['Export 2 s of video (ms)', 'export.exportMs'],
  ...['browser', 'renderer', 'gpu', 'utility', 'other'].map(t => [`Memory after open, ${t} (MiB)`, `memoryDetail.snapshots.open.byType.${t}`]),
  ['Memory after open: renderer JS heap (MiB)', 'memoryDetail.snapshots.open.jsHeapUsedMiB'],
  ['Memory after open: engine WebAssembly memory (MiB)', 'memoryDetail.snapshots.open.wasmMiB'],
  ['Memory after play: renderer JS heap (MiB)', 'memoryDetail.snapshots.playWarm.jsHeapUsedMiB'],
  ['Memory after play: engine WebAssembly memory (MiB)', 'memoryDetail.snapshots.playWarm.wasmMiB'],
  ...['browser', 'renderer', 'gpu', 'utility', 'other'].map(t => [`Memory peak, ${t} (MiB)`, `memoryDetail.byType.peak.${t}`]),
];
const artifacts = (r, mark) => { const f = get(r, `flicker.${mark}`); return f && f.artifactTransients !== undefined ? f.artifactTransients + (f.artifactBlanks ?? 0) : null; };
const content = (r, mark) => { const f = get(r, `flicker.${mark}`); return f && f.contentTransients !== undefined && f.contentTransients !== null ? f.contentTransients + (f.contentBlanks ?? 0) : null; };
const DRAW = [
  ['Brush: input→frame p50 (ms)', 'draw.latency.p50'],
  ['Brush: input→frame p95 (ms)', 'draw.latency.p95'],
  ['Brush: input→frame p99 (ms)', 'draw.latency.p99'],
  ['Brush: frames drawn per second', 'draw.paintsPerSec.p50'],
  ['Brush: worst UI freeze (ms)', 'draw.uiFrameGaps.max'],
  ['Brush: release → stroke committed (ms)', 'draw.commitMs.p50'],
  ['Brush: ink under the path (min %)', r => { const c = get(r, 'draw.coverage'); return Array.isArray(c) ? Math.min(...c.map(v => v ?? 0)) * 100 : null; }],
  ['Undo stroke p50 (ms)', 'draw.undoMs.p50'],
  ['Undo stroke worst (ms)', 'draw.undoMs.max'],
  ['Flicker while drawing (bad pictures)', r => (get(r, 'draw.flicker.transients') ?? 0) + (get(r, 'draw.flicker.blanks') ?? 0)],
  ['Flicker while drawing, artifacts only', r => get(r, 'draw.flicker.artifactTransients') === undefined ? null : get(r, 'draw.flicker.artifactTransients') + (get(r, 'draw.flicker.artifactBlanks') ?? 0)],
  ['Memory peak (MiB)', 'memory.peakMiB'],
];
const FREE = [
  ['Startup to window (ms)', 'empty.startup.firstWindowMs'],
  ['Startup to usable (ms)', 'empty.startup.readyMs'],
  ['Empty app memory, settled (MiB)', 'empty.medianMiB'],
  ...TYPES.map(t => [`Empty app memory, ${t} (MiB)`, `empty.byType.${t}`]),
  ['Empty app: renderer JS heap (MiB)', 'empty.detail.jsHeapUsedMiB'],
  ['Empty app: engine WebAssembly memory (MiB)', 'empty.detail.wasmMiB'],
  ['Home with 200 projects: usable (ms)', 'home.homeUsableMs'],
  ['Home: projects listed', 'home.listed'],
  ['Home: list scroll worst frame gap (ms)', 'home.scroll.uiFrameGaps.max'],
  ['Home: list scroll frame gap p95 (ms)', 'home.scroll.uiFrameGaps.p95'],
  ['Home: list scroll long tasks', 'home.scroll.longTasks'],
  ['Home: memory, settled (MiB)', 'home.settledMiB'],
];
const value = (r, m, context = {}) => typeof m === 'function' ? m(r, context) : get(r, m);

// ---------- targets: the one table ----------
// target: a number or a function of the file's results; `higher` marks rows where more is better.
// floor: 'x3' at least 3x faster than the base, 'half' at most half its memory, 'atLeast' no worse than the base,
// 'better' better than the base, 'notWorse' within 5% of the base (noise), or null.
// files: which files the row applies to (a part of the file name); absent = every file. source: 'doc' (default), 'draw' or 'free'.
const REFRESH = 7;
const TARGETS = [
  {name: 'App start until usable (ms)', metric: 'startup.readyMs', target: 1000, floor: 'x3'},
  {name: 'Open tdd2 (ms)', metric: 'open.openMs', target: 1000, floor: 'x3', files: ['tdd2']},
  {name: 'Open svr_uriel (ms)', metric: 'open.openMs', target: 600, floor: 'x3', files: ['svr_uriel']},
  {name: 'Open testingupload.styk (ms)', metric: 'open.openMs', target: 800, floor: 'x3', files: ['testingupload']},
  {name: 'Memory with tdd2 open, settled, above the empty app (MiB)', metric: (r, c) => c.empty === null || c.empty === undefined ? null : get(r, 'open.settledMiB') - c.empty, target: 400, floor: 'half', files: ['tdd2']},
  {name: 'Empty app memory (MiB), smaller than today\'s ~0.8 GB', metric: 'empty.medianMiB', target: 800, floor: 'half', source: 'free'},
  {name: 'Memory peak over a tdd2 session (MiB)', metric: 'memory.peakMiB', target: 1536, floor: 'half', files: ['tdd2']},
  {name: 'Play press until first frame (ms)', metric: 'playCold.startMs', target: REFRESH, floor: 'x3'},
  {name: 'Play stutters', metric: r => worst(r, ['playCold.stutters', 'playWarm.stutters']), target: 0, floor: 'notWorse'},
  {name: 'Play worst frame interval (ms), frame time + 1 refresh', metric: r => worst(r, ['playCold.frameIntervals.max', 'playWarm.frameIntervals.max']),
    target: r => 1000 / (get(r, 'playCold.targetFps') || 24) + REFRESH, floor: 'notWorse'},
  {name: 'Draws per animation frame', metric: 'draws.drawsPerFrame', target: 1.001, floor: null},
  {name: 'Scrub frame by frame p95 (ms)', metric: 'scrub.latency.p95', target: 9, floor: 'x3'},
  {name: 'Jump to a distant frame p95 (ms)', metric: 'jump.latency.p95', target: 16, floor: 'x3'},
  {name: 'Next-frame key p95 (ms)', metric: 'step.latency.p95', target: 9, floor: 'x3'},
  {name: 'Joint drag input→frame p50 (ms)', metric: 'poseDrag.latency.p50', target: 3, floor: 'atLeast'},
  {name: 'Joint drag input→frame p95 (ms)', metric: 'poseDrag.latency.p95', target: 7, floor: 'better'},
  {name: 'Joint drag input→frame p99 (ms)', metric: 'poseDrag.latency.p99', target: null, floor: 'better'},
  {name: 'Figure move input→frame p95 (ms)', metric: 'moveDrag.latency.p95', target: 7, floor: 'better'},
  {name: 'Joint drag frames per second', metric: 'poseDrag.paintsPerSec.p50', target: 115, higher: true, floor: 'atLeast'},
  {name: 'Worst UI freeze during a drag (ms)', metric: r => worst(r, ['poseDrag.uiFrameGaps.max', 'moveDrag.uiFrameGaps.max']), target: 16, floor: 'atLeast'},
  {name: 'Drag release → committed (ms)', metric: 'poseDrag.commitMs.p50', target: 10, floor: 'atLeast'},
  {name: 'Undo (ms)', metric: 'poseDrag.undoMs.p50', target: 10, floor: 'notWorse'},
  {name: 'Redo (ms)', metric: 'poseDrag.redoMs.p50', target: 10, floor: 'notWorse'},
  {name: 'Brush input→frame p95 (ms)', metric: 'draw.latency.p95', target: 7, floor: 'better', source: 'draw'},
  {name: 'Brush input→frame p50 (ms)', metric: 'draw.latency.p50', target: null, floor: 'atLeast', source: 'draw'},
  {name: 'Brush input→frame p99 (ms)', metric: 'draw.latency.p99', target: null, floor: 'better', source: 'draw'},
  {name: 'Brush worst UI freeze (ms)', metric: 'draw.uiFrameGaps.max', target: 16, floor: 'atLeast', source: 'draw'},
  {name: 'Undo a brush stroke, median (ms)', metric: 'draw.undoMs.p50', target: 10, floor: 'notWorse', source: 'draw'},
  {name: 'Undo a brush stroke, worst (ms)', metric: 'draw.undoMs.max', target: 16, floor: 'notWorse', source: 'draw'},
  {name: 'Save as .styk, tdd2 (ms)', metric: 'save.ms', target: 1000, floor: 'x3', files: ['tdd2']},
  {name: 'Save as .styk, testingupload (ms)', metric: 'save.ms', target: 800, floor: 'x3', files: ['testingupload']},
  {name: 'Flicker, artifacts: scrub', metric: r => artifacts(r, 'flicker-scrub'), target: 0, floor: 'notWorse'},
  {name: 'Flicker, artifacts: playback', metric: r => artifacts(r, 'flicker-play'), target: 0, floor: 'notWorse'},
  {name: 'Flicker, artifacts: drag', metric: r => artifacts(r, 'flicker-drag'), target: 0, floor: 'notWorse'},
  {name: 'Flicker, artifacts: idle', metric: r => artifacts(r, 'flicker-idle'), target: 0, floor: 'notWorse'},
  {name: 'Flicker, artifacts: drawing', metric: r => get(r, 'draw.flicker.artifactTransients') === undefined ? null : get(r, 'draw.flicker.artifactTransients') + (get(r, 'draw.flicker.artifactBlanks') ?? 0), target: 0, floor: 'notWorse', source: 'draw'},
];

// ---------- compute ----------
const groups = new Map();
for (const r of runs) { const key = `${r.label}|${r.file ?? 'drawing'}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); }
const files = [...new Set(runs.map(r => r.file ?? 'drawing'))].sort((a, b) => (a === 'drawing') - (b === 'drawing') || (a === 'free') - (b === 'free') || a.localeCompare(b));
const group = (label, file) => groups.get(`${label}|${file}`) ?? [];
const emptyOf = label => median(group(label, 'free').map(r => get(r, 'empty.medianMiB')));
const out = {}, lines = [];
const fmt = v => v === null || v === undefined || Number.isNaN(v) ? '—' : Math.abs(v) >= 100 ? Math.round(v).toString() : (+v.toFixed(1)).toString();
for (const file of files) {
  const metrics = file === 'drawing' ? DRAW : file === 'free' ? FREE : DOC;
  lines.push(`\n### ${file}  (runs: ${labels.map(l => `${l} ${group(l, file).length}`).join(', ')})\n`, `| Measure | ${labels.join(' | ')} |`, `|---|${labels.map(() => '---:').join('|')}|`);
  out[file] = {};
  for (const [name, m] of metrics) {
    const values = labels.map(l => median(group(l, file).map(r => value(r, m, {empty: emptyOf(l)}))));
    out[file][name] = Object.fromEntries(labels.map((l, i) => [l, values[i]]));
    lines.push(`| ${name} | ${values.map(fmt).join(' | ')} |`);
  }
  const errs = labels.flatMap(l => group(l, file).flatMap(r => Object.entries(r).filter(([, v]) => v?.error).map(([k, v]) => `${r.label}#${r.run} ${k}: ${v.error}`)));
  if (errs.length) lines.push('', 'Errors:', ...errs.map(e => `- ${e}`));
}

// ---------- scoreboard ----------
const meets = (row, v, goal) => v === null || v === undefined || goal === null || goal === undefined ? null : row.higher ? v >= goal : v <= goal;
const clears = (row, v, b) => {
  if (!row.floor || v === null || v === undefined || b === null || b === undefined) return null;
  switch (row.floor) {
    case 'x3': return v * 3 <= b;
    case 'half': return v * 2 <= b;
    case 'atLeast': return row.higher ? v >= b : v <= b;
    case 'better': return row.higher ? v > b : v < b;
    case 'notWorse': return row.higher ? v >= b * .95 : v <= b * 1.05 + 1e-9;
    default: return null;
  }
};
const mark = ok => ok === null ? '' : ok ? '✓' : '✗';
const score = [], detail = [];
const header = `| Target | Goal | ${labels.map(l => `${l}${l === base ? ' (base)' : ''}: worst file · target · floor`).join(' | ')} |`;
for (const row of TARGETS) {
  const source = row.source ?? 'doc';
  const fileList = source === 'draw' ? ['drawing'] : source === 'free' ? ['free'] : files.filter(f => f !== 'drawing' && f !== 'free' && (!row.files || row.files.some(part => f.includes(part))));
  const perFile = {};
  for (const file of fileList) {
    const results = {};
    for (const l of labels) {
      const rs = group(l, file);
      results[l] = {value: median(rs.map(r => value(r, row.metric, {empty: emptyOf(l)}))), goal: median(rs.map(r => typeof row.target === 'function' ? row.target(r) : row.target))};
    }
    perFile[file] = results;
  }
  const cells = labels.map(l => {
    const vs = fileList.map(f => perFile[f][l]).filter(x => x.value !== null && x.value !== undefined && !Number.isNaN(x.value));
    if (!vs.length) return {text: 'absent', worst: null};
    const w = row.higher ? Math.min(...vs.map(x => x.value)) : Math.max(...vs.map(x => x.value));
    const goalMet = vs.map(x => meets(row, x.value, x.goal ?? row.target)).filter(x => x !== null);
    const floors = fileList.map(f => clears(row, perFile[f][l].value, perFile[f][base]?.value)).filter(x => x !== null);
    const t = goalMet.length ? goalMet.every(Boolean) : null, fl = l === base ? null : floors.length ? floors.every(Boolean) : null;
    return {text: `${fmt(w)} ${mark(t)}${row.floor ? ` · ${l === base ? 'base' : fl === null ? 'n/a' : mark(fl)}` : ''}`.trim(), worst: w, target: t, floor: fl};
  });
  const goalText = typeof row.target === 'function' ? 'frame time + 7 ms' : row.target === null ? '—' : `${row.higher ? '≥' : '≤'} ${fmt(row.target)}`;
  score.push(`| ${row.name} | ${goalText}${row.floor ? ` · ${{x3: '3× faster than main', half: '≤ half of main', atLeast: 'as good as main', better: 'better than main', notWorse: 'not worse than main'}[row.floor]}` : ''} | ${cells.map(c => c.text).join(' | ')} |`);
  detail.push(`| **${row.name}** |  | ${labels.map(() => '').join(' | ')} |`);
  for (const file of fileList) detail.push(`| ${file} | ${row.higher ? '≥' : '≤'} ${fmt(typeof row.target === 'function' ? median(group(base, file).map(r => row.target(r))) : row.target)} | ${labels.map(l => {
    const x = perFile[file][l]; return `${fmt(x.value)} ${mark(meets(row, x.value, x.goal ?? row.target))}${row.floor && l !== base ? ` · ${mark(clears(row, x.value, perFile[file][base]?.value)) || 'n/a'}` : ''}`.trim(); }).join(' | ')} |`);
  out[`scoreboard:${row.name}`] = Object.fromEntries(labels.map((l, i) => [l, {worst: cells[i].worst, meetsTarget: cells[i].target, clearsFloor: cells[i].floor}]));
}
lines.push('', '## Scoreboard', '', `Worst file per label (best-case worst file must meet the target). ✓ meets / clears, ✗ does not, blank: no target, absent: the checkout cannot measure it. Floor is judged against \`${base}\`, file by file.`,
  '', header, `|---|---|${labels.map(() => '---:').join('|')}|`, ...score,
  '', '### The scoreboard by file', '', `| Row | Goal | ${labels.join(' | ')} |`, `|---|---|${labels.map(() => '---:').join('|')}|`, ...detail);
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(out, null, 1));
writeFileSync(path.join(dir, 'summary.md'), lines.join('\n'));
console.log(lines.join('\n'));
