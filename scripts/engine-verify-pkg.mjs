#!/usr/bin/env node
// Fails when the engine's WebAssembly build (src/engine/pkg, docs/engine/threading.md)
// is missing or incomplete. Release, web and CI builds run it so that no artifact ships
// without the engine and silently falls back to the JavaScript renderer, or without the
// Pivot codec's module (docs/engine/formats-piv.md) and cannot open Pivot files, or without the
// drawing raster engine's (docs/engine/drawing.md).
import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';

const pkg = path.resolve(import.meta.dirname, '../src/engine/pkg');
const required = ['styk_engine.js', 'styk_engine_bg.wasm', 'styk_codec.js', 'styk_codec_bg.wasm', 'styk_drawing.js', 'styk_drawing_bg.wasm', 'build-info.json'];
const missing = required.filter(name => !existsSync(path.join(pkg, name)));
if (missing.length) {
  console.error(`The engine build is missing (${missing.join(', ')} in src/engine/pkg). Run npm run engine:build.`);
  process.exit(1);
}
const info = JSON.parse(readFileSync(path.join(pkg, 'build-info.json'), 'utf8'));
const size = statSync(path.join(pkg, 'styk_engine_bg.wasm')).size;
if (size < 1024 * 1024) {
  console.error(`The engine module is ${size} bytes: the build looks incomplete. Run npm run engine:build.`);
  process.exit(1);
}
console.log(`engine build ok: ${(size / 1024).toFixed(0)} KiB, ${JSON.stringify(info)}`);
