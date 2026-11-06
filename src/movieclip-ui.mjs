import {presentError} from './error-presentation.mjs';
import {tupleMessages, messageTuple, messageAttributes, localizedAttribute, appendLocalized, messageHTML, localizedMarkup} from './localization-bindings.mjs';

import {messageError} from './localized-error.mjs';

import {t as interfaceText} from './localization.mjs';

import {drawingSetsView} from './movieclip-drawings-view.mjs';
import {drawingBarrier} from './drawing-resources.mjs';
import {playbackSettings,movieclipAsset,movieclipTime} from './movieclips.mjs';

const inspectorStates=new WeakMap();
const seconds=value=>Number(Number(value).toFixed(3));
function inspectorState(editor){
  let state=inspectorStates.get(editor);
  if(!state||state.token!==editor._documentToken){state={token:editor._documentToken,nextKeys:1};inspectorStates.set(editor,state);}
  return state;
}
function nextKeys(editor){
  const track=editor.report._styk?.layerSheet?.tracks[editor.layerForUid(editor.selectedUid)];
  return track?track.keys.filter(key=>!key.patchOnly&&key.tick>editor.tick&&key.tick<track.end).length:editor.timeline.filter(row=>row.start>editor.tick&&row.count>0).length;
}

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** A movieclip instance's name line: the clip's name (double-click renames the definition) with the movieclip glyph. */
export const movieclipTarget=editor=>({name:editor.figure.name,glyph:'frame',
  rename:{description:interfaceText("movieclipUi.movieclipName"), descriptionKey: "movieclipUi.movieclipName",tip:interfaceText("movieclipUi.doubleClickToRenameTheMovieclip"), tipKey: "movieclipUi.doubleClickToRenameTheMovieclip",maxlength:120,data:{'movieclip-name':true}}});

/**
 * A movieclip instance's sections (experience.md §5.1): Playback (how it
 * plays: mode, start or hold frame, speed; where it is and how long it runs)
 * and Transform are open; Extend (adding it to the next keyframes), Bake and
 * export (Break apart frame, Bake to frames, Export clip…) and its drawing
 * sets are titled. Edit clip and Make unique are its quick actions.
 * `number(label, key, value, unit, extra)` builds a property row
 * (inspector-view.mjs passes one that reads live values); `layer` is the
 * figure's Layer select.
 */
