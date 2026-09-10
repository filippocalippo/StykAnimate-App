import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.dirname(appRoot);
const { availablePort } = createRequire(import.meta.url)('../desktop/backend.cjs');
const binary = path.join(appRoot, 'build', 'sidecar', 'styk-codec', process.platform === 'win32' ? 'styk-codec.exe' : 'styk-codec');
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
let output = '', exited = false;
const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port)], {
  cwd: appRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, STYK_WEB_ROOT: appRoot, STYK_TOOLS_ROOT: path.join(appRoot, 'codecs'), STYK_BRIDGE_PATH: path.join(appRoot, 'codecs', 'codec_bridge.py') },
});
child.on('error', error => { output += error.message; exited = true; });
child.on('exit', () => { exited = true; });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
try {
  let health;
  for (let attempt = 0; attempt < 200 && !exited; attempt++) {
    try { const response = await fetch(`${origin}/api/health`); if (response.ok) { health = await response.json(); break; } }
    catch { /* Wait for the standalone interpreter to bind. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!health) throw new Error(`The frozen codec did not start.\n${output}`);
  assert.equal(health.jsonEncoder, 'orjson', 'A release sidecar must use the compiled JSON encoder.');
  assert.equal(health.nativeFrameScanner, 'cpp', 'A release sidecar must load the bundled C++ PIV scanner.');
  const checks = [];
  for (const filename of ['Samples.stk', 'Goku_Broly_Movie_by_Killer1.piv']) {
    const fixture = path.join(workspace, filename);
    try { await access(fixture); } catch { continue; }
    const original = await readFile(fixture);
    const response = await fetch(`${origin}/api/import?filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: original });
    assert.equal(response.status, 200, `Frozen import failed for ${filename}`);
    const imported = await response.json();
    assert.ok(imported.document?.keyframes?.length);
    const result = { filename, bytes: original.length, keyframes: imported.document.keyframes.length, decodeMs: imported.timings?.decode_ms };
    if (filename.endsWith('.piv')) {
      const exported = await fetch(`${origin}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: imported.sourceId, document: imported.document, format: 'piv', filename }) });
      assert.equal(exported.status, 200);
      const bytes = Buffer.from(await exported.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(original).digest('hex'));
      result.byteExact = true;
    }
    checks.push(result);
  }
  const evidence = { verifiedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, standalone: true, health, checks };
  await mkdir(path.join(appRoot, 'artifacts'), { recursive: true });
  await writeFile(path.join(appRoot, 'artifacts', 'sidecar-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { if (!exited) child.kill(); }
