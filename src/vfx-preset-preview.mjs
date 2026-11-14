/** Still previews for the effects panel: a small figure with an effect, a preset or one style of an
 * effect, at a characteristic frame, drawn by the engine (engine-pictures.mjs). The catalogue's
 * generated effects show them as tiles; its preview card shows any effect or preset; a visual
 * picker shows a look or a style (`style` mode, key `type:param:index`). Generated effects draw
 * on a dark stage, filters and looks on a mid slate so darkening and lightening both read.
 * Previews are requested one after another and cached for the session. */
import {emptyDocument,createObject,createFrame} from './demo.mjs';
import {createVfx} from './vfx.mjs';
import {createVfxClip} from './vfx-clips.mjs';
import {isGeneratorType,VFX_REGISTRY} from './vfx-registry.mjs';
import {VFX_PRESETS} from './vfx-presets.mjs';
import {engineDocumentPicture,bitmapURL,placement} from './engine/engine-pictures.mjs';

const STAGE={width:240,height:160},WIDTH=120,HEIGHT=80,FIGURE=[217,223,235],DARK=0xff15131d,SLATE=0xff48506a,cache=new Map(),queue=[];let running=false;
/** The effects a preview draws: [[type, params], …]. */
function previewEffects(mode,key){
 if(mode==='style'){const [type,param,index]=key.split(':'),value=Number(index),d=VFX_REGISTRY[type]?.params[param];return d?[[type,{[param]:value,...(d.applies?.[value]??{})}]]:null;}
 if(mode==='presets')return VFX_PRESETS[key]?.effects??null;
 return VFX_REGISTRY[key]?[[key,{}]]:null;
}

/** Whether a catalogue entry has a generated preview: the generated effect types. */
export const hasEffectPreview=(mode,key)=>mode==='add'&&isGeneratorType(key);
/** Whether a preview can be drawn for `key` at all (any effect, preset or style). */
export const canPreview=(mode,key)=>Boolean(previewEffects(mode,key));
/** A cached preview image URL, or null while it renders. */
export const cachedEffectPreview=(mode,key)=>cache.get(`${mode}:${key}`)??null;
/** Render the preview for `key` and hand it to `done(url)`. */
export function requestEffectPreview(mode,key,done){
 const id=`${mode}:${key}`,url=cache.get(id);if(url){done(url);return;}
 queue.push({id,mode,key,done});void drain();
}
async function drain(){
 if(running)return;
 running=true;
 try{
  while(queue.length){
   const job=queue.shift();let url=cache.get(job.id);
   if(url===undefined){try{url=await renderPreview(job.mode,job.key);}catch{url=null;}cache.set(job.id,url);}
   if(url)job.done(url);
  }
 }finally{running=false;}
}
/** The frame that shows an effect at its most characteristic moment. */
function previewTick(effects,duration){
 let tick=0;
 for(const [type,p={}] of effects){
  const t=type==='explosion'?[10,10,12,22,40,20,10,14,16,10][p.style??0]:type==='beam'?(p.charge??12)+(p.travel??6)+6:type==='aura'?40:type==='smoke'?(p.emission===1?16:46):p.emission===1?Math.min(10,(p.life??30)*.4):30;
  tick=Math.max(tick,t+(p.delay??0));
 }
 return Math.floor(duration===null?Math.max(tick,80):Math.min(tick,Math.max(1,duration-1)));
}
async function renderPreview(mode,key){
 const effects=previewEffects(mode,key);if(!effects)return null;
 const duration=48,beam=effects.some(([type])=>type==='beam'),tick=previewTick(effects,duration),generated=effects.some(([type])=>isGeneratorType(type));
 // Camera effects (a vignette, scanlines, a shockwave) belong to the scene.
 const scene=effects.some(([type])=>VFX_REGISTRY[type]?.scene||type==='vignette');
 const report=emptyDocument(),figure=report.figure_types[0];Object.assign(report,{canvas_width:STAGE.width,canvas_height:STAGE.height});
 for(const segment of figure.segments)segment.color_rgb=FIGURE;
 // The timeline runs to the preview's tick: its last keyframe is exposed for one tick, so a second ends it.
 const stage=ticks=>({...createFrame([createObject(figure,1,beam?48:STAGE.width/2,STAGE.height*.62,{scale:.42})],ticks),_stykBackgroundColor:generated?DARK:SLATE});
 report.keyframes=[stage(tick+2),stage(1)];
 const clip=createVfxClip(scene?{kind:'scene'}:{kind:'figure',uid:1},effects[0][0],'preview','effect0',{start:0,duration});
 clip.effects=effects.map(([type,params],i)=>{const effect=createVfx(type,`effect${i}`);return {...effect,params:{...effect.params,...params,...(VFX_REGISTRY[type].params.seed?{seed:7}:{}),...(type==='beam'?{aimX:.9,aimY:.52}:{})}};});
 report._styk.vfxClips={version:1,clips:[clip]};
 const dpr=Math.min(2,globalThis.devicePixelRatio||1);
 const picture=await engineDocumentPicture(report,{tick,width:Math.round(WIDTH*dpr),height:Math.round(HEIGHT*dpr),placement:placement.card()});
 return picture?bitmapURL(picture.bitmap):null;
}
