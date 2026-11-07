import {readFileSync, readdirSync} from 'node:fs';
import {join, relative, dirname, basename} from 'node:path';

// A token scanner, not a grep: comments (including nested block comments), raw
// strings, ordinary strings and character literals cannot introduce code.
export function tokens(source) {
  const out = [];
  let i = 0, line = 1;
  const advance = end => { line += (source.slice(i, end).match(/\n/g) ?? []).length; i = end; };
  while (i < source.length) {
    if (/\s/.test(source[i])) { advance(i + 1); continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); advance(end < 0 ? source.length : end); continue; }
    if (source.startsWith('/*', i)) {
      let end = i + 2, depth = 1;
      while (end < source.length && depth) {
        if (source.startsWith('/*', end)) { depth++; end += 2; }
        else if (source.startsWith('*/', end)) { depth--; end += 2; }
        else end++;
      }
      if (depth) throw new Error(`line ${line}: unterminated comment`);
      advance(end); continue;
    }
    const raw = /^(?:br|cr|r)(#*)"/.exec(source.slice(i));
    if (raw) {
      const end = source.indexOf('"' + raw[1], i + raw[0].length);
      if (end < 0) throw new Error(`line ${line}: unterminated raw string`);
      out.push({value: source.slice(i + raw[0].length, end), string: true, line});
      advance(end + 1 + raw[1].length); continue;
    }
    if (source[i] === '"' || /^[bc]"/.test(source.slice(i, i + 2))) {
      const start = i + (source[i] === '"' ? 1 : 2);
      let end = start;
      while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      if (end >= source.length) throw new Error(`line ${line}: unterminated string`);
      out.push({value: source.slice(start, end), string: true, line}); advance(end + 1); continue;
    }
    const char = /^(?:b)?'(?:\\(?:u\{[^}]+\}|x[\da-fA-F]{2}|.)|[^'\\])'/u.exec(source.slice(i));
    if (char) { advance(i + char[0].length); continue; }
    const ident = /^(?:r#)?[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i));
    const value = ident ? ident[0].replace(/^r#/, '') : source[i];
    out.push({value, string: false, line}); advance(i + (ident?.[0].length ?? 1));
  }
  return out;
}

export function productionTokens(source) {
  const input = tokens(source), out = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i].value === '#' && input[i + 1]?.value === '[') {
      let end = i + 2;
      while (end < input.length && input[end].value !== ']') end++;
      const attr = input.slice(i + 2, end).map(t => t.value).join('');
      // Only cfg(test) and all(test, ...) are definitely test-only; not(test)
      // and any(test, feature) still contain production code.
      if (attr.startsWith('cfg(') && requiresTest(attr.slice(4, -1))) {
        let cursor = end + 1;
        while (cursor < input.length && !['{', ';'].includes(input[cursor].value)) cursor++;
        if (input[cursor]?.value === '{') {
          let depth = 1;
          while (++cursor < input.length && depth) {
            if (!input[cursor].string && input[cursor].value === '{') depth++;
            if (!input[cursor].string && input[cursor].value === '}') depth--;
          }
          i = cursor - 1;
        } else i = cursor;
        continue;
      }
    }
    out.push(input[i]);
  }
  return out;
}

// Third-party forks own their target predicates and native worker implementations.
// Application guards do not rewrite vendor/ (S2t cosmic-text/cryoglyph/iced).
const vendorSource = file => file.replaceAll('\\', '/').startsWith('vendor/');

