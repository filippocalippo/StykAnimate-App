import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';

export function polygonConstructionFixture() {
  const report = emptyDocument();
  report.canvas_width = 400; report.canvas_height = 300;
  const definition = {figure_type_id: 1, name: 'Bent polygon rig', polyfills: [], image_assets: [], text_assets: [], segments: [
    [11,0,80,0,Math.PI/2], [33,11,80,0,0], [77,33,70,Math.PI/2,0],
    [99,0,80,Math.PI/2,0], [123,99,60,Math.PI,0],
  ].map(([segment_id,parent_id,length,angle_rad,bend_rad],i) => ({segment_id,parent_id,length,angle_rad,bend_rad,
    primitive_code:0,segment_type:'line',segment_kind:'line',thickness:5,color_rgb:[43,43,43],transparency:0,visible:true,z_order:i+1}))};
  definition.segment_count = definition.segments.length;
  report.figure_types = [definition];
  report.keyframes = [createFrame([createObject(definition,1,120,80)])];
  return report;
}
