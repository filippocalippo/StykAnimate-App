/** Still previews of generated effects for the effects catalogue: a small figure on a dark
 * stage at a characteristic frame, drawn by the engine (engine-pictures.mjs). Previews are
 * requested one after another and cached for the session. */
import {emptyDocument,createObject,createFrame} from './demo.mjs';
import {createVfx} from './vfx.mjs';
import {createVfxClip} from './vfx-clips.mjs';
import {isGeneratorType} from './vfx-registry.mjs';
import {engineDocumentPicture,bitmapURL,placement} from './engine/engine-pictures.mjs';

const STAGE={width:240,height:160},WIDTH=120,HEIGHT=80,FIGURE=[217,223,235],cache=new Map(),queue=[];let running=false;

/** Whether a catalogue entry has a generated preview: the generated effect types. */
export const hasEffectPreview=(mode,key)=>mode==='add'&&isGeneratorType(key);
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
 const effects=[[key,{}]],duration=48,beam=key==='beam',tick=previewTick(effects,duration);
 const report=emptyDocument(),figure=report.figure_types[0];Object.assign(report,{canvas_width:STAGE.width,canvas_height:STAGE.height});
 for(const segment of figure.segments)segment.color_rgb=FIGURE;
 // The timeline runs to the preview's tick: its last keyframe is exposed for one tick, so a second ends it.
 const stage=ticks=>({...createFrame([createObject(figure,1,beam?48:STAGE.width/2,STAGE.height*.62,{scale:.42})],ticks),_stykBackgroundColor:0xff15131d});
 report.keyframes=[stage(tick+2),stage(1)];
 const clip=createVfxClip({kind:'figure',uid:1},effects[0][0],'preview','effect0',{start:0,duration});
 clip.effects=effects.map(([type,params],i)=>{const effect=createVfx(type,`effect${i}`);return {...effect,params:{...effect.params,...params,seed:7,...(type==='beam'?{aimX:.9,aimY:.52}:{})}};});
 report._styk.vfxClips={version:1,clips:[clip]};
 const dpr=Math.min(2,globalThis.devicePixelRatio||1);
 const picture=await engineDocumentPicture(report,{tick,width:Math.round(WIDTH*dpr),height:Math.round(HEIGHT*dpr),placement:placement.card()});
 return picture?bitmapURL(picture.bitmap):null;
}
