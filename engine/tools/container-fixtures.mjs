#!/usr/bin/env node
// Native container fixtures: small .styk, .stkz and .stykmov files the repository keeps so that the
// container reader and writer have inputs everywhere (a fresh checkout, CI), and library previews have
// figure and movieclip files to open (engine/crates/styk-engine/tests/thumbnails.rs).
//
//   node engine/tools/container-fixtures.mjs [--out <folder>] [--list]
//
// Without --out it regenerates engine/tests/containers/. Every file is written from a document that is
// already in the repository (an editor-built fixture, opened the way the app opens a project) by the app's
// own save path: the document export worker (src/document-export-worker.mjs, run in a Node worker as the
// integration tests run it) for the projects, the figure and the movieclip, and the lift and the Rust
// writer (src/document-lift.mjs, src/native-file-codec.mjs) for the file with shared arrays, which the
// worker's transport does not carry. The output is byte-stable: the container writer is deterministic and
// the only generated input, a noise picture, comes from a fixed sequence. `scripts/engine-parity.mjs`
// (the "containers" stage) opens and saves every one of them again against the Rust store, and
// `engine/tools/container-parity.mjs` is the check.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {Worker as NodeWorker} from 'node:worker_threads';
import {crc32, deflateSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const url = relative => pathToFileURL(path.join(repo, relative)).href;
const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = path.resolve(at < 0 ? path.join(here, '../tests/containers') : args[at + 1]);

// The document export worker, in a Node worker behind the page's Worker interface.
class WorkerFacade extends EventTarget {
  constructor() {
    super();
    this.worker = new NodeWorker(new URL(url('tests/document-export-node-worker.mjs')));
    this.worker.on('message', data => { const event = new Event('message'); event.data = data; this.dispatchEvent(event); });
    this.worker.on('error', error => { const event = new Event('error', {cancelable: true}); event.message = error.message; this.dispatchEvent(event); });
    this.worker.on('messageerror', () => this.dispatchEvent(new Event('messageerror')));
  }
  postMessage(value, transfer) { this.worker.postMessage(value, transfer); }
  terminate() { void this.worker.terminate(); }
}
globalThis.Worker = WorkerFacade;
const {DocumentExporter} = await import(url('src/document-export.mjs'));
const {FakeCodecHost} = await import(url('tests/support/codec-host.mjs'));
const {openDocument, buildContainerV2} = await import(url('tests/support/native-files.mjs'));
const {buildContainerV1} = await import(url('tests/support/container-v1.mjs'));

const fixtures = 'engine/crates/styk-eval/tests/fixtures';
const source = relative => new Uint8Array(readFileSync(path.join(repo, relative)));
/** A repository document as the app opens a project. */
const project = relative => openDocument(source(relative), 'styk', {verifySource: false});

/** A noise picture of `width` × `height` pixels: PNG with stored (uncompressed) blocks, so its bytes depend
 * on nothing but this code, and big enough that its base64 passes the lift's 64 KiB payload threshold. */
function noisePng(width, height) {
  let state = 0x9e3779b9;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row++) {
    const start = row * (1 + width * 4);
    for (let i = 1; i <= width * 4; i++) {
      state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
      rows[start + i] = state & 255;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), size = Buffer.alloc(4), sum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); sum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.writeUInt8(8, 8); header.writeUInt8(6, 9);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, {level: 0})), chunk('IEND', Buffer.alloc(0))]);
}

/** Every numeric array of 32 values or more, equal ones replaced by one instance: the same document,
 * with arrays the file holds once (a movieclip that reuses a figure's mesh does this in a real project). */
function shareEqualArrays(document) {
  const first = new Map();
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (Array.isArray(child) && child.length >= 32 && child.every(v => typeof v === 'number')) {
        const text = JSON.stringify(child);
        if (first.has(text)) value[key] = first.get(text); else first.set(text, child);
      } else walk(child);
    }
  };
  walk(document);
  return document;
}

/** What each file is written from, and what it covers. */
const files = [
  // Version 2 with a numeric-array section: a spatial mesh's positions, bones and weights.
  {name: 'project-arrays.styk', async build({save}) { return save(await project(`${fixtures}/spatial/mesh-views.json`), {name: 'Mesh views'}); }},
  // Version 2 with arrays stored once and named by several markers: a movieclip that holds the figure's mesh again.
  {name: 'project-shared-arrays.styk', async build() {
    const document = shareEqualArrays(await project(`${fixtures}/spatial/mesh-in-movieclip.json`));
    return buildContainerV2(document, 'styk');
  }},
  // Version 2 with pose channels: stored pose-key sequences, referenced from several channels.
  {name: 'project-channels.styk', async build({save}) { return save(await project(`${fixtures}/channels/channels-pose.json`), {name: 'Pose channels'}); }},
  // Version 2 with a binary-payload section: one picture used by two backgrounds, stored once.
  {name: 'project-images.styk', async build({save}) {
    const document = await project(`${fixtures}/clip-paint/image-identity.json`);
    const image = noisePng(128, 96), [background] = document.backgrounds;
    background.data_url = `data:image/png;base64,${image.toString('base64')}`;
    background.width = 128; background.height = 96;
    document.backgrounds.push({...background, name: 'Same picture again', background_id: 2});
    return save(document, {name: 'Pictures'});
  }},
  // Version 2 with a drawing layer: its tile blob is a payload.
  {name: 'project-drawing.styk', async build({save}) {
    return save(await project('engine/crates/styk-raster/tests/fixtures/drawing-root-sampling/raw-cel-only.json'), {name: 'Drawing'});
  }},
  // Version 1 (zlib around the project's JSON), which the app reads and no longer writes.
  {name: 'project-version-1.styk', async build() {
    return buildContainerV1(JSON.stringify(await project(`${fixtures}/drawlist/painted-limbs.json`)), 'styk');
  }},
  // A figure file: one figure at its pose at tick 0, with a mesh's arrays.
  {name: 'figure.stkz', async build({save}) {
    return save(await project(`${fixtures}/spatial/mesh-views.json`), {format: 'stkz', name: 'Mesh figure', figureTypeId: 1, tick: 0});
  }},
  // Movieclip files: generated effects growing through a clip of nine ticks, and a figure animated by property
  // channels that swings out and back through seventeen (its widest pose is in the middle).
  {name: 'movieclip-effects.stykmov', async build({save}) {
    return save(await project(`${fixtures}/generators/movieclip.json`), {format: 'stykmov', name: 'Effects clip', figureTypeId: 2, tick: 0});
  }},
  {name: 'movieclip-motion.stykmov', async build({save}) {
    return save(await project(`${fixtures}/channels/channels-in-movieclip.json`), {format: 'stykmov', name: 'Motion clip', figureTypeId: 3, tick: 0});
  }},
];

if (args.includes('--list')) { for (const file of files) console.log(file.name); process.exit(0); }

const codecHost = new FakeCodecHost(), exporter = new DocumentExporter({codecHost, idleMs: 0});
const save = async (document, {format = 'styk', ...options}) => new Uint8Array(await (await exporter.export(document, {format, ...options})).arrayBuffer());
mkdirSync(out, {recursive: true});
try {
  for (const file of files) {
    const bytes = await file.build({save});
    writeFileSync(path.join(out, file.name), bytes);
    console.log(`${file.name}: ${bytes.length} bytes`);
  }
} finally { exporter.dispose(); codecHost.close(); }
process.exit(0);
