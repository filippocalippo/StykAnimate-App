// Spec → open animation: prepares text, figure files and audio in the app, compiles, then loads.
import {compileSpec} from './spec.mjs';

export async function buildAnimation(session, spec) {
  const external = await session.textFigures((spec.cast ?? []).filter(member => member.kind === 'text'));
  for (const member of spec.cast ?? []) if (member.kind === 'file') {
    if (!member.path) throw new Error(`${member.id}: a file figure needs "path" to a .stk file`);
    external.set(member.id, {figure: await session.figureFile(member.path)});
  }
  const audio = spec.audio?.length ? await session.prepareAudio(spec.audio) : [];
  let compiled = compileSpec(spec, external);
  // Lengthen the last keyframe so the animation lasts as long as its sound.
  const audioEnd = Math.max(0, ...audio.map(clip => clip.start + clip.duration));
  const fps = spec.fps ?? 24, needed = Math.ceil(audioEnd * fps) - compiled.ticks;
  if (spec.extendToAudio !== false && needed > 0) {
    const keyframes = structuredClone(spec.keyframes);
    keyframes.at(-1).hold = (keyframes.at(-1).hold ?? 12) + needed;
    compiled = compileSpec({...spec, keyframes}, external);
  }
  const opened = await session.load(compiled.document, spec.title ?? 'Untitled animation');
  return {...opened, audio};
}
