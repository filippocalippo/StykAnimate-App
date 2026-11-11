import {emptyDocument, createFrame} from './demo.mjs';
import {createBlueStartupPose} from './startup-blue-data.mjs';
import {ensureLayerState} from './layers.mjs';
import {initializeLayerSheet} from './editor-layer-sheet.mjs';

/** The canvas shapes Home's Start tiles offer (src/home/): the startup landscape, a vertical one and a square. */
export const STARTUP_CANVASES=Object.freeze({landscape:Object.freeze({width:960,height:540}),portrait:Object.freeze({width:540,height:960}),square:Object.freeze({width:720,height:720})});

/** Shared by application startup and File → New; demo fixtures stay independent. A `canvas` of another
 * size keeps Blue where it stands in the startup landscape: centred, a little above the middle. */
export function createStartupDocument({canvas}={}) {
  const report=emptyDocument(),{figure,object}=createBlueStartupPose();
  if(canvas&&(canvas.width!==report.canvas_width||canvas.height!==report.canvas_height)){
    if(![canvas.width,canvas.height].every(value=>Number.isInteger(value)&&value>=1&&value<=100000))throw new RangeError('Canvas dimensions must be 1-100000 pixels.');
    const x=Math.round(object.root_x/report.canvas_width*canvas.width),y=Math.round(object.root_y/report.canvas_height*canvas.height);
    // The hand and foot controllers keep their targets in scene coordinates: they move with the figure.
    for(const control of Object.values(object._stykIK??{}))if(control.target){control.target.x+=x-object.root_x;control.target.y+=y-object.root_y;}
    object.root_x=x;object.root_y=y;
    report.canvas_width=canvas.width;report.canvas_height=canvas.height;
  }
  report.figure_types=[figure];
  report.keyframes=[{...createFrame([object],10),_styk:{easing:{interpolation:'constant'}}}];
  ensureLayerState(report);
  initializeLayerSheet(report);
  // Native Pivot timing clamps the final key to one tick. The shared sheet
  // owns the ten-frame hold for Camera, Scene and the figure's layer.
  report._styk.layerSheet.duration=10;
  for(const track of Object.values(report._styk.layerSheet.tracks))track.end=10;
  return report;
}
