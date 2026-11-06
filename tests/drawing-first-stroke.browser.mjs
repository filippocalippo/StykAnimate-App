import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
// Draw mode paints on the first stroke: it chooses an editable drawing layer,
// or creates one, instead of silently ignoring the gesture.
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.stack));
const check=(name,value)=>{assert.ok(value,name);console.log('PASS',name);};
const stroke=async(x,y)=>{await page.mouse.move(x,y);await page.mouse.down();await page.waitForFunction(()=>Boolean(styk.drawing.gesture));await page.mouse.move(x+90,y+35,{steps:10});await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture);await page.evaluate(()=>styk.drawing.barrier());};
const drawingLayers=()=>page.evaluate(async()=>{const {isDrawingLayer}=await import('/src/drawing-model.mjs');return styk.editor.layers.filter(isDrawingLayer).map(l=>l.id);});
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>styk.state.settings.autosaveSeconds=0);
  check('the document starts without a drawing layer',(await drawingLayers()).length===0);
  await page.locator('[data-workspace-mode="draw"]').click();
  check('Draw explains that painting creates a layer',await page.locator('#inspector .drawing-empty').textContent().then(t=>/created for you/.test(t)));
  const rect=await page.locator('#viewport').boundingBox();
  await stroke(rect.x+rect.width*.4,rect.y+rect.height*.45);
  const layers=await drawingLayers();
  check('the first stroke creates and activates one drawing layer',layers.length===1&&await page.evaluate(id=>styk.editor.activeLayerId===id,layers[0]));
  check('the first stroke leaves ink on the new layer',await page.evaluate(()=>{const t=styk.editor.drawingTarget(),s=styk.drawing.owner.entry(t.figure);return Boolean(s?.store?.bounds?.width);}));
  // Selecting a non-drawing layer then painting reuses the existing layer.
  await page.evaluate(()=>{const layer=styk.editor.layers.find(l=>l.kind==='layer'&&!l.drawing);styk.editor.selectSheetLayer(layer.id);});
  await stroke(rect.x+rect.width*.4,rect.y+rect.height*.6);
  check('painting from a figure layer reuses the existing drawing layer',(await drawingLayers()).length===1&&await page.evaluate(id=>styk.editor.activeLayerId===id,layers[0]));
  check('no uncaught browser errors',!errors.length);
}finally{await browser.close();}
if(errors.length)console.error(errors.join('\n'));
