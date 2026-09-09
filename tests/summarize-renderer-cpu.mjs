/** Attribute sampled main-thread CPU time around the return from playback. */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2]);
const [profile, report, trace] = await Promise.all(['main.cpuprofile', 'report.json', 'chrome-trace.json']
  .map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
const marker = trace.traceEvents.find(event => event.name.startsWith('styk-tick-') && event.args?.data?.startTime !== undefined);
const offset = marker.ts - marker.args.data.startTime * 1000;
const last = report.measurements.presented.filter(frame => frame.success && frame.playing).at(-1);
const task = report.measurements.longTasks.filter(task => task.at >= last.at).sort((a, b) => b.ms - a.ms)[0]
  || report.measurements.regular[0];
const start = offset + task.at * 1000, end = start + (task.ms ?? task.cpuMs) * 1000;
const nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map();
for (const node of profile.nodes) for (const id of node.children || []) parents.set(id, node.id);
const self = new Map(), inclusive = new Map(); let ts = profile.startTime, samples = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const delta = profile.timeDeltas[i], previous = ts; ts += delta;
  if (ts < start || previous > end) continue;
  const ms = Math.max(0, Math.min(ts, end) - Math.max(previous, start)) / 1000;
  let id = profile.samples[i]; self.set(id, (self.get(id) || 0) + ms); samples++;
  while (id) { inclusive.set(id, (inclusive.get(id) || 0) + ms); id = parents.get(id); }
}
const rows = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 35).map(([id, ms]) => {
  const frame = nodes.get(id).callFrame;
  return {ms, name: frame.functionName || '(anonymous)', url: frame.url, line: frame.lineNumber + 1};
});
const summary = {selected: task, samples, profileMs: {start: (profile.startTime - offset) / 1000, end: (profile.endTime - offset) / 1000},
  self: rows(self), inclusive: rows(inclusive), limitation: 'Sampling attributes CPU wall time approximately; nested inclusive totals overlap.'};
await writeFile(path.join(directory, 'editor-return-cpu-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
