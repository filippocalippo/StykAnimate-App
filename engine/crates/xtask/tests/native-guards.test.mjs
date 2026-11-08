import assert from 'node:assert/strict';
import test from 'node:test';
import {directionErrors, registryUsers, parseAllow, allowErrors, wasmPackages} from '../../../../scripts/native-guards.mjs';
import {windowsErrors, webErrors} from '../../../../scripts/native-source-guards.mjs';
import {catalogueIds, parseLimits, screenCheck} from '../../../../scripts/native-screen-guards.mjs';
import {mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('web constraints reject clocks, thread imports and calls with precise locations', () => {
  const source = `// std::thread::spawn is just a comment
use std::thread::{Builder as ThreadBuilder, spawn};
use std::time::Instant as Clock;
fn bad() { Clock::now(); std::thread::spawn(|| {}); SystemTime::now(); }
#[cfg(test)] mod tests { fn allowed() { Instant::now(); } }`;
  const errors = webErrors(source, 'engine/crates/styk-core/src/bad.rs');
  assert.equal(errors.length, 4, errors.join('\n'));
  assert.match(errors[0], /bad.rs:2: web:/);
  assert.match(errors[1], /bad.rs:4: web:/);
  assert.deepEqual(webErrors('fn good(clock: &dyn Clock) { clock.now_ns(); let s = "Instant::now()"; }', 'good.rs'), []);
  assert.equal(webErrors('use std::thread as host; fn f() { host::spawn(|| {}); }', 'bad.rs').length, 1);
});

test('test fakes cannot be enabled by a production dependency', () => {
  const m = fixture({'styk-core': ['styk-services']});
  m.packages[0].dependencies[0].features = ['test-fakes'];
  assert.match(directionErrors(m)[0].message, /only by dev-dependencies/);
  m.packages[0].dependencies[0].kind = 'dev';
  assert.deepEqual(directionErrors(m), []);
  m.packages[0].features.default = ['styk-services/test-fakes'];
  assert.match(directionErrors(m)[0].message, /production features/);
});

test('native helper exemptions require both a named helper and native cfg', () => {
  const file = 'engine/crates/styk-export/src/gpu.rs';
  const body = 'std::thread::Builder::new();';
  assert.equal(webErrors(`fn dispose() { ${body} }`, file).length, 1);
  assert.equal(webErrors(`#[cfg(not(target_arch = "wasm32"))] fn other() { ${body} }`, file).length, 1);
  assert.deepEqual(webErrors(`fn dispose() { #[cfg(not(target_arch = "wasm32"))] { ${body} } }`, file), []);
  assert.equal(webErrors(`fn dispose() { #[cfg(not(target_arch = "wasm32"))] { ${body} } ${body} }`, file).length, 1);
  assert.equal(webErrors(`#[cfg(not(target_arch = "wasm32"))] fn dispose() { ${body} }`, 'other.rs').length, 1);
});

test('a configured screenshot is rendered headlessly and comparison failure reaches the check', () => {
  mkdirSync('tmp', {recursive: true});
  const root = mkdtempSync(resolve('tmp/screen-guard-'));
  try {
    mkdirSync(join(root, 'engine/crates/styk-ui/src'), {recursive: true});
    mkdirSync(join(root, 'docs/native/screens'), {recursive: true});
    writeFileSync(join(root, 'engine/crates/styk-ui/src/screens.rs'), 'fn id() { match self { S::A => "a" } }');
    const limits = '["a"]\nreference = "ref.png"\nmax_difference = 0.01\nwidth = 10\nheight = 10';
    writeFileSync(join(root, 'docs/native/screens/limits.toml'), limits);
    assert.throws(() => screenCheck(root), /limits.toml:1: screenshot: missing reference/);
    writeFileSync(join(root, 'ref.png'), 'the injected renderer/comparator supplies the image data');
    const calls = [];
    assert.throws(() => screenCheck(root, (command, args, options) => {
      calls.push(args);
      assert.equal(options.env.STYK_BACKGROUND_WINDOW, 'headless');
      if (args.includes('image-diff')) throw new Error('difference exceeds the catalogue limit');
    }), /limits.toml:1: screenshot: a: difference exceeds/);
    assert.equal(calls.length, 3);
    assert.ok(calls[1].includes('--screen'));
    assert.equal(calls[2].at(-1), '0.01');
  } finally { rmSync(root, {recursive: true}); }
});

test('real Clippy rejects interface violations and allows test-only unwraps', () => {
  mkdirSync('tmp', {recursive: true});
  const root = mkdtempSync(resolve('tmp/clippy-guard-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "guard-violation"\nversion = "0.0.0"\nedition = "2024"\n[workspace]\n');
    const lint = readFileSync('engine/crates/styk-app/src/main.rs', 'utf8').split('\n')[0];
    assert.match(lint, /deny\(clippy::unwrap_used/);
    const source = `${lint}\nuse std::fs::File as AliasedFile;
pub fn bad(m: &std::sync::Mutex<()>, r: &std::sync::RwLock<()>, c: &std::sync::Condvar, rx: &std::sync::mpsc::Receiver<()>, h: std::thread::JoinHandle<()>) {
    None::<()>.unwrap();
    None::<()>.expect("bad");
    let _ = std::fs::read("missing");
    std::fs::read("missing");
    drop(AliasedFile::open("missing"));
    std::thread::sleep(std::time::Duration::ZERO);
    drop(m.lock());
    drop(r.read());
    drop(r.write());
    drop(c.wait(m.lock().unwrap()));
    drop(h.join());
    drop(rx.recv());
    drop(rx.recv_timeout(std::time::Duration::ZERO));
    let mut empty = &b""[..]; drop(std::io::Read::read(&mut empty, &mut [0]));
    drop(rx.iter().next());
}
pub fn file_read(file: &mut AliasedFile) {
    drop(std::io::Read::read(file, &mut [0]));
}`;
    writeFileSync(join(root, 'src/lib.rs'), source);
    const args = ['clippy', '--manifest-path', join(root, 'Cargo.toml'), '--offline', '--message-format=json'];
    const options = {encoding: 'utf8', timeout: 120000, env: {...process.env, CARGO_TARGET_DIR: resolve('engine/target/guard-fixtures'), CLIPPY_CONF_DIR: resolve('engine/guard-clippy')}};
    const result = spawnSync('cargo', args, options);
    assert.equal(result.status, 101, result.stderr);
    const diagnostics = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(d => d.reason === 'compiler-message').map(d => d.message);
    for (const code of ['clippy::unwrap_used', 'clippy::expect_used', 'clippy::let_underscore_must_use', 'unused_must_use', 'clippy::disallowed_methods', 'clippy::disallowed_types']) assert.ok(diagnostics.some(d => d.code?.code === code), `${code}: ${result.stdout}`);
    for (const line of [8,9,10,11,12,13,14,15,16,17,18,21]) assert.ok(diagnostics.some(d => d.code?.code === 'clippy::disallowed_methods' && d.level === 'error' && d.spans.some(s => s.is_primary && s.line_start === line)), `unguarded line ${line}: ${result.stdout}`);
    writeFileSync(join(root, 'src/lib.rs'), `${lint}\n#[cfg(test)] mod tests { #[test] fn permitted() { None::<()>.unwrap(); } }`);
    const clean = spawnSync('cargo', [...args, '--tests'], options);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    // Negative control: the exact violating program compiled without the guard
    // must succeed. This proves the assertions fail against the former policy.
    writeFileSync(join(root, 'src/lib.rs'), source.slice(source.indexOf('\n') + 1));
    const unguarded = spawnSync('cargo', args, options);
    assert.equal(unguarded.status, 0, unguarded.stdout + unguarded.stderr);
  } finally { rmSync(root, {recursive: true}); }
});

test('Windows source scan rejects cfgs and types with file and line', () => {
  for (const source of ['#[cfg(windows)] fn f() {}', '#[cfg(not(windows))] fn f() {}', '#[cfg(target_os = "windows")] fn f() {}', 'use windows_sys::Win32::Foundation::HWND;', 'fn f(h: HWND) {}']) {
    assert.match(windowsErrors('\n'+source, 'fixture.rs')[0], /fixture.rs:2: platform:/);
  }
});

test('source scan ignores strings, nested comments, character literals and test modules', () => {
  const source = '// windows\n/* /* HWND */ windows */\nconst S: &str = r###"cfg(windows) HWND"###;\nfn f() { let _ = \'"\'; let _ = "\\\"HWND"; a.windows(2); }\n#[cfg(test)] mod tests { #[cfg(windows)] fn f(h: HWND) {} }';
  assert.deepEqual(windowsErrors(source, 'fixture.rs'), []);
  assert.deepEqual(windowsErrors('fn f(windows: bool) { if !windows {} }', 'fixture.rs'), []);
  assert.ok(windowsErrors('#[cfg(any(test, feature = "a"))] fn f(h: HWND) {}', 'fixture.rs').length);
});

test('screen catalogue and limits reject malformed thresholds and retain pending references', () => {
  assert.deepEqual(catalogueIds('fn id() { match self { S::A => "component-sheet", } }'), ['component-sheet']);
  const text = '["component-sheet"]\nreference = ""\nmax_difference = 0.0\nwidth = 10\nheight = 10';
  assert.equal(parseLimits(text).get('component-sheet').reference, '');
  assert.throws(() => parseLimits(text.replace('0.0', '1.1')), /screenshot: invalid/);
  assert.throws(() => parseLimits(text+'\nwidth = 11'), /screenshot: invalid or duplicate/);
  assert.throws(() => parseLimits(text.replace('0.0', 'invalid')), /limits.toml:3: screenshot: invalid value/);
});

test('a screen masks the parts another chunk owns, each a rectangle inside the screen naming its owner', () => {
  const text = '["a"]\nreference = "ref.png"\nmax_difference = 0.01\nwidth = 10\nheight = 10';
  const masked = parseLimits(`${text}\nmasks = [\n  [1, 2, 3, 4, "K-cmd: the quick actions"],\n  [0, 9, 10, 1, "K-dock: the corners"],\n]`).get('a');
  assert.deepEqual(masked.masks, [[1, 2, 3, 4, 'K-cmd: the quick actions'], [0, 9, 10, 1, 'K-dock: the corners']]);
  assert.deepEqual(parseLimits(text).get('a').masks, []);
  assert.throws(() => parseLimits(`${text}\nmasks = [\n  [1, 2, 3, 4],\n]`), /a: a mask is \[x, y, width, height, "owner: what"\]/);
  assert.throws(() => parseLimits(`${text}\nmasks = [\n  [8, 8, 3, 3, "K-cmd: past the edge"],\n]`), /mask \[8, 8, 3, 3\] lies outside the screen/);
  assert.throws(() => parseLimits(`${text}\nmasks = [\n  [1, 2, 3, 4, "K-cmd"],`), /limits.toml:6: screenshot: unclosed masks/);
});

test('masked rectangles are painted alike in both images before they are compared', async () => {
  const {readPng, writePng} = await import('../../../../scripts/png.mjs');
  const {maskedCopies} = await import('../../../../scripts/native-screen-guards.mjs');
  mkdirSync('tmp', {recursive: true});
  const root = mkdtempSync(resolve('tmp/screen-mask-'));
  try {
    const image = colour => ({width: 4, height: 4, data: Buffer.from(Array.from({length: 16}, () => [...colour, 255]).flat())});
    writePng(join(root, 'ref.png'), image([0, 0, 0]));
    writePng(join(root, 'actual.png'), image([200, 0, 0]));
    const [left, right] = maskedCopies(join(root, 'ref.png'), join(root, 'actual.png'), [[0, 0, 2, 4, 'K-cmd: left half']], root, 'a');
    const [a, b] = [readPng(left), readPng(right)];
    const pixel = (img, x, y) => [...img.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 3)];
    for (let y = 0; y < 4; y++) {
      assert.deepEqual([pixel(a, 1, y), pixel(b, 1, y)], [[255, 255, 255], [255, 255, 255]], 'the masked half is the same in both');
      assert.deepEqual([pixel(a, 2, y), pixel(b, 2, y)], [[0, 0, 0], [200, 0, 0]], 'the rest is compared as captured');
    }
    assert.deepEqual(maskedCopies('r.png', 'a.png', [], root, 'b'), ['r.png', 'a.png'], 'an unmasked screen compares its captures');
  } finally { rmSync(root, {recursive: true}); }
});

function fixture(edges, registry = []) {
  const names = [...new Set([...Object.keys(edges), ...Object.values(edges).flat()])];
  return {
    workspace_members: names.filter(n => n.startsWith('styk-')),
    packages: names.map(name => ({id: name, name, source: registry.includes(name) ? 'registry+crates.io' : null, manifest_path: `${name}/Cargo.toml`, features: {}, dependencies: (edges[name] ?? []).map(name => ({name, kind: null, optional: false, source: registry.includes(name) ? 'registry+crates.io' : null}))})),
    resolve: {nodes: names.map(id => ({id, deps: (edges[id] ?? []).map(pkg => ({pkg, dep_kinds: [{kind: null}]}))}))},
  };
}

test('direction catches a toolkit hidden behind a transitive dependency', () => {
  const m = fixture({'styk-core': ['bridge'], bridge: ['iced'], iced: []});
  assert.match(directionErrors(m)[0].message, /styk-core -> bridge -> iced/);
});

test('views may reach the engine through core but may not import it directly', () => {
  const m = fixture({'styk-ui': ['styk-core'], 'styk-core': ['styk-doc'], 'styk-doc': []});
  assert.deepEqual(directionErrors(m), []);
  m.packages[0].dependencies.push({name: 'styk-doc', kind: null});
  assert.match(directionErrors(m)[0].message, /styk-ui must not depend on styk-doc/);
});

test('the app wires owners but does not import an engine directly', () => {
  assert.deepEqual(directionErrors(fixture({'styk-app': ['styk-core', 'styk-platform'], 'styk-core': ['styk-doc'], 'styk-platform': ['styk-services']})), []);
  assert.ok(directionErrors(fixture({'styk-app': ['styk-doc']})).some(e => e.rule === 'direction'));
});

test('services and platform cannot reverse the ownership graph', () => {
  for (const name of ['styk-platform', 'styk-services', 'styk-trace']) {
    assert.ok(directionErrors(fixture({[name]: ['styk-core']})).some(e => e.rule === 'direction'));
  }
});

test('Windows dependencies are confined to platform', () => {
  for (const name of ['windows', 'windows-sys', 'winapi']) {
    assert.ok(directionErrors(fixture({'styk-ui': [name]}, [name])).some(e => e.rule === 'platform'));
    assert.deepEqual(directionErrors(fixture({'styk-platform': [name]}, [name])), []);
  }
});

test('devtools must be optional and enabled only by its named app feature', () => {
  const m = fixture({'styk-app': ['styk-devtools']});
  assert.equal(directionErrors(m)[0].rule, 'devtools');
  m.packages[0].dependencies[0].optional = true;
  m.packages[0].features.devtools = ['dep:styk-devtools'];
  assert.deepEqual(directionErrors(m), []);
  m.packages[0].features.default = ['devtools'];
  assert.equal(directionErrors(m)[0].rule, 'devtools');
});

test('allow-list rejects both a new package and an additional user', () => {
  const m = fixture({'styk-core': ['serde'], 'styk-doc': ['serde'], serde: []}, ['serde']);
  assert.match(allowErrors(m, new Map())[0], /allow-list: unapproved package serde/);
  const allow = parseAllow('# owned by orchestrator\n"serde" = ["styk-core"]\n');
  assert.match(allowErrors(m, allow)[0], /styk-doc may not use serde/);
  assert.deepEqual(allowErrors(m, registryUsers(m)), []);
  assert.match(allowErrors(m, registryUsers(m), '[[package]]\nname = "unused-new-package"\nsource = "registry+crates.io"')[0], /Cargo.lock:2: allow-list: unapproved package/);
  assert.throws(() => parseAllow('serde = true'), /deps-allow.toml:1/);
  assert.throws(() => parseAllow('"serde" = [invalid]'), /deps-allow.toml:1: allow-list:/);
  assert.throws(() => parseAllow('"serde" = []\n"serde" = []'), /deps-allow.toml:2/);
});

test('wasm gate selects the engine binding, core and services without native tools', () => {
  const m = fixture({'styk-cli': ['styk-doc'], 'styk-ui': ['styk-core'], 'styk-core': ['styk-services'], 'styk-wasm': ['styk-doc']});
  assert.deepEqual(wasmPackages(m), ['styk-core', 'styk-services', 'styk-wasm']);
  assert.throws(() => wasmPackages(fixture({'styk-core': ['styk-services']})), /styk-wasm is missing/);
});
