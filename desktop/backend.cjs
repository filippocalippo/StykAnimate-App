'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');

function pythonCandidates(env = process.env) {
  const candidates = [];
  const add = (command, args = []) => {
    if (command && !candidates.some((item) => item.command === command)) candidates.push({ command, args });
  };
  add(env.STYK_PYTHON);
  if (env.VIRTUAL_ENV) add(path.join(env.VIRTUAL_ENV, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  if (env.CONDA_PREFIX) add(path.join(env.CONDA_PREFIX, process.platform === 'win32' ? 'python.exe' : 'bin/python'));
  if (process.platform === 'win32') {
    for (const directory of ['miniconda3', 'anaconda3', 'miniforge3']) {
      const candidate = path.join(os.homedir(), directory, 'python.exe');
      if (fs.existsSync(candidate)) add(candidate);
    }
    add('py', ['-3']);
    add('python');
    add('python3');
  } else {
    add('python3');
    add('python');
  }
  return candidates;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function startBackend({ appRoot, resourcesPath, packaged = false, onError = () => {}, log = () => {}, port: requestedPort }) {
  const port = requestedPort || await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const resourceRoot = packaged ? resourcesPath : appRoot;
  const server = path.join(resourceRoot, 'backend', 'server.py');
  const webRoot = packaged ? path.join(resourcesPath, 'web') : appRoot;
  const toolsRoot = packaged ? path.join(resourcesPath, 'tools') : path.resolve(appRoot, '..', 'tools');
  const bridgePath = packaged ? path.join(resourcesPath, 'codec_bridge.py') : path.resolve(appRoot, '..', 'StykAnimate', 'tools', 'codec_bridge.py');
  const binary = path.join(resourcesPath || appRoot, 'sidecar', 'styk-codec', process.platform === 'win32' ? 'styk-codec.exe' : 'styk-codec');
  const commands = packaged && fs.existsSync(binary)
    ? [{ command: binary, args: [] }]
    : pythonCandidates().map((candidate) => ({ command: candidate.command, args: [...candidate.args, server] }));
  const attempts = [];
  for (const candidate of commands) {
    let output = '';
    let terminated = false;
    let intentionalStop = false;
    let startupError;
    const child = spawn(candidate.command, [...candidate.args, '--host', '127.0.0.1', '--port', String(port)], {
      cwd: resourceRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', STYK_WEB_ROOT: webRoot, STYK_TOOLS_ROOT: toolsRoot, STYK_BRIDGE_PATH: bridgePath },
    });
    child.on('error', (error) => { startupError = error; terminated = true; });
    child.on('exit', (code, signal) => {
      terminated = true;
      if (child.stykReady && !intentionalStop) onError(`The Pivot codec stopped (${signal || code}). ${output.slice(-1600)}`);
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      const message = chunk.toString();
      output = (output + message).slice(-12000);
      log(message);
    });
    const deadline = Date.now() + 20000;
    while (!terminated && Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(700) });
        if (response.ok) {
          child.stykReady = true;
          return {
            origin,
            port,
            child,
            stop() { intentionalStop = true; if (!terminated) child.kill(); },
          };
        }
      } catch { /* The child is still binding its loopback socket. */ }
      await wait(90);
    }
    intentionalStop = true;
    if (!terminated) child.kill();
    attempts.push(`${candidate.command}: ${startupError?.message || output.trim() || 'Startup timed out.'}`);
  }
  throw new Error(`The Pivot codec could not start. Install Python 3.11 or newer, or set STYK_PYTHON to its executable.\n\n${attempts.join('\n\n')}`);
}

module.exports = { startBackend, pythonCandidates, availablePort };
