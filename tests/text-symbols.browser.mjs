/** Real dialog/worker proof for native symbol keyboard maps and installed TTC faces. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import backendModule from '../desktop/backend.cjs';
import fontModule from '../desktop/font-service.cjs';
const appRoot=fileURLToPath(new URL('..',import.meta.url)),output=path.join(appRoot,'artifacts/text-symbols');
await mkdir(output,{recursive:true});
const service=new fontModule.FontService({directories:['C:/Windows/Fonts'],maxDepth:0});
const rows=(await service.listFonts()).filter(row=>['MS Gothic','MS PGothic'].includes(row.family)&&row.style==='Regular');
assert.equal(rows.length,2);const backend=await backendModule.startBackend({appRoot}),checks=[],errors=[];let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/src/app.mjs',route=>route.fulfill({contentType:'text/javascript',body:''}));
  await page.route('**/test-font/*',async route=>{
    const id=new URL(route.request().url()).pathname.split('/').at(-1);
    await route.fulfill({contentType:'font/ttf',body:await service.readFont(id)});
  });
  await page.goto(backend.origin);
  await page.evaluate(async rows=>{
    const{TextDialog}=await import('/src/text-dialog.mjs'),{Editor}=await import('/src/editor.mjs');
    window.editor=new Editor({demo:false});window.applied=0;
    window.textDialog=new TextDialog({dialog:document.querySelector('#dialog'),content:document.querySelector('#dialog-content'),
      fontService:{listFonts:async()=>rows,readFont:async id=>new Uint8Array(await(await fetch('/test-font/'+id)).arrayBuffer())}});
    window.openText=()=>textDialog.open({onApply:figure=>{window.lastFigure=figure;window.applied++;editor.importFigure(figure);}});
    await openText();
  },rows);
  const ready=()=>page.waitForFunction(()=>document.querySelector('#text-preview-state')?.textContent==='Ready');
  const check=(label,condition=true)=>{assert.ok(condition,label);checks.push(label);};
  await ready();await page.locator('#text-content').fill('b()[]{}');
  await page.locator('#text-font-file').setInputFiles('C:/Windows/Fonts/webdings.ttf');await ready();
  check('Actual font file chooser and worker compile typed Webdings symbols',await page.locator('#text-font option:checked').textContent().then(x=>x.includes('Webdings')));
  const symbols=await page.evaluate(()=>{const canvas=document.querySelector('#text-preview');return {asset:textDialog.result.text_assets[0],
    pixels:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.reduce((sum,value,i)=>sum+(i%4===3&&value>0?1:0),0)};});
  check('Bicycle and all six speech-bubble characters retain typed UTF16 units and render outlines',symbols.asset.text==='b()[]{}'&&symbols.asset.glyphs.every(g=>g.commands.length>0)&&symbols.pixels>1000);
  await page.screenshot({path:path.join(output,'webdings.png')});
  await page.locator('#create-text').click();
  check('Create commits one editable portable text figure',await page.evaluate(()=>applied===1&&editor.figure.text_assets[0].text==='b()[]{}'&&editor._undo.length===1));
  await page.evaluate(()=>openText());await ready();await page.locator('#text-content').fill('水 日本語');
  await page.locator('#text-local-fonts').click();
  await page.locator('#text-installed-font').selectOption(String(rows.findIndex(row=>row.family==='MS Gothic')));await ready();
  check('Installed TTC family selection compiles Japanese BMP glyphs',await page.evaluate(()=>textDialog.result.text_assets[0].font_name==='MS Gothic'&&textDialog.result.text_assets[0].text==='水 日本語'));
  await page.locator('#text-installed-font').selectOption(String(rows.findIndex(row=>row.family==='MS PGothic')));await ready();
  check('A second face from the same collection is separately selectable',await page.evaluate(()=>textDialog.result.text_assets[0].font_name==='MS PGothic'));
  await page.screenshot({path:path.join(output,'japanese.png')});await page.locator('#create-text').click();
  check('TTC text creation and undo retain the earlier symbol figure',await page.evaluate(()=>{if(applied!==2)return false;editor.undo();return editor.frame.objects.length===1&&editor.report.figure_types.some(f=>f.text_assets?.some(a=>a.text==='b()[]{}'));}));
  assert.deepEqual(errors,[]);await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors},null,2));
  console.log(JSON.stringify({checks:checks.length,errors}));
}finally{await browser?.close();backend.stop();}
