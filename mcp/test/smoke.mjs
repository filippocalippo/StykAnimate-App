// End-to-end check against the real app: build examples/hello-short.json, preview it, save the project and
// export a Shorts MP4. Output goes to artifacts/mcp-smoke for inspection.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {APP_ROOT} from '../src/app-root.mjs';
import {AppSession} from '../src/session.mjs';
import {buildAnimation} from '../src/build.mjs';

const out = path.resolve(process.argv[2] ?? path.join(APP_ROOT, 'artifacts', 'mcp-smoke'));
await mkdir(out, {recursive: true});
const session = new AppSession();
try {
  const spec = JSON.parse(await readFile(new URL('../examples/hello-short.json', import.meta.url), 'utf8'));
  const built = await buildAnimation(session, spec);
  console.log('build', built);
  assert.equal(built.ticks, 97);
  const sheet = await session.preview({frames: [0, 12, 24, 36, 48, 60, 72, 84]});
  await writeFile(path.join(out, 'preview.png'), Buffer.from(sheet, 'base64'));
  console.log('preview', path.join(out, 'preview.png'));
  console.log('save', await session.save(path.join(out, 'hello.styk')));
  const exported = await session.exportVideo({preset: 'shorts', out: path.join(out, 'hello.mp4')});
  console.log('export', exported);
  assert.match(exported.size, /1,080 × 1,920/);
  assert.deepEqual(session.pageErrors, []);
  console.log('PASS');
} finally { await session.close(); }
