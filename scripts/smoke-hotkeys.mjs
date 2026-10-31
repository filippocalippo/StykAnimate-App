import {_electron as electron} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'artifacts','hotkeys-desktop');
const profile=path.join(output,`profile-${Date.now()}`);
await mkdir(profile,{recursive:true});
await writeFile(path.join(profile,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
const checks=[],errors=[];
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
let app;
let closed = false;
const launch=async()=>{
  closed = false;
  app=await electron.launch({args:[root],cwd:root,timeout:45000,env:{...process.env,STYK_USER_DATA_DIR:profile,STYK_LIBRARY_DIR:path.join(profile,'library')}});
  app.on('close',()=>{closed=true;});
  app.process().stderr.on('data', data => process.stderr.write(data));
  console.log('Desktop process started');
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:30000});
  const welcome = page.getByRole('button',{name:'Close welcome screen'});
  if (await welcome.isVisible()) await welcome.click();
  return page;
};
const stop=async()=>{
  if(!app||closed)return;
  const page=app.windows()[0];
  if(page&&!page.isClosed()) await page.evaluate(async()=>{
    styk.editor.markSaved();
    await stykDesktop.setDocumentState({name:styk.editor.name,dirty:false});
  }).catch(()=>{});
  await app.close(); app=null;
};
try {
  let page=await launch();
  const original=await page.evaluate(()=>styk.editor.totalTicks);
  await page.locator('#overlay').focus();await page.keyboard.press('a');
  check('A duplicates a frame in Electron',await page.evaluate(()=>styk.editor.totalTicks)===original+1);
  const nativeAccelerators=await app.evaluate(({Menu})=>{
    const found=[]; const walk=menu=>{for(const item of menu.items){if(!item.role&&item.accelerator)found.push([item.label,item.accelerator]);if(item.submenu)walk(item.submenu);}};
    walk(Menu.getApplicationMenu());return found;
  });
  check('Native editor menus do not intercept customizable shortcuts',nativeAccelerators.length===0);
  await page.evaluate(()=>styk.settingsUI.open('shortcuts'));
  await page.locator('[data-hotkey-id="add-frame"] [data-hotkey-record]').first().click();await page.keyboard.press('b');
  await page.locator('[data-hotkey-id="undo"] [data-hotkey-record]').first().click();await page.keyboard.press('Control+Alt+u');
  await page.getByRole('button',{name:'Close settings',exact:true}).click();
  await page.evaluate(()=>styk.settingsUI.flush());
  check('Settings are written through the desktop preferences bridge',await page.evaluate(async()=>{
    const stored=await stykDesktop.getEditorSettings();return stored.hotkeys['add-frame'][0]==='KeyB'&&stored.hotkeys.undo[0]==='Mod+Alt+KeyU';
  }));
  await page.locator('#overlay').focus();await page.keyboard.press('Control+z');
  check('The old native Undo accelerator stays disabled',await page.evaluate(()=>styk.editor.totalTicks)===original+1);
  await page.keyboard.press('Control+Alt+u');
  check('Reassigned Undo works in Electron',await page.evaluate(()=>styk.editor.totalTicks)===original);
  await stop();page=await launch();
  check('Custom shortcuts survive an actual desktop process restart',await page.evaluate(()=>styk.hotkeys.label('add-frame')==='B'&&styk.hotkeys.label('undo')==='Ctrl+Alt+U'));
  const restored=await page.evaluate(()=>styk.editor.totalTicks);
  await page.locator('#overlay').focus();await page.keyboard.press('a');
  check('Old A remains disabled after restart',await page.evaluate(()=>styk.editor.totalTicks)===restored);
  await page.keyboard.press('b');check('Custom B works after restart',await page.evaluate(()=>styk.editor.totalTicks)===restored+1);
  check('No desktop renderer errors',errors.length===0);
  await page.screenshot({path:path.join(output,'desktop.png')});
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors},null,2));
} catch(error) {
  const page = app?.windows()[0];
  if (page && !page.isClosed()) {
    console.error(await page.evaluate(()=>({ready:styk?.ready, duration:styk?.editor?.totalTicks, bindings:styk?.hotkeys?.label('add-frame'), focus:document.activeElement?.outerHTML?.slice(0,400), dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.outerHTML.slice(0,900)), error:document.querySelector('#renderer-error')?.textContent})));
    await page.screenshot({path:path.join(output,'failure.png')});
  }
  console.error(error);throw error;
} finally {await stop();}
