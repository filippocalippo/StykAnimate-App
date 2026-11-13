import {messageError} from './localized-error.mjs';
/** Display colors and copy-on-write recoloring. No geometry or asset copies. */
import {resolveInstanceFigure, polygonIdentity, meshPaletteColor} from './animation-style.mjs';
import {segmentPaint, parseColor, hexColor} from './paint.mjs';
import {color, mixColor} from './pivot/read-view.mjs';
import {findFigureType} from './figure-types.mjs';

const usesSegmentColors = (report, figure, object) => report.version >= 5 || figure?._styk?.colorMode === 'segments' || object?._styk?.colorMode === 'segments';
export function displayedColor(report, figure, object, rgb) {
  if (!usesSegmentColors(report, figure, object)) return (Number(object.color_override_raw) | 0) < 0 ? [0,0,0] : color(object.color_override_raw).rgb;
  return mixColor(rgb, object.color_override_raw);
}
export function displayedSegmentPaint(report, figure, object, segment) {
  const paint = segmentPaint(segment);
  // A full native override suppresses the secondary endpoint, including alpha.
  // Bake that visible solid so clearing the override cannot reveal a new fade.
  if(usesSegmentColors(report,figure,object) && Number(object.color_override_raw)>>>24===255){paint.type='solid';paint.stops=[paint.stops[0]];}
  return {...paint, stops:paint.stops.map(stop=>({...stop,color:displayedColor(report,figure,object,stop.color)}))};
}
export function figurePalette(report, figure, object) {
  const resolved=resolveInstanceFigure(figure,object), colors=new Map();
  const row=rgb=>{const key=hexColor(rgb);if(!colors.has(key))colors.set(key,{color:key,segments:[],polygons:[]});return colors.get(key);};
  for(const segment of resolved.segments){
    const stops=displayedSegmentPaint(report,resolved,object,segment).stops, matches=new Map();
    stops.forEach((stop,index)=>{const entry=row(stop.color);let match=matches.get(entry);if(!match){match={handleId:segment.segment_id,stops:[]};entry.segments.push(match);matches.set(entry,match);}match.stops.push(index);});
  }
  resolved.polyfills?.forEach((polygon,index)=>row(displayedColor(report,resolved,object,polygon.color_rgb??[0,0,0])).polygons.push(polygonIdentity(polygon,index)));
  resolved._styk?.spatialMesh?.colors.forEach((_,index)=>{
    const entry=row(displayedColor(report,resolved,object,meshPaletteColor(resolved,object,index)));
    (entry.meshColors??=[]).push(index);
  });
  return [...colors.values()].sort((a,b)=>b.segments.length-a.segments.length || a.color.localeCompare(b.color));
}
/**
 * The colours `figurePalette` lists for the figures `objects` together (`figureOf(object)`: the figure each shows), as a set. A figure with no
 * style of its own and no colour mode of its own shows the colours of its definition under its colour override alone, so figures alike are
 * listed once: a selection of thousands of figures has a few kinds.
 */
export function paletteColors(report, objects, figureOf) {
  const colors = new Set(), listed = new Map();
  for (const object of objects) {
    const figure = figureOf(object);
    if (figure && !object._stykStyle && object._styk?.colorMode !== 'segments') {
      let overrides = listed.get(figure);
      if (!overrides) listed.set(figure, overrides = new Set());
      if (overrides.has(object.color_override_raw)) continue;
      overrides.add(object.color_override_raw);
    }
    for (const entry of figurePalette(report, figure, object)) colors.add(entry.color);
  }
  return colors;
}
/** Palette membership is scoped by instance: attached rigs can reuse handle IDs. */
export function attachedFigurePalette(report, frame, uid) {
  const objects=frame.objects, start=objects.findIndex(object=>object.unique_id===uid);
  if(start<0)return [];
  const children=new Map(), figures={get:id=>findFigureType(report.figure_types,id)};
  objects.forEach((object,slot)=>{
    const parent=object.join?.target_object_slot;
    if(parent===undefined)return;
    if(!children.has(parent))children.set(parent,[]);
    children.get(parent).push(slot);
  });
  const queue=[start], seen=new Set(queue), colors=new Map();
  for(let cursor=0;cursor<queue.length;cursor++){
    const slot=queue[cursor], object=objects[slot], figure=figures.get(object.figure_type_id);
    if(figure)for(const entry of figurePalette(report,figure,object)){
      if(!colors.has(entry.color))colors.set(entry.color,{color:entry.color,segments:[],polygons:[],instances:{}});
      const row=colors.get(entry.color);
      for(const segment of entry.segments)row.segments.push(segment);
      for(const polygon of entry.polygons)row.polygons.push(polygon);
      if(entry.meshColors)row.meshColors=[...new Set([...(row.meshColors??[]),...entry.meshColors])];
      row.instances[object.unique_id]={...entry,figureTypeId:figure.figure_type_id};
    }
    for(const child of children.get(slot)??[])if(!seen.has(child)){seen.add(child);queue.push(child);}
  }
  if(queue.length===1)for(const row of colors.values())delete row.instances;
  return [...colors.values()].sort((a,b)=>b.segments.length-a.segments.length||a.color.localeCompare(b.color));
}
const rgb=value=>{
  if(typeof value==='string')return parseColor(value).color;
  if(!Array.isArray(value)||value.length!==3||value.some(n=>!Number.isInteger(n)||n<0||n>255))throw messageError(new Error(''), "errors.figureColors.chooseThreeRgbBytesOrAHexColor", {});
  return [...value];
};
