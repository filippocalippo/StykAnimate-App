#!/usr/bin/env node
// Container parity: the document the app opens a native file into (the Rust container module in a worker,
// src/native-file-codec.mjs, then the interface's own restore of the lifted form) must be the document the
// Rust store reads (`styk container json`), and saving it again must write the file's bytes.
//
//   node engine/tools/container-parity.mjs <file-or-list.txt>… [--styk <path to styk>]
//
// A `.txt` argument is a list of files, one per line. For each file:
// - the JSON text of the document the app's open path produces (JSON.stringify) and of the Rust store's
//   reader (`styk container json`) are compared byte for byte, and both refusing a file counts as agreement;
// - for a version 2 project or figure file, the app's save path (lift, with the embedded original source stored
//   first as the document export worker does, then the Rust writer) must write the bytes the file holds.
// Exit code 1 when any file differs. The JavaScript reader that was this tool's oracle is gone; its documents
// and the bytes of its writer were compared with these on 261 files before it was deleted (see docs/engine/formats.md).
import {pathToFileURL} from 'node:url';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const repoUrl = pathToFileURL(repo).href;
const {decodeDocument, buildContainerV2} = await import(`${repoUrl}/tests/support/native-files.mjs`);
const {base64ToBytes} = await import(`${repoUrl}/src/base64.mjs`);
const args = process.argv.slice(2);
const option = args.indexOf('--styk');
const styk = option >= 0 ? args.splice(option, 2)[1] : path.join(repo, `engine/target/release/styk${process.platform === 'win32' ? '.exe' : ''}`);
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
      // The document export worker stores the embedded original source first (document-export-worker.mjs).
      const document = opened.document, source = document._stykSource?.source_base64;
      const output = typeof source === 'string' ? {...document, _stykSource: {...document._stykSource, source_base64: base64ToBytes(source)}} : document;
      const written = await buildContainerV2(output, kind, typeof source === 'string' ? {preBlobs: [output._stykSource.source_base64]} : {});
      if (Buffer.compare(Buffer.from(written), Buffer.from(bytes)) === 0) saved++;
      else { different++; console.log(`DIFFERENT ${file}: saved again, the app writes ${written.length} bytes (${sha(written).slice(0, 12)}), the file holds ${bytes.length} (${sha(bytes).slice(0, 12)})`); }
    }
  }
} finally { rmSync(temp, {recursive: true, force: true}); }
console.log(JSON.stringify({files: files.length, same, bothReject, savedIdentically: saved, different}));
process.exit(different ? 1 : 0);
