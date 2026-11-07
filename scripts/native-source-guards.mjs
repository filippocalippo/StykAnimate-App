import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';

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
      if (attr === 'cfg(test)' || /^cfg\(all\(test[,)]/.test(attr)) {
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

export function windowsErrors(source, file) {
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

export function sourceErrors(root) {
  const errors = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name), rel = relative(root, path).replaceAll('\\', '/');
      // Frozen evidence must never be rewritten to satisfy a new guard. All
      // integration tests are also outside the non-test Windows-code rule.
      if (rel.startsWith('engine/tests/') || /engine\/crates\/[^/]+\/tests(?:\/|$)/.test(rel) || rel.startsWith('tests/fixtures/owner-references/')) continue;
      if (rel.startsWith('engine/crates/styk-platform/')) continue;
      if (entry.isDirectory()) walk(path);
      // Standalone unit-test modules and test drivers are compiled only by tests.
      else if (/^(?:tests|.*_tests)\.rs$/.test(entry.name) || rel === 'engine/crates/styk-design/src/widgets/testing.rs') continue;
      else if (entry.name.endsWith('.rs')) {
        const source = readFileSync(path, 'utf8');
        errors.push(...windowsErrors(source, rel));
        // Binaries, tracing and host tools are not portable engine libraries.
        if (!/engine\/crates\/(?:styk-app|styk-cli|styk-devtools|styk-text-check|styk-trace|xtask)\//.test(rel) && !rel.includes('/src/bin/')) {
          // This real-time clock exists only for explicitly enabled test fakes;
          // production clocks are supplied by styk-platform.
          // StdThreads has only codec/edit test callers; production injects Fanout.
          if (!['engine/crates/styk-services/src/clock/test_fakes.rs', 'engine/crates/styk-doc/src/fanout/test_fakes.rs'].includes(rel)) errors.push(...webErrors(source, rel));
        }
      }
    }
  }
  walk(join(root, 'engine/crates'));
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
    const clock = names.has(t.value) && ts[i + 1]?.value === ':' && ts[i + 2]?.value === ':' && ts[i + 3]?.value === 'now';
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
