import {vfxStack, vfxPadding} from './vfx.mjs';
// Which effects a drawn item carries, and how far they spread: pure reads of its stacks, shared by the
// editor's bounds, the previews and the painters that run them.
const empty=Object.freeze([]);
function segmentVfx(item){if(!item.obj?._stykVfx||item.type==='poly'||!item.seg)return empty;return vfxStack(item.obj,{kind:'segment',figureTypeId:item.fig?.figure_type_id,handleId:item.seg.segment_id});}
export function drawableVfxPadding(item){
 if(!item.obj?._stykVfx&&!item._movieclipOwner&&!item._movieclipInner)return 0;
 let padding=vfxPadding(vfxStack(item.obj),Math.abs(item.obj?.scale??1))+vfxPadding(segmentVfx(item),Math.abs(item.obj?.scale??1));
 if(item._movieclipOwner)padding+=vfxPadding(item._movieclipOwner.effects,Math.abs(item._movieclipOwner.scale??1));
 for(let inner=item._movieclipInner;inner;inner=inner.inner)padding+=vfxPadding(inner.owner.effects,Math.abs(inner.owner.scale??1));return padding;
}
