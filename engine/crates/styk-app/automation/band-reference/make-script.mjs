// The native app's script for the same scenarios: tmp/band-ref/native.script, the PNGs in tmp/band-ref/out/native/.
import {copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {SCENARIOS, HEIGHT} from './scenarios.mjs';

// Output goes to the ignored tmp/band-ref of the repository.
const OUT = new URL('../../../../../tmp/band-ref/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const here = OUT;
const fixture = new URL('../../../../tests/edit/startup.document.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(`${here}out/native`, {recursive: true});
mkdirSync(`${here}files`, {recursive: true});
const names = new Set(SCENARIOS.flatMap(s => s.names));
for (const name of names) copyFileSync(fixture, `${here}files/${name}.styk`);

// Each scenario needs its own set of projects: the script opens the largest set first and closes nothing, so scenarios
// with fewer tabs run in their own script. The script file is per tab set.
const sets = new Map();
for (const scenario of SCENARIOS) {
  const key = scenario.names.join('|');
  if (!sets.has(key)) sets.set(key, []);
  sets.get(key).push(scenario);
}
let index = 0;
const foldsFile = `${here}out/chromium/folds.json`;
const folds = existsSync(foldsFile) ? JSON.parse(readFileSync(foldsFile, "utf8")) : {};
for (const [key, scenarios] of sets) {
  const names = key.split('|');
  const lines = ['styk-auto/1', `# generated: ${names.length} tabs`];
  for (const name of names) lines.push(`open files/${name}.styk`);
  lines.push('wait 5', 'resize 1560 900');
  const first = scenarios[0];
  // The project in front and the unsaved one, as the Chromium harness sets them.
  first.dirty.forEach((dirty, i) => {
    if (dirty) { lines.push(`click tab:${i + 1}`, 'edit 30'); }
  });
  lines.push(`click tab:${first.front + 1}`);
  for (const scenario of scenarios) {
    lines.push("click workspace:animate", `theme ${scenario.theme}`, scenario.workspace === 'rig' ? 'click workspace:build' : `session ${scenario.session || 'none'}`, `resize ${scenario.width} ${HEIGHT}`, 'wait 4', `expect width ${scenario.width}`, ...(folds[scenario.id] ? [`expect folds ${folds[scenario.id].join(',') || 'none'}`] : []), `screenshot out/native/${scenario.id}.png`);
  }
  const file = `${here}native-${index++}.script`;
  writeFileSync(file, lines.join('\n') + '\n');
  console.log(file, scenarios.length, 'scenarios');
}
