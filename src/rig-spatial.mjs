import {validationLabel} from "./validation-labels.mjs";
import {messageError} from './localized-error.mjs';
/** Spatial articulation in the native rig dependency graph. Rotation still uses
 * ordinary angle channels; depth is derived, never a separate animated scene. */
const EPS=1e-9;
export const spatialBone=s=>Boolean(s?._stykRig?.spatial?.origin);
export const spatialSkin=s=>Boolean(s?._stykRig?.spatial?.bindings);
const sameVector=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===3&&b.length===3&&a[0]===b[0]&&a[1]===b[1]&&a[2]===b[2];
const sameMotion=(a,b)=>a===b||Boolean(a&&b&&a.type===b.type&&a.min===b.min&&a.max===b.max&&
  (a.axis===b.axis||sameVector(a.axis,b.axis))&&a.driver?.joint===b.driver?.joint&&a.driver?.multiplier===b.driver?.multiplier);
export function sameSpatial(a,b){
  if(a===b)return true;if(!a||!b)return false;
  if(a.bindings||b.bindings)return Boolean(Array.isArray(a.bindings)&&Array.isArray(b.bindings)&&a.bindings.length===b.bindings.length&&sameVector(a.point,b.point)&&a.bindings.every((v,i)=>v?.joint===b.bindings[i]?.joint&&v?.weight===b.bindings[i]?.weight)&&
    (a.viewPoints===b.viewPoints||Array.isArray(a.viewPoints)&&Array.isArray(b.viewPoints)&&a.viewPoints.length===b.viewPoints.length&&a.viewPoints.every((p,i)=>sameVector(p,b.viewPoints[i]))));
  return a.parent===b.parent&&a.turn===b.turn&&a.pitch===b.pitch&&sameVector(a.origin,b.origin)&&sameVector(a.tip,b.tip)&&sameMotion(a.motion,b.motion);
}
export function validateSpatial(s,reference,dependencies,segments,ids){
  const vector=v=>Array.isArray(v)&&v.length===3&&[0,1,2].every(i=>Number.isFinite(v[i])&&Math.abs(v[i])<=1e6);
  if(!s||typeof s!=='object'||Array.isArray(s))throw messageError(new Error(''), "errors.rigSpatial.invalidSpatialJoint", {});
  const ref=(id,label,bone=false)=>{reference(id,label,true);dependencies.add(id);if(id&&bone&&!spatialBone(segments[ids.get(id)]))throw messageError(new Error(''), "errors.rigSpatial.mustBeAnArticulatedSpatialJoint", {label: validationLabel(label)});};
  if(s.bindings){
    if(Object.keys(s).some(k=>!['point','bindings','viewPoints'].includes(k))||!vector(s.point)||!Array.isArray(s.bindings)||!s.bindings.length||s.bindings.length>4)throw messageError(new Error(''), "errors.rigSpatial.aSkinPointNeedsAPositionAnd1", {});
    if(s.viewPoints!==undefined&&(!Array.isArray(s.viewPoints)||![4,8].includes(s.viewPoints.length)||Array.from({length:s.viewPoints.length},(_,i)=>i).some(i=>!vector(s.viewPoints[i]))||s.bindings.length!==1))throw messageError(new Error(''), "errors.rigSpatial.viewCorrectedSkinNeedsFourCardinalOrEight", {});
    const seen=new Set();let sum=0;
    for(const b of s.bindings){if(!b||Object.keys(b).some(k=>!['joint','weight'].includes(k))||!Number.isFinite(b.weight)||b.weight<=0||b.weight>1||seen.has(b.joint))throw messageError(new Error(''), "errors.rigSpatial.skinWeightsMustUseDistinctJointsAndPositive", {});ref(b.joint,'Skin binding',true);if(!b.joint)throw messageError(new Error(''), "errors.rigSpatial.bindSkinToAnArticulatedJoint", {});seen.add(b.joint);sum+=b.weight;}
    if(Math.abs(sum-1)>1e-6)throw messageError(new Error(''), "errors.rigSpatial.skinWeightsMustAddUpToOne", {});
  }else{
    if(Object.keys(s).some(k=>!['parent','turn','pitch','origin','tip','motion'].includes(k))||!vector(s.origin)||!vector(s.tip))throw messageError(new Error(''), "errors.rigSpatial.anArticulatedJointNeedsARestOriginAnd", {});
    if(s.motion!==undefined){
      const m=s.motion,limit=m?.type==='hinge'?2*Math.PI:1e6;
      if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!['type','min','max','axis','driver'].includes(k))||!['slide','hinge'].includes(m.type)||![m.min,m.max].every(v=>Number.isFinite(v)&&Math.abs(v)<=limit)||m.min>m.max||
        m.axis!==undefined&&(m.type!=='hinge'||!vector(m.axis)||Math.abs(Math.hypot(...m.axis)-1)>1e-6))
        throw messageError(new Error(''), "errors.rigSpatial.aMechanicalJointNeedsASlideOrHinge", {});
      if(m.type==='slide'&&Math.hypot(...s.tip.map((n,i)=>n-s.origin[i]))<=EPS)throw messageError(new Error(''), "errors.rigSpatial.aSlidingJointSlidesFromItsOriginToward", {});
      if(m.driver!==undefined){
        const d=m.driver;
        if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['joint','multiplier'].includes(k))||!d.joint||!Number.isFinite(d.multiplier)||Math.abs(d.multiplier)>10)
          throw messageError(new Error(''), "errors.rigSpatial.aMechanicalJointNeedsASlideOrHinge", {});
        ref(d.joint,'Motion driver',true);
        if(!segments[ids.get(d.joint)]._stykRig.spatial.motion)throw messageError(new Error(''), "errors.rigSpatial.aMechanicalJointNeedsASlideOrHinge", {});
      }
    }
    ref(s.parent,'Spatial parent',true);ref(s.turn,'Turn control');ref(s.pitch,'Tilt control');
    if(!s.turn||!s.pitch||s.turn===s.pitch)throw messageError(new Error(''), "errors.rigSpatial.chooseSeparateTurnAndTiltControls", {});
  }
}
export function remapSpatial(s,map){return s.bindings?{point:[...s.point],bindings:s.bindings.map(b=>({...b,joint:map.get(b.joint)??b.joint})),...(s.viewPoints?{viewPoints:s.viewPoints.map(p=>[...p])}:{})}:{...s,origin:[...s.origin],tip:[...s.tip],...(s.motion?{motion:{...s.motion,
  ...(s.motion.axis?{axis:[...s.motion.axis]}:{}),...(s.motion.driver?{driver:{...s.motion.driver,joint:map.get(s.motion.driver.joint)??s.motion.driver.joint}}:{})}}:{}),...Object.fromEntries(['parent','turn','pitch'].map(k=>[k,map.get(s[k])??s[k]]))};}
