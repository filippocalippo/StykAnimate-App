import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const yaml = createRequire(import.meta.url)('js-yaml');
export async function fileHash(filename, algorithm = 'sha512', encoding = 'base64') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest(encoding);
}
export async function verifyReleaseAssets(directory, version) {
  const metadata = yaml.load(await readFile(path.join(directory, 'latest.yml'), 'utf8'));
  assert.equal(metadata.version, version, 'Update metadata version differs from the release.');
  const setup = `StykAnimate-${version}-Setup-x64.exe`;
  assert.equal(metadata.path, setup, 'Only the Setup installer can be an update target.');
  assert.equal(metadata.files?.length, 1, 'Publish one Windows architecture per feed.');
  const entry = metadata.files[0];
  assert.equal(entry.url, setup, 'Unexpected installer name or URL.');
  assert.equal(entry.size, (await stat(path.join(directory, setup))).size);
  assert.equal(entry.sha512, await fileHash(path.join(directory, setup)), 'Installer checksum differs from latest.yml.');
  assert.equal(metadata.sha512, entry.sha512);
  const names = [setup, `${setup}.blockmap`, `StykAnimate-${version}-Portable-x64.exe`, 'latest.yml'];
  for (const name of names) assert.ok((await stat(path.join(directory, name))).size > 0, `Missing release asset: ${name}`);
  return names.map(name => path.join(directory, name));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const assets = await verifyReleaseAssets(process.argv[2] || `release/${version}`, version);
  console.log(`Verified ${assets.length} public release assets and installer SHA-512 for ${version}.`);
}
