import {playbackSettings} from './movieclips.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function movieclipInspector(editor,field){
  const object=editor.object,figure=editor.figure,p=playbackSettings(object,{end:editor.totalTicks}),restart=p.restarts?.some(key=>key.tick===editor.tick);
  const input=(name,label,value,min,max,step=1)=>`<label class="field"><span>${label}</span><input type="number" data-movieclip-field="${name}" aria-label="Movieclip ${label.toLowerCase()}" value="${value}" min="${min}" max="${max}" step="${step}"></label>`;
  return `<section class="inspector-section"><div class="object-heading"><input class="figure-name" data-movieclip-name aria-label="Movieclip name" value="${esc(figure.name)}" maxlength="120"></div><div class="movieclip-actions"><button class="button primary" data-action="movieclip-edit">Edit movieclip</button><button class="button" data-action="movieclip-unique">Make unique</button></div></section>
    <section class="inspector-section"><div class="inspector-title">Playback</div><select class="inline-select" data-movieclip-field="mode" aria-label="Movieclip playback">${[['loop','Loop'],['hold','Once · hold'],['once','Once · hide'],['single','Single frame']].map(([value,label])=>`<option value="${value}" ${p.mode===value?'selected':''}>${label}</option>`).join('')}</select><div class="field-grid movieclip-fields">
    ${input('start','Start',p.start+1,1,10000001)}${input('end','End',p.end??editor.totalTicks,p.start+1,10000001)}${input('offset','Source frame',p.offset+1,1,10000001,.01)}${input('speed','Speed',p.speed,.01,100,.01)}</div><div class="movieclip-actions"><button class="button" data-action="${restart?'movieclip-clear-restart':'movieclip-restart'}">${restart?'Remove restart':'Restart here'}</button><button class="button" data-action="movieclip-split" ${editor.tick<=p.start||editor.tick>=(p.end??editor.totalTicks)?'disabled':''}>Split here</button></div></section>
    <section class="inspector-section"><div class="inspector-title">Transform</div><div class="field-grid">${field('X','root_x',object.root_x,'px')}${field('Y','root_y',object.root_y,'px')}${field('Scale','scale',object.scale*100,'%','min="0.01"')}${field('Angle','rotation',(object.angles[0]??0)*180/Math.PI,'°')}${field('Opacity','figure_opacity',(1-(object.field28??0)/255)*100,'%','min="0" max="100"')}${field('Z-index','figure_z_order',object._stykZIndex??0,'','min="-1000000" max="1000000"')}</div></section>
    <section class="inspector-section"><div class="movieclip-actions"><button class="button" data-action="movieclip-break" title="Replace only frame ${editor.tick+1}">Break apart frame</button><button class="button" data-action="movieclip-bake">Bake animation</button><button class="button" data-action="movieclip-export">Export movieclip</button></div></section>`;
}
export function installMovieclipUI({editor,actions,pause,finishEdit,getTimeline,setTool,onError,queueUI,exportClip}){
  const breadcrumb=document.createElement('div');breadcrumb.className='movieclip-breadcrumb';breadcrumb.hidden=true;
  document.querySelector('.context-strip').before(breadcrumb);
  const dialog=document.createElement('dialog');dialog.className='movieclip-dialog';dialog.setAttribute('aria-label','Create movieclip');document.body.append(dialog);
  const style=document.createElement('style');style.textContent=`.movieclip-breadcrumb{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#eef4ff;border-bottom:1px solid #dce6f4}.movieclip-breadcrumb[hidden]{display:none}.movieclip-breadcrumb strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.movieclip-actions{display:flex;gap:6px;flex-wrap:wrap}.movieclip-actions .button{flex:1;white-space:nowrap}.movieclip-fields{margin:10px 0}.movieclip-dialog{width:min(400px,calc(100vw - 32px));padding:20px;border:1px solid #d8dde4;border-radius:10px;color:#252a31;background:#fff}.movieclip-dialog::backdrop{background:#0005}.movieclip-dialog form{display:grid;gap:16px}.movieclip-dialog h2{margin:0;font-size:17px}.movieclip-dialog label{display:grid;gap:6px;font-size:12px}.movieclip-dialog input,.movieclip-dialog select{width:100%;padding:8px;border:1px solid #d8dde4;border-radius:5px;background:#fff;color:#252a31;font:inherit}.movieclip-dialog .movieclip-check{display:flex;align-items:center}.movieclip-dialog .movieclip-check input{width:auto}.movieclip-dialog .movieclip-error{color:#b42318;font-size:12px}.movieclip-dialog footer{display:flex;justify-content:flex-end;gap:8px}.movieclip-count{font-variant-numeric:tabular-nums;color:#697586;font-size:12px}`;document.head.append(style);
  function open(mode){
    document.getElementById('insert-dialog')?.close();
    pause();finishEdit();
    const timelineView=getTimeline(),selection=timelineView?.selectedFrameIndices??[],rows=editor.timeline,timeRange=editor.report._styk?.layerSheet?timelineView?.selectedTimeRange:null;
    const start=mode==='range'&&timeRange?timeRange.start:mode==='range'&&selection.length?Math.min(...selection.map(i=>rows[i].start)):editor.tick;
    const end=mode==='range'&&timeRange?Math.min(editor.totalTicks,timeRange.end):mode==='range'&&selection.length?Math.max(...selection.map(i=>rows[i].start+rows[i].count)):start+1;
    const range=mode==='range'?`<div class="field-grid"><label>From frame<input name="start" type="number" min="1" max="${editor.totalTicks}" value="${start+1}" required></label><label>Through frame<input name="end" type="number" min="1" max="${editor.totalTicks}" value="${end}" required></label></div>`:`<input name="start" type="hidden" value="${start+1}">`;
    dialog.innerHTML=`<form><h2>${mode==='empty'?'New movieclip':'Create movieclip'}</h2>
      <label>Name<input name="name" aria-label="Movieclip name" required maxlength="120" value="${esc(editor.figure?.name?`${editor.figure.name} clip`:'Movieclip')}"></label>
      ${mode==='empty'?'':`${range}<label>Contents<select name="contents"><option value="selected" ${editor.selectedUids.size?'':'disabled'} ${editor.selectedUids.size?'selected':''}>Selected figures</option><option value="all" ${editor.selectedUids.size?'':'selected'}>All figures</option></select></label><label class="movieclip-check"><input name="replace" type="checkbox" checked>Replace selection</label>`}
      <div class="movieclip-error" role="alert" hidden></div><footer><button type="button" class="button" data-cancel>Cancel</button><button type="submit" class="button primary">Create</button></footer></form>`;
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
    dialog.querySelector('form').onsubmit=event=>{
      event.preventDefault();const form=event.currentTarget,values=new FormData(form),name=String(values.get('name')).trim();if(!name)return;
      try{
        const figure=mode==='empty'?editor.createEmptyMovieclip(name):editor.createMovieclip({name,start:Number(values.get('start'))-1,...(mode==='range'?{end:Number(values.get('end'))}:{}),uids:values.get('contents')==='all'?[]:[...editor.selectedUids],replace:values.has('replace')});
        dialog.close();setTool('select');if(mode==='empty')editor.enterMovieclip(figure.figure_type_id);queueUI();
      }catch(error){const target=dialog.querySelector('[role="alert"]');target.hidden=false;target.textContent=error.message;}
    };
    dialog.showModal();dialog.querySelector('input').select();
  }
  Object.assign(actions,{
    'movieclip-new':()=>open('empty'),'movieclip-create':()=>open('selection'),'movieclip-range':()=>open('range'),
    'movieclip-edit':()=>{pause();finishEdit();setTool('select');editor.enterMovieclip();},
    'movieclip-done':()=>{pause();finishEdit();editor.leaveMovieclip();queueUI();},
    'movieclip-cancel':()=>{pause();editor.leaveMovieclip({save:false});queueUI();},
    'movieclip-unique':()=>editor.makeMovieclipUnique(),'movieclip-restart':()=>editor.restartMovieclip(),'movieclip-clear-restart':()=>editor.removeMovieclipRestart(),
    'movieclip-split':()=>editor.splitMovieclip(),
    'movieclip-break':()=>editor.breakApartMovieclip(),'movieclip-export':()=>exportClip(),
    'movieclip-bake':()=>editor.bakeMovieclip(),
  });
  document.addEventListener('movieclip-create-range',()=>open('range'));
  for(const name of Object.keys(actions).filter(name=>name.startsWith('movieclip-'))){const run=actions[name];actions[name]=(...args)=>{pause();finishEdit();return run(...args);};}
  document.addEventListener('change',event=>{
    if(event.target.matches('[data-movieclip-name]')){try{pause();finishEdit();editor.renameMovieclip(event.target.value);}catch(error){onError(error);}queueUI();return;}
    const input=event.target.closest('[data-movieclip-field]');if(!input)return;
    try{pause();finishEdit();const key=input.dataset.movieclipField;let value=key==='mode'?input.value:input.value===''&&key==='end'?null:Number(input.value);
      if(key==='start'||key==='offset')value--;
      if(key==='start'){const p=playbackSettings(editor.object);editor.placeMovieclip({start:value,end:(p.end??editor.totalTicks)+value-p.start},{move:true});}
      else if(key==='end')editor.placeMovieclip({end:value});else editor.setMovieclipPlayback({[key]:value},{allFrames:true});queueUI();
    }catch(error){onError(error);queueUI();}
  });
  function sync(){
    const scopes=editor._movieclipScopes??[];breadcrumb.hidden=!scopes.length;
    if(scopes.length)breadcrumb.innerHTML=`<button class="button" data-action="movieclip-done">← Scene</button><strong>${scopes.map(s=>esc(s.name)).join(' / ')}</strong><button class="button" data-action="movieclip-cancel">Cancel</button><button class="button primary" data-action="movieclip-done">Done</button>`;
  }
  editor.addEventListener('change',sync);sync();
  return {open,sync};
}
