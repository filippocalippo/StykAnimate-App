import {messageError} from './localized-error.mjs';
import {VFX_REGISTRY,isGeneratorType} from './vfx-registry.mjs';
export {VFX_REGISTRY} from './vfx-registry.mjs';
import {vfxPaint} from './vfx-paint.mjs';
export const VFX_LIMIT=16;
const empty=Object.freeze([]), parsed=new Map();
export const isVfxProperty=property=>property==='vfxScope'||property==='vfxStack'||typeof property==='string'&&property.startsWith('vfx1:');
export function vfxProperty(type,id,param){const value=`vfx1:${type}:${id}:${param}`;if(!vfxDescriptor(value))throw messageError(new Error(''), "errors.vfx.invalidEffectParameter", {});return value;}
export function vfxDescriptor(property){
  if(property==='vfxScope')return {type:'number',discrete:true,min:0,max:1,label:'Include attached parts'};
  if(property==='vfxStack')return {type:'stack',discrete:true};
  if(typeof property!=='string'||!property.startsWith('vfx1:'))return null;
  if(parsed.has(property))return parsed.get(property);
  const parts=property.split(':'),[,effectType,id,param]=parts,definition=Object.hasOwn(VFX_REGISTRY,effectType)?VFX_REGISTRY[effectType]:null;
  if(parts.length!==4||!definition||!/^[a-zA-Z0-9_-]{1,64}$/.test(id))return null;
  const descriptor=param==='enabled'?{type:'number',default:1,min:0,max:1,step:1,discrete:true,label:'Enabled'}:definition.params[param];
  if(!descriptor)return null;
  const result={...descriptor,effectType,id,param};if(parsed.size>=4096)parsed.clear();parsed.set(property,result);return result;
}
export function validateVfxValue(property,value){
  if(property==='vfxStack')return validateVfxStack(value);
  const d=vfxDescriptor(property);if(!d)throw messageError(new Error(''), "errors.vfx.unknownVfxParameter", {});
  if(d.type==='color'&&typeof value==='object')return vfxPaint(value);
  if(typeof value!=='number'||!Number.isFinite(value)||value<d.min||value>d.max||(d.type==='color'||d.discrete)&&!Number.isInteger(value))throw messageError(new Error(''), "errors.cameraMotion.mustBeBetweenAnd", {label:{messageKey:property==='vfxScope'?'vfxInspector.wholeFigure':d.param==='enabled'?'vfxChannels.enabled':`vfxCatalog.parameter.${d.effectType}.${d.param}.label`,diagnosticValue:d.label},min:d.min,max:d.max});
  return value;
}
export function validateVfxStack(stack){
  if(!Array.isArray(stack)||stack.length>VFX_LIMIT)throw messageError(new Error(''), "errors.vfx.anEffectStackSupportsUpToEffects", {VFX_LIMIT: VFX_LIMIT});
  const ids=new Set();return stack.map(effect=>{
    if(!effect||![1,2].includes(effect.version)||!Object.hasOwn(VFX_REGISTRY,effect.type)||typeof effect.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(effect.id)||ids.has(effect.id)||typeof effect.enabled!=='boolean'||!effect.params||typeof effect.params!=='object'||Array.isArray(effect.params))throw messageError(new Error(''), "errors.vfx.invalidVfxStack", {});
    ids.add(effect.id);const definition=VFX_REGISTRY[effect.type],params={};
    if(Object.keys(effect.params).some(key=>!Object.hasOwn(definition.params,key)))throw messageError(new Error(''), "errors.vfx.unknownVfxParameter", {});
    for(const [name,descriptor] of Object.entries(definition.params))params[name]=validateVfxValue(vfxProperty(effect.type,effect.id,name),effect.params[name]??descriptor.default);
    if(effect.version===1&&effect.type==='outline'&&effect.params.rounded===undefined)params.rounded=0;
    return {version:2,id:effect.id,type:effect.type,enabled:effect.enabled,params};
  });
}
export function createVfx(type,id){if(!Object.hasOwn(VFX_REGISTRY,type))throw messageError(new Error(''), "errors.vfx.chooseAnAvailableEffect", {});return validateVfxStack([{version:2,type,id,enabled:true,params:{}}])[0];}
export function vfxOwnerKey(target){return target.kind==='segment'?`${target.figureTypeId??'*'}/${target.handleId}`:'figure';}
export function vfxStack(owner,target={kind:'figure'}){return (arguments.length===1&&owner?.objects?owner?._vfxTimelineScene:undefined)??owner?._stykVfx?.[vfxOwnerKey(target)]??empty;}
export function validateVfxOwner(owner){
  if(owner?._stykVfxScope!==undefined&&![0,1].includes(owner._stykVfxScope))throw messageError(new Error(''), "errors.vfx.invalidConnectedVfxScope", {});
  const value=owner?._stykVfx;if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>65536)throw messageError(new Error(''), "errors.vfx.invalidVfxOwner", {});
  for(const [key,stack] of Object.entries(value)){if(key!=='figure'&&!/^(\*|[1-9]\d*)\/[1-9]\d*$/.test(key))throw messageError(new Error(''), "errors.vfx.invalidVfxSegmentIdentity", {});if(Array.isArray(stack)&&stack.some(e=>isGeneratorType(e?.type)))throw messageError(new Error(''), "errors.vfx.generatedEffectsBelongOnTheEffectsTimeline", {});validateVfxStack(stack);}
}
const resolved=new WeakMap();
export function resolvedVfx(effect){let value=resolved.get(effect);if(!value){value=validateVfxStack([effect])[0];resolved.set(effect,value);resolved.set(value,value);}return value;}
/** Filters only: generators are built by the engine (styk_eval::vfx::generated), never a filter executor. */
export function activeVfx(stack){return stack?.length?stack.filter(e=>e.enabled&&!isGeneratorType(e.type)).map(resolvedVfx).filter(e=>!neutralVfx(e)):empty;}
function neutralVfx({type,params:p}){return p.effectStrength===0?true:type==='turbulence'?p.amount===0:type==='tint'?p.mix===0:type==='glow'?p.intensity===0&&p.coreMix===0:type==='outline'?(p.width===0||p.opacity===0)&&!p.only:type==='blur'?p.radius===0:type==='shadow'?p.opacity===0:type==='grade'?p.exposure===0&&p.contrast===1&&p.saturation===1&&p.temperature===0&&!p.tint&&!p.shadows&&!p.highlights&&p.gamma===1:type==='pixelate'?p.size<=1&&(p.linked||p.sizeY<=1):type==='noise'||type==='vignette'?p.amount===0:type==='dissolve'?p.progress===0:type==='rgbSplit'?p.amount===0:type==='wave'||type==='shockwave'?p.strength===0:type==='bloom'||type==='lightSweep'?p.intensity===0:type==='crt'?!p.amount&&!p.curvature&&!p.chromatic:false;}
function blurPadding(radius,sampling=false){
 if(radius<=0)return 0;
 // Match the executors' three box passes, minimum one-pixel kernel, and
 // downsample/upsample interpolation footprint, even at subpixel scales.
 const factor=Math.max(1,Math.ceil(radius/20)),kernel=Math.min(128,Math.max(1,Math.round(radius/factor*.57735)));
 const footprint=3*kernel*factor+(factor>1?2*factor:0);
 return sampling?footprint:Math.max(radius*3,footprint);
}
function stackPadding(stack,scale,extent,sampling){
 let n=0;
 for(const {type,params:p} of activeVfx(stack)){
  let pad=0;
  if(['blur','glow','bloom','shadow'].includes(type)){
   pad=type==='blur'&&p.mode?p.radius*scale*(sampling?1:3)+(sampling?2:0):blurPadding(p.radius*scale,sampling);
   pad+=(p.spread??0)*scale;
   if(type==='shadow')pad+=Math.max(Math.abs(p.offsetX),Math.abs(p.offsetY))*scale;
  }else if(type==='outline')pad=p.width*scale;
  else if(type==='pixelate')pad=Math.max(1,p.size*scale,(p.linked?p.size:p.sizeY)*scale);
  else if(type==='rgbSplit')pad=p.amount*Math.max(Math.abs(p.red),Math.abs(p.green),Math.abs(p.blue))*scale;
  else if(type==='turbulence')pad=p.amount*scale;
  else if(type==='wave'||type==='shockwave')pad=Math.abs(p.strength)*scale;
  else if(type==='crt')pad=p.chromatic*scale+p.curvature*extent;
  n+=Math.ceil(pad);
 }
 return n;
}
export function vfxPadding(stack,scale=1,extent=0){return stackPadding(stack,scale,extent,false);}
