import {buildGeometry, buildGeometryAsync} from './pivot/geometry.mjs';

const wireOnly=new Set(['record_offset','record_end']);
function equal(a,b,ignoreWire=false){
  if(Object.is(a,b))return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  if(Array.isArray(a))return a.length===b.length&&a.every((value,index)=>equal(value,b[index]));
  // Native tween evaluation explicitly clears this optional override. An absent
  // field and an undefined override both use the figure's normal geometry.
  const relevant=(value,key)=>!ignoreWire||(!wireOnly.has(key)&&!(key==='runtime_segments'&&value[key]===undefined));
  const keys=Object.keys(a).filter(key=>relevant(a,key)),other=Object.keys(b).filter(key=>relevant(b,key));
  return keys.length===other.length&&keys.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
}

/** One scene plus a bounded alternate pose per independent object. Native keys
 * and exact tween poses can differ through floating-point reconstruction; keep
 * both representations rather than rounding coordinates or rebuilding all keys. */
export class RetainedGeometryCache {
  constructor({maxAlternateDrawables=250000,maxAlternates=1024}={}){
    Object.assign(this,{maxAlternateDrawables,maxAlternates});this.clear();
  }
  retainRevision(revision){this.revision=revision;}
  adopt(report,frame,revision,geometry){
    if(this.report!==report||this.revision!==revision||this.version!==report.version)this.clear();
    Object.assign(this,{report,frame,revision,geometry,version:report.version,reusedObjects:0});
  }
  get(report,frame,revision){
    const incremental=this.plan(report,frame,revision);
    return this.publish(report,frame,revision,buildGeometry(report,frame,incremental),incremental);
  }
  async getAsync(report,frame,revision,options={}){
    const baseline=this.geometry, baselineRevision=this.revision, baselineReport=this.report;
    const incremental=this.plan(report,frame,revision);
    const geometry=await buildGeometryAsync(report,frame,incremental,options);
    if(this.geometry!==baseline||this.revision!==baselineRevision||this.report!==baselineReport||options.checkCurrent?.()===false)
      throw new DOMException('Geometry preparation was superseded.', 'AbortError');
    return this.publish(report,frame,revision,geometry,incremental);
  }
  plan(report,frame,revision){
    let incremental=null;
    if(this.report===report&&this.version===report.version&&this.revision===revision&&frame.objects.length===this.frame.objects.length&&!this.geometry.warnings.length){
      const dirtySlots=new Set(),changedParents=new Set(),children=new Map(),objects=new Map(this.geometry.objects);
      const count=Math.max(frame.objects.length,this.frame.objects.length);
      for(let slot=0;slot<count;slot++){
        if(!equal(frame.objects[slot],this.frame.objects[slot],true)){
          changedParents.add(slot);
          const alternate=this.alternates.get(slot);
          if(alternate&&!frame.objects[slot]?.join&&equal(frame.objects[slot],alternate.obj,true))objects.set(slot,alternate);
          else dirtySlots.add(slot);
        }
        const parent=frame.objects[slot]?.join?.target_object_slot;
        if(parent!==undefined){const slots=children.get(Number(parent))||[];slots.push(slot);children.set(Number(parent),slots);}
      }
      const queue=[...changedParents];
      for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])||[])if(!dirtySlots.has(child)){dirtySlots.add(child);queue.push(child);}
      incremental={previous:{...this.geometry,objects},dirtySlots};
    }
    return incremental;
  }
  publish(report,frame,revision,geometry,incremental){
    if(!incremental){this.alternates.clear();this.alternateDrawables=0;}
    // Alternate geometry avoids rebuilding the pose, but its GPU instance still
    // changed relative to the last displayed scene. Notify incremental renderers
    // even when the native builder reused that alternate object successfully.
    if(incremental)for(const [slot,g] of geometry.objects)if(g!==this.geometry.objects.get(slot))geometry.changedSlots.add(slot);
    this.reusedObjects=incremental?[...geometry.objects].filter(([slot,g])=>g===incremental.previous.objects.get(slot)).length:0;
    if(incremental)for(const [slot,g] of geometry.objects){
      const old=this.geometry.objects.get(slot);
      if(!old||old===g||old.obj.join)continue;
      const prior=this.alternates.get(slot);if(prior){this.alternates.delete(slot);this.alternateDrawables-=prior.drawables.length;}
      if(old.drawables.length>this.maxAlternateDrawables)continue;
      this.alternates.set(slot,old);this.alternateDrawables+=old.drawables.length;
      while(this.alternateDrawables>this.maxAlternateDrawables||this.alternates.size>this.maxAlternates){
        const [key,value]=this.alternates.entries().next().value;this.alternates.delete(key);this.alternateDrawables-=value.drawables.length;
      }
    }
    this.report=report;this.version=report.version;this.revision=revision;this.frame=frame;this.geometry=geometry;
    return geometry;
  }
  clear(){this.report=null;this.frame=null;this.geometry=null;this.revision=null;this.reusedObjects=0;this.alternates=new Map();this.alternateDrawables=0;}
}
export {RetainedGeometryCache as PlaybackGeometryCache};