export function spatialAxisQuaternion(axis,angle){const h=Math.sin(angle/2)/Math.hypot(...axis);return[axis[0]*h,axis[1]*h,axis[2]*h,Math.cos(angle/2)];}
export function quatMultiply(a,b){return[a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];}
export function quatRotate(q,p){const[x,y,z,w]=q,[a,b,c]=p,tx=2*(y*c-z*b),ty=2*(z*a-x*c),tz=2*(x*b-y*a);return[a+w*tx+y*tz-z*ty,b+w*ty+z*tx-x*tz,c+w*tz+x*ty-y*tx];}
export function spatialQuaternion(bend,turn,pitch){
  const x=pitch/2,y=turn/2,z=bend/2,cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z);
  return[sx*cy*cz-cx*sy*sz,cx*sy*cz+sx*cy*sz,cx*cy*sz-sx*sy*cz,cx*cy*cz+sx*sy*sz];
}
export function spatialPoint(frame,point){
  let p=point;
  if(frame.shape){const offset=shapeOffset(frame,point);p=point.map((n,i)=>n+offset[i]);}
  if(frame.choiceScale!==undefined){p=p.map((n,i)=>frame.origin[i]+(n-frame.origin[i])*frame.choiceScale);}
  else if(Math.abs(frame.stretch-1)>EPS){const v=frame.axis,d=(point[0]-frame.origin[0])*v[0]+(point[1]-frame.origin[1])*v[1]+(point[2]-frame.origin[2])*v[2];p=p.map((n,i)=>n+d*(frame.stretch-1)*v[i]);}
  const rotated=quatRotate(frame.q,p);for(let i=0;i<3;i++)rotated[i]+=frame.t[i];return rotated;
}
function shapeOffset(frame,point){
  const r=point.map((n,i)=>n-frame.origin[i]),d=r.reduce((sum,n,i)=>sum+n*frame.axis[i],0);
  const u=Math.max(0,Math.min(1,d/frame.restLength)),amount=frame.shape.width*(1+frame.shape.taper*u*u*(3-2*u))-1;
  return r.map((n,i)=>(n-d*frame.axis[i])*amount);
}

const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const normalize=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const axes=[[1,0,0],[0,1,0],[0,0,1]];
/** Choose the equivalent native Euler channels nearest the previous pose.
 * The manipulator itself rotates quaternions, including at Euler singularities. */
export function quaternionPose(q,previous){
 const [x,y,z,w]=normalize(q),sy=Math.max(-1,Math.min(1,2*(w*y-z*x))),turn=Math.asin(sy);
 let pitch,bend;
 if(Math.abs(sy)>1-1e-10){
  pitch=previous.pitch;
  const a=quatMultiply([x,y,z,w],[-Math.sin(pitch/2),0,0,Math.cos(pitch/2)]);
  bend=2*Math.atan2(a[2],a[3]);
 }else{
  pitch=Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y));
  bend=Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z));
 }
 const candidates=[{pitch,turn,bend},{pitch:pitch+Math.PI,turn:Math.PI-turn,bend:bend+Math.PI}].map(p=>Object.fromEntries(Object.keys(p).map(k=>[k,previous[k]+wrap(p[k]-previous[k])])));
 return candidates.sort((a,b)=>Object.keys(a).reduce((s,k)=>s+(a[k]-previous[k])**2-(b[k]-previous[k])**2,0))[0];
}
export function betweenVectors(a,b){
 const d=dot(a,b);if(d<-.999999){const axis=normalize(cross(a,Math.abs(a[0])<.8?axes[0]:axes[1]));return [...axis,0];}
 return normalize([...cross(a,b),1+d]);
}