export function windowsErrors(source, file) {
  if (vendorSource(file)) return [];
  const ts = productionTokens(source), errors = [];
  const winType = /^(windows_sys|winapi|Win32\w*|HWND|HANDLE|HMODULE|HINSTANCE|HRESULT|DWORD|LPCWSTR|LPWSTR|WPARAM|LPARAM|LRESULT)$/;
  const cfg = new Set();
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].string || !['cfg', 'cfg_attr'].includes(ts[i].value)) continue;
    let start = i + 1;
    if (ts[start]?.value === '!') start++;
    if (ts[start]?.value !== '(') continue;
    let depth = 1;
    for (let j = start + 1; j < ts.length && depth; j++) {
      if (!ts[j].string && ts[j].value === '(') depth++;
      if (!ts[j].string && ts[j].value === ')') depth--;
      cfg.add(j);
    }
  }
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.string) continue;
    const windows = t.value === 'windows' && (cfg.has(i) || (ts[i + 1]?.value === ':' && ts[i + 2]?.value === ':'));
    if (winType.test(t.value) || windows || (cfg.has(i) && t.value === 'target_os' && ts[i + 1]?.value === '=' && ts[i + 2]?.value === 'windows')) {
      errors.push(`${file}:${t.line}: platform: Windows code belongs in styk-platform (${t.value})`);
    }
  }
  return errors;
}

// A small declaration scan: filenames never establish test-only status.
function requiresTest(expr) {
  if (expr === 'test') return true;
  const m = /^(all|any)\((.*)\)$/.exec(expr);
  if (!m) return false;
  let depth = 0, start = 0; const args = [];
  for (let i = 0; i <= m[2].length; i++) {
    const c = m[2][i];
    if (c === '(') depth++; if (c === ')') depth--;
    if (i === m[2].length || c === ',' && depth === 0) { if (i > start) args.push(m[2].slice(start,i)); start = i + 1; }
  }
  return args.length > 0 && (m[1] === 'all' ? args.some(requiresTest) : args.every(requiresTest));
}

function moduleDeclarations(source, file) {
  const ts = tokens(source), production = new Set(productionTokens(source).filter(t => t.value === 'mod').map(t => t.line));
  const out = [];
  function scan(start, end, dir) {
    let override;
    for (let i = start; i < end; i++) {
      if (ts[i].string) continue;
      if (ts[i].value === '#' && ts[i+1]?.value === '[') {
        let stop = i+2; while (stop < end && ts[stop].value !== ']') stop++;
        if (ts[i+2]?.value === 'path' && ts[i+3]?.value === '=' && ts[i+4]?.string) override = ts[i+4].value;
        i = stop; continue;
      }
      if (ts[i].value !== 'mod') { if (['fn','struct','enum','impl','use'].includes(ts[i].value)) override = undefined; continue; }
      const name = ts[i+1]?.value, next = ts[i+2]?.value;
      if (next === ';') out.push({candidates: override ? [join(dirname(file), override)] : [join(dir, name+'.rs'), join(dir,name,'mod.rs')], test: !production.has(ts[i].line)});
      if (next === '{') {
        let stop = i+3, depth = 1;
        while (stop < end && depth) { if (!ts[stop].string) { if(ts[stop].value === '{')depth++; if(ts[stop].value === '}')depth--; } stop++; }
        scan(i+3, stop-1, join(dir,name)); i = stop-1;
      }
      override = undefined;
    }
  }
  const dir = ['lib.rs','main.rs','mod.rs'].includes(basename(file)) ? dirname(file) : join(dirname(file),basename(file,'.rs'));
  scan(0,ts.length,dir); return out;
}

export function interfaceErrors(source, file) {
  if (vendorSource(file)) return [];
  const ts = productionTokens(source), errors = [];
  for (let i=0;i<ts.length;i++) if (!ts[i].string && ts[i].value === '.' && ['unwrap','expect'].includes(ts[i+1]?.value) && ts[i+2]?.value === '(') {
    errors.push(file+':'+ts[i].line+': interface: .'+ts[i+1].value+' is forbidden, including local macro bodies');
  }
  return errors;
}

