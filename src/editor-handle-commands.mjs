import {messageError} from './localized-error.mjs';
/** The segment values shown for the selected segment, and the text the segment-value dialog copies and pastes. The engine
 * session sets and pastes them (`setSegmentValues`, `pasteSegmentValues`).
 * help5-2/value_input.htm; static clipboard evidence is in artifacts/native-static/capslock-and-segment-values.md. */
import {shortest} from './pivot/read-view.mjs';
const DEG = 180 / Math.PI;
const finite = value => { if (!Number.isFinite(value)) throw messageError(new Error(''), "errors.editorHandleCommands.positionValuesMustBeFinite", {}); return value; };

/** Nearest incoming end tangent, walking joined origins only when necessary. */
function segmentRelativeReference(geometry, slot, jointIndex) {
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
  if(typeof text!=='string'||text.length>100)throw messageError(new Error(''), "errors.editorHandleCommands.pasteUpTo100CharactersOfAngleBend", {});
  // Native paste compacts numeric tokens into the visible boxes, ignoring
  // malformed tokens; a partial paste leaves the remaining fields unchanged.
  const numbers=[];
  for(const token of text.split(':')){
    if(!/^\s*[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?\s*$/i.test(token))continue;
    const value=Number(token.trim().replace(',','.'));if(Number.isFinite(value))numbers.push(value);
    if(numbers.length===3)break;
  }
  const values=Object.fromEntries(numbers.map((value,index)=>[['angle','bend','length'][index],value]));
  if('length'in values&&!(values.length>0))throw messageError(new Error(''), "errors.editorHandleCommands.segmentLengthMustBeGreaterThanZero", {});
  return values;
}

export const editorHandleCommandMethods={
  segmentValues({relative=false}={}) {
    const g=this.geometry.objects.get(this.selectedSlot),shape=g?.segments[this.selectedJoint];if(!shape)return null;
    const reference=relative?segmentRelativeReference(this.geometry,this.selectedSlot,this.selectedJoint):0;
    return {angle:shortest(shape.angle-reference)*DEG,bend:shape.bend*DEG,
      length:Math.abs(g.obj.scale)>1e-9?shape.length/Math.abs(g.obj.scale)
        :g.obj.len_flag?g.obj.lengths[this.selectedJoint]:shape.seg.length};
  },
};
