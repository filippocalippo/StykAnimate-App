#!/usr/bin/env node
// Documents whose shape the interface once kept from the engine, built through the editor
// (docs/engine/rendering.md, "Every document"): the deepest movieclip graph a file opens
// (eight levels) and the deeper ones nested editing builds in a session (17 and 24), documents
// saved with a frame draft (the Simple timeline's working frame), and an animation with no keys.
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {here, repo, repoUrl, Editor, documentOf, limb, open, whole, nextKey, nextSheetKey, emptyDocument, createObject, createFrame, writeProject, writeReference} from './fixture-kit.mjs';
const {movieclipFigure, validateMovieclipGraph} = await import(`${repoUrl}/src/movieclips.mjs`);

export function nested(depth) {
  const e = open(documentOf([limb()], () => [180, 160]));
  nextKey(e, 4); whole(e).moveSelection(70, 20); e.rotateSelection(.7);
  let document = e.serialize();
  for (let level = 0; level < depth; level++) {
    const report = emptyDocument(), clip = movieclipFigure(1, `Level ${level + 1}`, document, {duration: 5});
    report.figure_types = [clip]; report.keyframes = [createFrame([createObject(clip, 1, 0, 0)], 4)];
    const outer = open(report); nextKey(outer, 4); document = outer.serialize();
  }
  return document;
}

/**
 * Movieclips `levels` deep as nested editing builds them: each clip is made, placed and
 * entered in turn, so only the clip entered is ever checked. A file cannot hold the result
 * (`validateMovieclipGraph` opens eight levels); the editor draws it as it draws any other.
 */
export function nestedByEditing(levels) {
  const e = new Editor({demo: false, propertyChannels: true, layerTimeline: true});
  e.load(documentOf([limb()], () => [180, 160]));
  nextSheetKey(e, 4); whole(e).moveSelection(70, 20); e.rotateSelection(.7); e.seek(0);
  for (let level = 0; level < levels; level++) {
    const clip = e.createEmptyMovieclip(`Level ${level + 1}`);
    e.seek(0); e.addFigure(clip.figure_type_id);
    const uid = e.selectedUid;
    e.moveSelection(8, 3); e.rotateSelection(.03 * (level % 3 + 1));
    // A second key lengthens the clip around it, so the figure at the bottom plays through every level.
    nextSheetKey(e, 4, uid); whole(e, uid).moveSelection(-5, 6); e.seek(0);
    e.enterMovieclip(clip.figure_type_id);
  }
  e.importFigure(documentOf([limb(true)], () => [120, 100]));
  const uid = e.selectedUid;
  nextSheetKey(e, 4, uid); whole(e, uid).moveSelection(40, -25); e.rotateSelection(.5); e.seek(0);
  for (let level = 0; level < levels; level++) e.leaveMovieclip();
  e.seek(0);
  return e.serialize();
}

/** The number of movieclip levels a document nests. */
export function nestingDepth(report) {
  const clip = report.figure_types.find(figure => figure._styk?.movieclip);
  return clip ? 1 + nestingDepth(clip._styk.movieclip.document) : 0;
}

/**
 * A project saved with a frame draft, as a native timeline holds one (the Simple timeline's
 * working frame: `mode` 'add' keeps the pose beyond the stored keys, 'update' edits the key
 * under the playhead; the draft's `baseline` is the stored pose the edits started from).
 */
export function framedDraft(mode) {
  const e = new Editor({demo: false, propertyChannels: true});
  e.load(documentOf([limb(true)], () => [180, 160]));
  nextKey(e, 4); whole(e).moveSelection(70, 20); e.rotateSelection(.7);
  if (mode === 'update') e.selectFrame(0);
  e.enableFrameDrafts({mode});
  whole(e).moveSelection(25, 10); e.rotateSelection(.3);
  return e.serialize();
}

/**
 * The same draft on a document with a layer sheet, which is what every document the app holds
 * has (it deletes the draft of a native one as it adds the sheet; a draft a file brings with its
 * sheet stays in the document, unused until drafts are enabled).
 */
export function framedDraftSheet(mode) {
  const native = framedDraft(mode);
  const sheet = new Editor({demo: false, propertyChannels: true, layerTimeline: true}).load(structuredClone(native)).serialize();
  sheet._styk.simpleFrameDraft = structuredClone(native._styk.simpleFrameDraft);
  return sheet;
}

/** An animation with no keys, as a Pivot file holds one: the editor adds a private working pose. */
export function emptyAnimation() {
  const document = documentOf([limb()]);
  document.keyframes = [];
  return document;
}

const args = process.argv.slice(2), outAt = args.indexOf('--out');
const out = path.resolve(outAt < 0 ? `${here}/../crates/styk-eval/tests/fixtures/document` : args[outAt + 1]);
mkdirSync(out, {recursive: true});
const document = nested(8);
validateMovieclipGraph(document);
writeReference(writeProject(out, 'deep-eight', document, [0, 1, 2, 3, 4], {native: true}), 'deep-eight');
// Construct the rejected wrapper directly: the editor must reject it before evaluation.
const invalid = emptyDocument(), clip = movieclipFigure(1, 'Ninth level', document, {duration: 5});
invalid.figure_types = [clip]; invalid.keyframes = [createFrame([createObject(clip, 1, 0, 0)], 4)];
for (const depth of [9, 17]) {
  let report = invalid;
  for (let level = 9; level < depth; level++) {
    const outer = emptyDocument(), next = movieclipFigure(1, `Level ${level + 1}`, report, {duration: 5});
    outer.figure_types = [next]; outer.keyframes = [createFrame([createObject(next, 1, 0, 0)], 4)]; report = outer;
  }
  try { open(report); throw new Error(`Depth ${depth} was accepted`); }
  catch (error) { if (!/eight nested/.test(error.message)) throw error; }
  console.log(`depth ${depth}: rejected by editor's graph validation`);
}
for (const [name, levels] of [['deep-seventeen', 17], ['deep-twenty-four', 24]]) {
  const deep = nestedByEditing(levels);
  if (nestingDepth(deep) !== levels) throw new Error(`${name} nests ${nestingDepth(deep)} levels`);
  try { open(structuredClone(deep)); throw new Error(`${name} was accepted`); }
  catch (error) { if (!/eight nested/.test(error.message)) throw error; }
  writeReference(writeProject(out, name, deep, [0, 1, 2, 3, 4], {deep: true}), name);
}
for (const mode of ['add', 'update']) {
  const draft = framedDraft(mode);
  if (draft._styk.simpleFrameDraft?.mode !== mode || !draft._styk.simpleFrameDraft.baseline) throw new Error(`no ${mode} draft`);
  writeReference(writeProject(out, `frame-draft-${mode}`, draft, [0, 1, 2, 3, 4], {native: true}), `frame-draft-${mode}`);
}
{
  const draft = framedDraftSheet('add');
  if (!draft._styk.layerSheet || !draft._styk.simpleFrameDraft?.baseline) throw new Error('no draft on the sheet');
  writeReference(writeProject(out, 'frame-draft-sheet', draft, [0, 1, 2, 3, 4]), 'frame-draft-sheet');
}
writeFileSync(`${out}/empty-animation.json`, JSON.stringify(emptyAnimation()) + '\n');
console.log('empty-animation: no keys');
