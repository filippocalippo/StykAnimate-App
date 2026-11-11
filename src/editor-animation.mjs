/** What the editor reads of the authored animation: its channels and the camera-motion clips. The values the frame on show gives
 * them are the session's reads (`animationValue`, `segmentAnimationTarget`, `engine-owner.mjs`). Every edit of them is a command
 * of the engine session. */
import {animationChannels, animationEndTick, findAnimationChannel, normalizeAnimationTarget} from './animation-channels.mjs';

const noClips = Object.freeze([]);

export const editorAnimationMethods = {
  get animationChannels() { return animationChannels(this.report); },
  get animationEndTick() { return animationEndTick(this.report); },
  resolveAnimationTarget(target,property,tick=this.tick){
    return target?.kind==='segment'&&target.figureTypeId===undefined?this.segmentAnimationTarget(target.uid,target.handleId,property,tick):normalizeAnimationTarget(target);
  },
  animationChannel(target, property, {exactTarget=false}={}) { return findAnimationChannel(this.report, exactTarget?normalizeAnimationTarget(target):this.resolveAnimationTarget(target,property), property); },
  getCameraMotions() { return this.report._styk.cameraMotion?.clips ?? noClips; },
  /** The open motion-path gesture's falloff plan for the overlay, or null. */
  motionPathFalloff() {
    const session = this._drag;
    if (!session?.motionPath || !session.falloff) return null;
    return {tick: session.tick, ...session.falloff, writes: session.writes,
      changed: new Set(session.subs.filter(sub => sub.moved || (sub.kind === 'edge' && session.moved)).map(sub => sub.tick))};
  },
};
