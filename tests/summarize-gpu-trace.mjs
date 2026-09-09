/** Summarize a bounded Chrome trace without conflating CPU submission with display. */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2] || 'artifacts/renderer-live-tail-stall-ring');
const events = JSON.parse(await readFile(path.join(directory, 'chrome-trace.json'), 'utf8')).traceEvents;
const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
const threads = new Map(events.filter(e => e.ph === 'M' && e.name === 'thread_name').map(e => [`${e.pid}:${e.tid}`, e.args.name]));
const markers = events.filter(e => e.name.startsWith('styk-tick-') && e.args?.data?.startTime !== undefined).sort((a, b) => a.ts - b.ts);
if (!markers.length) throw new Error('No tick markers in trace.');
const offset = markers[0].ts - markers[0].args.data.startTime * 1000;
const timing = e => ({name: e.name, thread: threads.get(`${e.pid}:${e.tid}`), at: (e.ts - offset) / 1000, ms: e.dur / 1000 || 0, cpuMs: e.tdur === undefined ? null : e.tdur / 1000, args: e.args});
const trigger = report.detectedStall || report.measurements.triggered;
const frames = report.measurements.presented.filter(p => p.playing && p.success).filter((p, i, a) => i === 0 || a[i - 1].tick !== p.tick);
const gaps = frames.slice(1).map((p, i) => ({start: frames[i].at, end: p.at, elapsed: p.at - frames[i].at, from: frames[i].tick, to: p.tick})).sort((a, b) => b.elapsed - a.elapsed);
const editorReturn = process.argv.includes('--editor-return');
const returnTask = editorReturn && report.measurements.longTasks.filter(task => task.at >= frames.at(-1)?.at).sort((a, b) => b.ms - a.ms)[0];
const selected = returnTask ? {start: returnTask.at, end: returnTask.at + returnTask.ms} : trigger ? {start: trigger.at - trigger.elapsed, end: trigger.at} : gaps[0]?.elapsed > 90 ? gaps[0] : {start: markers[0].args.data.startTime, end: markers.at(-1).args.data.startTime};
const lo = offset + selected.start * 1000, hi = offset + selected.end * 1000;
const within = events.filter(e => e.ts <= hi && e.ts + (e.dur || 0) >= lo);
const slowTasks = within.filter(e => e.ph === 'X' && e.dur > 2000).sort((a, b) => b.dur - a.dur).slice(0, 65).map(timing);
const names = ['DCompPresenter::Present', 'Display::FrameDisplayed', 'DXGISwapChainImageBacking::Present', 'WidgetBase::DidCommitAndDrawCompositorFrame'];
const present = {};
for (const name of names) {
  const matches = events.filter(e => e.name === name).sort((a, b) => a.ts - b.ts);
  present[name] = {previous: matches.filter(e => e.ts < lo).slice(-2).map(timing), during: matches.filter(e => e.ts >= lo && e.ts <= hi).map(timing), next: matches.filter(e => e.ts > hi).slice(0, 2).map(timing)};
}
const summary = {trigger, selectedWindowMs: selected, traceEvents: events.length, tickMarkers: markers.map(timing), slowTasks, present,
  windowEvents: within.filter(e => e.ph === 'X' && (e.dur > 1000 || /destroy|release|collect|wait|present|swap/i.test(e.name))).map(timing),
  limitation: 'Chrome trace CPU task wall durations and presentation API/feedback events. Timing proximity alone does not prove causality; no monitor scanout timestamp is measured.'};
const gpuThread = events.find(e => e.ph === 'M' && e.name === 'thread_name' && e.args.name === 'CrGpuMain');
const resources = {};
for (const e of within.filter(e => e.pid === gpuThread?.pid && e.tid === gpuThread?.tid && e.ph === 'X' && /SharedImageStub::OnDestroy|RasterDecoderImpl::DoRasterCHROMIUM$/.test(e.name))) {
  const row = resources[e.name] ??= {count: 0, ms: 0}; row.count++; row.ms += e.dur / 1000;
}
summary.gpuResourceEvents = resources;
await writeFile(path.join(directory, editorReturn ? 'trace-summary-editor-return.json' : 'trace-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({trigger, selectedWindowMs: selected, eventCount: events.length, slowTasks: slowTasks.slice(0, 20), gpuResourceEvents: resources,
  present: process.argv.includes('--brief') ? Object.fromEntries(Object.entries(present).map(([name, row]) => [name, {count: row.during.length,
    maxGapMs: Math.max(0, ...row.during.slice(1).map((event, index) => event.at - row.during[index].at))}])) : present}, null, 2));
