// Cargo metadata is authoritative, including optional and target-specific declarations.
// Node is already required by xtask's design generator; no additional packages are used.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceErrors} from './native-source-guards.mjs';
import {screenCheck} from './native-screen-guards.mjs';

const frontend = new Set(['styk-app', 'styk-ui', 'styk-design', 'styk-devtools', 'styk-platform', 'styk-text-check', 'xtask']);
const toolkit = name => /^(iced|winit|cryoglyph)([_-]|$)/.test(name);
const nativeEdges = {
  'styk-app': ['styk-core', 'styk-ui', 'styk-design', 'styk-platform', 'styk-devtools', 'styk-trace', 'styk-text-check'],
  'styk-ui': ['styk-core', 'styk-design'],
  // Shared field widgets use core's portable focus and text state (S2a).
  'styk-design': ['styk-core'],
  'styk-devtools': ['styk-core', 'styk-ui', 'styk-design', 'styk-trace'],
  'styk-platform': ['styk-services'],
  'styk-services': [],
  'styk-trace': [],
};

export function directionErrors(metadata) {
  const members = new Set(metadata.workspace_members);
  const local = metadata.packages.filter(p => members.has(p.id));
  const byId = new Map(metadata.packages.map(p => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
  const errors = [];
  for (const p of local) {
    for (const [feature, entries] of Object.entries(p.features)) {
      if (entries.some(e => e === 'test-fakes' || /\/test-fakes$/.test(e))) errors.push({package: p, dependency: feature, rule: 'web', message: 'production features may not activate test-fakes'});
    }
    for (const d of p.dependencies.filter(d => d.kind !== 'dev')) {
      if (d.features?.includes('test-fakes')) errors.push({package: p, dependency: d.name, rule: 'web', message: 'test-fakes may be enabled only by dev-dependencies'});
      if (!frontend.has(p.name) && !['styk-core', 'styk-cli'].includes(p.name) && d.name === 'styk-core') {
        errors.push({package: p, dependency: d.name, rule: 'direction', message: `${p.name} must not depend on the application core`});
      }
      if (nativeEdges[p.name] && d.name.startsWith('styk-') && !nativeEdges[p.name].includes(d.name)) {
        errors.push({package: p, dependency: d.name, rule: 'direction', message: `${p.name} must not depend on ${d.name}`});
      }
      if (['windows', 'windows-sys', 'winapi'].includes(d.name) && p.name !== 'styk-platform') {
        errors.push({package: p, dependency: d.name, rule: 'platform', message: `${d.name} belongs only in styk-platform`});
      }
      if (d.name === 'styk-devtools') {
        const features = p.features;
        if (p.name !== 'styk-app' || !d.optional || !features.devtools?.includes('dep:styk-devtools') ||
            Object.entries(features).some(([f, entries]) => f !== 'devtools' && entries.some(e => /^(dep:)?styk-devtools([/?]|$)|^devtools$/.test(e)))) {
          errors.push({package: p, dependency: d.name, rule: 'devtools', message: 'styk-devtools is allowed only through styk-app/devtools'});
        }
      }
    }
    if (nativeEdges[p.name]) {
      const visited = new Set();
      const walk = (id, path) => {
        if (visited.has(id)) return;
        visited.add(id);
        for (const edge of nodes.get(id)?.deps ?? []) {
          if (edge.dep_kinds.every(k => k.kind === 'dev')) continue;
          const next = byId.get(edge.pkg);
          if (!next) throw new Error(`unresolved metadata package ${edge.pkg}`);
          if (next.name.startsWith('styk-') && !nativeEdges[p.name].includes(next.name)) {
            // A permitted front-end module may in turn own its documented edges.
            if (p.name === 'styk-devtools' && ['styk-ui', 'styk-design'].includes(path.at(-1))) continue;
            errors.push({package: p, dependency: path[1] ?? next.name, rule: 'direction', message: `${[...path, next.name].join(' -> ')} crosses an ownership boundary`});
          } else if (next.name !== 'styk-core' && !(p.name === 'styk-app' && nativeEdges[p.name].includes(next.name))) walk(next.id, [...path, next.name]);
        }
      };
      walk(p.id, [p.name]);
    }
    if (frontend.has(p.name)) continue;
    const visit = (id, path, seen) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const edge of nodes.get(id)?.deps ?? []) {
        if (edge.dep_kinds.every(k => k.kind === 'dev')) continue;
        const next = byId.get(edge.pkg);
        if (!next) throw new Error(`unresolved metadata package ${edge.pkg}`);
        // Q2: deps.rs separately validates this non-default feature and its closure.
        if (p.name === 'styk-cli' && id === p.id && ['styk-core', 'styk-services', 'styk-platform'].includes(next.name)) continue;
        if (frontend.has(next.name) || toolkit(next.name)) {
          errors.push({package: p, dependency: path[1] ?? next.name, rule: 'direction', message: `${[...path, next.name].join(' -> ')} reaches the front end`});
        } else visit(next.id, [...path, next.name], seen);
      }
    };
    visit(p.id, [p.name], new Set());
  }
  return errors;
}

// All crates.io packages, including transitive packages. Users are package names,
// not versions: a version update cannot silently introduce a new package or edge.
export function registryUsers(metadata) {
  const packages = new Map(metadata.packages.map(p => [p.id, p]));
  const users = new Map(metadata.packages.filter(p => p.source?.startsWith('registry+')).map(p => [p.name, new Set()]));
  for (const node of metadata.resolve.nodes) {
    for (const edge of node.deps) {
      const dependency = packages.get(edge.pkg);
      if (dependency.source?.startsWith('registry+')) users.get(dependency.name).add(packages.get(node.id).name);
    }
  }
  // Unresolved optional declarations must also be governed.
  for (const p of metadata.packages) for (const d of p.dependencies) {
    if (d.source?.startsWith('registry+') && users.has(d.name)) users.get(d.name).add(p.name);
  }
  return users;
}

