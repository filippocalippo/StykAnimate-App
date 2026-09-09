import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2] || 'artifacts/playback-patch-app-headless-profile'), rows = [];
for (const file of (await readdir(directory)).filter(name => name.endsWith('.cpuprofile'))) {
  const profile = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
  const nodes = new Map(profile.nodes.map(node => [node.id, node])), parent = new Map(), self = new Map(), inclusive = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id);
  const identity = id => {const c = nodes.get(id).callFrame; return `${c.functionName || '(anonymous)'} ${c.url ? `${c.url.replace(/^.*\/src\//, 'src/')}:${c.lineNumber + 1}` : ''}`.trim();};
  let sampledMs = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    const id = profile.samples[index], ms = (profile.timeDeltas[index] || 0) / 1000; sampledMs += ms;
    const name = identity(id); self.set(name, (self.get(name) || 0) + ms);
    const seen = new Set(); for (let ancestor = id; ancestor; ancestor = parent.get(ancestor)) {
      const key = identity(ancestor); if (!seen.has(key)) inclusive.set(key, (inclusive.get(key) || 0) + ms); seen.add(key);
    }
  }
  const top = data => [...data].map(([name, ms]) => ({name, ms: Math.round(ms * 100) / 100})).sort((a, b) => b.ms - a.ms).slice(0, 50);
  rows.push({file, sampledMs, self: top(self), inclusive: top(inclusive)});
}
await writeFile(path.join(directory, 'cpu-summary.json'), JSON.stringify({rows,
  limitation: 'Sampled main-thread CPU at approximately 0.5ms intervals across one gesture, commit, ACK and idle warm-up per file. Inclusive functions overlap; CDP sampling changes wall timing and does not measure GPU display latency.'}, null, 2));
console.log(JSON.stringify(rows.map(row => ({file: row.file, self: row.self.slice(0, 14), inclusive: row.inclusive.slice(0, 14)})), null, 2));
