import {invalidateFrameIndex} from './frame-ids.mjs';

export function applyFrameTiming(editor,command,direction){
  for(const change of command.changes){
    const frame=editor.report.keyframes[change.index],value=change[direction];
    const replacement={...frame};
    if(value.exists)replacement.duration_raw=value.value;else delete replacement.duration_raw;
    editor.report.keyframes[change.index]=replacement;
  }
  invalidateFrameIndex(editor.report);
}

/** Timing cannot change the native pose at the same key's start. Authored
 * channels, working drafts and inbetween ticks retain full invalidation. */
export function captureTimingGeometry(editor){
  if(!editor._geometry||editor._frameDraftEnabled||editor.animationChannels.length||editor._authoredPoseEdit||
    editor.tick!==editor.timeline[editor.frameIndex]?.start)return null;
  return {geometry:editor._geometry,index:editor.frameIndex,objects:editor.frame.objects};
}
export function restoreTimingGeometry(editor,retained){
  if(retained&&editor.frameIndex===retained.index&&editor.frame.objects===retained.objects&&
    editor.tick===editor.timeline[editor.frameIndex]?.start){
    editor._geometry=retained.geometry;editor._incremental=null;
    editor._seekGeometry?.adopt(editor.report,editor.evaluatedFrame,editor.revision,retained.geometry);
  }
}
