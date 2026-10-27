import {messageError} from './localized-error.mjs';
import {drawingMetadata, isDrawingLayer, createDrawingFigure} from './drawing-model.mjs';
import {sheetKeyAt} from './layer-sheet.mjs';
import {createObject} from './demo.mjs';

function assertDrawingTargets(editor,ids) {
  if(!ids.length)throw messageError(new Error(''), "errors.editorDrawing.chooseADrawingLayer", {});
  for(const id of ids){const layer=editor.getLayer(id);if(!isDrawingLayer(layer))throw messageError(new Error(''), "errors.editorDrawing.chooseADrawingLayerOrCreateANew", {});if(layer.locked||!layer.visible)throw messageError(new Error(''), "errors.editorDrawing.showAndUnlockBeforeDrawing", {name: layer.name});}
}
export const editorDrawingMethods={
  drawingTarget(id=this.activeLayerId,tick=this.tick) {
    assertDrawingTargets(this,[id]);const track=this.report._styk.layerSheet.tracks[id],{key,next}=sheetKeyAt(track,tick);
    if(!key||tick>=track.end)throw messageError(new Error(''), "errors.editorDrawing.insertABlankDrawingOrCopyDrawingHere", {});
    const frame=key.value?.frameId?this.getFrameById(key.value.frameId):null;
    const object=frame?.objects.find(o=>this.layerForUid(o.unique_id)===id),figure=object&&this.report.figure_types.find(f=>f.figure_type_id===object.figure_type_id);
    if(figure&&!drawingMetadata(figure))throw messageError(new Error(''), "errors.editorDrawing.convertThisImageToADrawingBeforePainting", {});
    return {id,key,end:next?.tick??track.end,object,figure};
  },
  prepareDrawingCel({pixelsPerUnit=1,world={x:0,y:0}}={}) {
    const target=this.drawingTarget();if(target.figure)return target;
    const figure=createDrawingFigure({pixelsPerUnit,figureTypeId:this.report.figure_types.reduce((n,f)=>Math.max(n,f.figure_type_id+1),1)});
    const uid=this.getLayerFigureUids(target.id)[0]??this._nextUid;
    const object=createObject(figure,uid,world.x,world.y,{scale:1/pixelsPerUnit});
    return {...target,figure,object,created:true};
  },
};
