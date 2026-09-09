/** Recovery must resume after posing is followed by scrubbing or playback. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'artifacts');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext(),page=await context.newPage();
const report={checks:[],errors:[]};page.on('pageerror',e=>report.errors.push(e.message));
async function stored() {return page.evaluate(()=>new Promise(resolve=>{const request=indexedDB.open('stykanimate-recovery',1);request.onsuccess=()=>{const db=request.result,tx=db.transaction('documents'),get=tx.objectStore('documents').get('latest');let result=null;get.onsuccess=()=>result=get.result;tx.oncomplete=()=>{db.close();resolve(result?{name:result.name,bytes:result.blob?.size}:null);};};request.onerror=()=>resolve(null);}));}
async function waitForRecovery(name) {const deadline=Date.now()+8000;let record;do{record=await stored();if(record?.name===name)return record;await page.waitForTimeout(100);}while(Date.now()<deadline);return record;}
try {
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>styk?.ready);
  await page.evaluate(()=>{const e=styk.editor;e.newDocument();e.addFrame();e.selectFrame(0);e.name='Recovery after scrub';e.markSaved();});
  const x=page.locator('[data-field="root_x"]');await x.fill('93');await x.press('Tab');
  const box=await page.locator('.styk-timeline-scroll').boundingBox();await page.mouse.click(box.x+16,box.y+14);
  const scrub=await waitForRecovery('Recovery after scrub');
  report.checks.push({name:'Recovery resumes after a post-edit timeline seek',passed:scrub?.name==='Recovery after scrub',record:scrub});
  await page.evaluate(()=>{styk.editor.name='Recovery after playback';styk.editor.select(styk.editor.frame.objects[0].unique_id);});
  await page.locator('[data-field="root_x"]').fill('109');await page.locator('[data-field="root_x"]').press('Tab');
  await page.locator('#play-button').click();await page.waitForTimeout(600);await page.locator('#play-button').click();
  const playback=await waitForRecovery('Recovery after playback');
  report.checks.push({name:'Recovery resumes after playing and pausing a dirty document',passed:playback?.name==='Recovery after playback',record:playback});
  assert.ok(report.checks.every(c=>c.passed),'A dirty document lost its pending recovery after interaction.');
  assert.deepEqual(report.errors,[]);
} catch(error){report.failure=error.stack;process.exitCode=1;}
finally{report.measuredAt=new Date().toISOString();await writeFile(path.join(out,'recovery-interaction.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
