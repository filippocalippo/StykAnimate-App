export function geometryFixture({version = 5, invalid = false} = {}) {
  const segment = (id,parent,type,angle,extra={}) => ({segment_id:id,parent_id:parent,segment_type:type,
    segment_kind:type==='circle'?'circleFill':type,angle_rad:angle,length:30,thickness:4,bend_rad:0,
    z_order:id,color_rgb:[42,80,120],transparency:12,aux_code:0,visible:true,...extra});
  const figure={figure_type_id:1,name:'Mixed geometry',segment_count:4,segments:[
    segment(2,7,'circle',.8,{aux_code:1}), segment(12,2,'text',.25,{extra_u16:1}),
    segment(7,0,'line',.2,{bend_rad:.4}), segment(9,7,'image',-.5,{extra_u16:1})],
    polyfills:[{polyfill_id:1,segment_ids:[0,7,2],z_order:1,color_rgb:[90,30,130],alpha_raw:60}],
    image_assets:[{asset_index:1,pivot:{x:2,y:3},endpoint:{x:22,y:8},data_url:'data:image/png;base64,fixture'}],
    text_assets:[{asset_index:1,bounds:{left:0,bottom:0,width:20,height:25},normalized_svg_path:'M0 0L20 20',placements:[]}]};
  const object=(uid,x,y,extra={})=>({object_slot:uid-1,unique_id:uid,figure_type_id:1,root_x:x,root_y:y,
    scale:1,color_override_raw:0,field28:0,angles:[.8,.25,.2,-.5],len_flag:0,lengths:[],bend_flag:0,bends:[],join:null,...extra});
  const frame={duration_raw:1,objects:[object(1,10,20),object(2,99,99,{scale:-1.2,field28:70,
    color_override_raw:0x80335577,join:{target_object_slot:0,target_handle_id:7}}),
    object(3,88,88,{len_flag:1,lengths:[20,40,60,80],bend_flag:1,bends:[0,0,-.2,0],
      join:{target_object_slot:1,target_handle_id:2}}),object(4,150,100)],object_draw_order:[2,3,1,0]};
  if(invalid){frame.objects.push(object(5,0,0,{figure_type_id:999}),object(6,0,0,{join:{target_object_slot:5,target_handle_id:0}}));
    frame.object_draw_order.push(4,5);}
  return {version,canvas_width:500,canvas_height:300,figure_types:[figure],keyframes:[frame]};
}

export function geometrySummary(geometry) {
  const shape=({obj,fig,...fields})=>({...fields,objectUid:obj.unique_id,figureTypeId:fig.figure_type_id});
  return {objects:[...geometry.objects].map(([slot,value])=>[slot,value?{slot,objectUid:value.obj.unique_id,
    figureTypeId:value.fig.figure_type_id,root:value.root,joints:[...value.joints],
    segments:value.segments.map(shape),polys:value.polys.map(shape),drawables:value.drawables?.map(shape)}:null]),
    order:geometry.orderedObjects.map(object=>object.slot),drawables:geometry.drawables.map(shape),warnings:geometry.warnings};
}
