/**
 * The engine port's feature inventory (docs/RUST-ENGINE-PORT.md): every module that holds
 * engine logic, its Rust owner and its status. The table lives in engine/inventory.tsv.
 *
 *   node scripts/engine-inventory.mjs            check the table and print the summary
 *   node scripts/engine-inventory.mjs --render   also rewrite docs/engine/INVENTORY.md
 *
 * The check fails when a source file under src/, codecs/, backend/, native/ or desktop/ has
 * no row (a new module must say whether it is engine or UI), when a row names a file that no
 * longer exists but is not marked removed, or when a kind or status is unknown.
 */
import {readdirSync, readFileSync, statSync, writeFileSync, existsSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const KINDS = {
  engine: 'Engine logic: ported to Rust',
  platform: 'Browser, Electron or operating-system service: stays in JS (or native), driven by the engine where an owner is named',
  ui: 'Interface: stays in JS',
  app: 'Telemetry, support, updates: stays in JS',
  tool: 'Test or profiling tool of a removed subsystem',
};
// js: still the JavaScript (or Python) implementation. partial: the Rust owner implements part of
// the module's engine logic with parity (the note says which part); the rest is still JavaScript.
// ported: the Rust owner implements all of it and passes parity, the old module still ships.
// verified: the app runs on the Rust owner. removed: the old module is deleted. stays: not engine logic.
const STATUSES = ['js', 'partial', 'ported', 'verified', 'removed', 'stays'];
const COUNTED = ['js', 'partial', 'ported', 'verified', 'removed'];
const SKIP_DIRS = new Set(['locales', 'styles', 'node_modules', '__pycache__', 'bin', 'assets']);
const walk = dir => readdirSync(path.join(root, dir), {withFileTypes: true}).flatMap(entry => entry.isDirectory()
  ? (SKIP_DIRS.has(entry.name) ? [] : walk(path.join(dir, entry.name)))
  : /\.(mjs|cjs|js|py|cpp)$/.test(entry.name) ? [path.join(dir, entry.name).replaceAll('\\', '/')] : []);

const lines = readFileSync(path.join(root, 'engine/inventory.tsv'), 'utf8').split('\n').filter(Boolean);
const rows = lines.slice(1).map(line => { const [file, kind, owner, status, note = ''] = line.split('\t'); return {file, kind, owner, status, note}; });
const problems = [];
const known = new Set();
for (const row of rows) {
  if (known.has(row.file)) problems.push(`${row.file}: listed twice`);
  known.add(row.file);
  if (!KINDS[row.kind]) problems.push(`${row.file}: unknown kind ${row.kind}`);
  if (!STATUSES.includes(row.status)) problems.push(`${row.file}: unknown status ${row.status}`);
  if (row.kind === 'engine' && (!row.owner || row.owner === '-')) problems.push(`${row.file}: engine logic without a Rust owner`);
  if (row.kind === 'engine' && row.status === 'stays') problems.push(`${row.file}: engine logic cannot stay in JS`);
  if (row.status === 'partial' && !row.note.includes('Rust:')) problems.push(`${row.file}: partial, but the note does not say what Rust covers ("Rust: …")`);
  const exists = existsSync(path.join(root, row.file));
  if (!exists && row.status !== 'removed') problems.push(`${row.file}: missing, but not marked removed`);
  if (exists && row.status === 'removed') problems.push(`${row.file}: marked removed, but still present`);
}
for (const file of ['src', 'codecs', 'backend', 'native', 'desktop'].filter(dir => existsSync(path.join(root, dir))).flatMap(walk))
  if (!known.has(file) && !file.startsWith('src/engine/')) problems.push(`${file}: no inventory row (add it to engine/inventory.tsv)`);

// Sizes are measured at the baseline when a module is removed, so the totals stay comparable.
const bytes = row => existsSync(path.join(root, row.file)) ? statSync(path.join(root, row.file)).size : Number(row.note.match(/\((\d+) bytes\)/)?.[1] ?? 0);
const engine = rows.filter(row => row.kind === 'engine');
const empty = owner => ({owner, modules: 0, bytes: 0, ...Object.fromEntries(COUNTED.flatMap(status => [[status, 0], [`${status}Bytes`, 0]]))});
const owners = new Map(), total = empty('Total');
for (const row of engine) {
  const owner = row.owner.split('::')[0];
  const entry = owners.get(owner) ?? empty(owner);
  for (const target of [entry, total]) { target.modules++; target.bytes += bytes(row); target[row.status]++; target[`${row.status}Bytes`] += bytes(row); }
  owners.set(owner, entry);
}
const summary = [...owners.values()].sort((a, b) => a.owner.localeCompare(b.owner));
const kib = value => `${Math.round(value / 1024)} KiB`;
const share = (entry, ...statuses) => `${Math.round(100 * statuses.reduce((sum, status) => sum + entry[`${status}Bytes`], 0) / Math.max(1, entry.bytes))} %`;
const line = (entry, bold = '') => `| ${bold}${entry.owner === 'Total' ? 'Total' : `\`${entry.owner}\``}${bold} | ${entry.modules} | ${kib(entry.bytes)} | ${COUNTED.map(status => entry[status]).join(' | ')} | ${share(entry, 'ported', 'verified', 'removed')} | ${share(entry, 'partial')} | ${share(entry, 'removed')} |`;
const summaryTable = ['| Rust owner | Modules | Source at start | js | partial | ported | verified | removed | Covered by Rust | Partly covered | Deleted |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...summary.map(entry => line(entry)), line(total, '**')].join('\n');

if (process.argv.includes('--render')) {
  const section = (title, kind) => {
    const list = rows.filter(row => row.kind === kind).sort((a, b) => a.owner.localeCompare(b.owner) || a.file.localeCompare(b.file));
    return [`## ${title}`, '', KINDS[kind] + '.', '', '| Module | Rust owner | Status | Notes |', '| --- | --- | --- | --- |',
      ...list.map(row => `| \`${row.file}\` | ${row.owner === '-' ? '' : `\`${row.owner}\``} | ${row.status} | ${row.note} |`), ''].join('\n');
  };
  writeFileSync(path.join(root, 'docs/engine/INVENTORY.md'), [
    '# Engine port: feature inventory', '',
    'Generated by `node scripts/engine-inventory.mjs --render` from `engine/inventory.tsv`. Edit the table there, never here.',
    'Statuses: **js** still the JavaScript or Python implementation; **partial** the Rust owner implements part of the',
    "module's engine logic with parity (the note says which part, after \"Rust:\"); **ported** the Rust owner implements all of it",
    'and passes its parity suite while the old module still ships; **verified** the app runs on the Rust owner alone; **removed**',
    'the old module is deleted; **stays** not engine logic. Shares are of the engine source size at the start (bytes);',
    '"covered" counts ported, verified and removed modules. The plan and the rules are in [RUST-ENGINE-PORT.md](../RUST-ENGINE-PORT.md).', '',
    '## Summary', '', summaryTable, '',
    section('Engine modules', 'engine'), section('Platform services', 'platform'), section('Interface', 'ui'),
    section('Application services', 'app'), section('Tools of removed subsystems', 'tool')].join('\n'));
}
console.log(summaryTable.replaceAll('`', '').replaceAll('**', ''));
if (problems.length) { console.error(`\n${problems.length} inventory problems:\n  ${problems.join('\n  ')}`); process.exit(1); }
