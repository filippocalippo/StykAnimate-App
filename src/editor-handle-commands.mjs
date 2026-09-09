/** Native screen-pixel positioning, alignment and segment-value commands.
 * help5-2/{positioning_figures,segment_alignment,value_input,
 * alignment_to_neighbouring_frames}.htm; static clipboard evidence is in
 * artifacts/native-static/capslock-and-segment-values.md.
 */
import {arc, buildGeometry, evaluatedFrame, shortest} from './pivot/geometry.mjs';
import {cameraMatrix} from './renderer-geometry.mjs';
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const finite = value => { if (!Number.isFinite(value)) throw new Error('Position values must be finite.'); return value; };

export function screenVectorToWorld(dx, dy, options) {
  finite(dx); finite(dy);
  const [a,b,c,d] = cameraMatrix(options), determinant = a*d-b*c;
  if (!Number.isFinite(determinant) || Math.abs(determinant)<1e-20) throw new Error('The current view cannot resolve a pixel movement.');
  return {x:(d*dx-c*dy)/determinant,y:(a*dy-b*dx)/determinant};
}

/** Nearest incoming end tangent, walking joined origins only when necessary. */
export function segmentRelativeReference(geometry, slot, jointIndex) {
  let g=geometry.objects.get(slot), vertex=g?.segments[jointIndex]?.seg.parent_id;
  const seen=new Set();
  while(g&&!seen.has(g)) {
    seen.add(g);
    const incoming=g.segments.find(shape=>shape.seg.segment_id===vertex);
    if(incoming)return incoming.angle+incoming.bend;
    const join=g.obj.join;if(!join)return 0;
    vertex=join.target_handle_id??0;g=geometry.objects.get(join.target_object_slot);
  }
  return 0;
}

/** Pivot's normal animation clipboard is Angle:Bend:Length; units are degrees
 * and unscaled posed length. Relative mode belongs to the receiving UI, and
 * is deliberately not encoded in the clipboard payload.
 */
