import {readFileSync, mkdirSync, existsSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {productionTokens} from './native-source-guards.mjs';

// The catalogue's id() match is the source of screen IDs, not a second inventory.
export function catalogueIds(source) {
  const all = productionTokens(source), ids = [];
  const start = all.findIndex((token, i) => token.value === 'fn' && all[i + 1]?.value === 'id');
  if (start < 0) throw new Error('screens.rs:1: screenshot: catalogue has no id function');
  const body = all.findIndex((token, i) => i > start && token.value === '{');
  let end = body + 1, depth = 1;
  while (end < all.length && depth) {
    if (!all[end].string && all[end].value === '{') depth++;
    if (!all[end].string && all[end].value === '}') depth--;
    end++;
  }
  const ts = all.slice(body, end);
  for (let i = 0; i < ts.length; i++) if (ts[i].string && ts[i - 1]?.value === '>' && ts[i - 2]?.value === '=') ids.push(ts[i].value);
  return [...new Set(ids)].sort();
}

export function parseLimits(source) {
  const screens = new Map();
  let current;
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim(), location = `docs/native/screens/limits.toml:${index + 1}: screenshot`;
    if (!line || line.startsWith('#')) continue;
    const section = /^\["([a-z0-9-]+)"\]$/.exec(line);
    if (section) {
      if (screens.has(section[1])) throw new Error(`${location}: duplicate screen`);
      current = {line: index + 1}; screens.set(section[1], current); continue;
    }
    const entry = /^(reference|max_difference|width|height)\s*=\s*(.*)$/.exec(line);
    if (!entry || !current || Object.hasOwn(current, entry[1])) throw new Error(`${location}: invalid or duplicate entry`);
    try { current[entry[1]] = JSON.parse(entry[2]); }
    catch { throw new Error(`${location}: invalid value for ${entry[1]}`); }
  }
  for (const [id, spec] of screens) {
    if (typeof spec.reference !== 'string' || !Number.isFinite(spec.max_difference) || spec.max_difference < 0 || spec.max_difference > 1 || !Number.isInteger(spec.width) || !Number.isInteger(spec.height) || spec.width < 1 || spec.height < 1) throw new Error(`docs/native/screens/limits.toml:${spec.line}: screenshot: invalid configuration for ${id}`);
  }
  return screens;
}

export function screenCheck(root, run = execFileSync, target = resolve(root, 'engine/target')) {
  const ids = catalogueIds(readFileSync(resolve(root, 'engine/crates/styk-ui/src/screens.rs'), 'utf8'));
  const specs = parseLimits(readFileSync(resolve(root, 'docs/native/screens/limits.toml'), 'utf8'));
  for (const id of specs.keys()) if (!ids.includes(id)) throw new Error(`docs/native/screens/limits.toml:${specs.get(id).line}: screenshot: unknown screen ${id}`);
  let references = 0;
  for (const id of ids) {
    const spec = specs.get(id);
    if (!spec?.reference) { console.log(`screenshot: ${id}: no reference yet`); continue; }
    const reference = resolve(root, spec.reference);
    if (!existsSync(reference)) throw new Error(`docs/native/screens/limits.toml:${spec.line}: screenshot: missing reference for ${id}`);
    const out = resolve(root, 'artifacts/native-screens');
    mkdirSync(out, {recursive: true});
    const actual = resolve(out, `${id}.png`);
    const options = {cwd: root, stdio: 'inherit', env: {...process.env, STYK_BACKGROUND_WINDOW: 'headless'}, timeout: 45000};
    try {
      // A cold compile may take longer than a render; do not abandon cargo's
      // compiler children by applying the app-process timeout to the build.
      if (references === 0) run('cargo', ['build', '--quiet', '--locked', '--manifest-path', 'engine/Cargo.toml', '-p', 'styk-app', '-p', 'styk-cli'], {...options, timeout: 0});
      // Never accept an old capture after an unsuccessful or incomplete render.
      rmSync(actual, {force: true});
      // Launch the binary itself so the timeout owns the app process, not cargo.
      run(resolve(target, 'debug/stykanimate.exe'), ['--screen', id, '--size', `${spec.width}x${spec.height}`, '--scale', '1', '--screenshot', actual], options);
      run(resolve(target, 'debug/styk.exe'), ['image-diff', reference, actual, String(spec.max_difference)], options);
    } catch (error) { throw new Error(`docs/native/screens/limits.toml:${spec.line}: screenshot: ${id}: ${error.message}`); }
    references++;
  }
  console.log(`screenshots: active, ${references} references (${ids.length} catalogue screens)`);
}
