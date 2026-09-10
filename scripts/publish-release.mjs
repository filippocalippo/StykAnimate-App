import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifyReleaseAssets, fileHash } from './release-assets.mjs';
const repo = 'filippocalippo/styk-animate-releases';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const directory = process.argv.find(arg => arg.startsWith('--directory='))?.slice(12) || `release/${version}`;
const assets = await verifyReleaseAssets(directory, version);
const tag = `v${version}`;
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let existing;
try { existing = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft'])); }
catch (error) { if (!String(error.stderr).includes('release not found')) throw error; }
if (existing && !existing.isDraft) throw new Error(`${tag} is already public. Increase the version instead of replacing an existing release.`);
const checksums = path.join(directory, 'SHA256SUMS.txt');
await writeFile(checksums, (await Promise.all(assets.map(async file => `${await fileHash(file, 'sha256', 'hex')}  ${path.basename(file)}`))).join('\n') + '\n');
if (!existing) gh(['release', 'create', tag, '--repo', repo, '--draft', '--title', `StykAnimate ${version}`, '--notes-file', 'release-notes.md']);
// Upload only this fixed allowlist; private source, logs and app.asar never become release attachments.
gh(['release', 'upload', tag, '--repo', repo, '--clobber', ...assets, checksums]);
gh(['release', 'edit', tag, '--repo', repo, '--notes-file', 'release-notes.md']);
const remote = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'assets']));
for (const file of [...assets, checksums]) {
  const item = remote.assets.find(item => item.name === path.basename(file));
  if (!item || !item.size) throw new Error(`GitHub is missing ${path.basename(file)}. The release remains a draft.`);
  if (item.digest && item.digest !== `sha256:${await fileHash(file, 'sha256', 'hex')}`) throw new Error(`GitHub checksum mismatch for ${item.name}.`);
}
if (process.argv.includes('--publish')) {
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
  console.log(`Published https://github.com/${repo}/releases/tag/${tag}`);
} else console.log(`${tag} uploaded as a draft. Run again with --publish to make the verified release available to installed apps.`);
