// What the engine's fixture generators share: the real JavaScript editor, small
// documents to start from, and the dump of what the editor evaluates
// (tools/reference.mjs). Used by ik-fixtures.mjs, eval-fixtures.mjs and vfx-fixtures.mjs.
import './v8-pin.mjs';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, '../..');
/** The repository as a URL: what `import()` takes on every platform. */
export const repoUrl = pathToFileURL(repo).href;
export const {Editor} = await import(`${repoUrl}/src/editor.mjs`);
export const {emptyDocument, createObject, createFrame} = await import(`${repoUrl}/src/demo.mjs`);

/** A document with one figure made of `segments` ([id, parent, length, angle, extra]). */
export function documentOf(figures, place = () => [300, 150]) {
  const document = emptyDocument(), template = document.figure_types[0], base = template.segments[0];
  document.figure_types = figures.map((segments, i) => ({...structuredClone(template), figure_type_id: i + 1, name: `Figure ${i + 1}`,
    segments: segments.map(([segment_id, parent_id, length, angle_rad, extra = {}]) =>
      ({...base, segment_id, parent_id, length, angle_rad, thickness: 6, aux_code: 0, is_static: false, flag_bits: undefined, ...extra})),
    segment_count: segments.length}));
  const objects = document.figure_types.map((figure, i) => createObject(figure, i + 1, ...place(i)));
  document.keyframes = [createFrame(objects, 1)];
  return document;
}
/** A thigh (11), a shin (22) and a foot (33); optionally a second limb (44, 55, 66). */
export const limb = (second = false) => [[11, 0, 90, .8], [22, 11, 90, 2], [33, 22, 35, 0],
  ...(second ? [[44, 0, 90, 2.1], [55, 44, 90, 1.2], [66, 55, 35, Math.PI]] : [])];

export const open = (document, options = {}) => new Editor({demo: false, ...options}).load(document);
export const joint = (editor, id, uid = editor.selectedUid ?? 1) => {
  editor.select(uid); const index = editor.figure.segments.findIndex(s => s.segment_id === id);
  editor.select(uid, index); return editor;
};
export const whole = (editor, uid = 1) => { editor.select(uid, -1); return editor; };
/** A second native keyframe after the current one; the editor moves onto it. */
export function nextKey(editor, ticks) {
  editor.setFrameDuration(ticks); editor.duplicateFrame();
  editor.selectFrame(editor.report.keyframes.length - 1);
  return editor;
}
/** A later key on a layer's pose track; the editor moves onto it. */
export function nextSheetKey(editor, tick, uid = 1) {
  editor.sheetInsertKey([editor.layerForUid(uid)], tick); editor.seek(tick);
  return editor;
}

/** Every edit of a layer-sheet pose leaves its previous pose source in the
 * project for undo. No key refers to them, so no evaluation reads them: drop
 * them to keep a fixture to the few poses it is about. */
export function prune(document) {
  const sources = document._styk?.frameSources, tracks = document._styk?.layerSheet?.tracks;
  if (sources && tracks) {
    const used = new Set(Object.values(tracks).flatMap(track => track.keys.flatMap(key => [key.value?.frameId, ...(key.movieclipPatches ?? []).map(p => p.frameId)])));
    // Channels refer to poses too: a sheet's legacy animation, and the stored animation a frame draft keeps beside the working one.
    for (const animation of [document._styk.layerSheet.legacyAnimation, document._styk.simpleFrameDraft?.animationBaseline])
      for (const channel of animation?.channels ?? []) for (const key of channel.keys) used.add(key.value?.frameId);
    for (const id of Object.keys(sources)) if (!used.has(id)) delete sources[id];
  }
  for (const figure of document.figure_types) if (figure._styk?.movieclip?.document) prune(figure._styk.movieclip.document);
  return document;
}

/**
 * Writes `<out>/<name>.json` (the project) and returns the editor's evaluation of
 * it at `ticks`, without the timings that differ on every run: the caller adds
 * what it needs and writes `<name>.reference.json` with writeReference().
 * `vfx` adds the effects the editor resolves (reference.mjs --vfx), `camera` what the
 * scene camera does when shown (--camera: the shot camera and parallax offsets), `images`
 * where pictures are drawn (--images), `scene` the frame's background (--scene), `style` each
 * object's outline (--style); `native` evaluates it on its native timeline (--native) into
 * `<name>.native.reference.json`; `deep` loads movieclips nested deeper than a file opens (--deep).
 */
export function writeProject(out, name, document, ticks, {vfx = false, camera = false, images = false, scene = false, style = false, native = false, deep = false, inbetween = []} = {}) {
  const file = `${out}/${name}.json`, reference = `${out}/${name}${native ? '.native' : ''}.reference.json`;
  writeFileSync(file, JSON.stringify(prune(document)) + '\n');
  execFileSync(process.execPath, [`${here}/reference.mjs`, file, reference, '--ticks', ticks.join(','), ...(vfx ? ['--vfx'] : []), ...(camera ? ['--camera'] : []), ...(images ? ['--images'] : []), ...(scene ? ['--scene'] : []), ...(style ? ['--style'] : []), ...(native ? ['--native'] : []), ...(deep ? ['--deep'] : []), ...(inbetween.length ? ['--inbetween', inbetween.map(([index, ratio]) => `${index}:${ratio}`).join(',')] : [])], {stdio: ['ignore', 'ignore', 'ignore']});
  const dump = JSON.parse(readFileSync(reference, 'utf8'));
  delete dump.loadMs; delete dump.evalMsPerFrame;
  return {file, reference, dump};
}
export function writeReference(written, name) {
  writeFileSync(written.reference, JSON.stringify(written.dump) + '\n');
  const size = n => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`${name}: ${size(readFileSync(written.file).length)} project, ${written.dump.frames.length} ticks, ${size(JSON.stringify(written.dump).length)} reference`);
}
