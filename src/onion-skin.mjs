import {buildGeometry, evaluatedFrame} from './pivot/geometry.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {easingMode} from './keyframe-easing.mjs';

// A changed parent also moves its joined descendants, even when their own
// native object records have not changed.
function affectedSlots(frame, uids) {
  const slots = new Set(), children = new Map(), queue = [];
  frame.objects.forEach((object, slot) => {
    if (uids.has(object.unique_id)) { slots.add(slot); queue.push(slot); }
    if (object.join) {
      const parent = Number(object.join.target_object_slot);
      let list = children.get(parent); if (!list) children.set(parent, list = []);
      list.push(slot);
    }
  });
  for (let i = 0; i < queue.length; i++) for (const slot of children.get(queue[i]) || [])
    if (!slots.has(slot)) { slots.add(slot); queue.push(slot); }
  return slots;
}

function animationKeyTicks(editor, rows) {
  const channels=editor.report._styk.animation.channels,ticks=new Set();
  const figurePoses=new Set(),layerPoses=new Set();
  for(const channel of channels){
    for(const key of channel.keys)if(!key.hidden)ticks.add(key.tick);
    if(channel.property==='pose'){
      if(channel.target.kind==='figure')figurePoses.add(channel.target.uid);
      if(channel.target.kind==='layer')layerPoses.add(channel.target.id);
    }
  }
  // Native frames remain source assets when a pose track is authored. Their
  // old times are keys only for figures still driven by the native timeline.
  const usesNative=editor.layers.some(layer=>!layerPoses.has(layer.id) &&
    layer.figureUids.some(uid=>!figurePoses.has(uid)));
  if(usesNative)for(const row of rows)if(row.count>0)ticks.add(row.start);
  return [...ticks].sort((a,b)=>a-b);
}

