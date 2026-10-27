import {messageError} from './localized-error.mjs';
import {animationRotation} from './animation-origin.mjs';
/** Named, mutually exclusive poses for existing spatial length channels.
 * Selection is derived from those channels; there is no extra animation state. */
export function validatePoseChoice(segment){
 const c=segment._stykPoseChoice;if(c===undefined)return;
 if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['group','label','shown','hidden'].includes(k))||
  !['group','label'].every(k=>typeof c[k]==='string'&&c[k].trim()&&c[k].length<=80)||
  !['shown','hidden'].every(k=>Number.isFinite(c[k])&&c[k]>=0&&c[k]<=1e6)||c.shown===c.hidden||
  !segment._stykRig?.spatial?.origin||segment.length<=0)throw messageError(new Error(''), "errors.rigPoseChoices.aPoseChoiceNeedsASpatialBoneNames", {});
}
export function poseChoiceGroups(figure,object){
 if(!figure||!object)return[];
 const groups=new Map();
 figure?.segments.forEach((s,index)=>{const c=s._stykPoseChoice;if(!c)return;let group=groups.get(c.group);
  if(!group){group={name:c.group,choices:[]};groups.set(c.group,group);}
  group.choices.push({id:s.segment_id,index,...c,length:object.len_flag?object.lengths[index]:s.length});
 });
 const visibility = [...groups.values()].map(group=>{
  const near=(a,b)=>Math.abs(a-b)<1e-5,shown=group.choices.filter(c=>near(c.length,c.shown));
  const hidden=group.choices.every(c=>near(c.length,c.hidden)),selected=shown.length===1&&group.choices.every(c=>c===shown[0]||near(c.length,c.hidden));
  return{...group,kind:'visibility',hidden:true,value:hidden?0:selected?shown[0].id:-1};
 });
 const sign=object.image_text_flags?-1:1,rotation=animationRotation(figure,object),byId=new Map(figure.segments.map((s,i)=>[s.segment_id,i]));
 const channels=(figure._styk?.poseChoices??[]).map(group=>{
  const choices=group.choices.map(c=>({...c,kind:'channels'}));
  const selected=choices.filter(c=>c.angles.every(([id,value])=>{
   const i=byId.get(id),delta=(object.angles[i]-rotation)*sign-figure.segments[i].angle_rad-value;
   return Math.abs(Math.atan2(Math.sin(delta),Math.cos(delta)))<1e-5;
  })&&c.lengths.every(([id,value])=>{
   const i=byId.get(id);return Math.abs((object.len_flag?object.lengths[i]:figure.segments[i].length)-value)<1e-5;
  }));
  return {...group,choices,kind:'channels',hidden:false,value:selected.length===1?selected[0].id:-1};
 });
 return [...channels,...visibility];
}

export function validateFigurePoseChoices(figure){
 const groups=figure._styk?.poseChoices;if(groups===undefined)return;
 const fail=()=>{throw new Error('Invalid native rig pose choices.');};
 if(!Array.isArray(groups)||!groups.length||groups.length>16)fail();
 const ids=new Map(figure.segments.map(s=>[s.segment_id,s])),allowed=new Set();
 for(const s of figure.segments)if(s._stykRig?.spatial?.origin){
  allowed.add(s.segment_id);allowed.add(s._stykRig.spatial.turn);allowed.add(s._stykRig.spatial.pitch);
 }
 const name=v=>typeof v==='string'&&v.trim()&&v.length<=80;
 const groupNames=new Set(figure.segments.flatMap(s=>s._stykPoseChoice?[s._stykPoseChoice.group]:[]));
 let total=0;
 for(const group of groups){
  if(!group||Object.keys(group).some(k=>!['name','choices'].includes(k))||!name(group.name)||groupNames.has(group.name)||
    !Array.isArray(group.choices)||!group.choices.length||group.choices.length>64)fail();
  groupNames.add(group.name);const choiceIds=new Set(),labels=new Set();let signature;
  for(const c of group.choices){
   if(!c||Object.keys(c).some(k=>!['id','label','angles','lengths'].includes(k))||
    !Number.isInteger(c.id)||c.id<1||c.id>65535||choiceIds.has(c.id)||!name(c.label)||labels.has(c.label))fail();
   choiceIds.add(c.id);labels.add(c.label);
   for(const key of ['angles','lengths']){
    if(!Array.isArray(c[key])||c[key].length>2048)fail();const seen=new Set();
    for(const pair of c[key]){
     if(!Array.isArray(pair)||pair.length!==2||!allowed.has(pair[0])||!ids.has(pair[0])||seen.has(pair[0])||
       !Number.isFinite(pair[1])||Math.abs(pair[1])>1e6||(key==='lengths'&&pair[1]<0))fail();
     seen.add(pair[0]);if(++total>32768)fail();
    }
   }
   if(!c.angles.length&&!c.lengths.length)fail();
   const current=JSON.stringify([c.angles.map(p=>p[0]).sort((a,b)=>a-b),c.lengths.map(p=>p[0]).sort((a,b)=>a-b)]);
   if(signature!==undefined&&signature!==current)fail();signature=current;
  }
 }
}
