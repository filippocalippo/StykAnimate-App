// Old-app recovery compatibility without launching Electron or touching a profile.
// The input is a repository fixture; outputs belong only to ignored artifacts for the native checks.
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
test('99c62189 recovery writer: two old runs preserve every project byte', async () => {
  for (const file of ['desktop/recovery.cjs', 'desktop/rename-retry.cjs']) {
    assert.equal((await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n'), execFileSync('git', ['show', `99c62189:${file}`], {cwd: root, encoding: 'utf8'}).replace(/\r\n/g, '\n'), `${file} is the pinned reference`);
  }
  const {RecoveryStore, atomicWrite} = require('../desktop/recovery.cjs');
  const source = await readFile(path.join(root, 'engine/tests/containers/project-channels.styk'));
  const directory = path.join(root, 'artifacts', 'native-recovery-reference');
  const slot = '12345678-1234-4234-8234-123456789abc';
  for (const run of ['first', 'second']) {
    const folder = path.join(directory, run); await mkdir(folder, {recursive: true});
    const store = new RecoveryStore(folder);
    await store.save({data: source.toString('base64'), name: 'Recovered 日本'});
    // The streamed desktop path commits the document, then calls updateMetadata.
    await atomicWrite(store.paths(slot).file, source); await store.updateMetadata('Named copy', slot);
    assert.equal((await store.list()).length, 2);
  }
  for (const filename of ['recovery.styk', `recovery-${slot}.styk`]) {
    const a = await readFile(path.join(directory, 'first', filename));
    const b = await readFile(path.join(directory, 'second', filename));
    assert.deepEqual(a, b); assert.deepEqual(a, source);
  }
  await writeFile(path.join(directory, 'source.styk'), source);
  console.log('RECOVERY_REFERENCE: 2 old-versus-old byte comparisons passed; only sidecar savedAt is time-dependent');
});
