import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {closeSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const module = fileURLToPath(new URL('../desktop/workspace-instance.cjs', import.meta.url));
const {claimPrimaryWorkspace} = createRequire(import.meta.url)(module);

// A process that claims the profile, reports the result, optionally starts a child that outlives it, and waits.
const CLAIMANT = `const {spawn} = require('node:child_process');
const fd = require(process.argv[1]).claimPrimaryWorkspace(process.argv[2]);
if (process.argv[3] === 'child') spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {stdio: 'ignore'});
process.stdout.write(fd === null ? 'secondary\\n' : 'primary\\n');
setTimeout(() => {}, 60000);`;
function claimant(profile, mode = '') {
  const child = spawn(process.execPath, ['-e', CLAIMANT, module, profile, mode], {stdio: ['ignore', 'pipe', 'inherit']});
  const role = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8').once('data', text => resolve(text.trim()));
    child.once('exit', code => reject(new Error(`claimant exited early (${code})`)));
  });
  return {child, role};
}
const ended = child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));

test('one process at a time is the primary workspace, and a killed one leaves no stale claim', {skip: process.platform !== 'darwin' && 'macOS only (O_EXLOCK)'}, async t => {
  const profile = await mkdtemp(path.join(tmpdir(), 'styk-primary-'));
  const children = [];
  t.after(async () => { for (const {child} of children) child.kill('SIGKILL'); await rm(profile, {recursive: true, force: true}); });

  const launches = Array.from({length: 6}, () => claimant(profile)); children.push(...launches);
  const roles = await Promise.all(launches.map(launch => launch.role));
  assert.equal(roles.filter(role => role === 'primary').length, 1, `simultaneous launches: ${roles}`);
  assert.equal(claimPrimaryWorkspace(profile), null, 'a later launch is secondary while the primary runs');

  const primary = launches[roles.indexOf('primary')].child;
  primary.kill('SIGKILL'); await ended(primary);
  const fd = claimPrimaryWorkspace(profile);
  assert.notEqual(fd, null, 'the claim is free as soon as a killed primary has ended');
  closeSync(fd);

  const holder = claimant(profile, 'child'); children.push(holder);
  assert.equal(await holder.role, 'primary');
  holder.child.kill('SIGKILL'); await ended(holder.child);
  const next = claimPrimaryWorkspace(profile);
  assert.notEqual(next, null, 'a child of the primary, still running, does not keep the claim');
  closeSync(next);
});
