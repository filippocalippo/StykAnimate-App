// Separate Cargo invocations keep the preview's model-only graph independent of the app.
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdtempSync, rmSync, rmdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import {catalogueIds, parseLimits} from './native-screen-guards.mjs';

export function previewGraphCheck(root) {
  // Separate invocation: the app must not unify engine into the view-model-only UI check.
  execFileSync('cargo', ['check', '--locked', '--manifest-path', 'engine/Cargo.toml', '-p', 'styk-ui', '--lib', '--no-default-features'], {cwd: root, stdio: 'inherit'});
  const tree = execFileSync('cargo', ['tree', '--manifest-path', 'engine/Cargo.toml', '--locked', '--offline', '-p', 'styk-screens', '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}'], {cwd: root, encoding: 'utf8'});
  const allowed = new Set(['styk-screens', 'styk-ui', 'styk-design', 'styk-core', 'styk-services', 'styk-platform']);
  const lines = tree.split(/\r?\n/);
  if (!lines.some(line => line.startsWith('styk-screens '))) throw new Error('preview graph supplied no root');
  for (const line of lines) {
    const name = line.split(' ')[0];
    if (name.startsWith('styk-') && !allowed.has(name)) throw new Error(`preview reaches forbidden crate ${name}`);
  }
  console.log('preview: model-only graph; no engine crates or core export/audio modules');
}

export function previewParityCheck(root, target) {
  const ids = catalogueIds(readFileSync(resolve(root, 'engine/crates/styk-ui/src/screens.rs'), 'utf8'));
  const specs = parseLimits(readFileSync(resolve(root, 'docs/native/screens/limits.toml'), 'utf8'));
  execFileSync('cargo', ['build', '--locked', '--manifest-path', 'engine/Cargo.toml', '-p', 'styk-screens'], {cwd: root, stdio: 'inherit'});
  const out = mkdtempSync(join(tmpdir(), 'styk-preview-parity-'));
  const files = [];
  try {
    for (const id of ids) {
      const spec = specs.get(id);
      if (!spec) throw new Error(`missing dimensions for ${id}`);
      const captures = ['stykanimate', 'styk-screens'].map(binary => {
        const path = join(out, `${binary}-${id}.png`); files.push(path, path.replace(/\.png$/, '.png.partial'));
        execFileSync(resolve(target, `debug/${binary}.exe`), ['--screen', id, '--size', `${spec.width}x${spec.height}`, '--scale', '1', '--screenshot', path], {cwd: root, stdio: 'inherit', timeout: 45000, env: {...process.env, STYK_BACKGROUND_WINDOW: 'headless'}});
        return readFileSync(path);
      });
      // Both hosts use the same deterministic PNG encoder (no timestamps or metadata).
      // Byte identity is stronger than pixel identity; even a single channel bit fails.
      if (!captures[0].equals(captures[1])) throw new Error(`${id}: preview capture differs from the real app`);
      console.log(`preview parity: ${id}: identical PNG bytes (all pixels identical)`);
    }
  } finally {
    for (const file of files) rmSync(file, {force: true});
    rmdirSync(out);
  }
}
