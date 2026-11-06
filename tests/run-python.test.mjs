import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolvePython, venvInterpreter} from '../scripts/run-python.mjs';

const only = (...commands) => (command) => commands.includes(command);

test('Linux without a bare python resolves python3', () => {
  const found = resolvePython({root: '/nowhere', env: {}, platform: 'linux', probe: only('python3')});
  assert.equal(found.command, 'python3');
});

test('Windows prefers the python on PATH, which is where a build machine installs its tools', () => {
  const both = () => true;
  assert.equal(resolvePython({root: '/nowhere', env: {}, platform: 'win32', probe: both}).command, 'python');
});

test('a conda install in the home directory is only a last resort on Windows, behind PATH', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'styk-home-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const conda = path.join(home, 'miniconda3', 'python.exe');
  await mkdir(path.dirname(conda), {recursive: true});
  await writeFile(conda, '');
  assert.equal(resolvePython({root: '/nowhere', env: {}, platform: 'win32', home, probe: () => true}).command, 'python');
  assert.equal(resolvePython({root: '/nowhere', env: {}, platform: 'win32', home, probe: command => command === conda}).command, conda);
});

test('Windows falls back to the py launcher when python is the Store stub or absent', () => {
  const found = resolvePython({root: '/nowhere', env: {}, platform: 'win32', probe: (command, args) => command === 'py' && args[0] === '-3'});
  assert.deepEqual(found, {command: 'py', args: ['-3']});
});

test('explicit environments still come before PATH on Windows', () => {
  const found = resolvePython({root: '/nowhere', env: {STYK_PYTHON: 'C:\\tools\\python.exe'}, platform: 'win32', probe: () => true});
  assert.equal(found.command, 'C:\\tools\\python.exe');
});

test('an explicit STYK_PYTHON wins, and an unusable one is skipped', () => {
  assert.equal(resolvePython({root: '/nowhere', env: {STYK_PYTHON: '/opt/py/bin/python'}, platform: 'linux', probe: only('/opt/py/bin/python', 'python3')}).command, '/opt/py/bin/python');
  assert.equal(resolvePython({root: '/nowhere', env: {STYK_PYTHON: '/broken'}, platform: 'linux', probe: only('python3')}).command, 'python3');
});

test('no usable interpreter is reported as null, not thrown', () => {
  assert.equal(resolvePython({root: '/nowhere', env: {}, platform: 'linux', probe: () => false}), null);
});

test('the repository virtual environment beats PATH but not STYK_PYTHON', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-venv-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, '.venv', 'bin'), {recursive: true});
  await writeFile(path.join(root, '.venv', 'bin', 'python'), '');
  const venv = venvInterpreter(root, 'linux');
  assert.equal(venv, path.join(root, '.venv', 'bin', 'python'));
  assert.equal(resolvePython({root, env: {}, platform: 'linux', probe: () => true}).command, venv);
  assert.equal(resolvePython({root, env: {STYK_PYTHON: '/x/python'}, platform: 'linux', probe: () => true}).command, '/x/python');
  assert.equal(venvInterpreter(path.join(root, 'missing'), 'linux'), null);
});
