#!/usr/bin/env node
// Container parity: the document the app opens a native file into (the Rust container module in a worker,
// src/native-file-codec.mjs, then the interface's own restore of the lifted form) must be the document the
// Rust store reads (`styk container json`), and the Rust writer must write the file's bytes again
// (`styk container roundtrip`: the engine's save lifts and frames the document as that command does).
//
//   node engine/tools/container-parity.mjs <file-or-list.txt>… [--styk <path to styk>]
//
// A `.txt` argument is a list of files, one per line. For each file:
// - the JSON text of the document the app's open path produces (JSON.stringify) and of the Rust store's
//   reader (`styk container json`) are compared byte for byte, and both refusing a file counts as agreement;
// - for a version 2 project or figure file, `styk container roundtrip` (lift, with the embedded original source stored
//   first as a save does, then the writer) must write the bytes the file holds.
// Exit code 1 when any file differs. The JavaScript reader and writer that were this tool's oracles are gone; their documents
// and bytes were compared with these on 261 files before they were deleted (see docs/engine/formats.md).
import {pathToFileURL} from 'node:url';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const repoUrl = pathToFileURL(repo).href;
const {decodeDocument} = await import(`${repoUrl}/tests/support/native-files.mjs`);
const args = process.argv.slice(2);
const option = args.indexOf('--styk');
const styk = option >= 0 ? args.splice(option, 2)[1] : path.join(process.env.CARGO_TARGET_DIR ?? path.join(repo, 'engine/target'), 'release', `styk${process.platform === 'win32' ? '.exe' : ''}`);
const files = args.flatMap(arg => arg.endsWith('.txt') ? readFileSync(arg, 'utf8').split('\n').filter(Boolean) : [arg]);
if (!files.length) { console.error('usage: node engine/tools/container-parity.mjs <file-or-list.txt>…'); process.exit(2); }
const temp = mkdtempSync(path.join(os.tmpdir(), 'styk-parity-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let same = 0, different = 0, bothReject = 0, saved = 0;
try {
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    const kind = path.extname(file).slice(1).toLowerCase();
    let opened = null, appError = null;
    try { opened = await decodeDocument(bytes, kind); }
    catch (error) { appError = error.messageKey || error.message; }
    const out = path.join(temp, 'rust.json');
    const run = spawnSync(styk, ['container', 'json', file, out], {encoding: 'utf8'});
    if (appError || run.status !== 0) {
      if (appError && run.status !== 0) { bothReject++; continue; }
      different++; console.log(`DIFFERENT ${file}: the app's open path ${appError ? `rejects (${appError})` : 'accepts'}, Rust ${run.status ? `rejects (${run.stderr.trim()})` : 'accepts'}`);
      continue;
    }
    const expected = Buffer.from(JSON.stringify(opened.document)), actual = readFileSync(out);
    if (actual.equals(expected)) same++;
    else {
      different++;
      let at = 0; while (at < actual.length && actual[at] === expected[at]) at++;
      console.log(`DIFFERENT ${file}: first difference at byte ${at}: app …${expected.subarray(Math.max(0, at - 40), at + 40)}… Rust …${actual.subarray(Math.max(0, at - 40), at + 40)}… (${sha(expected).slice(0, 12)} vs ${sha(actual).slice(0, 12)})`);
      continue;
    }
    if (opened.version === 2) {
      const again = spawnSync(styk, ['container', 'roundtrip', file], {encoding: 'utf8'});
      let result = null;
      try { result = JSON.parse(again.stdout); } catch { /* reported below */ }
      if (again.status === 0 && result?.fileIdentical) saved++;
      else { different++; console.log(`DIFFERENT ${file}: written again, the writer's bytes are not the file's (${(again.stdout || again.stderr).trim().slice(0, 300)})`); }
    }
  }
} finally { rmSync(temp, {recursive: true, force: true}); }
console.log(JSON.stringify({files: files.length, same, bothReject, savedIdentically: saved, different}));
process.exit(different ? 1 : 0);
