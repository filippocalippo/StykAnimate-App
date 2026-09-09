/** Native stage keyboard gestures through real browser keyboard/pointer events. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve('artifacts/native-handle-keyboard');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}}),checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);console.log('PASS',name);};
const near=(a,b,epsilon=1e-4)=>Math.abs(a-b)<epsilon;
async function setup({camera=false,previous=false}={}){
  await page.evaluate(async({camera,previous})=>{
    const{emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const{worldToScreen}=await import('/src/renderer-geometry.mjs');
    const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
    figure.segments=[{...base,segment_id:11,parent_id:0,length:100,angle_rad:.2},
      {...base,segment_id:22,parent_id:11,length:55,angle_rad:1},
      {...base,segment_id:33,parent_id:0,length:60,angle_rad:2.5}];figure.segment_count=3;
    report.keyframes=[createFrame([createObject(figure,1,400,260),createObject(figure,2,200,400)]),
      createFrame([createObject(figure,1,420,270),createObject(figure,2,200,400)])];
    if(camera)for(const frame of report.keyframes)frame.camera={is_default:false,x:0,y:0,scale:.7,angle_rad:.43};
    styk.editor.load(report,'Native handle keyboard');if(previous)styk.editor.selectFrame(1);
    styk.editor.select(1,0);styk.state.isolateMode=false;styk.state.hoverHandle=null;styk.fit();
    window.__screen=point=>{const r=document.querySelector('#viewport').getBoundingClientRect(),p=worldToScreen(point,{report:styk.editor.report,frame:styk.editor.evaluatedFrame,view:styk.state.view,cameraEnabled:false});return{x:r.x+p.x,y:r.y+p.y};};
    window.__points=()=>Object.fromEntries([...styk.editor.geometry.objects.get(0).joints].map(([id,p])=>[id,{...p}]));
  },{camera,previous});
  await page.keyboard.press('v');await page.locator('#viewport').focus();await page.waitForTimeout(80);
}
async function hover(id=11){const point=await page.evaluate(id=>__screen(styk.editor.geometry.objects.get(0).joints.get(id)),id);await page.mouse.move(point.x,point.y);await page.locator('#viewport').focus();}
const values=()=>page.evaluate(()=>({points:__points(),angles:styk.editor.object.angles.slice(),history:styk.editor._undo.length,hover:styk.state.hoverHandle,dragging:styk.editor.dragging,frame:styk.editor.frameIndex,uid:styk.editor.selectedUid}));
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>styk?.ready);
  await setup({camera:true});await hover(0);
  const originBefore=await page.evaluate(()=>__screen(styk.editor.geometry.objects.get(0).root));
  for(let i=0;i<5;i++)await page.keyboard.down('ArrowRight');await page.keyboard.up('ArrowRight');
  const originAfter=await page.evaluate(()=>__screen(styk.editor.geometry.objects.get(0).root));
  check('Five repeated origin nudges move five CSS pixels in world space despite a rotated, magnified camera',near(originAfter.x-originBefore.x,5)&&near(originAfter.y,originBefore.y));
  check('Held repeat creates one undo operation and ends the preview on keyup',(await values()).history===1&&!(await values()).dragging);
  await page.keyboard.press('Control+z');const undone=await page.evaluate(()=>__screen(styk.editor.geometry.objects.get(0).root));
  check('One undo restores the complete repeated nudge',near(undone.x,originBefore.x)&&near(undone.y,originBefore.y));

  await setup();await hover();const before=await values();await page.keyboard.down('r');
  await page.keyboard.down('Shift');await page.keyboard.down('ArrowRight');await page.keyboard.down('ArrowDown');
  await page.keyboard.up('ArrowRight');await page.keyboard.up('ArrowDown');await page.keyboard.up('Shift');
  const aligned=await values(),root=aligned.points[0],target=aligned.points[11];
  check('Shift plus two arrows aligns the edited endpoint diagonally',near(Math.atan2(target.y-root.y,target.x-root.x),Math.PI/4));
  check('Handle Edit alignment preserves every other endpoint',Object.keys(before.points).filter(id=>id!=='11').every(id=>near(aligned.points[id].x,before.points[id].x)&&near(aligned.points[id].y,before.points[id].y)));
  await page.keyboard.press('ArrowRight');const retained=await values();
  const pixels=await page.evaluate(({a,b})=>{const p=__screen(a),q=__screen(b);return{x:q.x-p.x,y:q.y-p.y};},{a:target,b:retained.points[11]});
  check('A hovered handle remains the keyboard target after it moves away from the stationary pointer',retained.hover?.id===11&&near(pixels.x,1)&&near(pixels.y,0));
  await page.keyboard.up('r');
  const rect=await page.locator('#viewport').boundingBox();await page.mouse.move(rect.x+45,rect.y+70);
  check('Moving the pointer away clears the retained handle',(await values()).hover===null);

  await setup();await hover();const escapeBefore=await values();await page.keyboard.down('ArrowRight');await page.keyboard.press('Escape');await page.keyboard.up('ArrowRight');
  check('Escape restores an in-progress keyboard gesture without creating history',JSON.stringify((await values()).points)===JSON.stringify(escapeBefore.points)&&(await values()).history===0);

  await setup();await hover();const childAngle=(await values()).angles[1];await page.keyboard.down('CapsLock');
  await page.keyboard.press('Shift+ArrowRight');
  check('Physically held Caps Lock isolates rotation from the child branch',near((await values()).angles[1],childAngle)&&await page.evaluate(()=>styk.state.isolateHeld));
  await page.keyboard.up('CapsLock');const isolated=await values();await page.keyboard.press('Shift+ArrowDown');
  check('Releasing Caps Lock resumes branch rotation even while its toggle remains on',!await page.evaluate(()=>styk.state.isolateHeld)&&near((await values()).angles[1]-isolated.angles[1],Math.PI/2));
  await page.keyboard.press('CapsLock');

  await setup({previous:true});await hover();const locateBefore=await values();
  const locateTarget=await page.evaluate(async()=>{const{buildGeometry}=await import('/src/pivot/geometry.mjs');return buildGeometry(styk.editor.report,styk.editor.report.keyframes[0]).objects.get(0).joints.get(11);});
  await page.keyboard.down('r');await page.keyboard.press('l');await page.keyboard.up('r');const located=await values();
  check('Hover L in Handle Edit locates the previous frame endpoint without moving other vertices',near(located.points[11].x,locateTarget.x)&&near(located.points[11].y,locateTarget.y)&&Object.keys(locateBefore.points).filter(id=>id!=='11').every(id=>near(located.points[id].x,locateBefore.points[id].x)&&near(located.points[id].y,locateBefore.points[id].y)));

  await setup();await hover();await page.keyboard.press('Control+ArrowRight');check('Ctrl Right cycles figures without nudging or changing frame',(await values()).uid===2&&(await values()).frame===0&&(await values()).history===0);
  await page.keyboard.press('Control+ArrowLeft');check('Ctrl Left cycles back through painter order',(await values()).uid===1);
  await page.evaluate(()=>{window.__nudgeCalls=0;const original=styk.editor.nudgeHandle;styk.editor.nudgeHandle=function(...args){__nudgeCalls++;return original.apply(this,args);};});
  await page.locator('[data-property="root_x"]').focus();await page.keyboard.press('ArrowUp');
  check('Property input arrows never dispatch canvas nudges',await page.evaluate(()=>__nudgeCalls===0&&styk.editor.frameIndex===0));
  check('No browser runtime errors',errors.length===0);
  await page.screenshot({path:path.join(out,'keyboard-inspector.png')});
  await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors,failure:error.stack},null,2));throw error;}
finally{await browser.close();}
