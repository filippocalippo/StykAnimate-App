import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
// Drawing-tablet behaviour with real pen pointer events (CDP pointerType "pen"):
// tap slop, pen drags, wheel-free zoom and rotate, and press-and-hold menus.
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.stack));
const check=(name,value)=>{assert.ok(value,name);console.log('PASS',name);};
const cdp=await page.context().newCDPSession(page);
const CTRL=2,SHIFT=8;
const pen=async(type,x,y,{button='left',modifiers=0,buttons=1,pointerType='pen'}={})=>cdp.send('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'&&!buttons?'none':button,buttons:type==='mouseReleased'?0:buttons,clickCount:type==='mouseMoved'?0:1,pointerType,force:.5,modifiers});
const stroke=async(from,to,options={})=>{await pen('mousePressed',from.x,from.y,options);const steps=8;for(let i=1;i<=steps;i++)await pen('mouseMoved',from.x+(to.x-from.x)*i/steps,from.y+(to.y-from.y)*i/steps,options);await pen('mouseReleased',to.x,to.y,options);await page.waitForTimeout(60);};
const state=()=>page.evaluate(()=>({undo:styk.editor._undo.length,root:[styk.editor.object?.root_x,styk.editor.object?.root_y],scale:styk.state.view.scale,rotation:styk.state.view.rotation??0,playing:Boolean(styk.state.playing)}));
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{const {createDemo}=await import('/src/demo.mjs');styk.editor.load(createDemo());styk.state.settings.autosaveSeconds=0;});
  await page.waitForTimeout(300);
  const origin=await page.evaluate(()=>{const {editor,state}=styk,r=document.getElementById('viewport').getBoundingClientRect(),o=editor.frame.objects[0];return {x:r.x+state.view.x+o.root_x*state.view.scale,y:r.y+state.view.y+o.root_y*state.view.scale};});
  const before=await state();
  await stroke(origin,{x:origin.x+2,y:origin.y+1});
  let after=await state();
  check('a jittery pen tap selects without moving the figure',after.undo===before.undo&&after.root[0]===before.root[0]&&after.root[1]===before.root[1]&&await page.evaluate(()=>Boolean(styk.editor.object)));
  await stroke(origin,{x:origin.x+40,y:origin.y});
  after=await state();
  check('a pen drag past the slop moves the figure as one undo step',after.undo===before.undo+1&&after.root[0]>before.root[0]+20);
  await page.keyboard.press('Control+z');
  const mouseBefore=await state();
  await stroke(origin,{x:origin.x+2,y:origin.y},{pointerType:'mouse'});
  check('mouse drags keep their pixel precision',(await state()).root[0]>mouseBefore.root[0]);
  await page.keyboard.press('Control+z');
  // Ctrl+Space drag: scrubby zoom, no edit, no playback on release.
  await page.locator('#viewport').focus();
  const zoomBefore=await state();
  await page.keyboard.down('Control');await page.keyboard.down('Space');
  await stroke({x:700,y:300},{x:820,y:300},{modifiers:CTRL});
  await page.keyboard.up('Space');await page.keyboard.up('Control');await page.waitForTimeout(100);
  after=await state();
  check('Ctrl+Space pen drag zooms in without editing',after.scale>zoomBefore.scale*1.5&&after.undo===zoomBefore.undo);
  check('releasing Space after zooming does not start playback',!after.playing);
  // Shift+Space drag rotates the Draw view.
  await page.locator('[data-workspace-mode="draw"]').click();await page.locator('#viewport').focus();
  await page.keyboard.down('Shift');await page.keyboard.down('Space');
  const c=await page.evaluate(()=>{const r=document.getElementById('viewport').getBoundingClientRect(),v=styk.state.view,rep=styk.editor.report;return {x:r.x+v.x+rep.canvas_width*v.scale/2,y:r.y+v.y+rep.canvas_height*v.scale/2};});
  await stroke({x:c.x+200,y:c.y},{x:c.x,y:c.y+200},{modifiers:SHIFT});
  await page.keyboard.up('Space');await page.keyboard.up('Shift');
  after=await state();
  check('Shift+Space pen drag rotates the Draw view about a quarter turn',Math.abs(after.rotation-Math.PI/2)<.15&&after.undo===zoomBefore.undo);
  await page.locator('.workspace-switch [data-workspace-mode="animate"]').click();
  // Press and hold with the pen tip must not open the canvas menu; the barrel still does.
  const menuAfter=async init=>{await page.evaluate(()=>document.getElementById('menu').hidden=true);await init();return page.evaluate(()=>!document.getElementById('menu').hidden);};
  const empty={x:300,y:200};
  check('a pen press-and-hold does not open the context menu',!(await menuAfter(async()=>{await pen('mousePressed',empty.x,empty.y);await page.evaluate(({x,y})=>document.getElementById('overlay').dispatchEvent(new PointerEvent('contextmenu',{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:'pen',button:2})),empty);await pen('mouseReleased',empty.x,empty.y);})));
  check('the pen barrel button still opens the context menu',await menuAfter(async()=>{await pen('mousePressed',empty.x,empty.y,{button:'right',buttons:2});await pen('mouseReleased',empty.x,empty.y,{button:'right',buttons:2});await page.waitForTimeout(100);}));
  check('no uncaught browser errors',!errors.length);
}finally{await browser.close();}
if(errors.length)console.error(errors.join('\n'));