export function parseAllow(text) {
  const result = new Map();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^("[^"]+")\s*=\s*(\[.*\])$/.exec(line);
    if (!match) throw new Error(`engine/deps-allow.toml:${i + 1}: allow-list: invalid entry`);
    const name = JSON.parse(match[1]);
    let users;
    try { users = JSON.parse(match[2]); }
    catch { throw new Error(`engine/deps-allow.toml:${i + 1}: allow-list: invalid users`); }
    if (result.has(name) || !Array.isArray(users) || users.some(u => typeof u !== 'string')) throw new Error(`engine/deps-allow.toml:${i + 1}: allow-list: invalid users`);
    result.set(name, new Set(users));
  }
  return result;
}

export function registryNamesFromLock(lock) {
  return lock.split('[[package]]').filter(block => /^source = "registry\+/m.test(block)).map(block => /^name = "([^"]+)"/m.exec(block)?.[1]).filter(Boolean);
}

export function allowErrors(metadata, allow, lock = '', allowSource = '') {
  const errors = [];
  const actual = registryUsers(metadata);
  for (const name of registryNamesFromLock(lock)) if (!actual.has(name)) actual.set(name, new Set());
  for (const [name, users] of actual) {
    const line = Math.max(1, lock.split(/\r?\n/).findIndex(l => l === `name = "${name}"`) + 1);
    if (!allow.has(name)) errors.push(`engine/Cargo.lock:${line}: allow-list: unapproved package ${name}`);
    else for (const user of users) if (!allow.get(name).has(user)) {
      const allowLine = Math.max(1, allowSource.split(/\r?\n/).findIndex(l => l.trimStart().startsWith(JSON.stringify(name))) + 1);
      errors.push(`engine/deps-allow.toml:${allowLine}: allow-list: ${user} may not use ${name}`);
    }
  }
  return errors;
}

export function wasmPackages(metadata) {
  const members = new Set(metadata.workspace_members);
  return metadata.packages.filter(p => members.has(p.id) && !frontend.has(p.name) && p.name !== 'styk-cli').map(p => p.name).sort();
}

export function allowSealErrors(current, approved) {
  const errors = [];
  if (!current.split(/\r?\n/).some(line => line.startsWith('#') && line.includes('Only the orchestrator may edit this file.'))) errors.push('engine/deps-allow.toml:1: allow-list: required ownership header is missing');
  if (approved === null || current.replaceAll('\r\n','\n') !== approved.replaceAll('\r\n','\n')) errors.push('engine/deps-allow.toml:1: allow-list: differs from the merge base with native-app; the orchestrator approves dependency changes at the merge');
  return errors;
}

export function approvedAllow(root) {
  const git = args => execFileSync('git', args, {cwd:root, encoding:'utf8', stdio:['ignore','pipe','pipe']});
  const base = git(['merge-base','HEAD','native-app']).trim();
  if (!git(['ls-tree','--name-only',base,'--','engine/deps-allow.toml']).trim()) return null;
  return git(['show',`${base}:engine/deps-allow.toml`]);
}

export function check(root, wasm = false) {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', 'engine/Cargo.toml', '--format-version', '1', '--all-features', '--locked', '--offline'], {cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}));
  const errors = directionErrors(metadata).map(e => {
    const manifest = readFileSync(e.package.manifest_path, 'utf8');
    const line = manifest.split(/\r?\n/).findIndex(l => l.includes(e.dependency)) + 1;
    return `${relative(root, e.package.manifest_path)}:${Math.max(1, line)}: ${e.rule}: ${e.message}`;
  });
  const allowSource = readFileSync(resolve(root, 'engine/deps-allow.toml'), 'utf8');
  const approvalErrors = allowSealErrors(allowSource, approvedAllow(root));
  errors.push(...allowErrors(metadata, parseAllow(allowSource), readFileSync(resolve(root, 'engine/Cargo.lock'), 'utf8'), allowSource));
  errors.push(...sourceErrors(root));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`metadata: dependency direction and registry allow-list pass (${metadata.packages.length} packages)`);
  console.log('source: Windows isolation, view boundaries, macro unwrap/expect and web Clock/Spawner constraints pass');
  // Check both builds: cfg(not(feature = "devtools")) must not hide violations.
  for (const features of ['styk-design/widgets', 'styk-app/devtools,styk-design/widgets']) {
    execFileSync('cargo', ['clippy', '--manifest-path', 'engine/Cargo.toml', '--locked', '--no-deps', '-p', 'styk-app', '-p', 'styk-ui', '-p', 'styk-devtools', '-p', 'styk-design', '-p', 'styk-text-check', '--lib', '--bins', '--features', features], {
      cwd: root, stdio: 'inherit', env: {...process.env, CLIPPY_CONF_DIR: resolve(root, 'engine/guard-clippy')},
    });
  }
  console.log('interface: clippy guards pass');
  screenCheck(root, execFileSync, metadata.target_directory);
  // Still verify every independent rule when a branch awaits merge approval.
  if (approvalErrors.length) throw new Error(approvalErrors.join('\n'));
  if (wasm) {
    const args = ['check', '--manifest-path', 'engine/Cargo.toml', '--locked', '--lib', '--target', 'wasm32-unknown-unknown'];
    for (const name of wasmPackages(metadata)) args.push('-p', name);
    execFileSync('cargo', args, {cwd: root, stdio: 'inherit'});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(resolve(process.argv[2] ?? '.'), process.argv.includes('--wasm')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
