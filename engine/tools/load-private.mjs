#!/usr/bin/env node
// The engine's load normalization (`styk load`, styk-edit `load`) against the editor's on documents that
// are not in the repository: each is decoded by the engine's codec, normalized by both, and the normalized
// documents (byte for byte) and the indexes compared.
//
//   node --max-old-space-size=32768 engine/tools/load-private.mjs [file…] [--styk <path to styk>]
//
// Without files: the .piv files of the folders STYK_CORPUS_DIR names (separated as PATH is).
// Exit code 1 when any document differs. Scratch files go to the temporary folder and are removed.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {indexesOf, oracle} from './load-oracle.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const option = args.indexOf('--styk');
const styk = option >= 0 ? args.splice(option, 2)[1] : path.join(repo, `engine/target/release/styk${process.platform === 'win32' ? '.exe' : ''}`);
const fallback = path.join(repo, `engine/target/debug/styk${process.platform === 'win32' ? '.exe' : ''}`);
const binary = existsSync(styk) ? styk : fallback;
const folders = (process.env.STYK_CORPUS_DIR ?? '').split(path.delimiter).filter(Boolean);
const files = args.length ? args : folders.filter(existsSync).flatMap(folder => readdirSync(folder).filter(name => /\.piv$/i.test(name)).sort().map(name => path.join(folder, name)));
if (!files.length) { console.error('no documents found; pass files or set STYK_CORPUS_DIR'); process.exit(2); }
const scratch = mkdtempSync(path.join(os.tmpdir(), 'styk-load-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const ms = since => `${(performance.now() - since).toFixed(0)} ms`;
let same = 0, different = 0;
try {
  for (const file of files) {
    const name = path.basename(file), input = path.join(scratch, 'input.json'), output = path.join(scratch, 'output.json'), indexes = path.join(scratch, 'indexes.json');
    const run = spawnSync(binary, ['load', file, '--input', input, '--output', output, '--indexes', indexes], {encoding: 'utf8', maxBuffer: 1 << 26});
    if (run.status === 2) { different++; console.log(`DIFFERENT ${name}: the engine could not read it: ${run.stderr.trim()}`); continue; }
    const rust = JSON.parse(run.stdout.trim().split('\n').pop());
    let started = performance.now();
    const text = readFileSync(input, 'utf8');
    const result = oracle(text);
    const editorMs = ms(started);
    if (result.error) {
      const agree = run.status === 1 && rust.refused?.includes(result.error.key ?? result.error.message ?? result.error.exception);
      console.log(`${agree ? 'same' : 'DIFFERENT'} ${name}: the editor refuses (${JSON.stringify(result.error)}), the engine ${run.status === 1 ? `refuses (${rust.refused})` : 'accepts'}`);
      agree ? same++ : different++;
      continue;
    }
    if (run.status !== 0) { different++; console.log(`DIFFERENT ${name}: the editor accepts, the engine refuses (${rust.refused})`); continue; }
    started = performance.now();
    const expected = Buffer.from(JSON.stringify(result.prepared.report));
    const actual = readFileSync(output);
    const wantedIndexes = Buffer.from(JSON.stringify(indexesOf(result.prepared)));
    const gotIndexes = readFileSync(indexes);
    const documentSame = actual.equals(expected), indexesSame = gotIndexes.equals(wantedIndexes);
    if (documentSame && indexesSame) {
      same++;
      console.log(`same ${name}: ${(expected.length / 1e6).toFixed(1)} MB, sha ${sha(expected)}; engine decode ${rust.decodeMs} ms + load ${rust.loadMs} ms; editor parse + load ${editorMs}`);
    } else {
      different++;
      let at = 0; while (at < actual.length && actual[at] === expected[at]) at++;
      console.log(`DIFFERENT ${name}: ${documentSame ? '' : `document first differs at byte ${at}: engine …${actual.subarray(Math.max(0, at - 60), at + 60)}… editor …${expected.subarray(Math.max(0, at - 60), at + 60)}…`} ${indexesSame ? '' : `indexes differ (${gotIndexes.length} / ${wantedIndexes.length} bytes)`}`);
    }
  }
} finally { rmSync(scratch, {recursive: true, force: true}); }
console.log(`${same} of ${same + different} documents load as the editor loads them`);
process.exit(different ? 1 : 0);
