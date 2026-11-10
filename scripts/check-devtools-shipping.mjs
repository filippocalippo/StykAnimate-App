// Proves the shipping build carries none of the developer tools (docs/DEVTOOLS.md "The shipping build").
//
//   node scripts/check-devtools-shipping.mjs [--web <dir>]... [--binary <file>]... [--capabilities <dir>]... [--expect-present]
//
// --web           a folder of shipped web files (the bundle, the staged web resources, a built site): no file under
//                 src/devtools/, and no file whose text carries a developer marker.
// --binary        a shipped executable or installer payload: none of the markers, in UTF-8 or UTF-16.
// --capabilities  a folder of Tauri capability files (and the generated ACL manifests): no developer command allowed.
// --expect-present  the opposite check, for the developer build: every input must carry the tools (so the markers are real).
// Exit 0 when clean, 1 when developer code was found (each finding printed), 2 on a usage error.
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Shipped files never come from these folders: the shipping resource lists filter them out (isDeveloperPath). */
export const DEVELOPER_PATHS = ['src/devtools/'];
export const isDeveloperPath = relative => DEVELOPER_PATHS.some(prefix => relative.split(path.sep).join('/').startsWith(prefix));

/**
 * Text that exists only in developer code: the early script's globals, the tools' marker, the desktop commands and the pipe.
 * The shipping code's own hooks (src/trace.mjs reading `__stykTrace`, src/devtools-gate.mjs checking `__STYK_DEVTOOLS__`)
 * are deliberately not markers: they are the instrumentation layer and the gate, inert without the developer build.
 */
export const MARKERS = ['__stykDevtoolsEarly', '__stykDevtoolsReceive', 'styk-devtools', 'stykanimate-dev-'];
const TEXT = /\.(m?js|cjs|html|css|json|map|txt|toml|wgsl)$/i;

async function* walk(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const utf16 = text => Buffer.from(text, 'utf16le');

/** Findings in a folder of web files. */
export async function scanWeb(root) {
  const findings = [];
  for await (const file of walk(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (isDeveloperPath(relative) || /(^|\/)devtools\//.test(relative)) { findings.push(`${relative}: a developer tools file`); continue; }
    if (!TEXT.test(file)) continue;
    const text = await readFile(file, 'utf8');
    for (const marker of MARKERS) if (text.includes(marker)) findings.push(`${relative}: contains ${JSON.stringify(marker)}`);
  }
  return findings;
}

/** Findings in a binary (an executable embeds its web assets, possibly compressed: the strings check covers the Rust side). */
export async function scanBinary(file) {
  const bytes = await readFile(file), findings = [];
  for (const marker of MARKERS) {
    if (bytes.includes(Buffer.from(marker, 'utf8'))) findings.push(`${path.basename(file)}: contains ${JSON.stringify(marker)}`);
    else if (bytes.includes(utf16(marker))) findings.push(`${path.basename(file)}: contains ${JSON.stringify(marker)} (UTF-16)`);
  }
  return findings;
}

/** Findings in capability files: any permission or command naming the developer tools. */
export async function scanCapabilities(root) {
  const findings = [];
  for await (const file of walk(root)) {
    if (!/\.(json|toml)$/i.test(file)) continue;
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/["']([\w:-]*devtools[\w:-]*)["']/gi)) findings.push(`${path.relative(root, file)}: allows ${match[1]}`);
  }
  return findings;
}

export async function checkShipping({web = [], binary = [], capabilities = []}) {
  const results = [];
  for (const root of web) results.push({input: root, kind: 'web', findings: await scanWeb(root)});
  for (const file of binary) results.push({input: file, kind: 'binary', findings: await scanBinary(file)});
  for (const root of capabilities) results.push({input: root, kind: 'capabilities', findings: await scanCapabilities(root)});
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), inputs = {web: [], binary: [], capabilities: []};
  let expectPresent = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (name === 'expect-present') { expectPresent = true; continue; }
    if (!(name in inputs) || !args[i + 1]) { console.error(`Usage: node scripts/check-devtools-shipping.mjs [--web <dir>] [--binary <file>] [--capabilities <dir>] [--expect-present]`); process.exit(2); }
    const value = path.resolve(args[++i]);
    try { await stat(value); } catch { console.error(`Missing input: ${value}`); process.exit(2); }
    inputs[name].push(value);
  }
  if (!inputs.web.length && !inputs.binary.length && !inputs.capabilities.length) { console.error('Give at least one input to check.'); process.exit(2); }
  const results = await checkShipping(inputs);
  let failed = false;
  for (const {input, kind, findings} of results) {
    const clean = findings.length === 0;
    if (expectPresent ? clean : !clean) failed = true;
    console.log(`${expectPresent ? (clean ? 'MISSING' : 'present') : (clean ? 'clean' : 'DEVELOPER CODE')} ${kind} ${input}${clean ? '' : `: ${findings.length} finding${findings.length === 1 ? '' : 's'}`}`);
    for (const finding of findings.slice(0, 20)) console.log(`  ${finding}`);
  }
  console.log(failed ? (expectPresent ? 'The developer build lacks its tools.' : 'The shipping build contains developer tools.') : (expectPresent ? 'The developer build carries its tools.' : 'No developer tools in the shipping build.'));
  process.exit(failed ? 1 : 0);
}