/** Keep sampled geometry independent of opacity, tint, selection and viewport. */
export class OnionSkinCache {
  constructor({evaluate = evaluatedFrame, geometry = buildGeometry, maxEntries = 24} = {}) {
    this.evaluate = evaluate; this.geometry = geometry; this.maxEntries = maxEntries;
    this.samples = new Map(); this.styles = new WeakMap(); this.objectStyles = new WeakMap(); this.stats = {builds:0,hits:0};
  }
  invalidate(detail = {}) {
    if (!['document','edit','history'].includes(detail.kind)) return;
    // Revision changes are explained by the editor's change event. A revision
    // change without an event still clears the cache defensively in get().
    this.revision = this.editor?.revision;
    if((detail.changedUids || detail.live || detail.frameIndices) && !detail.animation && !detail.definition && !detail.structural && !detail.timing &&
      !this.editor?.report._styk?.animation?.channels?.length && detail.kind !== 'document'){
      const indices=new Set(detail.frameIndices||detail.changedFrames||[detail.frameIndex]);
      // Add edits affect only the working copy; stored ghosts stay still.
      const draft=this.editor?.frameDraft;
      if(detail.kind==='edit' && draft?.mode==='add' && !detail.layers) indices.delete(draft.index);
      for(const [id,sample] of this.samples)if(indices.size && (!sample.dependencies || sample.dependencies.some(index=>indices.has(index)))){
        if(detail.changedUids?.length && !detail.layers) {
          sample.dirtyUids ??= new Set();
          for(const uid of detail.changedUids)sample.dirtyUids.add(uid);
        } else this.samples.delete(id);
        this.last=null;
      }
    }else {this.samples.clear();this.styles=new WeakMap();this.objectStyles=new WeakMap();this.last=null;this.keyTicks=null;}
  }
  get(editor, settings, {selected = new Set(), hidden = new Set(), visibilityKey} = {}) {
    if(this.editor !== editor){
      this.editor?.removeEventListener('change',this.listener);
      this.editor=editor;this.listener=event=>this.invalidate(event.detail);
      editor.addEventListener('change',this.listener);
      this.report=null;
    }
    const report = editor.report;
    if (this.report !== report || this.revision !== editor.revision) {
      this.samples.clear(); this.styles = new WeakMap(); this.objectStyles = new WeakMap(); this.last = null;
      this.report = report; this.revision = editor.revision;
      this.keyTicks = null;
    }
    const hiddenKey=visibilityKey ?? (hidden[Symbol.iterator] ? [...hidden] : []);
    const draft=editor.frameDraft, adding=draft?.mode==='add';
    // Draft mode changes can be metadata-only (no document revision).
    const draftKey=JSON.stringify([draft?.mode,adding?draft.index:null,draft?.empty]);
    const baseline=adding?report._styk?.simpleFrameDraft?.baseline:null;
    if(this.draftKey!==draftKey || this.draftBaseline && this.draftBaseline!==baseline){this.samples.clear();this.last=null;this.draftKey=draftKey;}
    this.draftBaseline=baseline;
    const signature = JSON.stringify([editor.frameIndex,editor.tick,editor.layerRevision,settings.onionBefore,settings.onionAfter,settings.onionStep,
      settings.onionMode,settings.onionScope,settings.onionJoined,settings.onionOpacity,settings.onionFade,settings.onionTint,
      settings.onionBeforeColor,settings.onionAfterColor,settings.onionShowOnTop,[...selected],hiddenKey]);
    if (this.last?.signature === signature) return this.last.frames;
    const frames = [], rows = editor.timeline;
    // The Add pose is the next, not-yet-stored frame. Its nearest predecessor
    // is the last stored pose, including the checkpoint underneath the draft.
    const sourceReport=adding?storedFrameReport(report,{validate:false}):report;
    const currentIndex=adding?rows.length:editor.frameIndex;
    const currentTick=adding?editor.totalTicks:editor.tick;
    // Advanced keys live on animation channels, independently of native frame
    // indices. Sample their actual times as well as the underlying stored keys.
    const authoredKeys=!adding && settings.onionMode!=='frames' && report._styk?.animation?.channels?.length;
    let keyTicks, previousKey, nextKey;
    if(authoredKeys){
      keyTicks=this.keyTicks??=animationKeyTicks(editor,rows);
      let low=0,high=keyTicks.length;
      while(low<high){const mid=(low+high)>>>1;if(keyTicks[mid]<currentTick)low=mid+1;else high=mid;}
      previousKey=low-1;nextKey=keyTicks[low]===currentTick?low+1:low;
    }
    for (let distance = Math.max(settings.onionBefore,settings.onionAfter); distance > 0; distance--) {
      for (const direction of [-1,1]) {
        if (distance > (direction < 0 ? settings.onionBefore : settings.onionAfter)) continue;
        let index = currentIndex + direction * distance * settings.onionStep, tick, ratio = 0;
        if (settings.onionMode === 'frames' || authoredKeys) {
          tick = authoredKeys ? keyTicks[direction<0?previousKey-(distance*settings.onionStep-1):nextKey+(distance*settings.onionStep-1)]
            : Math.floor(currentTick) + direction * distance * settings.onionStep;
          if(tick===undefined)continue;
          if (tick < 0 || tick >= editor.totalTicks) continue;
          let low=0,high=rows.length-1;
          while(low<high){const mid=Math.ceil((low+high)/2);if(rows[mid].start<=tick)low=mid;else high=mid-1;}
          index=low; ratio=rows[index].count ? Math.min(1,(tick-rows[index].start)/rows[index].count) : 0;
        } else {
          if(!adding && direction<0 && editor.tick>rows[editor.frameIndex]?.start)index++;
          if(index<0 || index>=rows.length) continue;
          tick=rows[index].start;
        }
        const id=`${index}:${tick}`;
        let sample=this.samples.get(id);
        if(!sample || sample.dirtyUids){
          let frame=this.evaluate(sourceReport,index,ratio,tick);
          // Before the first Add edit the evaluator can return the mutable
          // working frame itself. Keep its stored pose independent of edits.
          if(adding && !report._styk?.simpleFrameDraft?.baseline && index===draft.index)frame=structuredClone(frame);
          const incremental=sample?.dirtyUids?{previous:sample.geometry,dirtySlots:affectedSlots(frame,sample.dirtyUids)}:null;
          sample={frame,geometry:this.geometry(sourceReport,frame,incremental),dependencies:ratio>0?(report.auto_easing?null:
            easingMode(sourceReport.keyframes[index]?._styk?.easing)==='auto'?[index-1,index,index+1,index+2]:[index,index+1]):[index]};
          this.samples.set(id,sample);this.stats.builds++;
        }
        else {this.samples.delete(id);this.samples.set(id,sample);this.stats.hits++;}
        while(this.samples.size>this.maxEntries)this.samples.delete(this.samples.keys().next().value);
        let included = settings.onionScope === 'selected' ? new Set(selected) : null;
        if (included && settings.onionJoined) {
          const links=new Map(), connect=(a,b)=>{let list=links.get(a);if(!list)links.set(a,list=[]);list.push(b);};
          for(const object of sample.frame.objects)if(object.join){const uid=sample.frame.objects[object.join.target_object_slot]?.unique_id;connect(object.unique_id,uid);connect(uid,object.unique_id);}
          const queue=[...included];for(let i=0;i<queue.length;i++)for(const uid of links.get(queue[i])??[])if(!included.has(uid)){included.add(uid);queue.push(uid);}
        }
        const color = settings.onionTint ? (direction<0?settings.onionBeforeColor:settings.onionAfterColor) : null;
        const styleKey=JSON.stringify([color,included?[...included]:null,hiddenKey,editor.layerRevision]);
        let cache=this.styles.get(sample.geometry);if(!cache)this.styles.set(sample.geometry,cache=new Map());
        let geometry=cache.get(styleKey);
        if(!geometry){
          const rgb=color?.slice(1).match(/../g).map(value=>parseInt(value,16));
          const orderedObjects=sample.geometry.orderedObjects.filter(g=>(!included||included.has(g.obj.unique_id))&&!hidden.has(g.obj.unique_id)).map(g=>{
            if(!rgb)return g;
            let styles=this.objectStyles.get(g);if(!styles)this.objectStyles.set(g,styles=new Map());
            let styled=styles.get(color);
            if(!styled){styled={...g,drawables:g.drawables.map(item=>({...item,rgb,seg:item.seg?{...item.seg,secondary:null}:item.seg}))};styles.set(color,styled);while(styles.size>4)styles.delete(styles.keys().next().value);}
            return styled;
          });
          let drawables;
          geometry={objects:sample.geometry.objects,orderedObjects,get drawables(){return drawables??=orderedObjects.flatMap(g=>g.drawables);}};
          cache.set(styleKey,geometry);while(cache.size>4)cache.delete(cache.keys().next().value);
        }
        frames.push({frame:sample.frame,geometry,opacity:settings.onionOpacity*(settings.onionFade?1/distance:1),showOnTop:settings.onionShowOnTop});
      }
    }
    this.last={signature,frames};return frames;
  }
}