export function boundaryErrors(source, file) {
  if (vendorSource(file)) return [];
  const ts = productionTokens(source), errors = [];
  const engine = /^styk_(?:alloc|doc|draw|drawing|edit|engine|eval|export|formats|math|piv|raster|render|wasm)$/;
  const views = /engine\/crates\/styk-(ui|devtools)\//.test(file);
  const platform = file.includes('/styk-platform/');
  const windowsNames = new Set(['windows','windows_sys','winapi']);
  const coreNames = new Set(['styk_core']);
  // Local use declarations suffice for ordinary aliases; this is not a resolver.
  for (let i=0;i<ts.length;i++) if (ts[i].value === 'use') {
    let end=i; while(end<ts.length && ts[end].value!==';')end++;
    const declaration = ts.slice(i,end);
    if(!['crate','self','super'].includes(declaration[1]?.value) && declaration.some(t=>!t.string && windowsNames.has(t.value))) for(const t of declaration) if(!t.string && /^[A-Za-z_]/.test(t.value)) windowsNames.add(t.value);
    if(ts[i+1]?.value==='styk_core' && ts[i+2]?.value==='as') coreNames.add(ts[i+3]?.value);
  }
  for(let i=0;i<ts.length;i++) {
    const t=ts[i]; if(t.string)continue;
    if(views && engine.test(t.value)) errors.push(file+':'+t.line+': views: direct engine paths are forbidden');
    if(views && coreNames.has(t.value)) {
      let end=i+1; while(end<ts.length && ![';',')','='].includes(ts[end].value))end++;
      if(ts.slice(i+1,end).some(t=>!t.string && t.value==='engine')) errors.push(file+':'+t.line+': views: styk_core::engine is forbidden');
    }
    if(file.includes('/styk-core/') && !/\/src\/engine(?:\.rs|\/)/.test(file) && t.value==='pub' && ts[i+1]?.value==='use') {
      let end=i+2; while(end<ts.length && ts[end].value!==';')end++;
      const item=ts.slice(i,end+1);
      if(item.some(t=>!t.string && engine.test(t.value))) errors.push(file+':'+t.line+': core-api: engine re-exports belong in styk_core::engine');
    }
    if(platform && t.value==='pub') {
      let end=i+1; while(end<ts.length && ![';','{'].includes(ts[end].value))end++;
      // Include brace groups in pub use declarations.
      if(ts[i+1]?.value==='use') { end=i+1; while(end<ts.length && ts[end].value!==';')end++; }
      const item=ts.slice(i+1,end);
      // A crate-local wrapper (e.g. crate::windows::chrome::Chrome) is not an OS-crate item.
      if(['use','type'].includes(item[0]?.value) && !(item[0]?.value==='use' && ['crate','self','super'].includes(item[1]?.value)) && item.slice(1).some(t=>!t.string && windowsNames.has(t.value))) errors.push(file+':'+t.line+': platform-api: public Windows re-exports and aliases are forbidden');
    }
  }
  return errors;
}

