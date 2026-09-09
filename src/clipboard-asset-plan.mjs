/** Exact clipboard asset matching, without serializing unrelated libraries. */
import {yieldLoadTask} from './editor-load.mjs';

const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const LOCATORS=new Set(['record_offset','record_end','records_start','records_end','source_start','source_end','source_offset','source_size','image_start']);
const ignored=(a,b,key,omit)=>key===omit||LOCATORS.has(key)||
  (['data_base64','data_uri'].includes(key)&&a.data_url&&b.data_url)||
  (key==='side_tables'&&a.image_assets&&b.image_assets&&a.text_assets&&b.text_assets);

// Keep the synchronous public planner's existing equality rules. In particular,
// key order, foreign locators and redundant encoded asset aliases do not matter.
export function equivalentClipboardAsset(a,b,omit){
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a).filter(key=>!ignored(a,b,key,omit)),other=Object.keys(b).filter(key=>!ignored(a,b,key,omit));
  return keys.length===other.length&&keys.every(key=>own(b,key)&&equivalentClipboardAsset(a[key],b[key]));
}

export function* equivalentClipboardAssetSteps(a,b,omit){
  const stack=[{a,b,omit}];let work=0;
  while(stack.length){
    const next=stack.at(-1);a=next.a;b=next.b;
    if(a===b){stack.pop();}
    else if(!next.keys){
      if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
      const keys=Object.keys(a).filter(key=>!ignored(a,b,key,next.omit)),other=Object.keys(b).filter(key=>!ignored(a,b,key,next.omit));
      if(keys.length!==other.length)return false;
      next.keys=keys;next.index=0;
    }else if(next.index===next.keys.length){stack.pop();}
    else{
      const key=next.keys[next.index++];if(!own(b,key))return false;stack.push({a:a[key],b:b[key]});
    }
    if(++work%128===0)yield {phase:'preparing-assets',completed:work};
  }
  return true;
}

function* matchTable(source,target,key){
  const matches=[],projected=[],included=new Set();let compared=0;
  for(const value of source){
    for(const candidate of target){
      const equal=yield* equivalentClipboardAssetSteps(candidate,value,key);
      if(++compared%64===0)yield {phase:'preparing-assets',completed:compared};
      if(!equal)continue;
      matches.push([value[key],candidate[key]]);
      if(!included.has(candidate[key])){included.add(candidate[key]);projected.push({...value,[key]:candidate[key]});}
      break;
    }
  }
  return {summary:{count:target.length,ids:target.map(value=>value[key]),matches},projected};
}

export async function prepareClipboardAssetProjection(clipboard,report,{checkCurrent=()=>{},signal,yieldControl=yieldLoadTask,onProgress,onTiming}={}){
  const started=performance.now(),timing={cpuMs:0,maxTaskMs:0,yields:0};
  const check=()=>{if(signal?.aborted)throw new DOMException('Frame paste cancelled.','AbortError');checkCurrent();};
  const drain=async iterator=>{try{for(;;){check();const start=performance.now();let step;
    do{step=iterator.next();}while(!step.done&&performance.now()-start<4);
    const elapsed=performance.now()-start;timing.cpuMs+=elapsed;timing.maxTaskMs=Math.max(timing.maxTaskMs,elapsed);
    if(step.done)return step.value;
    onProgress?.(step.value);check();timing.yields++;await yieldControl();
  }}finally{iterator.return();}};
  try{
    check();onProgress?.({phase:'preparing-assets',completed:0});check();
    const figures=await drain(matchTable(clipboard.figure_types,report.figure_types,'figure_type_id'));
    const backgrounds=await drain(matchTable(clipboard.backgrounds??[],report.backgrounds??[],'background_id'));
    check();return {figures:figures.projected,backgrounds:backgrounds.projected,summary:{figures:figures.summary,backgrounds:backgrounds.summary}};
  }finally{onTiming?.({...timing,elapsedMs:performance.now()-started});}
}