export function movieclipSections(editor,{number=(label,key,value,unit='',extra={})=>({kind:'number',key,label,unit,value,...extra}),layer=null}={}){
  const object=editor.object,figure=editor.figure,p=playbackSettings(object),asset=movieclipAsset(figure),state=inspectorState(editor),remaining=nextKeys(editor);
  const sample=editor.evaluatedFrame.objects.find(value=>value.unique_id===object.unique_id)?._movieclipSample??movieclipTime(asset,p,editor.tick,editor.report.fps);
  const current=sample===null?null:Math.min(asset.duration,Math.floor(sample)+1),single=p.mode==='single';
  const feedback=state.feedback,validFeedback=feedback?.uid===object.unique_id&&feedback.tick===editor.tick&&feedback.revision===editor.revision?feedback:null,message=validFeedback?.message??'';
  const scene=Math.floor(editor.tick)+1,sets=drawingSetsView(figure,object);
  const playback=(name,label,description,value,min,max,extra={})=>({kind:'number',label,description,value,min,max,step:'any',precision:3,
    attrs:{required:true},data:{'movieclip-field':name},...extra});
  return [
    {id:'playback',title:interfaceText("movieclipUi.playback"), titleKey: "movieclipUi.playback",rows:[
      {kind:'select',label:interfaceText("movieclipUi.plays"), labelKey: "movieclipUi.plays",description:interfaceText("movieclipUi.movieclipPlayback"), descriptionKey: "movieclipUi.movieclipPlayback",value:p.mode,data:{'movieclip-field':'mode'},span:2,
        options:[messageTuple(['loop',interfaceText("movieclipUi.loop")], {1: {key: "movieclipUi.loop", params: {}}}),messageTuple(['hold',interfaceText("movieclipUi.playOnceHold")], {1: {key: "movieclipUi.playOnceHold", params: {}}}),messageTuple(['once',interfaceText("movieclipUi.playOnceHide")], {1: {key: "movieclipUi.playOnceHide", params: {}}}),messageTuple(['single',interfaceText("movieclipUi.singleFrame")], {1: {key: "movieclipUi.singleFrame", params: {}}})].map((_tuple) => {const [value,label] = _tuple; const _messages = tupleMessages(_tuple); return {value,label, ...(_messages[1] ? {labelKey: _messages[1].key, labelParams: _messages[1].params} : {})};})},
      {kind:'grid',rows:[
        playback('offset',single?interfaceText("movieclipUi.hold"):interfaceText("movieclipUi.start"),single?interfaceText("movieclipUi.movieclipHoldFrame"):interfaceText("movieclipUi.movieclipStartFrame"),p.offset+1,1,10000001,{labelKey:single?'movieclipUi.hold':'movieclipUi.start',descriptionKey:single?'movieclipUi.movieclipHoldFrame':'movieclipUi.movieclipStartFrame'}),
        playback('speed',interfaceText("movieclipUi.speed"),interfaceText("movieclipUi.movieclipSpeed"),p.speed,.001,100,{unit:'×',disabled:single,labelKey:'movieclipUi.speed',descriptionKey:'movieclipUi.movieclipSpeed'}),
      ]},
      {kind:'meta',parts:messageTuple([interfaceText("movieclipUi.frame"),{tag:'output',text:`${current??'—'} / ${asset.duration}`,data:{'movieclip-current-frame':true},attrs:{'aria-label':'Current movieclip frame'},descriptionKey:'movieclipUi.currentMovieclipFrame'},
        ' · ',{text:interfaceText("movieclipUi.scene2", {scene: scene}), textKey: "movieclipUi.scene2", textParams: {scene: scene},className:'movieclip-scene-frame',data:{tooltip:'Current scene frame'},tipKey:'movieclipUi.currentSceneFrame'}], {0: {key: "movieclipUi.frame", params: {}}})},
      {kind:'meta',parts:[{text:interfaceText('movieclipUi.durationSummary',{frames:{messageKey:'counts.frames',messageParams:{count:asset.duration}},seconds:seconds(asset.duration/asset.document.fps),fps:asset.document.fps}),textKey:'movieclipUi.durationSummary',textParams:{frames:{messageKey:'counts.frames',messageParams:{count:asset.duration}},seconds:seconds(asset.duration/asset.document.fps),fps:asset.document.fps},data:{'movieclip-duration':true}}]},
    ]},
    {id:'transform',title:interfaceText("movieclipUi.transform"), titleKey: "movieclipUi.transform",rows:[{kind:'grid',rows:[
      number('X','root_x',object.root_x,'px'),number('Y','root_y',object.root_y,'px'),
      number(interfaceText("movieclipUi.angle"),'rotation',((object.angles[0]??0)-(figure.segments[0]?.angle_rad??0))*180/Math.PI,'°', {labelKey: "movieclipUi.angle", labelParams: {}}),number(interfaceText("movieclipUi.scale"),'scale',object.scale*100,'%',{min:.01, labelKey: "movieclipUi.scale", labelParams: {}}),
      number(interfaceText("movieclipUi.opacity"),'figure_opacity',(1-(object.field28??0)/255)*100,'%',{min:0,max:100, labelKey: "movieclipUi.opacity", labelParams: {}}),
      number(interfaceText("movieclipUi.zIndex"),'figure_z_order',object._stykZIndex??0,'',{min:-1000000,max:1000000, labelKey: "movieclipUi.zIndex", labelParams: {}}),
      layer&&{...layer,span:2},
    ]}]},
    {id:'extend',title:interfaceText("movieclipUi.extend"), titleKey: "movieclipUi.extend",place:'titled',rows:[
      {kind:'grid',rows:[
        {kind:'number',id:'movieclip-next-keys',label:interfaceText("movieclipUi.nextKeys"), labelKey: "movieclipUi.nextKeys",description:interfaceText("movieclipUi.nextKeyframes"), descriptionKey: "movieclipUi.nextKeyframes",value:state.nextKeys,min:1,max:1000000,step:1,precision:0,
          attrs:{required:true},data:{'movieclip-next-keys':true}},
        {kind:'actions',items:[{action:'movieclip-extend',icon:'plus',label:interfaceText("movieclipUi.add"), labelKey: "movieclipUi.add",text:true,variant:'outline',disabled:!remaining,
          attrs:{'aria-label':'Add to next keyframes'},tip:interfaceText("movieclipUi.addThisClipToTheNextKeyframes"), tipKey: "movieclipUi.addThisClipToTheNextKeyframes"}]},
      ]},
      {kind:'meta',parts:[{text:interfaceText('movieclipUi.remainingKeys', {count:remaining}),textKey:'movieclipUi.remainingKeys',textParams:{count:remaining}}]},
      {kind:'meta',parts:[{text:message||(!remaining?interfaceText("movieclipUi.noLaterKeyframes"):''),textKey:validFeedback?.messageKey??(!remaining?'movieclipUi.noLaterKeyframes':undefined),textParams:validFeedback?.messageParams,data:{'movieclip-feedback':true},attrs:{role:'status','aria-live':'polite','aria-atomic':'true'}}]},
    ]},
    {id:'bake',title:interfaceText("movieclipUi.bakeAndExport"), titleKey: "movieclipUi.bakeAndExport",place:'titled',rows:[{kind:'actions',items:[
      {action:'movieclip-break',label:interfaceText("movieclipUi.breakApartFrame"), labelKey: "movieclipUi.breakApartFrame",text:true,variant:'outline',tip:interfaceText("movieclipUi.replaceOnlySceneFrame", {scene: scene}), tipKey: "movieclipUi.replaceOnlySceneFrame", tipParams: {scene: scene}},
      {action:'movieclip-bake',label:interfaceText("movieclipUi.bakeAnimation"), labelKey: "movieclipUi.bakeAnimation",text:true,variant:'outline',tip:interfaceText("movieclipUi.bakeTheClipIntoTheScene"), tipKey: "movieclipUi.bakeTheClipIntoTheScene"},
      {action:'movieclip-export',label:interfaceText("movieclipUi.exportMovieclip"), labelKey: "movieclipUi.exportMovieclip",text:true,variant:'outline',tip:interfaceText("movieclipUi.exportTheClipStykmov"), tipKey: "movieclipUi.exportTheClipStykmov"},
    ]}]},
    {id:'drawing-sets',title:interfaceText("movieclipUi.drawingSets"), titleKey: "movieclipUi.drawingSets",place:'titled',open:Boolean(sets),hidden:!sets,rows:[{kind:'markup',html:sets}]},
  ];
}
/** mountBreadcrumb(element) places the session breadcrumb ("← Scene", the scope path, Cancel, Done); the app owns where the stage
 * shows it, and without it the breadcrumb is not shown. */
