// Runs a Python script with an interpreter that exists on this machine: the
// packaging scripts that stage the video encoder and the Windows codec helpers,
// and the development-only Pivot codec oracle (codecs/, backend/).
//
// Stock Linux ships `python3` only, stock Windows ships `py`; the npm build
// scripts used a bare `python` and failed on the former. STYK_PYTHON and an
// active environment come first, then the repository's own virtual environment,
// because that is where scripts/requirements-build.txt is installed.
//
//   node scripts/run-python.mjs scripts/stage-video-encoder.py [args...]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Interpreters to try, in order: STYK_PYTHON, an active virtual or conda environment, then the platform's usual names. */
export function pythonCandidates(env = process.env, platform = process.platform, home = os.homedir()) {
  const candidates = [];
  const add = (command, args = []) => {
    if (command && !candidates.some((item) => item.command === command)) candidates.push({ command, args });
  };
  add(env.STYK_PYTHON);
  if (env.VIRTUAL_ENV) add(path.join(env.VIRTUAL_ENV, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  if (env.CONDA_PREFIX) add(path.join(env.CONDA_PREFIX, platform === 'win32' ? 'python.exe' : 'bin/python'));
  if (platform === 'win32') {
    add('py', ['-3']);
    add('python');
    add('python3');
    // A conda install in the home directory is a guess, not the interpreter the machine put on PATH.
    for (const directory of ['miniconda3', 'anaconda3', 'miniforge3']) {
      const candidate = path.join(home, directory, 'python.exe');
      if (existsSync(candidate)) add(candidate);
    }
  } else {
    add('python3');
    add('python');
  }
  return candidates;
}
const MINIMUM = 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)';

export function venvInterpreter(root = appRoot, platform = process.platform) {
  const candidate = platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
  return existsSync(candidate) ? candidate : null;
}

function defaultProbe(command, args) {
  const result = spawnSync(command, [...args, '-c', MINIMUM], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

/** First candidate that runs and is Python 3.11 or newer, or null. */
export function resolvePython({ root = appRoot, env = process.env, platform = process.platform, home = os.homedir(), probe = defaultProbe } = {}) {
  const candidates = pythonCandidates(env, platform, home);
  if (platform === 'win32') {
    // A build machine puts the interpreter it chose first on PATH (setup-python,
    // an activated environment) and installs the build requirements into that
    // one; `py -3` may select a different Python. The desktop app tries `py`
    // first to find any Python at runtime, which is the wrong order here.
    const py = candidates.findIndex((item) => item.command === 'py'), bare = candidates.findIndex((item) => item.command === 'python' && !item.args.length);
    if (py >= 0 && bare > py) candidates.splice(py, 0, ...candidates.splice(bare, 1));
  }
  const venv = venvInterpreter(root, platform);
  if (venv && !candidates.some((item) => item.command === venv)) {
    // An explicit STYK_PYTHON stays first; the repository environment beats PATH.
    const explicit = env.STYK_PYTHON ? 1 : 0;
    candidates.splice(explicit, 0, { command: venv, args: [] });
  }
  return candidates.find((candidate) => probe(candidate.command, candidate.args)) ?? null;
}

function main() {
  const [script, ...rest] = process.argv.slice(2);
  if (!script) { console.error('Usage: node scripts/run-python.mjs <script.py> [args...]'); return 2; }
  const python = resolvePython();
  if (!python) {
    console.error('Python 3.11 or newer was not found. Install it, or set STYK_PYTHON to its executable.');
    return 1;
  }
  const result = spawnSync(python.command, [...python.args, script, ...rest], { stdio: 'inherit', cwd: appRoot, windowsHide: true });
  if (result.error) { console.error(result.error.message); return 1; }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
