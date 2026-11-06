import {spatialCamera, spatialShape} from './spatial-projection.mjs';
import {spatialBone} from './rig-spatial.mjs';

export const editorSpatialMethods={
 /** The 3D rig's perspective and part proportions (the engine session sets them); the pose and motion of a bone are the session's reads (`getSpatialPose`, `getSpatialMotion`). */
 getSpatialCamera(){return spatialCamera(this.object);},
 getSpatialProportions(){
  const f=this.figure,o=this.object,s=f?.segments[this.selectedJoint];if(!o||!spatialBone(s))return null;
  return {...spatialShape(o,s.segment_id),canResizeLength:s.length>1e-9,length:s.length>1e-9?(o.len_flag?o.lengths[this.selectedJoint]:s.length)/s.length:1};
 },
};
