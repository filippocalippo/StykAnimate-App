/** Native Pivot saves stored keys, excluding an uncommitted Add-frame pose. */
import {validateSimpleFrameDraft} from './editor-frame-draft.mjs';

export function storedFrameReport(report, {validate = true} = {}) {
  if (report._styk?.simpleFrameDraft === undefined) return report;
  if (validate) validateSimpleFrameDraft(report);
  const draft = report._styk.simpleFrameDraft, metadata = {...report._styk};
  delete metadata.simpleFrameDraft;
  if (draft.empty === true) return {...report,_styk:metadata,keyframes:[],total_output_frames:0,duration_seconds:0};
  let keyframes = report.keyframes;
  if (draft.mode === 'add' && draft.baseline) {
    // Both the visible draft and its checkpoint retain one native identity.
    // Replace just that key; do not append or duplicate any source frames.
    keyframes = keyframes.slice(); keyframes[draft.index] = draft.baseline;
    if (Object.hasOwn(draft, 'animationBaseline')) {
      if (draft.animationBaseline === null) delete metadata.animation;
      else metadata.animation = draft.animationBaseline;
    }
  }
  return {...report, _styk: metadata, keyframes};
}

export const materializeSimpleFrameDraftForPivot = storedFrameReport;