export function sourceErrors(root) {
  const files = new Map(), errors = [];
  function walk(dir) {
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      const path=join(dir,entry.name), rel=relative(root,path).replaceAll('\\','/');
      // Frozen evidence, integration fixtures and benchmark harnesses stay untouched.
      if(/\/(tests|benches)(\/|$)/.test(rel))continue;
      if(entry.isDirectory())walk(path); else if(entry.name.endsWith('.rs'))files.set(path,readFileSync(path,'utf8'));
    }
  }
  // vendor/ is intentionally outside this first-party source walk (see vendorSource).
  walk(join(root,'engine/crates'));
  const incoming=new Map();
  for(const [path,source] of files) for(const decl of moduleDeclarations(source,path)) {
    const target=decl.candidates.find(p=>files.has(p)); if(!target)continue;
    if(!incoming.has(target))incoming.set(target,[]); incoming.get(target).push({parent:path,test:decl.test});
  }
  const tests=new Set(); let changed=true;
  while(changed) { changed=false; for(const [path,decls] of incoming) if(!tests.has(path) && decls.every(d=>d.test||tests.has(d.parent))) { tests.add(path); changed=true; } }
  for(const [path,source] of files) {
    if(tests.has(path))continue;
    const rel=relative(root,path).replaceAll('\\','/');
    errors.push(...boundaryErrors(source,rel));
    if(rel.includes('/styk-platform/'))continue;
    errors.push(...windowsErrors(source,rel));
    if(/\/styk-(ui|app|devtools)\//.test(rel) || /\/styk-design\/src\/widgets(?:\.rs|\/)/.test(rel) || rel.includes('/styk-text-check/src/pen_lab/')) errors.push(...interfaceErrors(source,rel));
    if(!/engine\/crates\/(?:styk-app|styk-cli|styk-devtools|styk-text-check|styk-trace|xtask)\//.test(rel) && !rel.includes('/src/bin/')) errors.push(...webErrors(source,rel));
  }
  return errors;
}

// Each native exception must ALSO be within cfg(not(target_arch = "wasm32")).
// GPU disposal drops in place on web; polling is driven by web mapping callbacks.
// The optional edit profiler has explicit no-op scope/take implementations on web.
const nativeHelpers = new Map([
  ['engine/crates/styk-export/src/gpu.rs', ['dispose', 'spawn_poller']],
  ['engine/crates/styk-edit/src/prof.rs', ['native']],
]);

export function webErrors(source, file) {
  if (vendorSource(file)) return [];
  const ts = productionTokens(source), native = [], helpers = [], errors = [];
  function body(start) {
    let open = start;
    while (open < ts.length && !['{', ';'].includes(ts[open].value)) open++;
    if (ts[open]?.value !== '{') return [open, open];
    let end = open, depth = 1;
    while (++end < ts.length && depth) {
      if (ts[end].string) continue;
      if (ts[end].value === '{') depth++;
      if (ts[end].value === '}') depth--;
    }
    return [open, end];
  }
  const names = new Set(['Instant', 'SystemTime']), threads = new Set(['thread']);
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].value === 'type' && ts[i+2]?.value === '=') { let end=i+3; while(end<ts.length && ts[end].value!==';')end++; if(ts.slice(i+3,end).some(t=>!t.string && names.has(t.value))) names.add(ts[i+1]?.value); }
    if (names.has(ts[i].value) && ts[i + 1]?.value === 'as') names.add(ts[i + 2]?.value);
    if (threads.has(ts[i].value) && ts[i + 1]?.value === 'as') threads.add(ts[i + 2]?.value);
    if (['fn', 'mod'].includes(ts[i].value) && nativeHelpers.get(file)?.includes(ts[i + 1]?.value)) helpers.push(body(i + 2));
    if (ts[i].value === '#' && ts[i + 1]?.value === '[') {
      let end = i + 2;
      while (end < ts.length && ts[end].value !== ']') end++;
      if (ts.slice(i + 2, end).map(t => t.value).join('') === 'cfg(not(target_arch=wasm32))') native.push(body(end + 1));
    }
  }
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.string) continue;
    const after = ts[i+1]?.value === '>' ? i+2 : i+1;
    const clock = names.has(t.value) && ts[after]?.value === ':' && ts[after+1]?.value === ':' && ts[after+2]?.value === 'now';
    // Also reject imports (including renamed imports), so an alias cannot hide a spawn.
    let thread = false;
    if (threads.has(t.value) && ts[i + 1]?.value === ':' && ts[i + 2]?.value === ':') {
      let end = i + 3;
      if (ts[end]?.value === '{') { while (end < ts.length && ts[end].value !== '}') end++; }
      thread = ts.slice(i + 3, end + 1).some(x => !x.string && ['spawn', 'Builder', '*'].includes(x.value));
    }
    if (!clock && !thread) continue;
    if (native.some(([a,b]) => i > a && i < b) && helpers.some(([a,b]) => i > a && i < b)) continue;
    errors.push(`${file}:${t.line}: web: use injected Clock/Spawner, not ${clock ? t.value + '::now' : 'thread spawn/Builder'}`);
  }
  return errors;
}
