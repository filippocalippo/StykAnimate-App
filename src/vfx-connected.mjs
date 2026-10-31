const MAX_DEPTH=16;
function descendants(frame,slot,children){
 const members=new Set([slot]),queue=[slot];
 for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])??[])if(!members.has(child)){members.add(child);queue.push(child);}
 return members;
}
function childIndex(frame){const children=new Map();frame.objects.forEach((o,slot)=>{if(o.join){const p=o.join.target_object_slot,list=children.get(p)??[];list.push(slot);children.set(p,list);}});return children;}
function scopeDepths(frame,children,forceUid){
 const depths=new Map(),queue=frame.objects.flatMap((o,slot)=>!o.join?[slot]:[]);
 for(let i=0;i<queue.length;i++){const slot=queue[i],o=frame.objects[slot];if(depths.has(slot))continue;
  depths.set(slot,(depths.get(o.join?.target_object_slot)??0)+Number(o._stykVfxScope===1||o.unique_id===forceUid));for(const child of children.get(slot)??[])queue.push(child);}
 return depths;
}
export function connectedVfxConflict(frame,uid){
 const root=frame.objects.findIndex(o=>o.unique_id===uid);if(root<0)return 'The effect owner is missing.';
 const children=childIndex(frame),members=descendants(frame,root,children),depths=scopeDepths(frame,children,uid);
 for(const slot of members)if(depths.get(slot)>MAX_DEPTH)return `Connected VFX support at most ${MAX_DEPTH} nested groups.`;
 return null;
}
