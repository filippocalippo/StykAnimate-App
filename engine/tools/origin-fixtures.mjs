#!/usr/bin/env node
// Builds the animation-origin fixtures of the Rust engine with the real JavaScript
// editor (Set Origin, then construction edits and animation): each is a small project
// and what the editor evaluates for it (tools/reference.mjs).
//
//   node engine/tools/origin-fixtures.mjs [name ...] [--out <folder>] [--list]
//
// Without names it regenerates every fixture into
// engine/crates/styk-eval/tests/fixtures/origin/, which
// engine/crates/styk-eval/tests/origin.rs compares the engine with. records-fixtures.mjs
// also records these documents' evaluated frames at exact and fractional ticks.
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {here, documentOf, limb, open, joint, writeProject, writeReference} from './fixture-kit.mjs';

let counter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});

/** Two limbs from one root, re-rooted at the shin's end; keys that turn and move the
 * whole figure about its original pivot and bend a joint, an Auto key between them. */
function animated(edit = () => {}) {
  const e = open(documentOf([limb(true), limb()], i => [260 + i * 220, 170]), {layerTimeline: true});
  e.sheetSetDuration(16);
  joint(e, 22, 1); e.setOrigin(22);
  edit(e);
  e.seek(6); e.select(1); e.rotateSelection(0.9); e.moveSelection(30, -20);
  e.sheetSetEasing([e.layerForUid(1)], 6, 6, {interpolation: 'auto'});
  e.seek(12); e.select(1); e.rotateSelection(-1.6); joint(e, 66, 1); e.rotateJoint(0.8);
  e.seek(0);
  return e;
}
const ticks = [0, 2, 3, 6, 8, 9, 12, 15];

const fixtures = {
  /** The original tree re-derived from the live segments (`animationOriginLayout`), with a
   * second instance mirrored and a figure joined to the first. */
  'origin-layout': () => {
    const e = animated(e => {
      e.select(2); e.joinTo(1, 55);
      e.addFigure(1); const copy = e.selectedUid; e.select(copy); e.moveSelection(-150, 120); e.mirrorSelection('horizontal');
    });
    return {document: e.serialize(), ticks};
  },
  /** A branch mirrored after Set Origin moves the vertex that defined the pivot: each pose
   * keeps the pivot as a local offset (`preserveAnimationOrigin`), turned with the figure. */
  'origin-offsets': () => {
    const e = animated(e => { joint(e, 11, 1); e.mirrorSegmentBranch('horizontal'); });
    return {document: e.serialize(), ticks};
  },
  /** A segment of the original tree dissolved after Set Origin: the figure keeps that tree as
   * a retained support graph whose removed bone is a ghost each pose stores. */
  'origin-support': () => {
    const e = animated(e => { joint(e, 11, 1); e.deleteSingleSegment({preserveEndpoints: true}); });
    return {document: e.serialize(), ticks};
  },
};

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log(Object.keys(fixtures).join('\n')); process.exit(0); }
const outAt = args.indexOf('--out');
const out = path.resolve(outAt < 0 ? `${here}/../crates/styk-eval/tests/fixtures/origin` : args[outAt + 1]);
const names = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
for (const name of names) if (!fixtures[name]) { console.error(`unknown fixture ${name}`); process.exit(2); }
mkdirSync(out, {recursive: true});
for (const name of names.length ? names : Object.keys(fixtures)) {
  counter = 0;
  const built = fixtures[name]();
  writeReference(writeProject(out, name, built.document, built.ticks), name);
}
