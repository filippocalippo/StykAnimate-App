import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';
const output='artifacts/release-1.0.1-ui';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  const inspector=await page.evaluate(async()=>{
    const {inspectorView}=await import('/src/inspector-view.mjs');
    styk.editor.select(styk.editor.frame.objects[0].unique_id);
    const figure=inspectorView({editor:styk.editor}),layer=inspectorView({editor:styk.editor,context:'layer'});
    return {figure,layer};
  });
  assert.doesNotMatch(inspector.figure,/data-parallax-layer/);assert.match(inspector.layer,/data-parallax-layer/);
  // The used colours are the figure's last section, titled and closed at rest.
  const palette=page.locator('#inspector section[data-section="colours"]');await palette.waitFor();
  assert.equal(await palette.getAttribute('data-open'),null);
  assert.equal(await palette.evaluate(el=>el===[...el.parentElement.children].filter(section=>!section.hidden).at(-1)),true);
  await palette.locator('.ui-section-toggle').click();await page.screenshot({path:output+'/figure.png'});
  await page.evaluate(async()=>{
    const {ReleaseSplash}=await import('/src/support-ui.mjs');
    window.donations=0;window.historyAttempts=0;
    window.splash=new ReleaseSplash({
      getReleaseInfo:async()=>({version:'1.0.1',title:'A cleaner workspace',groups:[{name:'Changed',notes:['Compact figure colors and a simpler welcome screen.']},{name:'Fixed',notes:['Show parallax only for selected layers.']}]}),
      openDonate:async()=>{window.donations++;},
      getReleaseHistory:async()=>{if(++window.historyAttempts===1)throw new Error('Offline');return [{version:'1.0.0',markdown:'# StykAnimate 1.0.0\n\nAnimation tools\n\n### Added\n'+Array.from({length:65},(_,i)=>'- Feature '+(i+1)+' with editable animation and reliable saving.').join('\n')+'\n\n### Fixed\n- <img src=x onerror=alert(1)>'}];}
    });await splash.open();
  });
  const modal=page.locator('.release-splash');await modal.waitFor();
  await modal.locator('.support-donate').click();assert.equal(await page.evaluate(()=>donations),1);
  await page.screenshot({path:output+'/welcome.png'});
  await modal.getByRole('button',{name:'Recent releases'}).click();await modal.getByRole('button',{name:'Retry'}).waitFor();
  assert.equal(await modal.locator('select').inputValue(),'1.0.1');
  await modal.getByRole('button',{name:'Retry'}).click();await modal.getByRole('button',{name:'Refresh',exact:true}).waitFor();
  await modal.getByRole('combobox',{name:'Release version'}).selectOption('1.0.0');
  assert.equal(await modal.locator('.splash-notes img').count(),0);
  assert.equal(await modal.locator('li').count(),66);
  for(const [name,width,height,dark] of [['history',1440,1000,false],['compact',700,480,false],['dark',900,700,true]]){
    await page.setViewportSize({width,height});await page.evaluate(dark=>document.documentElement.dataset.theme=dark?'dark':'light',dark);
    const bounds=await modal.evaluate(el=>{
      const body=el.querySelector('.splash-notes');body.scrollTop=body.scrollHeight;
      const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
      return {modal:rect(el),donate:rect(el.querySelector('.support-donate')),footer:rect(el.querySelector('footer')),scroll:body.scrollTop,overflow:el.scrollHeight>el.clientHeight};
    });
    assert.ok(bounds.scroll>0);assert.ok(bounds.donate.top>=bounds.modal.top);assert.ok(bounds.footer.bottom<=bounds.modal.bottom);assert.equal(bounds.overflow,false);
    await page.screenshot({path:`${output}/${name}.png`});
  }
  await modal.getByRole('combobox').selectOption('1.0.1');assert.equal(await modal.locator('.splash-notes').evaluate(el=>el.scrollTop),0);
  await page.keyboard.press('Escape');assert.equal(await modal.evaluate(el=>el.open),false);
  await page.evaluate(()=>splash.open());await modal.getByRole('button',{name:'Start animating'}).click();
  assert.deepEqual(errors,[]);console.log('PASS palette placement, layer parallax, grouped notes, history retry, inert remote text, long-list scrolling, compact/dark layouts, donation and close controls.');
} finally {await browser.close();}
