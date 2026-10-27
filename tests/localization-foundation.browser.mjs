import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const output=path.resolve('artifacts/localization-foundation');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:800}}), errors=[], checks=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',message=>{if (/^(?:ReferenceError|TypeError|SyntaxError):/.test(message.text())) errors.push(message.text());});
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);console.log('PASS',name);};
try {
  await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.waitForFunction(()=>styk.assets.count.getAttribute('data-i18n')==='counts.figures');
  check('Asset library connects its count after startup without swallowed binding errors',await page.evaluate(()=>styk.assets.count.getAttribute('data-i18n')==='counts.figures'&&styk.assets.count.textContent===styk.localization.t('counts.figures',{count:styk.assets.records.length})));

  await page.evaluate(()=>{
    styk.editor.newDocument();
    window.baseline={report:JSON.stringify(styk.editor.report),undo:styk.editor._undo.length,revision:styk.editor.revision,tick:styk.editor.tick,uid:styk.editor.selectedUid};
    window.savedButton=document.querySelector('.titlebar [data-action=save]');window.savedIcon=savedButton.querySelector('svg');
  });
  await page.evaluate(async()=>{
    const {createToasts}=await import('/src/ui/ui-toast.mjs');
    window.taskToasts=createToasts({document});
    window.localizedTask=taskToasts.task({title:'Preparing canvas and effects…',titleKey:'app.preparingCanvasAndEffects',meta:'Graphics device lost',metaKey:'rendererStatus.deviceLost',delay:0});
  });
  await page.waitForSelector('.ui-toast-progress');
  await page.evaluate(()=>{window.retainedStatus=document.querySelector('#status');styk.localization.localization.setPseudo('long');});
  check('Retained background, motion-path group and tween-type captions resolve their current language',await page.evaluate(()=>
    document.querySelector('#crumb-background').getAttribute('aria-label').includes('［')
    &&document.querySelector('.motion-path-tool').getAttribute('aria-label').includes('［')
    &&document.querySelector('#tweener-button').getAttribute('aria-label')===styk.localization.t('tweenerControls.tweener',{label:{messageKey:'tweenerControls.breakdown'}})
    &&document.querySelector('[data-tween-type=breakdown] span').textContent===styk.localization.t('tweenerControls.breakdown')
    &&document.querySelector('.tweener-hud').firstElementChild.textContent===styk.localization.t('tweenerControls.breakdown')
    &&document.querySelector('[data-tween-type=breakdown] path').getAttribute('d')==='M12 3 20 12 12 21 4 12Z'));
  check('Retained activity, delayed task captions and progress accessibility follow the language',await page.evaluate(()=>retainedStatus===document.querySelector('#status')&&retainedStatus.textContent.includes('［')&&document.querySelector('.ui-toast-text b').textContent.includes('［')&&document.querySelector('.ui-toast-progress').getAttribute('aria-label').includes('［')));
  await page.evaluate(()=>{window.onionCaption=document.querySelector('#onion-popover [data-i18n="onionControls.opacity"]');window.onionCaptionNode=onionCaption.firstElementChild;});
  await page.evaluate(async()=>{
    const {OnionFrameField}=await import('/src/onion-frame-field.mjs');
    const {appendLocalized}=await import('/src/localization-bindings.mjs');
    window.onionProbe=new OnionFrameField(styk.onionController,'before');appendLocalized(document.body,onionProbe.root);
    window.onionDraft=onionProbe.input;onionDraft.focus();onionDraft.value='23';
    window.onionRangeBefore=styk.state.settings.onionRangeBefore;
    styk.localization.localization.setPseudo('rtl');
  });
  check('Onion controls translate directions and plural values while preserving drafts and canonical preferences',await page.evaluate(()=>{
    const t=(key,params)=>styk.localization.t(key,params),direction={messageKey:'onionFrameField.before'};
    const marker=document.querySelector('.onion-range-end.before'),count=styk.onionController.snapshot().before.span;
    return onionProbe.root.dataset.direction==='before'&&onionProbe.key==='onionRangeBefore'
      &&document.activeElement===onionDraft&&onionDraft.value==='23'&&styk.state.settings.onionRangeBefore===onionRangeBefore
      &&onionProbe.scrub.textContent===t('onionFrameField.before')
      &&onionProbe.scrub.getAttribute('aria-label')===t('onionFrameField.dragFrames',{direction})
      &&onionDraft.getAttribute('aria-label')===t('onionFrameField.frames',{direction})
      &&onionProbe.root.querySelector('[data-step="-1"]').getAttribute('aria-label')===t('onionFrameField.decreaseFrames',{direction})
      &&onionProbe.root.querySelector('[data-step="1"]').getAttribute('aria-label')===t('onionFrameField.increaseFrames',{direction})
      &&marker.getAttribute('aria-label')===t('onionTimelineRange.onionFrames',{direction})
      &&marker.getAttribute('aria-valuetext')===t('counts.frames',{count})
      &&marker.title===t('onionTimelineRange.dragToChange',{spanLabel:{messageKey:'counts.frames',params:{count}}});
  }));
  check('Nested retained captions update their original slot without leaving English or adding duplicate text',await page.evaluate(()=>{
    const p=document.querySelector('#onion-popover'),keys=['opacity','allFigures','selected','more','sample','poses','everyFrame','every'];
    return onionCaption.firstElementChild===onionCaptionNode&&onionCaption.children.length===1
      &&keys.every(name=>p.querySelector(`[data-i18n="onionControls.${name}"]`).textContent===styk.localization.t(`onionControls.${name}`));
  }));
  await page.evaluate(async()=>{
    const {localizedMarkup,appendLocalized}=await import('/src/localization-bindings.mjs');
    window.captionProbe=document.createElement('button');
    localizedMarkup(captionProbe, '<svg aria-hidden="true"><path d="M1 1h2"></path></svg><span data-i18n="chrome.vfx">VFX</span><kbd>Ctrl+V</kbd>');
    captionProbe.dataset.i18n='chrome.vfx';appendLocalized(document.body,captionProbe);
    window.captionNodes=[...captionProbe.children];
    for(let cycle=0;cycle<4;cycle++)for(const locale of ['en','ar','he','de']){
      styk.localization.localization.setPseudo(null);styk.localization.setLocale(locale);
      styk.localization.apply(captionProbe);styk.localization.apply(document.querySelector('#onion-popover'));
      if(captionProbe.textContent!==styk.localization.t('chrome.vfx')+'Ctrl+V'
        ||document.querySelector('.onion-more summary').textContent!==styk.localization.t('onionControls.more'))throw new Error('Repeated caption after '+locale);
    }
  });
  check('Repeated language changes and subtree registration keep one VFX and More caption with original icon and shortcut nodes',await page.evaluate(()=>
    captionProbe.children.length===captionNodes.length&&captionNodes.every((node,index)=>captionProbe.children[index]===node)
    &&captionProbe.querySelector('kbd').textContent==='Ctrl+V'));
  await page.evaluate(()=>{captionProbe.remove();styk.localization.setLocale('en');});
  await page.evaluate(()=>onionProbe.destroy());
  await page.evaluate(()=>{localizedTask.done();taskToasts.destroy();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {createAppDialogs}=await import('/src/app-dialogs.mjs');
    const actions={}, state={renderSamples:[],renderer:null};
    createAppDialogs({editor:styk.editor,state,actions,overlays:styk.ui.overlays,playbackMetrics:{snapshot:()=>({fps:null,startupMs:null,bufferingMs:12.35,bufferingEvents:1})},guarded:fn=>fn,pause(){},finishCurrentEdit(){},localization:()=>styk.localization});
    actions.performance();
  });
  await page.locator('#performance-dialog[open]').waitFor();
  check('Performance buffering uses a complete singular message',await page.locator('.metric-table tr').nth(3).locator('td').nth(1).textContent()==='12.4 ms · 1 wait');
  await page.evaluate(()=>{window.metricNodes=[...document.querySelectorAll('.metric-table td')];styk.localization.localization.setPseudo('rtl');});
  check('Retained performance names, initializing status and buffering summary follow the language without rebuilding the table',await page.evaluate(()=>{
    const cells=[...document.querySelectorAll('.metric-table td')];
    return metricNodes.every((node,index)=>node===cells[index])&&cells[0].textContent===styk.localization.t('appDialogs.renderer')
      &&cells[1].textContent===styk.localization.t('appDialogs.initializing')
      &&cells[7].textContent===styk.localization.t('appDialogs.bufferingSummary',{milliseconds:{format:'number',value:12.35,options:{minimumFractionDigits:1,maximumFractionDigits:1}},count:1});
  }));
  await page.locator('#performance-dialog .ui-dialog-close').click();
  await page.evaluate(async()=>{
    const {sliderMarkup}=await import('/src/drawing-sliders.mjs');
    const {pressureCurveMarkup,refreshPressureCurve}=await import('/src/drawing-pressure-curve.mjs');
    const {localizedMarkup,appendLocalized}=await import('/src/localization-bindings.mjs');
    window.drawingCaptionProbe=document.createElement('section');localizedMarkup(drawingCaptionProbe,sliderMarkup('size',10)+pressureCurveMarkup([.1,.5,.4,.95]));appendLocalized(document.body,drawingCaptionProbe);
    window.curveHandle=drawingCaptionProbe.querySelector('[data-pressure-handle]');curveHandle.focus();window.curvePosition=[curveHandle.getAttribute('cx'),curveHandle.getAttribute('cy')];
    styk.localization.localization.setPseudo('long');
    refreshPressureCurve(drawingCaptionProbe,[.1,.5,.4,.95]);
  });
  check('Drawing slider hints and pressure accessibility translate in place while graph geometry and focus stay unchanged',await page.evaluate(()=>{
    const probe=drawingCaptionProbe,t=(key,params)=>styk.localization.t(key,params);
    return document.activeElement===curveHandle&&curvePosition.every((value,index)=>value===curveHandle.getAttribute(index?'cy':'cx'))
      &&probe.querySelector('.draw-slider').getAttribute('aria-label')===t('drawingSliders.size')
      &&probe.querySelector('.draw-slider').title===t('drawingSliders.interactionHint',{name:{messageKey:'drawingSliders.size'}})
      &&probe.querySelector('.draw-pressure-graph').getAttribute('aria-label')===t('drawingPressureCurve.graphDescription')
      &&curveHandle.getAttribute('aria-valuetext')===t('drawingPressureCurve.handleValue',{pressure:10,response:50});
  }));
  await page.evaluate(()=>{drawingCaptionProbe.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {quickBarMarkup,drawingInspector}=await import('/src/drawing-view.mjs');
    const legacy=await import('/src/inspector-legacy.mjs'),{propertyToggle}=await import('/src/property-toggle.mjs');
    const {localizedMarkup,appendLocalized}=await import('/src/localization-bindings.mjs');
    const drawing=Object.create(styk.drawing);Object.defineProperty(drawing,'tool',{value:'brush'});
    window.drawingOwnerProbe=document.createElement('section');
    localizedMarkup(drawingOwnerProbe,quickBarMarkup(drawing)+drawingInspector(drawing,{...legacy,propertyToggle})+legacy.numericField('Scale','localization-test-scale',12.5,'%','',{}, {labelKey:'inspectorView.scale',legacyField:false}));
    appendLocalized(document.body,drawingOwnerProbe);
    window.drawingDraft=drawingOwnerProbe.querySelector('[data-property="localization-test-scale"]');drawingDraft.value='37.25';drawingDraft.focus();
    window.drawingProbeNodes=[...drawingOwnerProbe.querySelectorAll('input,button')];
    styk.localization.localization.setPseudo('rtl');
  });
  check('Drawing tool, section, toggle, palette and numeric captions translate without replacing controls or editing their drafts',await page.evaluate(()=>{
    const probe=drawingOwnerProbe,t=(key,params)=>styk.localization.t(key,params),nodes=[...probe.querySelectorAll('input,button')];
    const add=probe.querySelector('.draw-quick-add');
    return document.activeElement===drawingDraft&&drawingDraft.value==='37.25'&&drawingProbeNodes.every((node,index)=>node===nodes[index])
      &&probe.querySelector('.draw-quick-tool span').textContent===t('drawingView.brush')
      &&probe.querySelector('[data-i18n="drawingView.preset"]').textContent===t('drawingView.preset')
      &&probe.querySelector('#draw-alphaLock').getAttribute('aria-label')===t('drawingView.lockAlpha')
      &&drawingDraft.getAttribute('aria-label')===t('inspector.withUnit',{label:{messageKey:'inspectorView.scale'},unit:'%'})
      &&(!add||add.getAttribute('aria-label')===t('drawingView.addTo',{value:styk.drawing.settings.color.toUpperCase(),where:{messageKey:'colorPicker.projectColors'}}));
  }));
  await page.evaluate(()=>{drawingOwnerProbe.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {HotkeySettings}=await import('/src/hotkey-settings.mjs'),{DEFAULT_HOTKEYS}=await import('/src/hotkeys.mjs');
    const {localizedMarkup,appendLocalized}=await import('/src/localization-bindings.mjs');
    window.hotkeyOwnerProbe=document.createElement('section');window.hotkeyProbeValues=structuredClone(DEFAULT_HOTKEYS);
    const settings={dialog:hotkeyOwnerProbe,content:hotkeyOwnerProbe,value:{hotkeys:hotkeyProbeValues},commit(patch){this.value={...this.value,...patch};},render(){localizedMarkup(hotkeyOwnerProbe,hotkeyProbe.html());}};
    window.hotkeyProbe=new HotkeySettings(settings);settings.render();appendLocalized(document.body,hotkeyOwnerProbe);
    window.hotkeyReset=hotkeyOwnerProbe.querySelector('[data-hotkey-id="save"] [data-hotkey-reset]');hotkeyReset.focus();
    hotkeyProbe.assign('save',[],true);hotkeyProbe.assign('redo',['Mod+KeyZ']);
    window.hotkeyBindingsBefore=JSON.stringify(settings.value.hotkeys);
    styk.localization.localization.setPseudo('long');
  });
  check('Shortcut captions, reset hints, assignment and conflict names follow the locale while physical bindings stay unchanged',await page.evaluate(()=>{
    const t=(key,params)=>styk.localization.t(key,params),probe=hotkeyOwnerProbe;
    return JSON.stringify(hotkeyProbe.settings.value.hotkeys)===hotkeyBindingsBefore
      &&probe.querySelector('[data-hotkey-id="save"] .hotkey-name span').textContent===t('hotkeyCaptions.command.save')
      &&probe.querySelector('[data-hotkey-id="save"] [data-hotkey-reset]').getAttribute('aria-label')===t('hotkeySettings.resetShortcut',{label:{messageKey:'hotkeyCaptions.command.save'}})
      &&probe.querySelector('.hotkey-status').textContent===t('hotkeySettings.assignmentSummary',{label:{messageKey:'hotkeyCaptions.command.save'},bindings:{messageKey:'hotkeySettings.unassigned'}})
      &&probe.querySelector('.hotkey-conflict p').textContent.includes(t('common.undo'))
      &&probe.querySelector('.hotkey-group h4').textContent===t('hotkeyCaptions.category.projectEditing');
  }));
  await page.evaluate(()=>{hotkeyOwnerProbe.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {UpdateUI}=await import('/src/update-ui.mjs');
    window.updateProbe=new UpdateUI({getUpdateState:async()=>({status:'idle'}),onUpdateState(){return()=>{};}});
    await Promise.resolve();updateProbe.render({status:'downloading',version:'1.2.3',currentVersion:'1.2.2',percent:35,total:2097152,transferred:1048576});
    window.updateProgress=updateProbe.progress;styk.localization.localization.setPseudo('rtl');
  });
  check('Update progress and version captions translate in place with unchanged download values',await page.evaluate(()=>updateProbe.progress===updateProgress&&updateProgress.value===35
    &&updateProbe.title.textContent===styk.localization.t('updateUi.downloadingVersion',{version:'1.2.3'})
    &&updateProbe.detail.textContent===styk.localization.t('updateUi.downloadingProgressWithSize',{percent:35,transferred:{format:'number',value:1,options:{minimumFractionDigits:1,maximumFractionDigits:1}},total:{format:'number',value:2,options:{minimumFractionDigits:1,maximumFractionDigits:1}}})));
  check('Every owned desktop update explanation renders translated metadata while preserving its original state message',await page.evaluate(async()=>{
    const english=(await import('/src/locales/en.mjs')).default;styk.localization.localization.setPseudo(null);styk.localization.setLocale('fr');
    for(const suffix of ['developmentUnavailable','linuxAppImageRequired','writableAppImageRequired','supportedInstallerRequired','windowsSetupRequired','retryConnection']){
      const key='desktop.updates.'+suffix,state={status:suffix==='retryConnection'?'error':'unavailable',message:english[key],messageKey:key};
      const before=JSON.stringify(state);updateProbe.render(state);
      if(updateProbe.detail.textContent!==styk.localization.t(key)||updateProbe.detail.textContent===english[key]||JSON.stringify(state)!==before)return false;
    }
    return true;
  }));
  await page.evaluate(()=>{updateProbe.element.remove();updateProbe.unsubscribe?.();styk.localization.localization.setPseudo(null);styk.localization.setLocale('en');});
  await page.evaluate(async()=>{
    const {showTimelineMenu}=await import('/src/timeline-menu.mjs');
    window.timelineCaptionHost={_run:fn=>fn(),scroll:document.createElement('div')};document.body.append(timelineCaptionHost.scroll);
    window.timelineCaptionActionRan=false;
    showTimelineMenu(timelineCaptionHost,{clientX:220,clientY:200},[[{heading:'Frames 2–4',headingKey:'layerTimeline.framesRange',headingParams:{first:2,last:4}},
      {label:'Remove frames',labelKey:'layerTimeline.removeFrames',shortcut:'Ctrl+Delete',action:()=>{timelineCaptionActionRan=true;}}]]);
    window.timelineCaptionRow=timelineCaptionHost.menu.element.querySelector('[role="menuitem"]');timelineCaptionRow.focus();
    styk.localization.localization.setPseudo('rtl');
  });
  check('Timeline menu headings and command captions retain their keys, parameters, focus and physical shortcut',await page.evaluate(()=>{
    const root=timelineCaptionHost.menu.element;
    return timelineCaptionRow===root.querySelector('[role="menuitem"]')&&document.activeElement===timelineCaptionRow
      &&root.querySelector('[data-i18n="layerTimeline.framesRange"]').textContent===styk.localization.t('layerTimeline.framesRange',{first:2,last:4})
      &&root.querySelector('[data-i18n="layerTimeline.removeFrames"]').textContent===styk.localization.t('layerTimeline.removeFrames')
      &&root.querySelector('kbd').textContent==='Ctrl+Delete';
  }));
  await page.evaluate(()=>timelineCaptionRow.click());
  check('Localized timeline menu commands retain their action',await page.evaluate(()=>timelineCaptionActionRan));
  await page.evaluate(()=>{timelineCaptionHost.scroll.remove();styk.localization.localization.setPseudo(null);});
  await page.locator('.brand[data-action=menu]').click();
  await page.locator('#menu [data-action=save]').focus();
  await page.evaluate(()=>{window.menuRow=document.activeElement;styk.localization.localization.setPseudo('long');});
  check('Open menu rows update long captions while retaining focus, row and shortcut nodes',await page.evaluate(()=>document.activeElement===menuRow&&menuRow.isConnected&&menuRow.querySelector('span').textContent.includes('［')&&menuRow.querySelector('kbd').textContent==='Ctrl+S'));
  await page.keyboard.press('Escape');
  await page.evaluate(async()=>{
    const {createDialog}=await import('/src/ui/ui-dialog.mjs');
    const {messageError}=await import('/src/localized-error.mjs');
    const {localizedText}=await import('/src/localization-bindings.mjs');
    const body=document.createElement('div');body.style.cssText='max-height:180px;overflow:auto';
    const label=document.createElement('label');localizedText(label,'common.name');
    const input=document.createElement('input');input.type='text';input.dataset.localizationDraft='';input.value='Draft العربية 中文 123.45';input.autofocus=true;
    label.append(input);body.append(label);const spacer=document.createElement('div');spacer.style.height='400px';body.append(spacer);
    window.testDialog=createDialog({title:'Name',titleKey:'common.name',description:'Change name',descriptionKey:'app.renameProject',descriptionParams:{name:'My animation'},body,actions:[{label:'Cancel',labelKey:'common.cancel',cancel:true},{label:'Save',labelKey:'common.save',value:'save',variant:'primary'}]});
    window.ownedError=messageError(new RangeError(), 'errors.exportRequest.chooseASizePreset');
    testDialog.setError(ownedError);
    testDialog.showModal();window.draftInput=input;window.scrollBody=body;input.focus();input.setSelectionRange(2,7);body.scrollTop=33;
    window.dialogTitle=testDialog.element.querySelector('.ui-dialog-title');
  });
  await page.evaluate(()=>styk.localization.localization.setPseudo('rtl'));
  check('RTL changes retained dialog captions without losing draft, selection, focus or scroll',await page.evaluate(()=>document.activeElement===draftInput&&draftInput.value==='Draft العربية 中文 123.45'&&draftInput.selectionStart===2&&draftInput.selectionEnd===7&&scrollBody.scrollTop===33&&dialogTitle===testDialog.element.querySelector('.ui-dialog-title')&&dialogTitle.textContent.includes('اختبار')));
  check('Open dialog errors follow the language while diagnostics retain their English identity',await page.evaluate(()=>testDialog.element.querySelector('.ui-dialog-error').textContent.includes('اختبار')&&ownedError.message==='Choose a size preset.'));
  check('Interface follows RTL and physical canvas and timeline retain LTR coordinates',await page.evaluate(()=>document.documentElement.dir==='rtl'&&getComputedStyle(testDialog.element).direction==='rtl'&&getComputedStyle(document.querySelector('#viewport')).direction==='ltr'&&getComputedStyle(document.querySelector('#timeline')).direction==='ltr'));
  check('Locale changes leave document, undo, selection, animation tick and original chrome nodes intact',await page.evaluate(()=>{const e=styk.editor,b=baseline;return JSON.stringify(e.report)===b.report&&e._undo.length===b.undo&&e.revision===b.revision&&e.tick===b.tick&&e.selectedUid===b.uid&&savedButton===document.querySelector('.titlebar [data-action=save]')&&savedButton.querySelector('svg')===savedIcon;}));
  await page.screenshot({path:path.join(output,'rtl-desktop-dialog.png')});
  await page.setViewportSize({width:390,height:740});
  await page.evaluate(()=>styk.localization.localization.setPseudo('long'));
  check('Long dialog labels fit a narrow viewport without horizontal clipping',await page.evaluate(()=>{const d=testDialog.element,b=d.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1&&[...d.querySelectorAll('.ui-dialog-foot button')].every(x=>x.scrollWidth<=x.clientWidth+1&&x.scrollHeight<=x.clientHeight+1);}));
  await page.screenshot({path:path.join(output,'long-narrow-dialog.png')});
  await page.evaluate(()=>styk.localization.localization.setPseudo(null));
  await page.locator('.ui-dialog-foot button').last().click();
  check('Localized action captions preserve the explicit result value',await page.evaluate(()=>testDialog.result.then(value=>value==='save')));
  await page.setViewportSize({width:1280,height:800});
  await page.evaluate(()=>styk.localization.localization.setPseudo('long'));
  check('Inspector numeric and quick-action captions connect to pseudolocalization',await page.evaluate(()=>document.querySelector('#inspector [data-i18n="inspectorView.scale"]')?.textContent.includes('［')&&![...document.querySelectorAll('[data-i18n]')].some(x=>/^(?:quick|drawing)\.[a-zA-Z]+$/.test(x.textContent.trim()))));
  await page.screenshot({path:path.join(output,'long-editor.png')});
  await page.setViewportSize({width:390,height:740});
  await page.locator('.brand[data-action=menu]').click();
  await page.locator('#menu [data-action=settings]').click();
  for (const pseudo of ['long','rtl']) {
    await page.evaluate(mode=>styk.localization.localization.setPseudo(mode),pseudo);
    check(`${pseudo}: Settings content fits a narrow window`,await page.locator('.styk-settings-content').evaluate(x=>x.scrollWidth<=x.clientWidth+1));
  }
  await page.locator('button[data-tab=animation]').click();
  await page.evaluate(()=>{window.playbackQualitySelect=document.querySelector('[data-setting=playbackQuality]');window.playbackQualityNodes=[...playbackQualitySelect.options];window.playbackQualityValue=playbackQualitySelect.value;});
  check('Playback quality options use the active language after the module was imported in English',await page.evaluate(async()=>{
    const {playbackQualityOptions}=await import('/src/preview-quality.mjs');return playbackQualityNodes.length===5&&playbackQualityNodes.every((option,index)=>option.textContent===styk.localization.t(playbackQualityOptions[index].labelKey));
  }));
  await page.evaluate(()=>styk.localization.localization.setPseudo('long'));
  check('Playback quality captions update their original options without changing the chosen quality',await page.evaluate(async()=>{
    const {playbackQualityOptions}=await import('/src/preview-quality.mjs');return playbackQualitySelect===document.querySelector('[data-setting=playbackQuality]')&&playbackQualitySelect.value===playbackQualityValue
      &&playbackQualityNodes.every((option,index)=>option===playbackQualitySelect.options[index]&&option.textContent===styk.localization.t(playbackQualityOptions[index].labelKey));
  }));
  await page.locator('button[data-tab=interface]').click();
  await page.evaluate(()=>{
    styk.ui.toasts.clear();
    styk.ui.toasts.show({titleKey:'app.restoreUnsavedWork',messageKey:'app.recoveryOffer',messageParams:{name:'My animation',time:{format:'date',value:Date.UTC(2026,0,1)}},timeout:0,actions:[{labelKey:'common.cancel',run(){}},{labelKey:'common.save',run(){}},{labelKey:'common.name',run(){}}]});
    styk.localization.localization.setPseudo('long');
  });
  check('Expanded notification text and actions fit a narrow dialog',await page.locator('.ui-toast').evaluate(x=>x.clientHeight<innerHeight/2&&x.scrollWidth<=x.clientWidth+1&&x.querySelector('.ui-toast-text').clientWidth>80));
  await page.screenshot({path:path.join(output,'long-narrow-settings-notification.png')});
  await page.evaluate(()=>styk.ui.toasts.clear());
  await page.locator('.styk-settings-close').click();
  await page.evaluate(()=>styk.localization.localization.setPseudo(null));
  await page.locator('.titlebar [data-action=export]').click();
  await page.locator('#export-dialog[open]').waitFor();
  await page.locator('#export-resolution').selectOption('custom');
  await page.locator('#export-width').fill('128.');
  await page.evaluate(()=>{window.exportDraft=document.querySelector('#export-width');window.exportName=document.querySelector('#export-name');exportDraft.setSelectionRange(1,3);window.exportScroll=document.querySelector('#export-dialog .ui-dialog-body');exportScroll.scrollTop=23;});
  for (const pseudo of ['long','rtl']) {
    await page.evaluate(mode=>styk.localization.localization.setPseudo(mode),pseudo);
    check(`${pseudo}: Export preserves numeric drafts, selection, control identity and scroll`,await page.evaluate(()=>document.activeElement===exportDraft&&exportDraft.value==='128.'&&exportDraft.selectionStart===1&&exportDraft.selectionEnd===3&&document.querySelector('#export-name')===exportName&&exportScroll.scrollTop===23));
    check(`${pseudo}: Export preset and category captions update and wrap in a narrow window`,await page.evaluate(()=>{const d=document.querySelector('#export-dialog');return d.scrollWidth<=d.clientWidth+1&&[...d.querySelectorAll('.export-preset-label')].every(x=>x.textContent.includes('［')&&getComputedStyle(x).whiteSpace==='normal')&&d.querySelector('[data-category=video]').textContent.includes('［')&&[...d.querySelectorAll('#export-format button')].every(x=>x.scrollWidth<=x.clientWidth+1&&x.scrollHeight<=x.clientHeight+1);}));
  }
  await page.evaluate(()=>styk.localization.localization.setPseudo(null));
  for (const locale of ['ar','he']) {
    await page.evaluate(locale=>styk.localization.setLocale(locale),locale);
    check(`${locale}: export dimensions keep physical width before height`,await page.evaluate(()=>{
      const span=document.querySelector('#export-summary-size'),text=span.firstChild,separator=text.data.indexOf(' × ');
      const end=text.data.indexOf(' px'),range=document.createRange();
      range.setStart(text,0);range.setEnd(text,separator);const width=range.getBoundingClientRect();
      range.setStart(text,separator+3);range.setEnd(text,end);const height=range.getBoundingClientRect();
      return width.width>0&&height.width>0&&width.left<height.left&&getComputedStyle(span).direction==='ltr';
    }));
    check(`${locale}: retained size presets isolate dimensions without changing their selected value`,await page.evaluate(()=>{
      const select=document.querySelector('#export-resolution');return select.value==='custom'&&[...select.options].filter(option=>option.value!=='custom').every(option=>/\u2066[\d]+ × [\d]+\u2069/.test(option.textContent));
    }));
  }
  await page.screenshot({path:path.join(output,'rtl-narrow-export.png')});
  await page.locator('#export-dialog .ui-dialog-close').click();

  await page.setViewportSize({width:1280,height:800});
  const fontEvidence=await page.evaluate(async()=>{
    styk.localization.localization.setPseudo(null);
    const samples={ar:'العربية',he:'עברית','zh-Hans':'中文',ru:'Русский',kk:'Қазақша Ә Ғ Қ Ң Ө Ұ Ү Һ І',el:'Ελληνικά',vi:'Tiếng Việt: ảnh, chuyển động',it:'È già così'};
    const results=[];
    for(const [locale,text] of Object.entries(samples)){
      styk.localization.setLocale(locale);const sample=document.createElement('span');sample.textContent=text;sample.style.font='24px var(--font-ui)';document.body.append(sample);
      await document.fonts.ready;results.push({locale,text,font:getComputedStyle(sample).fontFamily,width:sample.getBoundingClientRect().width,loaded:document.fonts.check('24px '+getComputedStyle(sample).fontFamily,text)});sample.remove();
    }
    styk.localization.setLocale('en');return results;
  });
  check('Representative script samples have loaded fallback fonts and measurable glyphs',fontEvidence.every(x=>x.loaded&&x.width>0));
  await page.evaluate(async()=>{
    const {SupportCenter}=await import('/src/support-center.mjs');
    const {supportErrorMessage}=await import('/src/support-localization.mjs');
    window.supportRoot=document.createElement('section');supportRoot.style.cssText='position:fixed;inset:24px;z-index:9999;background:white;overflow:auto';document.body.append(supportRoot);
    window.supportProbe=new SupportCenter(supportRoot,{api:async path=>path==='/config'?{limits:{fileBytes:8388608}}:{threads:[],nextCursor:null}});
    await supportProbe.start();supportProbe.notice(supportErrorMessage({code:'invalid_message'}),true);
    window.supportDraft=supportRoot.querySelector('[name=title]');supportDraft.value='Unsent draft';supportDraft.focus();supportDraft.setSelectionRange(1,5);
    window.supportCategory=supportRoot.querySelector('[name=category]');supportCategory.value='idea';
    window.supportFrequency=supportRoot.querySelector('[name=frequency]');supportFrequency.value='Every time';
    styk.localization.localization.setPseudo('rtl');
  });
  check('Support notices and options update in place without changing drafts or service values',await page.evaluate(()=>document.activeElement===supportDraft&&supportDraft.value==='Unsent draft'&&supportDraft.selectionStart===1&&supportDraft.selectionEnd===5&&supportCategory.value==='idea'&&supportFrequency.value==='Every time'&&supportCategory.selectedOptions[0].textContent.includes('اختبار')&&supportRoot.querySelector('.sc-notice').textContent.includes('اختبار')));
  const supportBusy=await page.evaluate(()=>{
    const submit=supportRoot.querySelector('[data-create] [type=submit]');const key=submit.getAttribute('data-i18n');
    supportProbe.setBusy(true,{messageKey:'supportCenter.exporting'});styk.localization.localization.setPseudo('long');const changed=submit.textContent.includes('［');supportProbe.setBusy(false);
    return changed&&submit.getAttribute('data-i18n')===key&&submit.textContent.includes('［');
  });
  check('Support busy captions translate and restore the original submit action',supportBusy);
  await page.evaluate(()=>{supportProbe.dispose();supportRoot.remove();styk.localization.localization.setPseudo(null);});
  for (const soundCount of [0,1,3]) {
    await page.evaluate(async count=>{
      const {openExportSheet}=await import('/src/export-sheet.mjs');
      window.soundCountProbe=count;
      window.soundOwnerSheet=openExportSheet({context:{canvasWidth:640,canvasHeight:360,totalFrames:12,fps:24,name:'Sound fixture',soundNames:Array.from({length:count},(_,index)=>index?'Sound '+index:'My sound.wav'),audioClips:Array.from({length:count},()=>({start:0,duration:1})),audioSupported:true},onExport(){}});
      window.soundCaption=soundOwnerSheet.element.querySelector('#export-audio').previousElementSibling;
      window.soundFilename=soundOwnerSheet.element.querySelector('#export-name');soundFilename.focus();soundFilename.value='Artist file';soundFilename.dispatchEvent(new Event('input',{bubbles:true}));soundFilename.setSelectionRange(2,5);
      styk.localization.localization.setPseudo('long');
    },soundCount);
    check(`Export sound caption (${soundCount}) translates counts while retaining authored names and drafts`,await page.evaluate(()=>
      soundCaption===soundOwnerSheet.element.querySelector('#export-audio').previousElementSibling
      &&soundCaption.textContent===(soundCountProbe===1?'My sound.wav':styk.localization.t(soundCountProbe?'exportSheet.soundCount':'exportSheet.includeSound',{count:soundCountProbe}))
      &&document.activeElement===soundFilename&&soundFilename.value==='Artist file'&&soundFilename.selectionStart===2&&soundFilename.selectionEnd===5&&soundOwnerSheet.request.width===640
      &&soundOwnerSheet.element.querySelector('[for="export-width"]').textContent===styk.localization.t('exportSheet.width')));
    await page.evaluate(async()=>{soundOwnerSheet.close();await soundOwnerSheet.closed;styk.localization.localization.setPseudo(null);});
  }
  await page.evaluate(async()=>{
    const {createCommandPalette}=await import('/src/ui/command-palette.mjs'),{interfaceLocalization}=await import('/src/localization.mjs');
    styk.localization.setLocale('en');window.paletteProbe=createCommandPalette({commands:{recent:()=>[],list:()=>[]}});
    window.paletteListeners=interfaceLocalization.listeners.size;paletteProbe.open();paletteProbe.input.value='Artist query';paletteProbe.input.dispatchEvent(new Event('input',{bubbles:true}));paletteProbe.input.setSelectionRange(2,5);
    styk.localization.setLocale('ar');
  });
  check('An English-created command palette refreshes search, accessible names and its empty state while preserving the typed query',await page.evaluate(()=>
    paletteProbe.input.placeholder===styk.localization.t('overlays.palette.placeholder')&&paletteProbe.input.getAttribute('aria-label')===styk.localization.t('overlays.palette.placeholder')
    &&paletteProbe.element.getAttribute('aria-label')===styk.localization.t('overlays.palette.label')&&paletteProbe.element.querySelector('.ui-palette-empty').textContent===styk.localization.t('overlays.palette.empty')
    &&document.activeElement===paletteProbe.input&&paletteProbe.input.value==='Artist query'&&paletteProbe.input.selectionStart===2&&paletteProbe.input.selectionEnd===5));
  await page.evaluate(()=>paletteProbe.close());
  check('Closing the command palette releases its session language listener',await page.evaluate(async()=>{const {interfaceLocalization}=await import('/src/localization.mjs');return interfaceLocalization.listeners.size===paletteListeners;}));
  await page.evaluate(async()=>{
    const {createPopover}=await import('/src/ui/ui-popover.mjs'),{appendLocalized}=await import('/src/localization-bindings.mjs');
    window.popoverAnchor=document.createElement('button');popoverAnchor.textContent='Artist anchor';appendLocalized(document.body,popoverAnchor);
    window.popoverDraft=document.createElement('input');popoverDraft.value='Artist draft';
    window.popoverProbe=createPopover({anchor:popoverAnchor,title:'Layout',titleKey:'layoutPopover.layout',closeLabel:'Close layout',closeLabelKey:'layoutPopover.closeLayout',body:popoverDraft});popoverProbe.show();
    window.popoverHeading=popoverProbe.element.querySelector('.ui-popover-title');window.popoverClose=popoverProbe.element.querySelector('.ui-popover-close');styk.localization.setLocale('he');
  });
  check('Retained popover headings and close captions use owner metadata while retaining the focused draft',await page.evaluate(()=>
    popoverHeading===popoverProbe.element.querySelector('.ui-popover-title')&&popoverClose===popoverProbe.element.querySelector('.ui-popover-close')
    &&popoverHeading.textContent===styk.localization.t('layoutPopover.layout')&&popoverClose.getAttribute('aria-label')===styk.localization.t('layoutPopover.closeLayout')
    &&document.activeElement===popoverDraft&&popoverDraft.value==='Artist draft'));
  await page.evaluate(()=>{popoverProbe.hide();popoverProbe.element.remove();popoverAnchor.remove();paletteProbe.element.remove();});
  await page.evaluate(async()=>{
    const {createToolOptions}=await import('/src/ui/tool-options.mjs'),{appendLocalized}=await import('/src/localization-bindings.mjs');
    styk.localization.setLocale('en');window.toolCaptionProbe=createToolOptions({label:'Tool options',labelKey:'app.toolOptions',descriptors:[
      {id:'rig-mode-test',kind:'select',label:'Drag',labelKey:'app.drag',showLabel:true,description:'Rig edit mode',descriptionKey:'app.rigEditMode',value:'rotate',options:[
        {value:'move',label:'Move joint',labelKey:'app.moveJoint'},{value:'rotate',label:'Rotate branch',labelKey:'app.rotateBranch'}]}]});
    appendLocalized(document.body,toolCaptionProbe.element);window.toolCaptionSelect=toolCaptionProbe.element.querySelector('select');window.toolCaptionOptions=[...toolCaptionSelect.options];toolCaptionSelect.focus();styk.localization.setLocale('ar');
  });
  check('Retained tool selectors translate owner captions while preserving option identity, focus and machine values',await page.evaluate(()=>
    toolCaptionProbe.element.getAttribute('aria-label')===styk.localization.t('app.toolOptions')&&toolCaptionProbe.element.querySelector('.ui-optbar-label').textContent===styk.localization.t('app.drag')
    &&toolCaptionSelect.getAttribute('aria-label')===styk.localization.t('app.rigEditMode')&&document.activeElement===toolCaptionSelect&&toolCaptionSelect.value==='rotate'
    &&toolCaptionOptions.every((option,index)=>option===toolCaptionSelect.options[index]&&option.textContent===styk.localization.t(index?'app.rotateBranch':'app.moveJoint'))));
  await page.evaluate(()=>{toolCaptionProbe.destroy();toolCaptionProbe.element.remove();});
  await page.evaluate(async()=>{
    const {openExportSheet}=await import('/src/export-sheet.mjs');
    styk.localization.setLocale('en');
    window.codecCapabilities={width:640,height:360,formats:[
      {id:'avi',provider:'FFmpeg',supported:true,defaultCodec:'ffv1',codecs:[
        {id:'ffv1',label:'FFV1 (lossless)',displayName:'FFV1',lossless:true,supported:true},
        {id:'rawvideo',label:'Uncompressed RGB',labelKey:'desktop.videoExportService.uncompressedRgb',lossless:true,supported:true}]},
      {id:'webm',provider:'FFmpeg',supported:true,defaultCodec:'vp9',codec:'VP9 with transparency',codecs:[
        {id:'vp9',label:'VP9 with transparency',displayName:'VP9',alpha:true,supported:true}]}]};
    window.codecBytes=JSON.stringify(codecCapabilities);
    window.codecSheet=openExportSheet({context:{canvasWidth:640,canvasHeight:360,totalFrames:12,fps:24,name:'Artist codec fixture'},probe:async()=>codecCapabilities,onExport(){}});
  });
  await page.waitForFunction(()=>codecSheet.states.get('avi').codec==='ffv1');
  await page.evaluate(()=>{
    const type=codecSheet.element.querySelector('#output-format');type.value='export-avi';type.dispatchEvent(new Event('input',{bubbles:true}));
    codecSheet.element.querySelector('#export-encoding-toggle').click();
    window.codecSelect=codecSheet.element.querySelector('#export-avi-codec');window.codecOptions=[...codecSelect.options];
    window.smoothingOptions=[...codecSheet.element.querySelector('#export-smoothing').options];window.sizeOptions=[...codecSheet.element.querySelector('#export-resolution').options];
    window.codecRequest=JSON.stringify(codecSheet.request);codecSelect.focus();styk.localization.setLocale('ar');
  });
  check('Owned native codec option captions refresh in place with the same selection, focus, request and capability data',await page.evaluate(()=>
    codecSelect===codecSheet.element.querySelector('#export-avi-codec')&&codecOptions.every((option,index)=>option===codecSelect.options[index])
    &&codecOptions[0].textContent==='FFV1'+styk.localization.t('exportRequest.lossless')
    &&codecOptions[1].textContent===styk.localization.t('desktop.videoExportService.uncompressedRgb')
    &&codecSelect.value==='ffv1'&&!codecSelect.disabled&&document.activeElement===codecSelect
    &&JSON.stringify(codecSheet.request)===codecRequest&&JSON.stringify(codecCapabilities)===codecBytes));
  check('Export edge options and size captions follow the language in their original option nodes',await page.evaluate(async()=>{
    const {EXPORT_SMOOTHING}=await import('/src/export-sampling.mjs'),{sizePresetChoices}=await import('/src/export-request.mjs');
    const sizes=sizePresetChoices({canvasWidth:640,canvasHeight:360});return smoothingOptions.every((option,index)=>option===codecSheet.element.querySelector('#export-smoothing').options[index]
      &&option.textContent===styk.localization.t(EXPORT_SMOOTHING[index].labelKey)&&option.title===styk.localization.t(EXPORT_SMOOTHING[index].descriptionKey))
      &&sizeOptions.every((option,index)=>option===codecSheet.element.querySelector('#export-resolution').options[index]&&option.textContent===sizes[index].label&&option.title===sizes[index].reason);
  }));
  await page.evaluate(()=>{
    codecSheet.element.querySelector('#export-format [data-category="video"]').click();
    const type=codecSheet.element.querySelector('#output-format');type.value='export-video';type.dispatchEvent(new Event('input',{bubbles:true}));
  });
  check('Native WebM summary localizes the transparency description without inserting a codec request field',await page.evaluate(()=>
    codecSheet.request.format==='webm'&&codecSheet.states.get('webm').codec===undefined
    &&codecSheet.element.querySelector('.export-encoding-summary').textContent.startsWith('VP9 · '+styk.localization.t('exportSheet.transparent'))
    &&!codecSheet.element.querySelector('.export-encoding-summary').textContent.includes('with transparency')));
  check('Export trim slider frame descriptions follow the language while frame numbers remain canonical',await page.evaluate(()=>
    [...codecSheet.element.querySelectorAll('.ui-range-handle')].every(control=>control.getAttribute('aria-valuetext')===styk.localization.t('filmstrip.card',{frame:Number(control.getAttribute('aria-valuenow'))}))));
  check('RTL export keeps actual numeric drafts and frame chronology left to right',await page.evaluate(()=>{
    const root=codecSheet.element,fields=[...root.querySelectorAll('input[inputmode=numeric],input[inputmode=decimal]')],strip=root.querySelector('.ui-range-strip');
    return fields.length>=6&&fields.every(field=>getComputedStyle(field).direction==='ltr')&&getComputedStyle(strip).direction==='ltr'
      &&strip.querySelector('[data-edge=start]').getBoundingClientRect().left<strip.querySelector('[data-edge=end]').getBoundingClientRect().left;
  }));
  await page.evaluate(async()=>{codecSheet.close();await codecSheet.closed;styk.localization.setLocale('en');});
  await page.evaluate(async()=>{
    const {UserLibrary}=await import('/src/user-library.mjs');
    const {appendLocalized}=await import('/src/localization-bindings.mjs');
    window.libraryData={id:'artist-asset',source:'public',kind:'figure',name:'My character.stkz',author:'Artist العربية',description:'An authored description'};
    window.libraryDataBefore=JSON.stringify(libraryData);
    window.publicCard=UserLibrary.prototype.card.call({},libraryData);
    window.localClipCard=UserLibrary.prototype.card.call({},{path:'My clip.stykmov',kind:'movieclip',name:'My clip.stykmov'});
    appendLocalized(document.body,publicCard);appendLocalized(document.body,localClipCard);
    window.libraryIcon=publicCard.querySelector('svg');publicCard.focus();
    styk.localization.localization.setPseudo('rtl');
  });
  check('Public library author grammar and movieclip hover instructions follow the locale while preserving authored data, focus and icons',await page.evaluate(()=>
    publicCard.title===styk.localization.t('userLibrary.publicAssetByAuthor',{name:libraryData.name,author:libraryData.author,description:': '+libraryData.description})
    &&localClipCard.title===styk.localization.t('userLibrary.nameDoubleClickToInsertOrDragOntoThe',{name:'My clip.stykmov',value1:{messageKey:'userLibrary.hoverToPlay2'}})
    &&publicCard.querySelector('.library-name').textContent==='My character.stkz'&&publicCard.dataset.publicId==='artist-asset'
    &&JSON.stringify(libraryData)===libraryDataBefore&&document.activeElement===publicCard&&publicCard.querySelector('svg')===libraryIcon));
  await page.evaluate(()=>{publicCard.remove();localClipCard.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {createDockKeyboard}=await import('/src/shell/dock-keyboard.mjs');
    window.dockMoves=[];window.dockSpeech=[];
    window.dockDraft=document.createElement('input');dockDraft.value='Panel draft';document.body.append(dockDraft);dockDraft.focus();dockDraft.setSelectionRange(1,4);
    window.dockProbe=createDockKeyboard({host:{registry:new Map([['properties',{title:'Properties',titleKey:'shell.panel.properties'}]]),canPlace:()=>true,presentation:()=> 'docked',solution:{panels:{properties:{side:'right'}}},workspace:{float:id=>dockMoves.push(['float',id]),dock:(id,target)=>dockMoves.push(['dock',id,target])},showPanel(){}},announce:text=>dockSpeech.push(text)});
    dockProbe.startMove('properties');window.dockCaption=document.querySelector('.shell-drop .ui-drop-label');
    styk.localization.localization.setPseudo('rtl');
  });
  check('Keyboard panel-move preview follows RTL in its original caption without moving the panel or disturbing focus and drafts',await page.evaluate(()=>
    dockCaption.textContent===styk.localization.t('dockKeyboard.floatHere')&&dockMoves.length===0
    &&document.activeElement===dockDraft&&dockDraft.value==='Panel draft'&&dockDraft.selectionStart===1&&dockDraft.selectionEnd===4));
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})));
  check('Keyboard movement keeps physical arrow choices and announces the current localized placement',await page.evaluate(()=>
    dockCaption===document.querySelector('.shell-drop .ui-drop-label')&&dockProbe.moving.target==='left'
    &&dockCaption.textContent===styk.localization.t('dockKeyboard.dockLeft')&&dockSpeech.at(-1)===styk.localization.t('dockKeyboard.dockLeft')));
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
  check('Keyboard placement preserves the canonical panel and side while announcing its translated title',await page.evaluate(()=>
    JSON.stringify(dockMoves)===JSON.stringify([['dock','properties','left']])
    &&dockSpeech.at(-1)===styk.localization.t('dockKeyboard.panelLocation',{title:{messageKey:'shell.panel.properties'},place:{messageKey:'dockKeyboard.dockLeft'}})));
  await page.evaluate(()=>{dockProbe.destroy();dockDraft.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {VfwExportControls}=await import('/src/vfw-export-controls.mjs');const {appendLocalized}=await import('/src/localization-bindings.mjs');
    window.vfwDesktopBefore=window.stykDesktop;
    window.vfwCapabilities={platform:'win32',codecs:[{id:'vfw:x64:00000000',label:'Artist codec (64-bit)',fourcc:'DIB ',provider:'Windows VFW',supported:false,reason:'Original English capability reason',reasonKey:'vfwExportControls.codecDoesNotAcceptFrames',reasonParams:{width:160,height:90}}],reason:'Original English check reason',reasonKey:'vfwExportControls.codecCheckFailure',reasonParams:{details:{format:'list',value:[{messageKey:'vfwExportControls.invalidCodecTable',messageParams:{arch:'x86'}},'External driver detail'],options:{type:'unit'}}}};
    window.stykDesktop={getVfwCapabilities:async()=>structuredClone(vfwCapabilities)};
    window.vfwDialog=document.createElement('dialog');appendLocalized(document.body,vfwDialog);vfwDialog.showModal();
    window.vfwProbe=new VfwExportControls({container:vfwDialog,dialog:vfwDialog,getDimensions:()=>({width:160,height:90})});
  });
  await page.waitForFunction(()=>vfwProbe.loadedKey==='160:90'&&vfwProbe.status.getAttribute('data-i18n')==='vfwExportControls.codecCheckFailure');
  await page.evaluate(()=>{window.vfwStatus=vfwProbe.status;window.vfwOption=vfwProbe.select.options[0];styk.localization.localization.setPseudo('rtl');});
  check('Owned Windows codec reasons translate in retained controls while external driver details, codec names and IDs remain raw',await page.evaluate(()=>
    vfwStatus===vfwProbe.status&&vfwStatus.textContent===styk.localization.t(vfwCapabilities.reasonKey,vfwCapabilities.reasonParams)
    &&vfwStatus.textContent.includes('External driver detail')&&vfwOption===vfwProbe.select.options[0]
    &&vfwOption.title===styk.localization.t('vfwExportControls.codecDoesNotAcceptFrames',{width:160,height:90})
    &&vfwOption.textContent==='Artist codec (64-bit)'&&vfwOption.value==='vfw:x64:00000000'&&vfwOption.disabled));
  await page.evaluate(()=>{vfwProbe.dispose();vfwDialog.close();vfwDialog.remove();window.stykDesktop=vfwDesktopBefore;styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const { pageEditor }=await import('/tests/support/page-editor.mjs');const {emptyDocument}=await import('/src/demo.mjs');const {vfxProperty}=await import('/src/vfx.mjs');
    const {openVfxChannelMenu}=await import('/src/vfx-key-channel-menu.mjs');
    window.effectEditor=pageEditor({demo:false}).load(emptyDocument());const id=effectEditor.addVfxClip({kind:'scene'},'glow');const clip=effectEditor.getVfxClips()[0],effect=clip.effects[0];
    for(const parameter of ['radius','intensity'])effectEditor.setVfxClipParameter(id,effect.id,parameter,1,{key:true,tick:0});
    window.effectBytes=JSON.stringify(effectEditor.report);window.effectUndo=effectEditor._undo.length;
    window.effectAnchor=document.createElement('button');effectAnchor.textContent='Effect keys';document.body.append(effectAnchor);window.closeEffects=openVfxChannelMenu(effectEditor,effectEditor.getVfxClips()[0],effectAnchor);
    window.effectInput=document.querySelector('.vfx-channel-menu [data-channel-property]');effectInput.focus();window.effectProperty=effectInput.dataset.channelProperty;styk.localization.localization.setPseudo('long');
  });
  check('Effect-channel picker retains focus, key IDs and document history while captions change',await page.evaluate(()=>document.activeElement===effectInput&&effectInput.dataset.channelProperty===effectProperty&&effectInput.closest('label').textContent.includes('［')&&JSON.stringify(effectEditor.report)===effectBytes&&effectEditor._undo.length===effectUndo));
  await page.evaluate(()=>{closeEffects();effectAnchor.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const { pageEditor }=await import('/tests/support/page-editor.mjs');const {createDemo}=await import('/src/demo.mjs');
    const {rigSections}=await import('/src/rig-controls.mjs');const {renderInspector,renderRow}=await import('/src/inspector-kit.mjs');
    const {PropertyControls}=await import('/src/property-controls.mjs');const {appendLocalized,localizedMarkup}=await import('/src/localization-bindings.mjs');
    window.rigCaptionEditor=pageEditor({demo:false}).load(createDemo());rigCaptionEditor.select(1,2);
    const weighted=rigCaptionEditor.addWeightedJoint(0,[{joint:rigCaptionEditor.figure.segments[0].segment_id,weight:.5}]);
    rigCaptionEditor.select(1,rigCaptionEditor.figure.segments.findIndex(segment=>segment.segment_id===weighted.segment_id));
    window.rigCaptionProbe=document.createElement('div');rigCaptionProbe.style.cssText='position:fixed;top:40px;right:10px;width:400px;max-height:600px;overflow:auto;background:white;z-index:10';appendLocalized(document.body,rigCaptionProbe);
    localizedMarkup(rigCaptionProbe,renderInspector({kind:'joint',sections:rigSections(rigCaptionEditor)})+[
      {kind:'number',id:'localized-validation',key:'test_value',label:'Weight',labelKey:'rigControls.weight',value:4,min:0,max:10},
      {kind:'stepper',id:'localized-stepper',label:'Chain',labelKey:'ikView.chain',value:2,min:1,max:3},
      {kind:'slider',id:'localized-slider',label:'Opacity',labelKey:'inspectorView.opacity',value:40,unit:'%'},
      {kind:'color',id:'localized-color',label:'Segment color',labelKey:'inspectorView.segmentColor',value:'#ff0000',picker:'paint'},
      {kind:'text',id:'localized-name',label:'Name',labelKey:'common.name',value:'Artist name'},
      {kind:'segmented',name:'localized-choice',label:'Angle',labelKey:'rigControls.angle',value:'artist',options:[
        {value:'artist',label:'Angle',labelKey:'rigControls.angle',iconOnly:true,icon:'origin',tip:'Artist control note'},
        {value:'joint',label:'Joint',labelKey:'rigControls.joint',iconOnly:true,icon:'origin'},
      ]},
    ].map(row=>renderRow(row)).join(''));
    window.rigCaptionNodes=[...rigCaptionProbe.querySelectorAll('input,select,button')];window.rigCaptionBytes=JSON.stringify(rigCaptionEditor.report);window.rigCaptionUndo=rigCaptionEditor._undo.length;
    window.validationEdits=[];window.validationControls=new PropertyControls(rigCaptionProbe,{preview:payload=>validationEdits.push(payload.value)});
    window.validationInput=rigCaptionProbe.querySelector('#localized-validation');validationInput.focus();validationInput.value='12';validationInput.dispatchEvent(new Event('input',{bubbles:true}));
    styk.localization.localization.setPseudo('rtl');
  });
  check('Rig and inspector factories retain accessible labels, option values, authored names and drafts during language changes',await page.evaluate(()=>{
    const t=(key,params)=>styk.localization.t(key,params),probe=rigCaptionProbe;
    return rigCaptionNodes.every((node,index)=>probe.querySelectorAll('input,select,button')[index]===node)
      &&document.activeElement===validationInput&&validationInput.value==='12'&&validationEdits.length===0
      &&probe.querySelector('#rig-weighted-weight-0').getAttribute('aria-label')===t('rigControls.anchorWeight',{value:1})
      &&probe.querySelector('#rig-weighted-joint-0').getAttribute('aria-label')===t('rigControls.anchor',{value:1})
      &&probe.querySelector('#localized-stepper').getAttribute('aria-label')===t('ikView.chain')
      &&probe.querySelector('#localized-stepper').closest('.ui-stepper').querySelector('[data-kit-step="-1"]').getAttribute('aria-label')===t('inspector.decrease',{name:{messageKey:'ikView.chain'}})
      &&probe.querySelector('#localized-slider').getAttribute('aria-label')===t('inspectorView.opacity')
      &&probe.querySelector('#localized-color').getAttribute('aria-label')===t('inspectorView.segmentColor')
      &&probe.querySelector('#localized-name').getAttribute('aria-label')===t('common.name')&&probe.querySelector('#localized-name').value==='Artist name'
      &&probe.querySelector('[name="localized-choice"][value="artist"]').closest('label').dataset.tooltip==='Artist control note'
      &&probe.querySelector('[name="localized-choice"][value="joint"]').closest('label').dataset.tooltip===t('rigControls.joint')
      &&JSON.stringify(rigCaptionEditor.report)===rigCaptionBytes&&rigCaptionEditor._undo.length===rigCaptionUndo;
  }));
  check('An invalid finite numeric draft keeps its translated range error and leaves the model untouched',await page.evaluate(()=>validationInput.validationMessage===styk.localization.t('propertyControls.enterValueBetween',{min:0,max:10})&&validationInput.getAttribute('aria-invalid')==='true'&&validationEdits.length===0));
  await page.evaluate(()=>{
    validationInput.value='6';validationInput.dispatchEvent(new Event('input',{bubbles:true}));validationControls.cancel();styk.localization.localization.setPseudo('long');
  });
  check('Valid numeric input and cancellation clear the error binding so a later language change cannot revive it',await page.evaluate(()=>validationInput.validationMessage===''&&!validationInput.hasAttribute('data-i18n-validation-message')&&!validationInput.hasAttribute('aria-invalid')&&validationInput.value==='4'&&validationEdits.join(',')==='6'));
  await page.evaluate(()=>{
    validationInput.min='';validationInput.focus();validationInput.value='12';validationInput.dispatchEvent(new Event('input',{bubbles:true}));styk.localization.localization.setPseudo('rtl');
  });
  check('One-sided numeric bounds retain their original infinity value in translated validation',await page.evaluate(()=>validationInput.validationMessage===styk.localization.t('propertyControls.enterValueBetween',{min:-Infinity,max:10})&&validationInput.value==='12'));
  await page.evaluate(()=>{validationControls.destroy();rigCaptionProbe.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const { pageEditor }=await import('/tests/support/page-editor.mjs');const {emptyDocument}=await import('/src/demo.mjs');const {Timeline}=await import("/src/layer-timeline.mjs");
    const {appendLocalized}=await import('/src/localization-bindings.mjs');
    window.organizationEditor=pageEditor({demo:false,layerTimeline:true}).load(emptyDocument());const artist=organizationEditor.createLayer('Artist layer',{activate:false});
    window.organizationHost=document.createElement('div');organizationHost.className='workspace';organizationHost.dataset.mode='animate';organizationHost.style.cssText='position:fixed;top:40px;right:10px;width:760px;height:300px;background:white;z-index:10';appendLocalized(document.body,organizationHost);
    window.organizationTimeline=new Timeline(organizationHost,organizationEditor);organizationTimeline.selectedLayers=new Set([artist.id]);organizationTimeline.selectedTrackId=artist.id;organizationTimeline.focusSelectedLayers();organizationTimeline.setLayerFilter('Artist');
    window.organizationBytes=JSON.stringify(organizationEditor.report);window.organizationUndo=organizationEditor._undo.length;window.organizationButton=organizationTimeline.newLayerButton;window.organizationIcon=organizationButton.firstElementChild;
    organizationTimeline._syncOrganization();organizationTimeline.layerSearch.focus();
    if(document.activeElement!==organizationTimeline.layerSearch)throw new Error('Timeline fixture search must be visible and focused before switching language.');
    styk.localization.localization.setPseudo('long');organizationTimeline._syncOrganization();
  });
  const organizationState=await page.evaluate(()=>{
    const t=(key,params)=>styk.localization.t(key,params),timeline=organizationTimeline;
    return {button:timeline.newLayerButton===organizationButton,icon:organizationButton.firstElementChild===organizationIcon,newLayer:organizationButton.getAttribute('aria-label')===t('timeline.newLayer'),
      count:timeline.layerSearch.title===t('timelineOrganization.visibleLayers',{visible:timeline.visibleLayerCount,count:organizationEditor.report._styk.layers.order.length}),
      showAll:timeline.focusLayersButton.querySelector('.ui-label').textContent===t('timelineOrganization.showAll'),
      focus:document.activeElement===timeline.layerSearch,draft:timeline.layerSearch.value==='Artist',
      document:JSON.stringify(organizationEditor.report)===organizationBytes,history:organizationEditor._undo.length===organizationUndo};
  });
  assert.ok(Object.values(organizationState).every(Boolean),JSON.stringify(organizationState));
  check('Timeline projection refresh keeps translated layer counts and actions without changing layer order or the search draft',true);
  await page.evaluate(()=>{organizationHost.dataset.mode='draw';organizationTimeline._syncOrganization();styk.localization.localization.setPseudo('rtl');organizationTimeline._syncOrganization();});
  check('Draw workspace refresh retains the translated drawing-layer action in RTL',await page.evaluate(()=>organizationTimeline.newLayerButton.getAttribute('aria-label')===styk.localization.t('timeline.newDrawingLayer')&&organizationTimeline.newLayerButton.firstElementChild===organizationIcon));
  await page.evaluate(()=>{organizationTimeline.destroy();organizationHost.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const { pageEditor }=await import('/tests/support/page-editor.mjs');const {createDemo}=await import('/src/demo.mjs');
    const {vfxPresetStore}=await import('/src/vfx-user-presets.mjs');const {appendLocalized}=await import('/src/localization-bindings.mjs');
    await vfxPresetStore.load();window.vfxPresetsBefore=vfxPresetStore.presets;
    vfxPresetStore.presets=[{id:'localization-artist',name:'Artist preset',effects:[{id:'artist-glow',type:'glow',params:{}}],keys:{'artist-glow.radius':[]}}];
    styk.localization.localization.setPseudo('rtl');
    // Import under a different initial language: display captions must never
    // become the canonical category values used to sort the catalogue.
    const {VfxInspector}=await import('/src/vfx-inspector.mjs?initial-language-review');
    window.vfxCaptionEditor=pageEditor({demo:false}).load(createDemo());vfxCaptionEditor.select(1);vfxCaptionEditor.figure.name='Artist figure';
    window.vfxCaptionRoot=document.createElement('div');vfxCaptionRoot.style.cssText='position:fixed;top:40px;right:10px;width:400px;height:500px;background:white;z-index:10';appendLocalized(document.body,vfxCaptionRoot);
    window.vfxCaptionProbe=new VfxInspector({editor:vfxCaptionEditor,root:vfxCaptionRoot,beforeEdit(){},onChange(){},onError(error){throw error;}});
    vfxCaptionProbe.visible=true;vfxCaptionProbe.sync();
    window.vfxCaptionBytes=JSON.stringify(vfxCaptionEditor.report);window.vfxCaptionUndo=vfxCaptionEditor._undo.length;
    window.vfxCaptionAnchor=vfxCaptionRoot.querySelector('[data-vfx-action=add]');vfxCaptionProbe.openPopup(vfxCaptionAnchor,'add');
  });
  check('A non-English initial language preserves the canonical generated-effects catalogue order',await page.evaluate(async()=>{
    const {categoryMessages}=await import('/src/vfx-localization.mjs');return vfxCaptionProbe.popup.querySelector('.vfx-catalog-results h3').getAttribute('data-i18n')===categoryMessages.Generate;
  }));
  await page.evaluate(()=>{
    window.vfxCaptionSearch=vfxCaptionProbe.popup.querySelector('input');vfxCaptionSearch.value='Unsubmitted search';
    window.vfxCaptionHeading=vfxCaptionRoot.querySelector('.ui-target-name');styk.localization.localization.setPseudo('long');
  });
  check('VFX catalogue and suggestion captions update in place while the raw figure name and search draft stay intact',await page.evaluate(()=>
    document.activeElement===vfxCaptionSearch&&vfxCaptionSearch.value==='Unsubmitted search'
    &&vfxCaptionSearch.getAttribute('aria-label')===styk.localization.t('vfxInspector.searchEffects')&&vfxCaptionSearch.placeholder===styk.localization.t('vfxInspector.searchEffects')
    &&vfxCaptionRoot.querySelector('.ui-target-name')===vfxCaptionHeading&&vfxCaptionHeading.textContent==='Artist figure'
    &&[...vfxCaptionRoot.querySelectorAll('.vfx-suggestion-meta')].every(node=>node.textContent.includes('［'))
    &&JSON.stringify(vfxCaptionEditor.report)===vfxCaptionBytes&&vfxCaptionEditor._undo.length===vfxCaptionUndo));
  await page.evaluate(()=>{vfxCaptionProbe.openPopup(vfxCaptionAnchor,'presets');window.artistPresetCard=vfxCaptionProbe.popup.querySelector('[data-choice="mine:localization-artist"]');window.artistPresetSummary=artistPresetCard.querySelector('small');styk.localization.localization.setPseudo('rtl');});
  check('My preset summaries retain nested effect translations and raw user names without changing preset IDs or document history',await page.evaluate(async()=>{
    const {presetSummaryMessage}=await import('/src/vfx-preset-ui.mjs');const {vfxPresetStore}=await import('/src/vfx-user-presets.mjs');const summary=presetSummaryMessage(vfxPresetStore.presets[0]);
    return artistPresetCard===vfxCaptionProbe.popup.querySelector('[data-choice="mine:localization-artist"]')&&artistPresetCard.querySelector('.vfx-my-preset-text>span').textContent==='Artist preset'
      &&artistPresetSummary===artistPresetCard.querySelector('small')&&artistPresetSummary.textContent===styk.localization.t(summary.messageKey,summary.messageParams)
      &&JSON.stringify(vfxCaptionEditor.report)===vfxCaptionBytes&&vfxCaptionEditor._undo.length===vfxCaptionUndo;
  }));
  await page.evaluate(async()=>{vfxCaptionProbe.destroy();vfxCaptionRoot.remove();const {vfxPresetStore}=await import('/src/vfx-user-presets.mjs');vfxPresetStore.presets=vfxPresetsBefore;styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {BackgroundDialog}=await import('/src/background-dialog.mjs');
    const {appendLocalized}=await import('/src/localization-bindings.mjs');
    window.backgroundCaptionReport={canvas_width:960,canvas_height:540,backgrounds:[
      {background_id:11,kind:3,name:'',x1:.1,y1:.2,x2:.7,y2:.4,color_a:0x80443322,color_b:0xffeeddcc},
      {background_id:12,kind:4,name:'Artist radial',x1:.5,y1:.5,x2:0,y2:.7,color_a:0xff443322,color_b:0xffeeddcc},
    ]};
    window.backgroundCaptionBytes=JSON.stringify(backgroundCaptionReport);
    window.backgroundCaptionDialog=document.createElement('dialog');window.backgroundCaptionContent=document.createElement('div');
    backgroundCaptionDialog.append(backgroundCaptionContent);appendLocalized(document.body,backgroundCaptionDialog);
    window.backgroundCaptionProbe=new BackgroundDialog({dialog:backgroundCaptionDialog,content:backgroundCaptionContent,onError(error){throw error;}});
    backgroundCaptionProbe.open({report:backgroundCaptionReport,frame:{background_id:11},onUse(){throw new Error('Unexpected application');},onCreate(){throw new Error('Unexpected application');}});
    window.backgroundCaptionOption=backgroundCaptionProbe.$('background-library').querySelector('[value="11"]');
    window.backgroundCaptionTrigger=backgroundCaptionProbe.paintTrigger;
    backgroundCaptionProbe.select(12);window.backgroundCaptionDraft=backgroundCaptionProbe.$('background-name');backgroundCaptionDraft.value='Unsubmitted artist name';backgroundCaptionDraft.focus();
    styk.localization.localization.setPseudo('rtl');
  });
  check('Background library selection refreshes retained paint and coordinate captions while keeping raw names and drafts',await page.evaluate(()=>{
    const t=(key,params)=>styk.localization.t(key,params);
    return backgroundCaptionTrigger===backgroundCaptionProbe.paintTrigger
      &&backgroundCaptionTrigger.textContent===t('backgroundDialog.radialGradient')
      &&backgroundCaptionContent.querySelector('[data-bg-coordinate=x1]').textContent===t('backgroundDialog.centerXPx')
      &&backgroundCaptionOption.textContent===t('builderOutliner.partNumber',{kind:{messageKey:'backgroundDialog.background'},id:11})
      &&backgroundCaptionProbe.$('background-library').querySelector('[value="12"]').textContent==='Artist radial'
      &&document.activeElement===backgroundCaptionDraft&&backgroundCaptionDraft.value==='Unsubmitted artist name'
      &&JSON.stringify(backgroundCaptionReport)===backgroundCaptionBytes;
  }));
  await page.evaluate(()=>{backgroundCaptionProbe.select(11);styk.localization.localization.setPseudo('long');});
  check('Selecting a linear fill changes the caption binding without reviving radial text or changing the source background',await page.evaluate(()=>
    backgroundCaptionTrigger.textContent===styk.localization.t('backgroundDialog.linearGradient')
    &&backgroundCaptionContent.querySelector('[data-bg-coordinate=x1]').textContent===styk.localization.t('backgroundDialog.startXPx')
    &&JSON.stringify(backgroundCaptionReport)===backgroundCaptionBytes));
  await page.evaluate(()=>{backgroundCaptionDialog.close();backgroundCaptionDialog.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const { pageEditor }=await import('/tests/support/page-editor.mjs');const {createDemo}=await import('/src/demo.mjs');const {openRigTest}=await import('/src/rig-test-ui.mjs');
    const {appendLocalized,localizedMarkup}=await import('/src/localization-bindings.mjs');
    window.rigOptionEditor=pageEditor({demo:false}).load(createDemo());rigOptionEditor.select(1,0);
    rigOptionEditor.figure.segments[0].name='';rigOptionEditor.figure.segments[1].name='Artist control';
    window.rigOptionBytes=JSON.stringify(rigOptionEditor.report);window.rigOptionUndo=rigOptionEditor._undo.length;
    window.rigOptionDialog=document.createElement('dialog');appendLocalized(document.body,rigOptionDialog);
    window.rigOptionProbe=openRigTest({editor:rigOptionEditor,showDialog(title,html){localizedMarkup(rigOptionDialog,html);rigOptionDialog.showModal();}},rigOptionEditor.serialize());
    window.rigOption=document.querySelector('#rig-test-joint option[data-i18n="builderSurfaceUi.jointNumber"]');
    window.rigOptionId=rigOption.value;styk.localization.localization.setPseudo('rtl');
  });
  check('Native rig-test options retain their generated joint captions through real SELECT parsing and locale changes',await page.evaluate(()=>
    rigOption===document.querySelector('#rig-test-joint option[data-i18n="builderSurfaceUi.jointNumber"]')
    &&rigOption.textContent===styk.localization.t('builderSurfaceUi.jointNumber',{id:Number(rigOptionId)})
    &&rigOption.value===rigOptionId&&document.querySelector('#rig-test-joint option:not([data-i18n])').textContent==='Artist control'
    &&JSON.stringify(rigOptionEditor.report)===rigOptionBytes&&rigOptionEditor._undo.length===rigOptionUndo));
  await page.evaluate(()=>{rigOptionProbe.dispose();rigOptionDialog.close();rigOptionDialog.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {timelineTouchMethods}=await import('/src/touch/timeline-scrubber.mjs');const {appendLocalized}=await import('/src/localization-bindings.mjs');
    window.touchCaptionRoot=document.createElement('div');appendLocalized(document.body,touchCaptionRoot);
    window.touchCaptionProbe={...timelineTouchMethods,events:new AbortController(),header:{setActions(bar){appendLocalized(touchCaptionRoot,bar);}}};
    touchCaptionProbe._mountTouchActions();window.touchCaptionNodes=[...touchCaptionProbe.touchButtons.values()].map(button=>[button,...button.children]);
    styk.localization.localization.setPseudo('rtl');
  });
  check('Touch frame actions consume their message metadata instead of frozen English captions, preserving icons and action IDs',await page.evaluate(()=>{
    const keys={done:'common.done',key:'timelineScrubber.addKey',shorter:'timelineScrubber.shorter',longer:'timelineScrubber.longer',left:'timelineScrubber.earlier',right:'timelineScrubber.later',copy:'common.copy',cut:'common.cut',paste:'common.paste',delete:'common.delete',easing:'timelineScrubber.easing',select:'timelineScrubber.select',more:'timelineScrubber.more'};
    return [...touchCaptionProbe.touchButtons].every(([id,button],index)=>button.lastChild.textContent===styk.localization.t(keys[id])
      &&button.getAttribute('aria-label')===styk.localization.t(keys[id])&&button.dataset.touchAction===id
      &&touchCaptionNodes[index].every((node,i)=>i===0?node===button:node===button.children[i-1]));
  }));
  await page.evaluate(()=>{
    touchCaptionProbe.start=1;touchCaptionProbe.end=1;touchCaptionProbe.ids=[];touchCaptionProbe.editor={getLayer(){throw new Error('No selected layers');}};
    touchCaptionProbe._touchKeyState=()=>({layer:{id:'artist-layer'},here:true,exposure:{start:1,end:3}});
    touchCaptionProbe._syncTouchActions();styk.localization.localization.setPseudo('long');
  });
  check('The touch key action retains its current removal caption and description without re-running editor commands',await page.evaluate(()=>{
    const button=touchCaptionProbe.touchButtons.get('key');
    return button.lastChild.textContent===styk.localization.t('timelineScrubber.remove')
      &&button.getAttribute('aria-label')===styk.localization.t('timelineScrubber.removeKey')
      &&button.dataset.tooltip===styk.localization.t('timelineScrubber.removeKey')&&button.dataset.touchAction==='key';
  }));
  await page.evaluate(()=>{touchCaptionProbe.events.abort();touchCaptionRoot.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const { pageEditor }=await import('/tests/support/page-editor.mjs');const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {construction}=await import('/src/rig-examples-3d.mjs');
    const {spatialSections,installSpatialControls}=await import('/src/spatial-controls.mjs');const {renderInspector}=await import('/src/inspector-kit.mjs');
    const {appendLocalized,localizedMarkup}=await import('/src/localization-bindings.mjs');
    const q=construction();q.add(0,0,0,'Figure rotation');
    const bone=(parent,origin,tip,name)=>{const turn=q.add(0,0,0,name+' turn'),pitch=q.add(0,0,0,name+' tilt'),v=tip.map((n,i)=>n-origin[i]);return q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,rig:{spatial:{parent,origin,tip,turn,pitch}}});};
    const chest=bone(0,[0,0,0],[0,40,0],'Chest');bone(chest,[0,40,0],[10,60,0],'Artist hair');const unnamed=bone(chest,[0,40,0],[-10,60,0],'');
    const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]};
    window.spatialCaptionEditor=pageEditor({demo:false}).load({...emptyDocument(),figure_types:[figure],keyframes:[createFrame([createObject(figure,1,200,100)])]});
    spatialCaptionEditor.select(1,q.segments.findIndex(segment=>segment.segment_id===chest));
    window.spatialCaptionBytes=JSON.stringify(spatialCaptionEditor.report);window.spatialCaptionUndo=spatialCaptionEditor._undo.length;
    window.spatialCaptionRoot=document.createElement('div');spatialCaptionRoot.style.cssText='position:fixed;top:24px;right:24px;width:440px;height:640px;overflow:auto;background:white;z-index:10';appendLocalized(document.body,spatialCaptionRoot);
    const refresh=()=>localizedMarkup(spatialCaptionRoot,renderInspector({kind:'spatial-rig',sections:spatialSections(spatialCaptionEditor).map(section=>section.id==='spatial-exact'?{...section,open:true}:section)}));
    refresh();installSpatialControls({editor:spatialCaptionEditor,root:spatialCaptionRoot,refresh,guard:fn=>fn});
    spatialCaptionRoot.querySelector('[data-spatial-mode=rotate]').click();
    window.spatialCaptionNodes=[...spatialCaptionRoot.querySelectorAll('input,select,button')];
    window.spatialCaptionDraft=spatialCaptionRoot.querySelector('#spatial-pitch-number');spatialCaptionDraft.value='17';spatialCaptionDraft.focus();
    window.spatialCaptionOption=spatialCaptionRoot.querySelector('#spatial-joint option[data-i18n="builderSurfaceUi.jointNumber"]');window.spatialCaptionId=unnamed;
    styk.localization.localization.setPseudo('rtl');
  });
  check('Spatial rig captions and nested numeric descriptions translate in retained controls while native joints, names and drafts remain intact',await page.evaluate(()=>{
    const t=(key,params)=>styk.localization.t(key,params),root=spatialCaptionRoot;
    return spatialCaptionNodes.every((node,index)=>node===root.querySelectorAll('input,select,button')[index])
      &&document.activeElement===spatialCaptionDraft&&spatialCaptionDraft.value==='17'
      &&spatialCaptionDraft.getAttribute('aria-label')===t('spatialControls.degrees',{label:{messageKey:'spatialControls.tilt'}})
      &&root.querySelector('#spatial-camera-distance').getAttribute('aria-label')===t('spatialControls.value',{label:{messageKey:'spatialControls.distance'}})
      &&root.querySelector('[data-spatial-mode=rotate]').textContent.trim()===t('spatialControls.rotate')
      &&root.querySelector('[data-spatial-select="-1"]').textContent===t('spatialControls.moveFigure')
      &&spatialCaptionOption.textContent===t('builderSurfaceUi.jointNumber',{id:spatialCaptionId})
      &&root.querySelector('#spatial-joint').selectedOptions[0].textContent==='Chest'
      &&[...root.querySelectorAll('#spatial-joint option')].some(option=>option.textContent==='Artist hair')
      &&JSON.stringify(spatialCaptionEditor.report)===spatialCaptionBytes&&spatialCaptionEditor._undo.length===spatialCaptionUndo;
  }));
  await page.evaluate(()=>{spatialCaptionRoot.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(()=>{
    styk.actions['layout-menu']();
    window.layoutCaptionRoot=document.querySelector('#layout-popover');
    window.layoutCaptionControls=[...layoutCaptionRoot.querySelectorAll('select')];
    window.layoutCaptionOptions=layoutCaptionControls.flatMap(select=>[...select.options]);
    window.layoutCaptionValues=layoutCaptionControls.map(select=>select.value);
    window.layoutCaptionDraft=layoutCaptionRoot.querySelector('[data-layout-position=vfx]');layoutCaptionDraft.focus();
    window.layoutCaptionBytes=JSON.stringify(styk.editor.report);window.layoutCaptionUndo=styk.editor._undo.length;
    styk.localization.localization.setPseudo('rtl');
  });
  check('Layout position captions and retained options use actual catalog keys without losing focus, selection or authored data',await page.evaluate(()=>{
    const root=layoutCaptionRoot,t=(key,params)=>styk.localization.t(key,params);
    return layoutCaptionControls.every((select,index)=>select===root.querySelectorAll('select')[index]&&select.value===layoutCaptionValues[index])
      &&layoutCaptionOptions.every(option=>option===option.parentElement.options[option.index]&&option.textContent===t(option.dataset.i18n))
      &&root.querySelector('[data-layout-position=vfx]').getAttribute('aria-label')===t('layoutPopover.vfxPosition')
      &&root.querySelector('[data-layout-position=vfx]').closest('.ui-row').querySelector('.ui-row-label').textContent===t('chrome.vfx')
      &&document.activeElement===layoutCaptionDraft&&JSON.stringify(styk.editor.report)===layoutCaptionBytes&&styk.editor._undo.length===layoutCaptionUndo;
  }));
  await page.evaluate(()=>{styk.actions['layout-menu']();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {createEasingControls}=await import('/src/keyframe-easing-view.mjs');
    const {appendLocalized}=await import('/src/localization-bindings.mjs');
    window.easingCaptionRoot=document.createElement('section');easingCaptionRoot.style.cssText='position:fixed;top:100px;left:20px;background:white;z-index:10';appendLocalized(document.body,easingCaptionRoot);
    window.easingCaptionControls=createEasingControls(easingCaptionRoot,{initial:{interpolation:'bezier',bezier:[.42,0,.58,1]}});
    window.easingCaptionInputs=[...easingCaptionRoot.querySelectorAll('input')];
    window.easingCaptionButtons=[...easingCaptionRoot.querySelectorAll('button')];
    window.easingCaptionValues=easingCaptionControls.read();window.easingCaptionPath=easingCaptionRoot.querySelector('[data-curve]').getAttribute('d');
    easingCaptionInputs[0].focus();easingCaptionInputs[0].value='0.23';styk.localization.localization.setPseudo('long');
  });
  check('Easing preview and control captions refresh without rebuilding the curve, selected mode or an unfinished numeric draft',await page.evaluate(()=>{
    const root=easingCaptionRoot,t=(key,params)=>styk.localization.t(key,params);
    return root.querySelector('svg').getAttribute('aria-label')===t('keyframeEasingPopover.keyframeEasing')
      &&easingCaptionInputs.every((input,index)=>input===root.querySelectorAll('input')[index]&&input.getAttribute('aria-label')===t(input.dataset.i18nAriaLabel))
      &&easingCaptionButtons.every((button,index)=>button===root.querySelectorAll('button')[index]&&button.textContent===t(button.dataset.i18n)&&button.getAttribute('aria-label')===t(button.dataset.i18nAriaLabel))
      &&document.activeElement===easingCaptionInputs[0]&&easingCaptionInputs[0].value==='0.23'
      &&JSON.stringify(easingCaptionControls.read())===JSON.stringify(easingCaptionValues)
      &&root.querySelector('[data-curve]').getAttribute('d')===easingCaptionPath&&root.querySelector('[data-easing=bezier]').getAttribute('aria-checked')==='true';
  }));
  await page.evaluate(()=>{easingCaptionRoot.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {createAppDialogs}=await import('/src/app-dialogs.mjs');
    window.untitledCaptionEditor={dirty:true,name:''};
    window.untitledCaptionPrompts=createAppDialogs({editor:untitledCaptionEditor,state:{},actions:{},overlays:styk.ui.overlays,guarded:fn=>fn,finishCurrentEdit(){},localization:()=>styk.localization});
    window.untitledCaptionAnswer=untitledCaptionPrompts.confirmReplace();
    window.untitledCaptionTitle=document.querySelector('dialog[open] .ui-dialog-title');styk.localization.localization.setPseudo('rtl');
  });
  check('Save confirmation translates a missing project name through a nested display reference without writing a document name',await page.evaluate(()=>untitledCaptionTitle.textContent===styk.localization.t('appDialogs.saveChangesTo',{value:{messageKey:'app.untitled'}})&&untitledCaptionEditor.name===''));
  await page.locator('#keep-editing').click();
  check('Cancelling the translated unnamed-project confirmation preserves its unsaved state',await page.evaluate(async()=>await untitledCaptionAnswer===false&&untitledCaptionEditor.dirty&&untitledCaptionEditor.name===''));
  await page.evaluate(()=>styk.localization.localization.setPseudo(null));
  await page.evaluate(async()=>{
    const {UserLibrary}=await import('/src/user-library.mjs');
    const {SupportCenter}=await import('/src/support-center.mjs');
    const {appendLocalized}=await import('/src/localization-bindings.mjs');
    window.libraryEmptyCaptionRoot=document.createElement('section');appendLocalized(document.body,libraryEmptyCaptionRoot);
    window.libraryEmptyCaptionProbe=Object.create(UserLibrary.prototype);Object.assign(libraryEmptyCaptionProbe,{editor:{selectedObjects:[]},desktop:{listLibrary(){}},source:'mine',folder:'',empty:libraryEmptyCaptionRoot});libraryEmptyCaptionProbe.renderEmpty(false);
    window.supportPriorityCaptionProbe=Object.create(SupportCenter.prototype);
    window.supportPriorityCaptionRow={id:'local-caption-fixture',priority:'urgent',title:'Artist report',status:'new',category:'bug',displayName:'Artist',createdAt:'2026-09-01T12:00:00Z'};
    window.supportPriorityCaptionBytes=JSON.stringify(supportPriorityCaptionRow);
    window.supportPriorityCaptionCard=supportPriorityCaptionProbe.boardCard(supportPriorityCaptionRow,'2026-10-01');appendLocalized(document.body,supportPriorityCaptionCard);
    styk.localization.localization.setPseudo('rtl');
  });
  check('Retained library guidance and support priority descriptions resolve nested current-language labels while raw report data stays intact',await page.evaluate(()=>{
    const t=(key,params)=>styk.localization.t(key,params),priority=supportPriorityCaptionCard.querySelector('.sc-card-priority');
    return libraryEmptyCaptionRoot.querySelector('.ui-empty-text').textContent===t('userLibrary.selectFiguresOrAMovieclipAndChooseAdd')
      &&priority.textContent===t('supportMessages.priorities.urgent')&&priority.getAttribute('aria-label')===t('supportCenter.priority',{textContent:{messageKey:'supportMessages.priorities.urgent'}})
      &&supportPriorityCaptionCard.dataset.priority==='urgent'&&supportPriorityCaptionCard.querySelector('.sc-card-title').textContent==='Artist report'
      &&JSON.stringify(supportPriorityCaptionRow)===supportPriorityCaptionBytes;
  }));
  await page.evaluate(async()=>{
    const {appendLocalized}=await import('/src/localization-bindings.mjs');
    window.libraryFolderCaptionDialog=document.createElement('dialog');appendLocalized(document.body,libraryFolderCaptionDialog);
    libraryEmptyCaptionProbe.dialog=libraryFolderCaptionDialog;libraryEmptyCaptionProbe.newFolder();
    window.libraryFolderCaptionInput=libraryFolderCaptionDialog.querySelector('input');
    window.libraryFolderInitialCaption=libraryFolderCaptionInput.value;
    libraryFolderCaptionInput.focus();libraryFolderCaptionInput.value='Artist folder العربية';styk.localization.localization.setPseudo('long');
  });
  check('New library folders start with a translated editable name and keep the artist draft when the language changes',await page.evaluate(()=>libraryFolderInitialCaption.includes('اختبار')&&libraryFolderCaptionInput.value==='Artist folder العربية'&&document.activeElement===libraryFolderCaptionInput&&libraryFolderCaptionInput.getAttribute('aria-label')===styk.localization.t('userLibrary.folderName')));
  await page.locator('dialog[open] [data-cancel]').click();
  await page.evaluate(async()=>{
    styk.localization.localization.setPseudo(null);styk.localization.setLocale('ar');
    window.libraryMoveCaptionEntries=[{path:'Artist folder العربية',name:'Artist folder العربية',kind:'folder'},{path:'asset.styk',name:'Artist asset',kind:'styk'}];
    window.libraryMoveCaptionBytes=JSON.stringify(libraryMoveCaptionEntries);window.libraryMoveCaptionWrites=0;
    Object.assign(libraryEmptyCaptionProbe,{entries:libraryMoveCaptionEntries,selected:'asset.styk',run:task=>task(),desktop:{listLibrary:async folder=>({entries:folder?[{path:folder+'/Child',name:'Artist child',kind:'folder'}]:libraryMoveCaptionEntries}),changeLibraryItem:()=>{libraryMoveCaptionWrites++;throw new Error('Read-only caption fixture must not move library data');}}});
    await libraryEmptyCaptionProbe.move();await libraryFolderCaptionDialog.querySelector('.library-move-folders button').onclick();
    window.libraryMoveParent=libraryFolderCaptionDialog.querySelector('[data-parent]');window.libraryMoveParentIcon=libraryMoveParent.querySelector('svg');
    window.libraryMoveParentCaption=libraryMoveParent.querySelector('span');libraryMoveParent.focus();styk.localization.setLocale('he');styk.localization.localization.setPseudo('long');
  });
  check('The library move chooser refreshes its retained parent destination without changing icons, focus or artist folder names',await page.evaluate(()=>libraryFolderCaptionDialog.querySelector('[data-parent]')===libraryMoveParent&&libraryMoveParent.querySelector('svg')===libraryMoveParentIcon&&libraryMoveParent.querySelector('span')===libraryMoveParentCaption&&libraryMoveParentCaption.textContent===styk.localization.t('userLibrary.myLibrary')&&libraryMoveParent.getAttribute('aria-label')===styk.localization.t('userLibrary.myLibrary')&&document.activeElement===libraryMoveParent&&libraryFolderCaptionDialog.querySelector('.library-move-folders button:not([data-parent])').textContent==='Artist child'&&JSON.stringify(libraryMoveCaptionEntries)===libraryMoveCaptionBytes));
  await page.evaluate(async()=>{await libraryFolderCaptionDialog.querySelector('.library-move-folders button:not([data-parent])').onclick();window.libraryMoveNamedParent=libraryFolderCaptionDialog.querySelector('[data-parent]');libraryMoveNamedParent.focus();styk.localization.localization.setPseudo('rtl');});
  check('A deeper library parent shows its authored destination name with a localized full-path description',await page.evaluate(()=>libraryFolderCaptionDialog.querySelector('[data-parent]')===libraryMoveNamedParent&&document.activeElement===libraryMoveNamedParent&&libraryMoveNamedParent.querySelector('span').textContent==='Artist folder العربية'&&libraryMoveNamedParent.getAttribute('aria-label')===styk.localization.t('userLibrary.folderLocation',{folder:'Artist folder العربية'})&&JSON.stringify(libraryMoveCaptionEntries)===libraryMoveCaptionBytes));
  await page.locator('dialog[open] [data-cancel]').click();
  check('Cancelling the translated library move chooser keeps the selected asset and writes no library changes',await page.evaluate(()=>libraryEmptyCaptionProbe.selected==='asset.styk'&&libraryMoveCaptionWrites===0&&JSON.stringify(libraryMoveCaptionEntries)===libraryMoveCaptionBytes));
  await page.evaluate(()=>{libraryFolderCaptionDialog.remove();libraryEmptyCaptionRoot.remove();supportPriorityCaptionCard.remove();styk.localization.localization.setPseudo(null);});
  await page.evaluate(async()=>{
    const {createAppDialogs}=await import('/src/app-dialogs.mjs');
    const {appendLocalized,localizedMarkup}=await import('/src/localization-bindings.mjs');
    const {clipNumber,clipStrength}=await import('/src/vfx-clip-controls.mjs');
    window.recoveryCaptionRecords=[{id:'local-blank',name:'',savedAt:'2026-09-01T12:34:00Z'},{id:'local-artist',name:'Artist recovery العربية',savedAt:'2026-09-02T14:56:00Z'}];
    window.recoveryCaptionBytes=JSON.stringify(recoveryCaptionRecords);
    window.recoveryCaptionPrompts=createAppDialogs({editor:{},state:{},actions:{},overlays:styk.ui.overlays,localization:()=>styk.localization});
    window.recoveryCaptionAnswer=recoveryCaptionPrompts.chooseRecovery(recoveryCaptionRecords,()=>{throw new Error('Read-only caption fixture must not discard recovery data');});
    window.recoveryCaptionSelect=document.querySelector('dialog[open] select');recoveryCaptionSelect.value='local-artist';recoveryCaptionSelect.focus();
    window.recoveryCaptionOptions=[...recoveryCaptionSelect.options];window.recoveryCaptionNodes=recoveryCaptionOptions.map(option=>[...option.childNodes]);
    styk.localization.setLocale('ar');
    window.vfxClipCaptionHost={bindings:new Map()};window.vfxClipCaptionRecord={id:'local-vfx',start:8,duration:12,strength:.75};
    window.vfxClipCaptionRoot=document.createElement('section');appendLocalized(document.body,vfxClipCaptionRoot);
    localizedMarkup(vfxClipCaptionRoot,clipNumber(vfxClipCaptionHost,vfxClipCaptionRecord,'start','vfxClipInspector.start',9,1,100,false)+clipNumber(vfxClipCaptionHost,vfxClipCaptionRecord,'duration','vfxClipInspector.duration',12,1,100,false)+clipStrength(vfxClipCaptionHost,vfxClipCaptionRecord,false));
    window.vfxClipCaptionInputs=[...vfxClipCaptionRoot.querySelectorAll('input')];window.vfxClipCaptionBindings=JSON.stringify([...vfxClipCaptionHost.bindings]);
    window.vfxClipCaptionBytes=JSON.stringify(vfxClipCaptionRecord);styk.localization.setLocale('he');
  });
  check('Native recovery options translate missing names and dates in retained text nodes while keeping selected IDs and authored names intact',await page.evaluate(()=>{
    const t=(key,params)=>styk.localization.t(key,params);
    return recoveryCaptionOptions.every((option,index)=>option===recoveryCaptionSelect.options[index]&&recoveryCaptionNodes[index].every((node,i)=>node===option.childNodes[i])
      &&option.textContent===(recoveryCaptionRecords[index].name||t('app.untitled'))+' · '+t('supportMessages.date',{date:{format:'date',value:recoveryCaptionRecords[index].savedAt,options:{dateStyle:'short',timeStyle:'short'}}}))
      &&recoveryCaptionSelect.value==='local-artist'&&document.activeElement===recoveryCaptionSelect&&JSON.stringify(recoveryCaptionRecords)===recoveryCaptionBytes;
  }));
  await page.locator('dialog[open] .ui-dialog-close').click();
  check('Cancelling the translated recovery chooser leaves every recovery record available',await page.evaluate(async()=>await recoveryCaptionAnswer===null&&JSON.stringify(recoveryCaptionRecords)===recoveryCaptionBytes));
  await page.evaluate(()=>{vfxClipCaptionInputs[0].focus();vfxClipCaptionInputs[0].value='17';styk.localization.localization.setPseudo('long');});
  check('VFX group timing and strength captions refresh while slider values, unfinished drafts and raw gesture bindings stay unchanged',await page.evaluate(()=>{
    const t=(key,params)=>styk.localization.t(key,params),root=vfxClipCaptionRoot;
    return vfxClipCaptionInputs.every((input,index)=>input===root.querySelectorAll('input')[index]&&input.getAttribute('aria-label')===t(input.dataset.i18nAriaLabel))
      &&root.querySelector('[data-i18n="vfxClipInspector.start"]').textContent===t('vfxClipInspector.start')
      &&root.querySelector('[data-i18n="vfxClipInspector.duration"]').textContent===t('vfxClipInspector.duration')
      &&document.activeElement===vfxClipCaptionInputs[0]&&vfxClipCaptionInputs[0].value==='17'&&root.querySelector('input[type=range]').value==='75'
      &&JSON.stringify([...vfxClipCaptionHost.bindings])===vfxClipCaptionBindings&&JSON.stringify(vfxClipCaptionRecord)===vfxClipCaptionBytes;
  }));
  await page.evaluate(()=>{vfxClipCaptionRoot.remove();styk.localization.localization.setPseudo(null);styk.localization.setLocale('en');});
  check('No uncaught errors in retained dialog, menu, RTL and pseudolocalization workflows',errors.length===0);
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,fontEvidence},null,2));
} catch(e){await page.screenshot({path:path.join(output,'failure.png')});await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,failure:e.message},null,2));throw e;}
finally{await browser.close();}
