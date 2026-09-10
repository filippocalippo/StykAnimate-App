import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyReleaseAssets, fileHash } from '../scripts/release-assets.mjs';
test('release verification rejects wrong versions, corrupt installers and incomplete uploads', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'styk-release-'));
  try {
    const name = 'StykAnimate-0.5.0-Setup-x64.exe';
    for (const file of [name, `${name}.blockmap`, 'StykAnimate-0.5.0-Portable-x64.exe']) await writeFile(path.join(directory, file), 'fixture');
    const sha512 = await fileHash(path.join(directory, name));
    await writeFile(path.join(directory, 'latest.yml'), JSON.stringify({ version: '0.5.0', path: name, sha512, files: [{ url: name, size: 7, sha512 }] }));
    assert.equal((await verifyReleaseAssets(directory, '0.5.0')).length, 4);
    await assert.rejects(verifyReleaseAssets(directory, '0.6.0'));
    await writeFile(path.join(directory, name), 'corrupt');
    await assert.rejects(verifyReleaseAssets(directory, '0.5.0'), /checksum/);
    await writeFile(path.join(directory, name), 'fixture');
    await rm(path.join(directory, `${name}.blockmap`));
    await assert.rejects(verifyReleaseAssets(directory, '0.5.0'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('public update feed contains no private repository or credentials', async () => {
  const config = JSON.parse(await readFile('package.json', 'utf8'));
  assert.deepEqual(config.build.publish, [{ provider: 'github', owner: 'filippocalippo', repo: 'styk-animate-releases', private: false, releaseType: 'draft' }]);
  const notes = JSON.parse(await readFile('desktop/release-info.json', 'utf8'));
  assert.equal(notes.version, config.version);
  const { DONATE_URL } = await import('../src/support-ui.mjs');
  const links = await import('../desktop/release-links.cjs');
  assert.equal(DONATE_URL, links.default.DONATE_URL);
  assert.ok(!config.build.extraResources.some(item => item.from.startsWith('..')));
});
