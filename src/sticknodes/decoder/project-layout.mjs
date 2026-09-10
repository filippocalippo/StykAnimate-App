/**
 * Independent, version-conditioned record layouts established by static analysis
 * of the user-supplied Android loader. No application code is distributed.
 * `fieldRanges` retain exact source offsets for audit and lossless pose edits.
 */
import {BinaryReader} from './binary.mjs';
const WIDTH={flag:1,u8:1,i8:1,i16:2,i32:4,f32:4,color:4};
export const KNOWN_PROJECT_LAYOUT={minVersion:110,maxVersion:431,maxBuild:117};
export function recordReader(r,target={}) {
 target.fieldRanges??={};
 return (name,type='f32',present=true,fallback=undefined)=>{
  if(!present){if(fallback!==undefined)target[name]=fallback;return fallback;}
  const start=r.offset, value=type==='string'?r.string(name):r[type]();
  target[name]=value;target.fieldRanges[name]={start,end:r.offset,type};return value;
 };
}
export function compilePoseLayout(v,b,connector=false){
 const fields=[];let size=0;const a=(name,type='f32',when=true)=>{if(when){fields.push({name,type,offset:size,length:WIDTH[type]});size+=WIDTH[type];}};
 a('is_stretchy','flag');a('is_floaty','flag',b>=48);a('is_smart_stretch','flag',v>=248&&b<22);
 a('use_segment_color','flag');a('use_circle_outline','flag',v>=256);a('circle_is_hollow','flag',b>=21);
 a('use_gradient','flag',v>=176);a('reverse_gradient','flag',v>=176);a('gradient_mode','i16',b>=20);
 a('use_segment_scale','flag');a('scale');a('length');a('thickness','i32');a('local_angle');
 a('default_local_angle','f32',v>=259);a('default_angle','f32',v>=259);
 a('color','color');a('gradient_color','color',v>=176);a('circle_outline_color','color',v>=256);
 a('use_polyfill_color','flag',v>=230);a('polyfill_color','color',v>=230);
 a('right_triangle_direction','i16',v>=259);
 a('segment_curve_radius_and_default_curve_radius','i32',v>=320);
 a('curve_circulization','flag',b>=20);a('segment_curve_polyfill_precision','i16',b>=21);
 if(v>=320){
  if(b<36)a('trapezoid_top_thickness_ratio');
  else{
   a('trapezoid_thickness_start',b<64?'i32':'f32');a('trapezoid_thickness_end',b<64?'i32':'f32');
   if(b===36){a('use_trapezoid_thickness_start','flag');a('use_trapezoid_thickness_end','flag');}
   else{a('trapezoid_is_rounded_start','flag');a('trapezoid_is_rounded_end','flag');a('trapezoid_top_thickness_ratio');}
  }
 }
 if(b>=41){
  if(b<=50){a('is_angle_locked','flag');a('legacy_angle_lock_offset');}
  else if(b<=56){a('is_angle_locked','flag');a('angle_lock_is_main_node','flag');a('angle_lock_offset_minuend');a('angle_lock_offset_subtrahend');}
  else if(b<=66){a('legacy_angle_locked','flag');a('legacy_angle_main','flag');a('angle_lock_offset');a('legacy_angle_relative_start','f32',b>=63);a('legacy_angle_relative_multiplier','i8',b>=63);}
  else a('angle_lock_offset');
  a('is_drag_locked','flag');a(b<=45?'legacy_drag_lock_mode':'drag_lock_angle',b<=45?'i16':'f32');
 }
 if(connector&&b>=43){a('connector_local_x');a('connector_local_y');a('connector_value');a('connector_percent');}
 if(connector&&b>=65)a('connector_smart_stretch_ancestral_value');
 return {fields,size,version:v,build:b,connector};
}
export function readPoseRecord(r,layout,{ranges=true}={}){
 const start=r.offset,p={};if(ranges)p.fieldRanges={};
 for(const f of layout.fields){p[f.name]=r[f.type]();if(ranges)p.fieldRanges[f.name]={start:start+f.offset,end:start+f.offset+f.length,type:f.type};}
 p.range={start,end:r.offset};return p;
}
export function skipPoseRecords(r,meta,layouts,validate=true){
 const start=r.offset;const nodes=meta.nodeCount,connectors=meta.connectorIndices??[];const total=nodes*layouts.normal.size+connectors.length*(layouts.connector.size-layouts.normal.size);r.need(total,'node poses');
 if(validate){let pos=start,ci=0;const b=r.bytes,d=r.view;for(let i=0;i<nodes;i++){
  const isConnector=connectors[ci]===i;if(isConnector)ci++;const s=isConnector?layouts.connector:layouts.normal;
  for(const f of s.fields){if(f.type==='flag'&&b[pos+f.offset]>1)r.fail('INVALID_POSE_FLAG',`Node ${i}: ${f.name} is not a boolean.`,'pose',pos+f.offset);if(f.type==='f32'&&!Number.isFinite(d.getFloat32(pos+f.offset)))r.fail('NON_FINITE_POSE',`Node ${i}: ${f.name} is not finite.`,'pose',pos+f.offset);}
  pos+=s.size;
 }}return r.skip(total,'node poses');
}
export function readStyle(r,v,b){
 const o={},a=recordReader(r,o);
 a('opacity','f32',v>=220,1);a('blur','f32',v>=220,0);
 if(b>=16){a('motionBlur','flag');a('omnidirectionalBlur','flag');a('motionBlurAngle','i32');}
 else if(v>=220){a('legacyHorizontalBlur','flag');a('legacyVerticalBlur','flag');}
 a('saturation','f32',v>=220,1);a('pixelation','i32',b>=16,0);
 a('tintColor','color',v>=220);a('tintAmount','f32',v>=220,0);a('hueShift','f32',v>=303,0);a('invert','flag',v>=220,false);
 a('glow','f32',v>=230,0);a('glowColor','color',v>=230);a('glowIntensity','f32',v>=242,1);
 a('outlineColor','color',b>=32);a('outlineAlpha','f32',b>=32,0);a('outlineThickness','f32',b>=32,0);
 a('dropShadowColor','color',v>=330);a('dropShadowAlpha','f32',v>=330,0);a('dropShadowDistance','i32',v>=330,0);a('dropShadowAngle','i32',v>=330,0);a('dropShadowBlur','f32',v>=330,0);
 return o;
}
export function readInstanceHeader(r,v,b,type){
 const start=r.offset,o={},a=recordReader(r,o);a('id','i32');
 if(type===0)a('scale');o.style=readStyle(r,v,b);
 if(type===0){
  a('x');a('y');a('color','color');a('isLocked','flag',v>=126,false);a('persistent','flag',v>=180,false);
  a('visibleInOnionSkin','flag',b>=15,true);a('tweenColors','flag',v>=230,false);
  a('tweenMode',b>=78?'i8':'flag',v>=230,0);
  a('scaleJoinedFigures','flag',v>=244,false);a('pushJoinedFigures','flag',v>=400,false);a('setStateOfJoins','flag',v>=400,false);a('joinsState','i32',v>=400,0);
  a('useParentFilters','flag',v>=310,false);a('lockedNodeId','i32',v>=248,-1);a('lockedNodeX','f32',v>=248,0);a('lockedNodeY','f32',v>=248,0);
 }else if(type===1){
  a('useParentFilters','flag',v>=310,false);a('scale');a('x');a('y');
  a('currentFrameIndex','i32');a('startFrameIndex','i32');a('flipX','i32');a('flipY','i32');a('playMode','i32');a('volumeScale');
  a('playDuringDelay','flag');a('isLocked','flag');a('persistent','flag');a('tweenMode','i8',b>=78,0);a('visibleInOnionSkin','flag',b>=15,true);
  a('rotation');a('secondaryRotation');
  o.playback={currentFrameIndex:o.currentFrameIndex,startFrameIndex:o.startFrameIndex,playMode:o.playMode,volumeScale:o.volumeScale,playDuringDelay:o.playDuringDelay};
 }else{
  a('useParentFilters','flag');a('legacySpriteByte0','u8',b<2);a('legacySpriteByte1','u8',b<2);a('scaleXYRatio');a('scaleX');a('scaleY');
  for(const corner of ['Tl','Tr','Bl','Br']){a('distort'+corner+'X','f32',b>=110,0);a('distort'+corner+'Y','f32',b>=110,0);}
  a('pivotX');a('pivotY');a('x');a('y');a('rotation');a('flipX','flag');a('flipY','flag');a('persistent','flag');
  a('tweenMode','i8',b>=78,0);a('visibleInOnionSkin','flag',b>=15,true);a('lockState','i32');a('smartStretchState','i32');
  // Native sprite records append nine parameters only when smart stretch is on.
  // Preserve their offsets even where their solver semantics remain unknown.
  if(o.smartStretchState!==0)for(let index=0;index<9;index++)a('smartStretchParameter'+index);
  if(type===3)a('groupFrame','i32');
 }
 o.headerRange={start,end:r.offset};return o;
}
export function readProjectHeader(r,v,b){
 const start=r.offset,o={},a=recordReader(r,o);
 a('editorFlagD','flag',b>=16,false);
 if(v>=220){a('editorFlagE','flag',v>=244,false);a('projectCredit','string');a('editorColor','color');}
 a('fps','i32');a('tweenCount','i32',v>=176,2);a('editorFlagB','flag',v>=127,false);a('editorFlagZ','flag',v>=113,false);a('editorFlagA','flag');a('editorFlagC','flag',v>=220,false);
 a('autoTween','flag');a('timelineFlagC','flag',v>=127,false);a('legacyFlag','flag',v>=140&&v<200,false);a('selectedFrame','i32');a('nextTextId','i32',v>=176,0);a('nextInstanceId','i32',v>=300,0);a('nextLibraryId','i32',v>=300,0);
 const fontCount=v>=400?r.count('fonts',10000):0;o.fontUsage=Array.from({length:fontCount},()=>r.flag());
 const orderLists=[];for(let j=0;j<(v>=400?3:v>=300?2:0);j++){const p=r.offset,n=r.count('library order',20000);orderLists.push({range:{start:p,end:p+4+n*4},values:Array.from({length:n},()=>r.i32())});}
 const libraryMetadata=[];if(v>=300){const n=r.count('metadata.outer',20000);for(let j=0;j<n;j++){const key=r.i32(),inner=[];const c=r.count('metadata.inner',20000);for(let k=0;k<c;k++){const innerKey=r.i32(),pairs=[];const p=r.count('metadata.pairs',20000);for(let l=0;l<p;l++)pairs.push([r.i32(),r.i32()]);inner.push({key:innerKey,pairs});}libraryMetadata.push({key,inner});}}
 let legacyBackground=null;
 if(v>=140&&v<400&&r.flag()){
  legacyBackground={};const f=recordReader(r,legacyBackground);
  if(v<170)f('legacyFit','flag');else{f('scaleX');f('scaleY');}
  const w=r.count('legacyBackground.width',32768),h=r.count('legacyBackground.height',32768);if(w*h>64000000)r.fail('PIXEL_LIMIT','Legacy background too large.');Object.assign(legacyBackground,{width:w,height:h,channels:3,pixelRange:r.skip(w*h*3)});
 }
 o.range={start,end:r.offset};return {settings:o,orderLists,libraryMetadata,legacyBackground};
}
export function readMainSettings(r,v,b){const start=r.offset,o={},a=recordReader(r,o);
 a('isTweened','flag');a('useImageBackground','flag',v>=140,true);a('useGradient','flag',v>=200,false);a('expandedGradient','flag',v>=200,false);a('stopSounds','flag',v>=160,false);
 a('isDelayed','flag',v>=200,false);a('delaySeconds','f32',v>=200,0);a('slowMotion','flag',v>=310,false);a('slowMotionTweenFrames','i32',v>=310,0);
 a('repeating','flag',v>=330,false);a('repeatBackFrames','i32',v>=330,0);a('repeatLoops','i32',v>=330,0);a('tweenWhenRepeating','flag',v>=330,false);
 a('cameraDuringDelay','flag',v>=310,false);a('easeIn','flag',v>=310,false);a('easeOut','flag',v>=310,false);a('interpolation','i16',v>=310,0);
 a('backgroundColor','color');a('backgroundGradientColor','color',v>=200);a('soundIndex','i32',v>=160,-1);a('soundVolume','f32',v>=160,1);a('soundPan','f32',v>=310,0);a('soundPitch','f32',v>=310,1);
 o.range={start,end:r.offset};o.colorA=o.backgroundColor;o.colorB=o.backgroundGradientColor;return o;
}
export function readProjectText(r,v,b,index=0){const start=r.offset,o={},a=recordReader(r,o);
 a('id','i32',v>=176,index);a('fontIndex','i32',v>=244,0);a('x');a('y');a('scale');a('text','string');a('color','color');a('align','i32');a('rotation','f32',v>=237,0);a('opacity','f32',v>=237,1);a('aboveBars','flag',v>=310,false);a('isLocked','flag',v>=310,false);a('hasShadow','flag',v>=242,false);a('shadowColor','color',v>=242);
 o.range={start,end:r.offset};return o;
}
export function readCamera(r,v,b){const start=r.offset,o={},a=recordReader(r,o);
 a('zoom','f32',v>=170,1);a('x','f32',v>=170,0);a('y','f32',v>=170,0);a('rotation','f32',v>=230,0);
 if(v>=310){a('wobbleXY','flag');a('wobbleRotation','flag');a('wobbleScale','flag');a('wobbleXYIntensity','i32');a('wobbleRotationIntensity');a('wobbleSpeed');}
 else if(v>=230){a('legacyWobble','flag');a('legacyWobbleIntensity');a('wobbleSpeed');}
 a('widescreen','flag',v>=220,false);a('legacyFlag','flag',v>=220&&v<244,false);
 o.bindings=[];if(v>=237){const n=r.count('camera.bindings',20000);for(let i=0;i<n;i++){const x={},f=recordReader(r,x);f('instanceId','i32');f('nodeId','i32');f('kind','i32',v>=300,0);for(let j=0;j<9;j++)f('parameter'+j);f('enabled','flag');o.bindings.push(x);}}
 o.secondaryBindings=[];if(v>=310){const n=r.count('camera.secondaryBindings',20000);for(let i=0;i<n;i++){const x={},f=recordReader(r,x);f('instanceId','i32');for(let j=0;j<8;j++)f('parameter'+j);o.secondaryBindings.push(x);}}
 o.range={start,end:r.offset};return o;
}
export function readProjectTrailer(r,v,b){const start=r.offset,o={tweenLinks:[],editorPairs:[]};
 if(v>=237){const n=r.count('tweenLinks',100000);for(let i=0;i<n;i++){const t={},f=recordReader(r,t);f('startFrame','i32');f('endFrame','i32');f('easeIn','flag');f('easeOut','flag');f('interpolation','i16',v>=256,0);o.tweenLinks.push(t);}}
 const viewport={};if(v>=251){const f=recordReader(r,viewport);f('selectionMode','i32');for(let i=0;i<5;i++)f('parameter'+i);f('selectedAsset','i32');
  for(const [name,present]of [['i',v>=300],['j',v>=300],['k',true],['l',true],['m',v>=300],['n',v>=310],['o',v>=310],['p',true],['r',b>=84],['s',b>=84],['t',b>=84],['u',b>=84]])f('flag_'+name,'flag',present,false);
  f('mode','i8',b>=79,0);viewport.palette=b>=84?Array.from({length:7},()=>r.color()):[];
 }o.viewport=viewport;
 if(v>=319){const n=r.count('editorPairs',100000);for(let i=0;i<n;i++)o.editorPairs.push([r.i32(),r.i32()]);}
 o.range={start,end:r.offset};return o;
}
