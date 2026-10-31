import {messageError} from './localized-error.mjs';
/** The Simple timeline's working frame, as a saved document records it. Enabling and editing a working frame are commands of the engine
 * session (`enableFrameDrafts`, `beginFrameDraft`, ...); the editor keeps only the check of what a document stores. */
import {validateScene} from './pivot/model.mjs';
import {validateAnimationDocument} from './animation-channels.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export function validateSimpleFrameDraft(report, {validateFrame = true} = {}) {
  const state = report._styk?.simpleFrameDraft;
  if (state === undefined) return;
  if (!state || state.version !== 1 || !['add', 'update'].includes(state.mode) ||
    !Number.isInteger(state.index) || !report.keyframes[state.index] ||
    state.frameId !== report.keyframes[state.index]._styk?.frameId)
    throw messageError(new Error(''), "errors.editorFrameDraft.invalidSimpleTimelineWorkingFrame", {});
  if (state.empty !== undefined && typeof state.empty !== 'boolean' || state.empty && (state.mode !== 'add' || state.index !== 0 || report.keyframes.length !== 1))
    throw messageError(new Error(''), "errors.editorFrameDraft.anEmptySimpleAnimationRequiresOneAddWorking", {});
  if (state.baseline !== undefined) {
    if (state.baseline?._styk?.frameId !== state.frameId) throw messageError(new Error(''), "errors.editorFrameDraft.theWorkingFrameCheckpointHasADifferentIdentity", {});
    if (validateFrame) validateScene({...report, keyframes: [state.baseline]});
  }
  if (own(state, 'animationBaseline')) {
    if (state.animationBaseline === undefined) throw messageError(new Error(''), "errors.editorFrameDraft.anAnimationCheckpointMustBeAChannelTable", {});
    if (!state.baseline) throw messageError(new Error(''), "errors.editorFrameDraft.anAnimationCheckpointRequiresAWorkingFrameBaseline", {});
    if (validateFrame) validateAnimationDocument({...report, _styk: {...report._styk, animation: state.animationBaseline}});
  }
}

