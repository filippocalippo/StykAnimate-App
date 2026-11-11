import {vfxClips, sameVfxTarget} from './vfx-clips.mjs';

/** What the interface reads of the effects in the document; the effects the frame on show gives a figure or the scene (`vfxEffects`)
 * and the values of a clip (`sampleVfxClip`) are the session's reads (engine-owner.mjs), and every edit of them is the session's
 * (engine-commands.mjs). */
export const editorVfxMethods={
  getVfxClips(target){return vfxClips(this.report).filter(c=>!target||sameVfxTarget(c.target,target));},
};
