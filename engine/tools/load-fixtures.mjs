#!/usr/bin/env node
// Load-normalization fixtures: what the editor's load does to a document, recorded from the JavaScript
// (src/editor-load.mjs `prepareEditorLoad`, the oracle) for the engine's port (styk-edit `load`).
//
//   node engine/tools/load-fixtures.mjs                 write engine/tests/load/{repository,cases}.json
//   node engine/tools/load-fixtures.mjs --out <folder>  write elsewhere
//   node engine/tools/load-fixtures.mjs --show <name>   print the oracle's answer for one case
//
// `repository.json`: every project document in the repository (the edit recordings' documents, the
// fixture documents of the crates, the recordings that carry one), by path. The normalized document
// is stored as the SHA-256 of its `JSON.stringify` bytes, with the indexes the editor builds from it
// (next identities, figure uids per layer, tracks); a document the editor refuses stores its error.
// `cases.json`: synthetic documents (every branch of the normalization, one invalid document per
// refusal; engine/tools/load-cases.mjs), with the input and the normalized document in full.
// Byte-stable: regenerating changes nothing unless the editor's load changed.
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {indexesOf, oracle} from './load-oracle.mjs';

const repo = path.resolve(import.meta.dirname, '../..');

const sha256 = text => createHash('sha256').update(text).digest('hex');
const isDocument = value => Boolean(value) && typeof value === 'object' && Array.isArray(value.figure_types) && Array.isArray(value.keyframes);

function* jsonFiles(folder) {
  for (const entry of readdirSync(folder, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'target' && entry.name !== 'src' && entry.name !== 'node_modules') yield* jsonFiles(file); }
    else if (entry.name.endsWith('.json')) yield file;
  }
}

/** The project documents the repository holds: `{source, field?, text}`. */
export function* repositoryDocuments() {
  const roots = ['engine/tests', 'engine/crates'].map(folder => path.join(repo, folder));
  for (const root of roots) for (const file of jsonFiles(root)) {
    const relative = path.relative(repo, file).split(path.sep).join('/');
    if (!/(^|\/)(tests|fixtures)\//.test(relative)) continue;
    const text = readFileSync(file, 'utf8');
    let value;
    try { value = JSON.parse(text); } catch { continue; }
    if (isDocument(value)) yield {source: relative, text};
    else if (typeof value?.document === 'string') {
      try { if (isDocument(JSON.parse(value.document))) yield {source: relative, field: 'document', text: value.document}; } catch { /* not a document */ }
    }
  }
}

function repositoryCase({source, field, text}) {
  const result = oracle(text), entry = {source, ...(field ? {field} : {})};
  if (result.error) return {...entry, error: result.error};
  const report = JSON.stringify(result.prepared.report), indexes = indexesOf(result.prepared);
  return {...entry, output: {bytes: Buffer.byteLength(report), sha256: sha256(report), indexes, indexesSha256: sha256(JSON.stringify(indexes))}};
}

function syntheticCase({name, input}) {
  const text = JSON.stringify(input), result = oracle(text);
  if (result.error) return {name, input, error: result.error};
  return {name, input, output: {document: result.prepared.report, ...indexesOf(result.prepared)}};
}

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const out = path.resolve(option('--out') ?? path.join(repo, 'engine/tests/load'));
const {syntheticDocuments} = await import('./load-cases.mjs');
const synthetic = await syntheticDocuments({repo});

if (option('--show')) {
  const name = option('--show');
  const found = synthetic.find(item => item.name === name);
  const text = found ? JSON.stringify(found.input) : [...repositoryDocuments()].find(item => item.source === name)?.text;
  if (text === undefined) { console.error(`no case named ${name}`); process.exit(2); }
  const result = oracle(text);
  console.log(result.error ? JSON.stringify(result.error) : JSON.stringify({document: result.prepared.report, ...indexesOf(result.prepared)}));
  process.exit(0);
}

mkdirSync(out, {recursive: true});
const repository = [...repositoryDocuments()].map(repositoryCase);
const cases = synthetic.map(syntheticCase);
writeFileSync(path.join(out, 'repository.json'), JSON.stringify({cases: repository}) + '\n');
writeFileSync(path.join(out, 'cases.json'), JSON.stringify({cases}) + '\n');
const refused = list => list.filter(item => item.error).length;
console.log(`load fixtures: ${repository.length} repository documents (${refused(repository)} refused), ${cases.length} synthetic cases (${refused(cases)} refused)`);
