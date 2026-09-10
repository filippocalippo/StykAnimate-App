import {buildGeometry, buildGeometryAsync} from './pivot/geometry.mjs';

const wireOnly=new Set(['record_offset','record_end','object_slot','join']);
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

const parentUid = (object, frame) => object.join ? frame.objects[Number(object.join.target_object_slot)]?.unique_id : null;
function sameJoin(a, b, aParent, bParent) {
  if (Boolean(a) !== Boolean(b) || aParent !== bParent) return false;
  if (!a) return true;
  const fields = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['target_object_slot','target_unique_id'].includes(key)));
  return equal(fields(a), fields(b));
}
/** Rebind slot metadata without recalculating points or tessellation. The old
 * object-local artwork remains valid and can be adopted by the renderer. */
function rebind(g, object, slot) {
  if (g.slot === slot && g.obj.join?.target_object_slot === object.join?.target_object_slot) return g;
  const records = new Map(), children = new Map();
  const item = value => {
    if (!records.has(value)) {
      let owner = object;
      if (value.obj !== g.obj) {
        owner = children.get(value.obj);
        if (!owner) { owner = {...value.obj, object_slot: slot}; children.set(value.obj, owner); }
      }
      records.set(value, {...value, obj: owner, slot});
    }
    return records.get(value);
  };
  const result = {...g, obj: object, slot, segments: g.segments.map(item), polys: g.polys.map(item), drawables: g.drawables?.map(item)};
  Object.defineProperty(result, 'renderSource', {value: g.renderSource || g});
  return result;
}
const drawableCount = g => g.drawables?.length ?? g.segments.length + g.polys.length;

/** One scene plus a bounded alternate pose per persistent figure. Native keys
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
    if(this.report!==report||this.version!==report.version||this.revision!==revision||!this.geometry||this.geometry.warnings.length)return null;
    const dirtySlots=new Set(),children=new Map(),objects=new Map(),ready=[],seen=new Set();
    const prior=new Map([...this.geometry.objects.values()].filter(Boolean).map(g=>[g.obj.unique_id,{g,parent:parentUid(g.obj,this.frame)}]));
    for(let slot=0;slot<frame.objects.length;slot++){
      const object=frame.objects[slot];if(!object)continue;
      if(seen.has(object.unique_id))return null;seen.add(object.unique_id);
      const parent=object.join?.target_object_slot;
      if(parent===undefined)ready.push(slot);
      else {const list=children.get(Number(parent))??[];list.push(slot);children.set(Number(parent),list);}
    }
    for(let i=0;i<ready.length;i++){
      const slot=ready[i],object=frame.objects[slot],parent=parentUid(object,frame);
      const root=object.join?objects.get(Number(object.join.target_object_slot))?.joints.get(Number(object.join.target_handle_id??0)):null;
      let matched;
      for(const entry of [prior.get(object.unique_id),this.alternates.get(object.unique_id)]){
        if(!entry||!equal(object,entry.g.obj,true)||!sameJoin(object.join,entry.g.obj.join,parent,entry.parent))continue;
        if(object.join&&(!root||!Object.is(root.x,entry.g.root.x)||!Object.is(root.y,entry.g.root.y)))continue;
        matched=rebind(entry.g,object,slot);break;
      }
      if(matched)objects.set(slot,matched);else dirtySlots.add(slot);
      for(const child of children.get(slot)??[])ready.push(child);
    }
    // Let the native builder report invalid/cyclic attachments exactly as before.
    if(ready.length!==seen.size)return null;
    return {previous:{...this.geometry,objects},dirtySlots};
  }
  publish(report,frame,revision,geometry,incremental){
    if(!incremental){this.alternates.clear();this.alternateDrawables=0;}
    // Alternate geometry avoids rebuilding the pose, but its GPU instance still
    // changed relative to the last displayed scene. Notify incremental renderers
    // even when the native builder reused that alternate object successfully.
    if(incremental)for(const [slot,g] of geometry.objects)if(g!==this.geometry.objects.get(slot))geometry.changedSlots.add(slot);
    this.reusedObjects=incremental?[...geometry.objects].filter(([slot,g])=>g===incremental.previous.objects.get(slot)).length:0;
    const current=incremental?new Map([...geometry.objects.values()].filter(Boolean).map(g=>[g.obj.unique_id,g])):null;
    if(incremental)for(const old of this.geometry.objects.values()){
      if(!old||old===current.get(old.obj.unique_id))continue;
      const uid=old.obj.unique_id,prior=this.alternates.get(uid);if(prior){this.alternates.delete(uid);this.alternateDrawables-=drawableCount(prior.g);}
      if(drawableCount(old)>this.maxAlternateDrawables)continue;
      this.alternates.set(uid,{g:old,parent:parentUid(old.obj,this.frame)});this.alternateDrawables+=drawableCount(old);
      while(this.alternateDrawables>this.maxAlternateDrawables||this.alternates.size>this.maxAlternates){
        const [key,value]=this.alternates.entries().next().value;this.alternates.delete(key);this.alternateDrawables-=drawableCount(value.g);
      }
    }
    this.report=report;this.version=report.version;this.revision=revision;this.frame=frame;this.geometry=geometry;
    return geometry;
  }
  clear(){this.report=null;this.frame=null;this.geometry=null;this.revision=null;this.reusedObjects=0;this.alternates=new Map();this.alternateDrawables=0;}
}
export {RetainedGeometryCache as PlaybackGeometryCache};