export function formatSegmentValues(values) {
  return ['angle','bend','length'].map(key=>String(finite(values[key]))).join(':');
}
export function parseSegmentValues(text) {
  if(typeof text!=='string'||text.length>100)throw new Error('Paste up to 100 characters of Angle:Bend:Length values.');
  // Native paste compacts numeric tokens into the visible boxes, ignoring
  // malformed tokens; a partial paste leaves the remaining fields unchanged.
  const numbers=[];
  for(const token of text.split(':')){
    if(!/^\s*[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?\s*$/i.test(token))continue;
    const value=Number(token.trim().replace(',','.'));if(Number.isFinite(value))numbers.push(value);
    if(numbers.length===3)break;
  }
  const values=Object.fromEntries(numbers.map((value,index)=>[['angle','bend','length'][index],value]));
  if('length'in values&&!(values.length>0))throw new Error('Segment length must be greater than zero.');
  return values;
}

function selectHandle(editor,{uid=editor.selectedUid,jointIndex=editor.selectedJoint,handleId}={}) {
  const frame=editor.selectionFrame??editor.frame,slot=frame.objects.findIndex(object=>object.unique_id===uid);
  if(slot<0)return null;
  const object=frame.objects[slot],figure=editor.report.figure_types.find(value=>value.figure_type_id===object.figure_type_id);
  if(handleId!==undefined)jointIndex=handleId===0?-1:figure.segments.findIndex(segment=>segment.segment_id===handleId);
  if(jointIndex < -1 || jointIndex>=figure.segments.length || handleId>0&&jointIndex<0)return null;
  if(uid!==editor.selectedUid||jointIndex!==editor.selectedJoint)editor.select(uid,jointIndex,{add:jointIndex<0&&editor.selectedUids.has(uid)});
  return {slot,object,figure,jointIndex};
}

function applyHandleTarget(editor,point,{editMode=false,bend=false,stretch=false,isolate=false,wholeFigure=false}={}) {
  if(editMode)return editor.editHandlePosition(point.x,point.y,{bend});
  if(wholeFigure)return editor.transformFigureHandle(point.x,point.y,{rotate:true,scale:false});
  if(bend)return editor.bendJoint(point.x,point.y,{stretch,isolate,snap:false});
  return editor.poseJoint(point.x,point.y,{stretch,isolate,snap:false});
}

export const editorHandleCommandMethods={
  nudgeHandle(dx,dy,options={}) {
    finite(dx);finite(dy);if(!dx&&!dy)return false;
    const target=selectHandle(this,options);if(!target)return false;
    const delta=screenVectorToWorld(dx,dy,{report:this.report,frame:this.evaluatedFrame,view:options.view,cameraEnabled:options.cameraEnabled});
    if(target.jointIndex<0&&!options.editMode)return this.moveSelection(delta.x,delta.y);
    const g=this.geometry.objects.get(target.slot),point=target.jointIndex<0?g.root:g.segments[target.jointIndex].end;
    return applyHandleTarget(this,{x:point.x+delta.x,y:point.y+delta.y},options);
  },

  alignHandle(dx,dy,options={}) {
    finite(dx);finite(dy);const magnitude=Math.hypot(dx,dy);if(!magnitude)return false;
    const target=selectHandle(this,options);if(!target||target.jointIndex<0)return false;
    const g=this.geometry.objects.get(target.slot),shape=g.segments[target.jointIndex],pivot=options.wholeFigure?g.root:shape.start;
    const distance=Math.hypot(shape.end.x-pivot.x,shape.end.y-pivot.y);
    // Native segment alignment targets canvas axes; camera/view magnification
    // only participates in pixel nudges, never changes authored absolute angles.
    return applyHandleTarget(this,{x:pivot.x+distance*dx/magnitude,y:pivot.y+distance*dy/magnitude},options);
  },

  locateEditedHandle(direction=-1,options={}) {
    if(direction!==-1&&direction!==1)throw new Error('Choose the previous or next frame.');
    if(this._drag)this.commitDrag();
    const index=this.frameIndex+direction;if(index<0||index>=this.report.keyframes.length)return false;
    const current=this.selectionFrame??this.frame,uid=options.uid??this.selectedUid;
    const object=current.objects.find(value=>value.unique_id===uid);if(!object)return false;
    const figure=this.report.figure_types.find(value=>value.figure_type_id===object.figure_type_id);
    const jointIndex=options.jointIndex??this.selectedJoint,handle=options.handleId??(jointIndex<0?0:figure.segments[jointIndex]?.segment_id);
    if(!Number.isInteger(handle)||handle<0)return false;
    const row=this.timeline[index],neighbor=evaluatedFrame(this.report,index,0,row.start),neighborSlot=neighbor.objects.findIndex(value=>value.unique_id===uid);
    if(neighborSlot<0)return false;
    const point=buildGeometry(this.report,neighbor).objects.get(neighborSlot)?.joints.get(handle);if(!point)return false;
    const target=selectHandle(this,{...options,uid,handleId:handle});if(!target)return false;
    return this.editHandlePosition(point.x,point.y,{bend:options.bend??false});
  },

  segmentValues({relative=false}={}) {
    const g=this.geometry.objects.get(this.selectedSlot),shape=g?.segments[this.selectedJoint];if(!shape)return null;
    const reference=relative?segmentRelativeReference(this.geometry,this.selectedSlot,this.selectedJoint):0;
    return {angle:shortest(shape.angle-reference)*DEG,bend:shape.bend*DEG,
      length:Math.abs(g.obj.scale)>1e-9?shape.length/Math.abs(g.obj.scale)
        :g.obj.len_flag?g.obj.lengths[this.selectedJoint]:shape.seg.length};
  },

  beginSegmentValueEdit(options={}) {
    if(!this.figure?.segments[this.selectedJoint])return false;
    const began=options.editMode?this.beginHandleEditDrag({label:'Edit segment values'}):this.beginDrag('Edit segment values');
    if(began)this._drag.segmentValueOptions={...options};return began;
  },

  setSegmentValues(values,options={}) {
    const opts={...this._drag?.segmentValueOptions,...options};
    if(!values||Object.keys(values).some(key=>!['angle','bend','length'].includes(key)))throw new Error('Choose segment angle, bend and length values.');
    for(const value of Object.values(values))finite(value);
    if('length'in values&&!(values.length>0))throw new Error('Segment length must be greater than zero.');
    const index=this.selectedJoint;if(!this.figure?.segments[index]||!Object.keys(values).length)return false;
    const previous=this.segmentValues(opts);
    if(Object.entries(values).every(([key,value])=>key==='angle'?Math.abs(shortest((value-previous.angle)*RAD))<1e-12:value===previous[key]))return false;
    const active=Boolean(this._drag);if(!active&&!this.beginSegmentValueEdit(opts))return false;
    try{
      const g=this.geometry.objects.get(this.selectedSlot),shape=g.segments[index],object=this.object;
      const reference=opts.relative?segmentRelativeReference(this.geometry,this.selectedSlot,index):0;
      const angle='angle'in values?values.angle*RAD+reference:shape.angle,bend='bend'in values?values.bend*RAD:shape.bend;
      const length='length'in values?values.length:this.segmentValues().length;
      if(opts.editMode){
        if(!this._drag.handleEdit)throw new Error('Begin a Handle Edit value gesture before changing these values.');
        const endpoint=arc(shape.start,angle,length*object.scale,bend).at(-1);
        this.editHandlePosition(endpoint.x,endpoint.y);
        object.angles[index]=shape.angle+shortest(angle-shape.angle);
        object.len_flag=1;object.lengths[index]=length;
        if('bend'in values){if(!object.bend_flag)object.bends=g.segments.map(value=>value.bend);object.bend_flag=1;object.bends[index]=bend;}
      }else{
        const angleDelta=shortest(angle-shape.angle),bendDelta=bend-shape.bend;
        if(Math.abs(angleDelta)>1e-12)this._rotateJoint(angleDelta,true,{isolate:opts.isolate});
        if(Math.abs(bendDelta)>1e-12)this._rotateJoint(bendDelta,false,{isolate:opts.isolate});
        if('length'in values){if(!object.len_flag)object.lengths=g.segments.map(value=>Math.abs(object.scale)>1e-9?value.length/Math.abs(object.scale):value.seg.length);object.len_flag=1;object.lengths[index]=length;}
        if('bend'in values){if(!object.bend_flag)object.bends=g.segments.map(value=>value.bend);object.bend_flag=1;object.bends[index]=bend;}
      }
      delete object.runtime_segments;this.touch();if(!active)return this.commitDrag();return true;
    }catch(error){this.cancelDrag();throw error;}
  },

  copySegmentValues(options={}) {
    const values=this.segmentValues(options);if(!values)return null;
    return this._segmentValuesClipboard=formatSegmentValues(values);
  },
  pasteSegmentValues(text=this._segmentValuesClipboard,options={}) {return this.setSegmentValues(parseSegmentValues(text),options);},
};