export function installMovieclipUI({editor,actions,pause,finishEdit,getTimeline,setTool,onError,queueUI,exportClip,mountBreadcrumb}){
  const breadcrumb=document.createElement('div');breadcrumb.className='movieclip-breadcrumb';breadcrumb.hidden=true;
  mountBreadcrumb?.(breadcrumb);
  const dialog=document.createElement('dialog');dialog.className='movieclip-dialog';localizedAttribute(dialog, 'aria-label', "movieclipUi.createMovieclip", {});appendLocalized(document.body, dialog);
  const style=document.createElement('style');style.textContent=`@layer legacy{.movieclip-breadcrumb{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--theme-subtle, #eef4ff);border-bottom:1px solid var(--theme-border, #dce6f4)}.movieclip-breadcrumb[hidden]{display:none}.movieclip-breadcrumb strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.movieclip-fields{margin:10px 0}.movieclip-dialog{width:min(400px,calc(100vw - 32px));padding:20px;border:1px solid var(--theme-border, #d8dde4);border-radius:10px;color:var(--theme-text, #252a31);background:var(--theme-panel, #fff)}.movieclip-dialog::backdrop{background:var(--theme-backdrop, #0005)}.movieclip-dialog form{display:grid;gap:16px}.movieclip-dialog h2{margin:0;font-size:17px}.movieclip-dialog label{display:grid;gap:6px;font-size:12px}.movieclip-dialog input,.movieclip-dialog select{width:100%;padding:8px;border:1px solid var(--theme-border, #d8dde4);border-radius:5px;background:var(--theme-panel, #fff);color:var(--theme-text, #252a31);font:inherit}.movieclip-dialog .movieclip-check{display:flex;align-items:center}.movieclip-dialog .movieclip-check input{width:auto}.movieclip-dialog .movieclip-error{color:var(--theme-danger, #b42318);font-size:12px}.movieclip-dialog footer{display:flex;justify-content:flex-end;gap:8px}.movieclip-count{font-variant-numeric:tabular-nums;color:var(--theme-muted, #697586);font-size:12px}}`;appendLocalized(document.head, style);
  function open(mode){
    document.getElementById('insert-dialog')?.close();
    pause();finishEdit();
    const timelineView=getTimeline(),selection=timelineView?.selectedFrameIndices??[],rows=editor.timeline,timeRange=editor.report._styk?.layerSheet?timelineView?.selectedTimeRange:null;
    const start=mode==='range'&&timeRange?timeRange.start:mode==='range'&&selection.length?Math.min(...selection.map(i=>rows[i].start)):editor.tick;
    const end=mode==='range'&&timeRange?Math.min(editor.totalTicks,timeRange.end):mode==='range'&&selection.length?Math.max(...selection.map(i=>rows[i].start+rows[i].count)):start+1;
    const range=mode==='range'?`<div class="field-grid"><label>${messageHTML("movieclipUi.fromFrame", {})}<input name="start" type="number" min="1" max="${editor.totalTicks}" value="${start+1}" required></label><label>${messageHTML("movieclipUi.throughFrame", {})}<input name="end" type="number" min="1" max="${editor.totalTicks}" value="${end}" required></label></div>`:`<input name="start" type="hidden" value="${start+1}">`;
    localizedMarkup(dialog, `<form><h2 ${messageAttributes((mode==='empty' ? "movieclipUi.newMovieclip" : "movieclipUi.createMovieclip"), (mode==='empty' ? {} : {}))}>${mode==='empty'?interfaceText("movieclipUi.newMovieclip"):interfaceText("movieclipUi.createMovieclip")}</h2>
      <label>${messageHTML("movieclipUi.name", {})}<input name="name" aria-label="Movieclip name" required maxlength="120" value="${esc(editor.figure?.name?`${editor.figure.name} clip`:interfaceText("movieclipUi.movieclip"))}" data-i18n-aria-label="movieclipUi.movieclipName"></label>
      ${mode==='empty'?'':`${range}<label>${messageHTML("movieclipUi.contents", {})}<select name="contents"><option value="selected" ${editor.selectedUids.size?'':'disabled'} ${editor.selectedUids.size?'selected':''} data-i18n="movieclipUi.selectedFigures">${messageHTML("movieclipUi.selectedFigures", {})}</option><option value="all" ${editor.selectedUids.size?'':'selected'} data-i18n="movieclipUi.allFigures">${messageHTML("movieclipUi.allFigures", {})}</option></select></label><label class="movieclip-check"><input name="replace" type="checkbox" checked>${messageHTML("movieclipUi.replaceSelection", {})}</label>`}
      <div class="movieclip-error" role="alert" hidden></div><footer><button type="button" class="button" data-cancel data-i18n="movieclipUi.cancel">Cancel</button><button type="submit" class="button primary" data-i18n="movieclipUi.create">Create</button></footer></form>`);
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
    dialog.querySelector('form').onsubmit=async event=>{
      event.preventDefault();const form=event.currentTarget,values=new FormData(form),name=String(values.get('name')).trim();if(!name)return;
      try{
        const revision=editor.revision;await drawingBarrier(editor.report);if(revision!==editor.revision)throw messageError(new Error(''), "errors.movieclipUi.theSceneChangedTryCreatingTheMovieclipAgain", {});
        const figure=mode==='empty'?editor.createEmptyMovieclip(name):editor.createMovieclip({name,start:Number(values.get('start'))-1,...(mode==='range'?{end:Number(values.get('end'))}:{}),uids:values.get('contents')==='all'?[]:[...editor.selectedUids],replace:values.has('replace')});
        dialog.close();setTool('select');if(mode==='empty')editor.enterMovieclip(figure.figure_type_id);queueUI();
      }catch(error){const target=dialog.querySelector('[role="alert"]');target.hidden=false;presentError(target, error);}
    };
    dialog.showModal();dialog.querySelector('input').select();
  }
  Object.assign(actions,{
    'movieclip-new':()=>open('empty'),'movieclip-create':()=>open('selection'),'movieclip-range':()=>open('range'),
    'movieclip-edit':async()=>{pause();finishEdit();await drawingBarrier(editor.report);setTool('select');editor.enterMovieclip();},
    'movieclip-done':async()=>{pause();finishEdit();await drawingBarrier(editor.report);editor.leaveMovieclip();queueUI();},
    'movieclip-cancel':()=>{pause();editor.leaveMovieclip({save:false});queueUI();},
    'movieclip-unique':()=>editor.makeMovieclipUnique(),
    'movieclip-break':()=>editor.breakApartMovieclip(),'movieclip-export':()=>exportClip(),
    'movieclip-bake':()=>editor.bakeMovieclip(),
    'movieclip-extend':()=>{
      const input=document.querySelector('[data-movieclip-next-keys]');
      if(!input?.reportValidity())return;
      try{
        const count=Number(input.value),available=nextKeys(editor),state=inspectorState(editor);
        const added=editor.addMovieclipToNextKeyframes(count),skipped=Math.min(count,available)-added;
        state.nextKeys=count;
        const messageKey=added?(skipped?'movieclipUi.extensionWithSkipped':'movieclipUi.addedToKeyframes'):available?'movieclipUi.alreadyPresentInTheseKeyframes':'movieclipUi.noLaterKeyframes';
        const messageParams=skipped&&added?{added:{messageKey:'movieclipUi.addedToKeyframes',messageParams:{count:added}},skipped}:{count:added};
        state.feedback={uid:editor.selectedUid,tick:editor.tick,revision:editor.revision,message:interfaceText(messageKey,messageParams),messageKey,messageParams};queueUI();
      }catch(error){onError(error);}
    },
  });
  document.addEventListener('movieclip-create-range',()=>open('range'));
  for(const name of Object.keys(actions).filter(name=>name.startsWith('movieclip-'))){const run=actions[name];actions[name]=(...args)=>{pause();finishEdit();return run(...args);};}
  document.addEventListener('change',event=>{
    if(event.target.matches('[data-movieclip-next-keys]')){if(event.target.checkValidity())inspectorState(editor).nextKeys=Number(event.target.value);return;}
    if(event.target.matches('[data-movieclip-name]')){try{pause();finishEdit();editor.renameMovieclip(event.target.value);}catch(error){onError(error);}queueUI();return;}
    const input=event.target.closest('[data-movieclip-field]');if(!input)return;
    if(!input.reportValidity()){queueUI();return;}
    try{pause();finishEdit();const key=input.dataset.movieclipField;if(!['mode','offset','speed'].includes(key))return;
      const value=key==='mode'?input.value:Number(input.value)-(key==='offset'?1:0);
      editor.setMovieclipPlayback({[key]:value},{allFrames:true});queueUI();
    }catch(error){onError(error);queueUI();}
  });
  function sync(){
    const scopes=editor._movieclipScopes??[];if(breadcrumb.hidden!==!scopes.length)breadcrumb.hidden=!scopes.length;
    if(scopes.length)localizedMarkup(breadcrumb, `<button class="button" data-action="movieclip-done" data-i18n="movieclipUi.scene">${messageHTML("movieclipUi.scene", {})}</button><strong>${scopes.map(s=>esc(s.name)).join(' / ')}</strong><button class="button" data-action="movieclip-cancel" data-i18n="common.cancel">${messageHTML("movieclipUi.cancel", {})}</button><button class="button primary" data-action="movieclip-done" data-i18n="common.done">${messageHTML("movieclipUi.done", {})}</button>`);
  }
  editor.addEventListener('change',sync);sync();
  return {open,sync};
}
