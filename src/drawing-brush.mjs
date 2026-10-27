import {messageError} from './localized-error.mjs';

/** The brush settings of the drawing workspace: the defaults every preset starts from, their
 * validation and the pen pressure curve. The dab pipeline itself (the stroke path, tapers, jitter and
 * the dab shapes) and the raster live in the drawing raster engine (docs/engine/drawing.md). */
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
const BRUSH_BLENDS=['normal','behind','multiply','screen','overlay','color','smudge'];
const BRUSH_ANGLE_MODES=['fixed','direction','tilt'];
const BRUSH_TIPS=['round','chalk','bristle','sponge'];
const BRUSH_GRAINS=['noise','paper','canvas'];
const STABILIZER_MODES=['average','string'];
/** Cubic Bézier control points (x1,y1,x2,y2) of the identity pressure curve. */
export const LINEAR_PRESSURE=Object.freeze([.25,.25,.75,.75]);
/** Every setting a brush preset defines, with its default. Presets, saved
 * brushes, per-tool tips and the preview all read this one list. */
export const BRUSH_DEFAULTS=Object.freeze({
  size:8,opacity:1,flow:1,hardness:1,
  pressureSize:true,pressureOpacity:false,pressureFlow:false,sizeCurve:1,opacityCurve:1,
  stabilization:0,stabilizerMode:'average',spacingRatio:.12,
  tip:'round',roundness:1,angle:0,angleMode:'fixed',
  scatter:0,sizeJitter:0,opacityJitter:0,angleJitter:0,taperIn:0,taperOut:0,
  texture:0,grain:'noise',grainScale:1,
  blend:'normal',alphaLock:false,smudgeLength:.8,colorRate:0,
});
export const BRUSH_KEYS=Object.keys(BRUSH_DEFAULTS);
/** Settings measured in document units: the caller scales them to cel pixels. */
export const BRUSH_LENGTHS=['size','taperIn','taperOut','grainScale'];
const NUMBERS=['size','opacity','flow','hardness','sizeCurve','opacityCurve','stabilization','spacingRatio','roundness','angle','scatter','sizeJitter','opacityJitter','angleJitter','taperIn','taperOut','texture','grainScale','smudgeLength','colorRate','pixelsPerUnit'];

/** Clamped, validated brush settings. Idempotent, so any layer may normalize. */
export function normalizeBrush(settings={}){
  const b={...BRUSH_DEFAULTS,color:[0,0,0],erase:false,seed:0,pixelsPerUnit:1,pressureCurve:LINEAR_PRESSURE};
  for(const key in settings)if(settings[key]!==undefined)b[key]=settings[key];
  if(!NUMBERS.every(key=>Number.isFinite(b[key]))||!Array.isArray(b.color)||b.color.length!==3||!b.color.every(Number.isFinite))throw messageError(new Error(''), "errors.drawingBrush.invalidBrushSettings", {});
  const curve=Array.isArray(b.pressureCurve)&&b.pressureCurve.length===4&&b.pressureCurve.every(Number.isFinite)?b.pressureCurve.map(n=>clamp(n)):LINEAR_PRESSURE;
  const blend=BRUSH_BLENDS.includes(b.blend)?b.blend:'normal',smudge=blend==='smudge'&&!b.erase;
  return {
    size:clamp(b.size,.5,8192),color:b.color.map(n=>clamp(n,0,255)),opacity:clamp(b.opacity),flow:clamp(b.flow),hardness:clamp(b.hardness),erase:Boolean(b.erase),
    pressureSize:Boolean(b.pressureSize),pressureOpacity:Boolean(b.pressureOpacity),pressureFlow:Boolean(b.pressureFlow),sizeCurve:clamp(b.sizeCurve,.1,4),opacityCurve:clamp(b.opacityCurve,.1,4),pressureCurve:curve,
    stabilization:clamp(b.stabilization,0,.95),stabilizerMode:STABILIZER_MODES.includes(b.stabilizerMode)?b.stabilizerMode:'average',spacingRatio:clamp(b.spacingRatio,.01,1),
    // Smudge picks up paint dab by dab, so it keeps the analytic round tip
    // and cannot repaint a provisional tail: it has no taper-out.
    tip:!smudge&&BRUSH_TIPS.includes(b.tip)?b.tip:'round',roundness:clamp(b.roundness,.05,1),angle:((b.angle%360)+360)%360,angleMode:BRUSH_ANGLE_MODES.includes(b.angleMode)?b.angleMode:'fixed',
    scatter:clamp(b.scatter,0,4),sizeJitter:clamp(b.sizeJitter),opacityJitter:clamp(b.opacityJitter),angleJitter:clamp(b.angleJitter),
    taperIn:clamp(b.taperIn,0,1e5),taperOut:smudge?0:clamp(b.taperOut,0,1e5),
    texture:smudge?0:clamp(b.texture),grain:BRUSH_GRAINS.includes(b.grain)?b.grain:'noise',grainScale:clamp(b.grainScale,.05,64),
    blend,alphaLock:Boolean(b.alphaLock),smudgeLength:clamp(b.smudgeLength),colorRate:clamp(b.colorRate),
    seed:b.seed>>>0,pixelsPerUnit:clamp(b.pixelsPerUnit,.01,64),
  };
}
/** Radius of a dab at this (curve-mapped) pressure before jitter and taper. */
export function dabRadius(brush,pressure=1){return brush.size*(brush.pressureSize?Math.max(.05,clamp(pressure)**brush.sizeCurve):1)/2;}

const curves=new Map();
/** Pen pressure through the cubic Bézier curve (0,0)–(x1,y1)–(x2,y2)–(1,1), as
 * a 257-entry table; null for the identity curve. */
export function pressureMap(curve=LINEAR_PRESSURE){
  const [x1,y1,x2,y2]=curve;if(Math.abs(x1-y1)<1e-6&&Math.abs(x2-y2)<1e-6)return null;
  const key=curve.join();let lut=curves.get(key);
  if(!lut){
    const bez=(t,a,b)=>3*(1-t)*(1-t)*t*a+3*(1-t)*t*t*b+t*t*t;lut=new Float32Array(257);
    for(let i=0;i<=256;i++){const x=i/256;let lo=0,hi=1;for(let k=0;k<32;k++){const mid=(lo+hi)/2;if(bez(mid,x1,x2)<x)lo=mid;else hi=mid;}lut[i]=clamp(bez((lo+hi)/2,y1,y2));}
    if(curves.size>32)curves.clear();curves.set(key,lut);
  }
  return p=>{const f=clamp(p)*256,i=Math.min(255,Math.floor(f));return lut[i]+(lut[i+1]-lut[i])*(f-i);};
}
