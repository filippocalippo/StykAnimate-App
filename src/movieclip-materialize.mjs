/** Explicit flattening for editable objects and legacy exports. Runtime playback
 * never uses this path and never expands the stored scene. */
import {isMovieclip,movieclipAsset} from './movieclips.mjs';
import {evaluatedFrame,buildGeometry,timeline} from './pivot/geometry.mjs';
import {layerVisible} from './layers.mjs';
import {createFrame} from './demo.mjs';

export function createMovieclipMaterializer(report,{allowCompositeOpacity=false}={}){
  const figures=report.figure_types.filter(f=>!isMovieclip(f)),typeMaps=new WeakMap(),uids=new Map();
  let nextType=report.figure_types.reduce((n,f)=>Math.max(n,f.figure_type_id+1),1),nextUid=1;
  for(const frame of [...report.keyframes,...Object.values(report._styk?.frameSources??{})])for(const object of frame.objects)nextUid=Math.max(nextUid,object.unique_id+1);
  const identity=path=>{if(!uids.has(path))uids.set(path,nextUid++);return uids.get(path);};
  let definitionSignatures;
  const signature=figure=>{const {figure_type_id,...data}=figure;return JSON.stringify(data);};
  function type(document,object){
    if(document===report)return object.figure_type_id;
    let map=typeMaps.get(document);if(!map){map=new Map();typeMaps.set(document,map);}
    if(!map.has(object.figure_type_id)){
      const figure=document.figure_types.find(f=>f.figure_type_id===object.figure_type_id);
      definitionSignatures??=new Map(figures.map(f=>[signature(f),f.figure_type_id]));
      const key=signature(figure),existing=definitionSignatures.get(key);
      if(existing!==undefined){map.set(object.figure_type_id,existing);return existing;}
      if(nextType>65535)throw new Error('Flattening movieclips exceeds the figure limit.');
      map.set(object.figure_type_id,nextType);definitionSignatures.set(key,nextType);figures.push({...figure,figure_type_id:nextType++});
    }
    return map.get(object.figure_type_id);
  }
  const sourceFrames=new WeakMap();
  function localFrame(asset,time){
    let cache=sourceFrames.get(asset);if(!cache){cache={rows:timeline(asset.document),time:null};sourceFrames.set(asset,cache);}
    if(cache.time===time)return cache.frame;
    const tick=asset.sourceStart+time;let low=0,high=cache.rows.length-1;
    while(low<high){const mid=Math.ceil((low+high)/2);if(cache.rows[mid].start<=tick)low=mid;else high=mid-1;}
    const row=cache.rows[low];cache.frame=evaluatedFrame(asset.document,low,row.count?(tick-row.start)/row.count:0,tick);cache.time=time;return cache.frame;
  }
  function expand(document,frame,transform,path,output){
    const geometry=buildGeometry(document,frame),definitions=new Map(document.figure_types.map(f=>[f.figure_type_id,f]));
    for(const slot of frame.object_draw_order??frame.objects.map((_,i)=>i)){
      const object=frame.objects[slot],figure=definitions.get(object.figure_type_id),g=geometry.objects.get(slot);
      if(!g||!layerVisible(document,object.unique_id))continue;
      const id=path?`${path}/${object.unique_id}`:String(object.unique_id);
      const point=p=>({x:transform.x+transform.a*p.x+transform.c*p.y,y:transform.y+transform.b*p.x+transform.d*p.y});
      if(isMovieclip(figure)){
        if(object._movieclipSample===null)continue;
        const asset=movieclipAsset(figure),local=localFrame(asset,object._movieclipSample??0),angle=object.angles?.[0]??0,
          scale=object.scale??1,c=Math.cos(angle)*scale,d=Math.sin(angle)*scale,root=point(g.root),flip=object.image_text_flags?-1:1;
        const a=transform.a*c+transform.c*d,b=transform.b*c+transform.d*d,
          cy=(-transform.a*d+transform.c*c)*flip,dy=(-transform.b*d+transform.d*c)*flip,opacity=transform.opacity*(1-(object.field28??0)/255);
        if(!allowCompositeOpacity&&opacity<1&&local.objects.length>1)throw new Error('Pivot cannot preserve movieclip group opacity across multiple figures. Use .styk or a rendered export.');
        expand(asset.document,local,{a,b,c:cy,d:dy,x:root.x-a*asset.pivot.x-cy*asset.pivot.y,y:root.y-b*asset.pivot.x-dy*asset.pivot.y,
          angle:transform.angle+angle*transform.flip,flip:transform.flip*flip,scale:transform.scale*scale,opacity},id,output);continue;
      }
      const root=point(g.root),next={...object,unique_id:path?identity(id):object.unique_id,figure_type_id:type(document,object),
        root_x:root.x,root_y:root.y,join:null,scale:(object.scale??1)*transform.scale,
        angles:(g.solvedAngles??object.angles).map(a=>a*transform.flip+transform.angle),field28:Math.round(255*(1-transform.opacity*(1-(object.field28??0)/255)))};
      if(transform.flip<0){next.image_text_flags=Number(!object.image_text_flags);next.bend_flag=1;next.bends=g.segments.map(s=>-s.bend);}
      if(g.solvedLengths){next.len_flag=1;next.lengths=g.solvedLengths.slice();}
      delete next.runtime_segments;delete next._stykIK;delete next._stykAnimationOrigin;delete next._stykMovieclip;delete next._movieclipSample;
      output.push(next);
    }
  }
  return {figures,identities:uids,frame(frame){const objects=[];expand(report,frame,{a:1,b:0,c:0,d:1,x:0,y:0,angle:0,flip:1,scale:1,opacity:1},'',objects);const result=createFrame(objects,frame.duration_raw);return {...frame,...result,camera:frame.camera,background_id:frame.background_id,background_id_b:frame.background_id_b,background_mix:frame.background_mix};}};
}
