import {messageAttributes} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';
import {drawingSelection} from './movieclip-drawings.mjs';
import {findFigureType} from './figure-types.mjs';

/** Drawing-bank controls belong to the interface; workers only select drawings. */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function drawingSetsView(figure,object){
 const asset=figure?._styk?.movieclip;if(!asset?.drawingSets)return'';
 const{group,view}=drawingSelection(asset,object),sets=asset.drawingSets,select=(key,label,items,current, _messages = {})=>`<label class="spatial-choice"><span ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}</span><select class="inline-select" data-drawing-${key} data-drawing-uid="${object.unique_id}" aria-label="${esc(figure.name)} ${label.toLowerCase()}">${items.map((item,i)=>`<option value="${i}" ${i===current?'selected':''}>${esc(item.name)}</option>`).join('')}</select></label>`;
 return`<section class="inspector-section spatial-rig" data-section="drawing-bank-${object.unique_id}"><strong>${esc(figure.name)}</strong>${select('group',interfaceText("movieclipDrawings.form"),sets,group, {label: {key: "movieclipDrawings.form", params: {}}})}${asset.spatialMeshes?`<p class="hint" data-i18n="movieclipDrawings.rotateAndTiltTheParentJointToPose">Rotate and tilt the parent joint to pose this attached mesh.</p>`:asset.drawingRotation?`<p class="hint" data-i18n="movieclipDrawings.rotateHeadToSwitchDirectionTiltSelectsUp">Rotate Head to switch direction. Tilt selects Up / Level / Down.</p>`:select('view',interfaceText("movieclipDrawings.view"),sets[group].views,view, {label: {key: "movieclipDrawings.view", params: {}}})}</section>`;
}
export function joinedDrawingSetsView(editor){
 const objects=editor.selectionFrame?.objects??[],types={get:id=>findFigureType(editor.report.figure_types,id)};
 return objects.filter(o=>o.join?.target_unique_id===editor.selectedUid).map(o=>drawingSetsView(types.get(o.figure_type_id),o)).join('');
}
