import {sheetKeyAt} from './layer-sheet.mjs';
import {drawingMetadata,isDrawingLayer} from './drawing-model.mjs';

/** Timeline distance of every drawing cel from the playhead, over all
 * drawing layers, measured circularly because playback and scrubbing loop:
 * the first frame is close to the last. Memory eviction keeps near cels. */
export function drawingCelDistances(editor){
  const distances=new Map(),tracks=editor.report._styk?.layerSheet?.tracks??{},tick=editor.tick,total=Math.max(1,editor.totalTicks??1);
  for(const layer of editor.layers??[]){
    if(!isDrawingLayer(layer))continue;const track=tracks[layer.id];if(!track)continue;
    track.keys.forEach((key,i)=>{
      const frame=key?.value?.frameId?editor.getFrameById(key.value.frameId):null;
      for(const object of frame?.objects??[]){
        if(editor.layerForUid(object.unique_id)!==layer.id)continue;
        const figure=editor.report.figure_types.find(f=>f.figure_type_id===object.figure_type_id),id=drawingMetadata(figure)?.celId;if(!id)continue;
        const start=key.tick,end=track.keys[i+1]?.tick??track.end,linear=tick<start?start-tick:tick>=end?tick-end+1:0;
        const d=Math.min(linear,Math.max(0,total-linear));
        if(!(distances.get(id)<=d))distances.set(id,d);
      }
    });
  }
  return distances;
}
/** The cel showing under the playhead plus up to `before`/`after` unique
 * neighbouring cels of the drawing layer `layerId`. Callers surface
 * `neighbors` first and `current` last so a bounded decode queue drops stale
 * prefetches before the cel the playhead actually shows. */
export function drawingCelPrefetch(editor,layerId,{before=2,after=2}={}){
  const layer=editor.getLayer(layerId);if(!isDrawingLayer(layer)||!layer.visible)return null;
  const track=editor.report._styk?.layerSheet?.tracks[layerId];if(!track)return null;
  const index=sheetKeyAt(track,editor.tick).index;
  const figureAt=key=>{const frame=key?.value?.frameId?editor.getFrameById(key.value.frameId):null;const object=frame?.objects.find(o=>editor.layerForUid(o.unique_id)===layerId);const figure=object&&editor.report.figure_types.find(f=>f.figure_type_id===object.figure_type_id);return figure&&drawingMetadata(figure)?figure:null;};
  const current=figureAt(track.keys[index]),neighbors=[],seen=new Set([drawingMetadata(current)?.celId]);
  for(const direction of [-1,1]){
    let found=0;
    for(let distance=1;index+direction*distance>=0&&index+direction*distance<track.keys.length&&found<(direction<0?before:after);distance++){
      const figure=figureAt(track.keys[index+direction*distance]);if(!figure||seen.has(drawingMetadata(figure).celId))continue;
      seen.add(drawingMetadata(figure).celId);neighbors.push(figure);found++;
    }
  }
  return{current,neighbors};
}
