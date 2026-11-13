/**
 * Stack lines through our own code, for statistics' `problem` reports (docs/STATISTICS.md, "Problems").
 *
 * A JavaScript line is kept as `function src/<path>:<line>` when its script is one of ours: a module of this repository
 * loaded from source (its URL's path starts with /src/), or a file of the bundle (scripts/build-app.mjs), whose lines are
 * read back to their module through the bundle's line table (`loadFrameTables`). A line of anything else (a browser
 * extension, a library, the browser itself) is left out. An engine line is the Rust function's name, which the
 * WebAssembly build keeps (decision 10), without its hash. Nothing else of a stack leaves: no arguments, no URLs.
 */
import {stackFrame} from './schema.mjs';

const MAX_LINES = 12;
/** "    at name (url:line:col)", "    at url:line:col", "    at async name (url…)". */
const V8_LINE = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?$/;
/** A WebAssembly line: "    at name (wasm://…:wasm-function[7]:0x1f)" or "    at url.wasm:wasm-function[7]:0x1f". */
const WASM_LINE = /^\s*at (?:(.+?) \()?\S*?(?:wasm:\/\/\S+|\.wasm):wasm-function\[\d+\]:0x[0-9a-f]+\)?$/i;
/** The panic machinery and the binding's glue, which every engine panic shows and none explains. */
const ENGINE_GLUE = /^(?:std|core|alloc|panic_unwind|panic_abort|wasm_bindgen|js_sys|web_sys|console_error_panic_hook|__rust|__rdl|__rg|rust_begin_unwind|rust_panic)(?:::|$)|^__wbg|^__wbindgen|panic|::start::|::\{\{closure\}\}$/;

/** The bundle's line tables once loaded (`loadFrameTables`), or null (a source run has none, and needs none). */
let frameTables = null, loading = null;

/**
 * Loads the bundle's line tables (scripts/build-app.mjs writes src/frame-map.json) the first time a problem is described: nothing
 * reads them at start. Resolves to the tables, or null where there are none.
 */
export function loadFrameTables(url = globalThis.location?.origin ? new URL('/src/frame-map.json', globalThis.location.origin) : null) {
  loading ??= !url || typeof fetch !== 'function' ? Promise.resolve(null)
    : fetch(url).then(response => response.ok ? response.json() : null).catch(() => null).then(tables => { frameTables = tables; return tables; });
  return loading;
}

/** Where a bundled file's `line` came from: `{module, line}` for a line of one of our modules, null for a line of anything else,
 * undefined for a file without a table. */
export function bundledLine(file, line, tables = frameTables) {
  const table = tables?.[file];
  if (!table) return undefined;
  for (const run of table.runs) {
    const last = run[1];
    if (line > last || line < run[2]) continue;
    let i = run.length - 2;
    while (run[i] > line) i -= 2;
    return {module: table.modules[run[0]], line: run[i + 1] + line - run[i]};
  }
  return null;
}

/** The module path inside this repository a script URL names, or null for a script that is not ours: one the app's own origin serves
 * from /src/. */
function ourModule(url) {
  let pathname;
  try {
    const parsed = new URL(url);
    if (globalThis.location?.origin && parsed.origin !== globalThis.location.origin) return null;
    pathname = parsed.pathname;
  } catch { return null; }
  if (!pathname.startsWith('/src/') || /\/(?:node_modules|vendor|devtools)\//.test(pathname)) return null;
  return pathname.slice(1);
}

/** A JavaScript function name as a stack line may carry it ("Object.render", "async loop", "new Stage"). */
const functionName = name => (name ?? '').replace(/^(?:async |new )/, '').replace(/^Object\./, '').replace(/ \[as [^\]]+\]$/, '');

/** A Rust function's name from a WebAssembly line, without its hash and generic arguments. */
export function engineFunction(name) {
  let plain = String(name ?? '').replace(/^.*\.wasm\./, '').replace(/::h[0-9a-f]{16}$/, '');
  // Generic arguments go, innermost first; "<Type as Trait>::f" is the type's "Type::f".
  for (let previous = ''; previous !== plain;) { previous = plain; plain = plain.replace(/<([^<>]*)>/g, (_, inner) => inner.includes(' as ') ? inner.split(' as ')[0] : ''); }
  plain = plain.replace(/\s+/g, '');
  return plain && !ENGINE_GLUE.test(plain) ? plain.slice(-96) : null;
}

/** One stack line kept, or null. */
function line(text, tables) {
  const wasm = WASM_LINE.exec(text);
  if (wasm) { const name = engineFunction(wasm[1]); return name ? stackFrame(name, '') : null; }
  const match = V8_LINE.exec(text);
  if (!match) return null;
  const [, fn, url, number] = match, row = Number(number);
  const file = url.slice(url.lastIndexOf('/') + 1).split('?')[0];
  // A bundled app has a table for each file with a line of ours: a file without one is a library's. A run from source has no tables.
  const bundled = tables ? bundledLine(file, row, tables) : undefined, module = tables ? null : ourModule(url);
  const place = bundled ? `${bundled.module}:${bundled.line}` : module && `${module}:${row}`;
  return place ? stackFrame(functionName(fn), place) : null;
}

/**
 * The lines of `stack` (an Error's stack text) through our own code, outermost last, at most 12, without repeats of the
 * same line in a row (a recursion). `tables` is the bundle's line table (tests pass their own).
 */
export function ourStack(stack, {tables = frameTables, limit = MAX_LINES} = {}) {
  const lines = [];
  for (const text of String(stack ?? '').split('\n')) {
    const kept = line(text, tables);
    if (kept && kept !== lines.at(-1)) lines.push(kept);
    if (lines.length >= limit) break;
  }
  return lines;
}

/** "StykAnimate engine panic: …", and the Pivot codec's and the drawing engine's: the hooks in engine/crates/*-wasm. */
const PANIC = /^StykAnimate (?:engine|Pivot codec|drawing engine) panic: /;
export const isPanicText = text => typeof text === 'string' && PANIC.test(text);

/**
 * What an engine panic's text says, for a `problem` of type `engine`: the message (still to be cleaned), and the Rust file
 * and line as `<crate>/src/<file>.rs:<line>` (never the path it was built at). `stack` is a JavaScript stack taken while the
 * hook ran: its WebAssembly lines name the functions the panic came through.
 */
export function panicDetails(text, stack = '') {
  const body = String(text ?? '').replace(PANIC, '');
  // Rust prints "panicked at <file>:<line>:<column>:\n<message>" (older: "panicked at '<message>', <file>:<line>:<column>").
  const modern = /panicked at (.+?):(\d+):\d+:\s*([\s\S]*)$/.exec(body), older = /panicked at '([\s\S]*)', (.+?):(\d+):\d+\s*$/.exec(body);
  const [file, row, message] = modern ? [modern[1], modern[2], modern[3]] : older ? [older[2], older[3], older[1]] : ['', '', body];
  const at = file.replace(/\\/g, '/').lastIndexOf('/src/');
  const crate = at > 0 ? file.replace(/\\/g, '/').slice(0, at).split('/').pop().replace(/-\d+\.\d+\.\d+.*$/, '') : '';
  const place = crate ? stackFrame('', `${crate}/src/${file.replace(/\\/g, '/').slice(at + 5)}:${row}`) : null;
  // The WebAssembly lines only: a line that is a function name alone (a JavaScript line ends with its place).
  const functions = ourStack(stack, {tables: null}).filter(entry => !/\s|:\d+$/.test(entry));
  return {message: message.trim() || 'engine panic', stack: [...(place ? [place] : []), ...functions].slice(0, MAX_LINES)};
}
