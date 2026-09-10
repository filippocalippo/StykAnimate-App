import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1500, height: 940}}), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const check = name => {checks.push(name); console.log('PASS', name);};
const snapshot = () => page.evaluate(() => {
  const e = styk.editor, g = e.geometry.objects.get(0);
  return {joints: Object.fromEntries(g.joints), angles: g.segments.map(s => s.angle), settings: e.getIKSettings(),
    history: e._undo.length, target: g.obj._stykIK?.[22]?.target, drag: styk.state.drag?.kind};
});
const near = (a, b) => Math.abs(a - b) < .05;
const angleNear = (a,b) => Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b))) < 1e-5;
const point = (a, b) => assert.ok(near(a.x, b.x) && near(a.y, b.y), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const screen = p => page.evaluate(p => {
  const rect = document.querySelector('#viewport').getBoundingClientRect(), v = styk.state.view;
  return {x: rect.left + v.x + p.x * v.scale, y: rect.top + v.y + p.y * v.scale};
}, p);
async function drag(from, to, during) {
  const a = await screen(from), b = await screen(to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 15});
  if (during) await during(await snapshot());
  await page.mouse.up(); await page.waitForFunction(() => !styk.state.drag);
}
try {
  await page.goto('http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
    const document = emptyDocument(), figure = document.figure_types[0], base = figure.segments[0];
    figure.name = 'IK legs';
    figure.segments = [
      {...base, segment_id: 11, parent_id: 0, length: 90, angle_rad: .8, aux_code: 0, is_static: false},
      {...base, segment_id: 22, parent_id: 11, length: 90, angle_rad: 2, aux_code: 0, is_static: false},
      {...base, segment_id: 33, parent_id: 22, length: 35, angle_rad: 0, aux_code: 0, is_static: false},
      {...base, segment_id: 44, parent_id: 0, length: 90, angle_rad: 2.1, aux_code: 0, is_static: false},
      {...base, segment_id: 55, parent_id: 44, length: 90, angle_rad: 1.2, aux_code: 0, is_static: false},
      {...base, segment_id: 66, parent_id: 55, length: 35, angle_rad: Math.PI, aux_code: 0, is_static: false},
    ]; figure.segment_count = 6;
    document.keyframes = [createFrame([createObject(figure, 1, 300, 150)], 8)];
    styk.editor.load(document); styk.editor.select(1, 1); styk.state.tool = 'pose'; styk.state.inspectorContext = 'figure';
    styk.editor._emit('selection');
  });
  await page.locator('#node-is-ik').check(); await page.locator('#node-ik-pinned').waitFor();
  assert.ok(await page.locator('#node-ik-pinned').isChecked());
  assert.equal(await page.locator('#node-ik-chain').inputValue(), '2'); check('Inspector enables an IK node with pinning and a two-bone chain');
  assert.ok(await page.getByRole('radio', {name: 'Bend both', exact: true}).isChecked());
  assert.equal(await page.locator('.ik-help').count(), 0);
  assert.equal(await page.getByText('Inverse kinematics', {exact: true}).count(), 0);
  assert.ok(await page.locator('#node-is-ik').evaluate(el => el.closest('.inspector-section')?.textContent.includes('Transform')));
  check('Compact IK controls live inside Transform without explanatory copy');
  await drag((await snapshot()).joints[22], {x: 420, y: 150});
  let previousKnee = (await snapshot()).joints[11], largestKneeStep = 0;
  const startCircle = await screen({x: 420, y: 150});
  await page.mouse.move(startCircle.x, startCircle.y); await page.mouse.down();
  for (let i = 1; i <= 120; i++) {
    const angle = i * Math.PI / 60, target = {x: 300 + 120 * Math.cos(angle), y: 150 + 120 * Math.sin(angle)}, p = await screen(target);
    await page.mouse.move(p.x, p.y);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const live = await snapshot(), knee = live.joints[11]; point(live.joints[22], target);
    largestKneeStep = Math.max(largestKneeStep, Math.hypot(knee.x - previousKnee.x, knee.y - previousKnee.y));
    assert.ok(largestKneeStep < 6, `Both mirrored the knee during actual pointer drag: ${largestKneeStep}`);
    previousKnee = knee;
  }
  await page.mouse.up(); await page.waitForFunction(() => !styk.state.drag);
  check('Both stays continuous through a real 360-degree pointer drag');
  const foldStart = await screen((await snapshot()).joints[22]); let largestFoldStep = 0;
  previousKnee = (await snapshot()).joints[11];
  await page.mouse.move(foldStart.x, foldStart.y); await page.mouse.down();
  for (let x = 418; x >= 240; x -= 2) {
    const p = await screen({x, y: 150}); await page.mouse.move(p.x, p.y);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const live = await snapshot(), knee = live.joints[11]; point(live.joints[22], {x, y: 150});
    largestFoldStep = Math.max(largestFoldStep, Math.hypot(knee.x - previousKnee.x, knee.y - previousKnee.y));
    assert.ok(largestFoldStep < 3, `Both snapped while crossing the root: ${JSON.stringify({x, largestFoldStep, previousKnee, knee, reference: live.settings.bendReference})}`); previousKnee = knee;
  }
  await page.mouse.up(); await page.waitForFunction(() => !styk.state.drag);
  check('Both changes side smoothly through the root during an actual pointer drag');
  const before = await snapshot();
  await drag(before.joints[22], {x: 355, y: 275}, live => {point(live.joints[22], {x: 355, y: 275}); assert.ok(angleNear(live.angles[2], before.angles[2]));});
  check('Actual target drag solves the leg while preserving foot orientation');
  await page.evaluate(() => {styk.editor.select(1, 4); styk.editor._emit('selection');});
  await page.getByText('Joint 55', {exact: true}).waitFor();
  await page.locator('#node-is-ik').check();
  await page.waitForFunction(() => styk.editor.getIKSettings().pinned);
  const planted = await snapshot();
  await drag(planted.joints[0], {x: 310, y: 140}, live => {
    point(live.joints[22], planted.joints[22]); point(live.joints[55], planted.joints[55]);
    point(live.joints[33], planted.joints[33]); point(live.joints[66], planted.joints[66]);
    assert.ok(angleNear(live.angles[2],planted.angles[2]));
    assert.ok(angleNear(live.angles[5],planted.angles[5]));
  });
  const moved = await snapshot(); point(moved.joints[0], {x: 310, y: 140});
  point(moved.joints[22], planted.joints[22]); point(moved.joints[55], planted.joints[55]);
  point(moved.joints[33], planted.joints[33]); point(moved.joints[66], planted.joints[66]);
  check('Root dragging keeps both complete feet planted in position and rotation');
  await page.evaluate(() => {styk.editor.select(1, 1); styk.editor._emit('selection');});
  await page.getByText('Joint 22', {exact: true}).waitFor();
  const rotationBefore=(await snapshot()).angles[2];
  await page.locator('#node-ik-rotation').fill('20'); await page.locator('#node-ik-rotation').press('Tab');
  assert.ok(near((await snapshot()).angles[2], rotationBefore + 20 * Math.PI / 180)); check('Target rotation explicitly turns the planted foot');
  const rotated = await snapshot();
  await drag(rotated.joints[0], {x: 315, y: 135}, live => {
    for (const id of [22, 33, 55, 66]) point(live.joints[id], rotated.joints[id]);
  });
  check('The edited target rotation remains planted through another root drag');
  await page.evaluate(() => {styk.editor.select(1, 1); styk.editor._emit('selection');});
  await page.locator('#node-ik-pinned').waitFor();
  const saved = await snapshot();
  await page.locator('#node-ik-pinned').uncheck();
  point((await snapshot()).joints[33], saved.joints[33]);
  await page.locator('#node-ik-pinned').check(); check('Unpin and re-pin preserve the displayed pose');
  await mkdir('artifacts/ik', {recursive: true});
  await page.screenshot({path: 'artifacts/ik/inspector-and-pins.png'});
  // Unreachable constraints use the ordinary circular node for recovery.
  const target = (await snapshot()).target;
  await drag(target, {x: 565, y: 270});
  const unreachable = await snapshot(); assert.ok(Math.hypot(unreachable.joints[22].x - 565, unreachable.joints[22].y - 270) > 5);
  await drag(unreachable.joints[22], {x: 360, y: 265}); point((await snapshot()).joints[22], {x: 360, y: 265});
  check('Unreachable chain remains selectable at its circular node and recovers without stretching');
  const bendSide = s => (s.joints[22].x - s.joints[0].x) * (s.joints[11].y - s.joints[0].y) - (s.joints[22].y - s.joints[0].y) * (s.joints[11].x - s.joints[0].x);
  await page.getByRole('radio', {name: 'Bend left', exact: true}).check(); assert.ok(bendSide(await snapshot()) < 0);
  await page.getByRole('radio', {name: 'Bend right', exact: true}).check(); assert.ok(bendSide(await snapshot()) > 0);
  await page.getByRole('radio', {name: 'Bend both', exact: true}).check(); assert.ok(bendSide(await snapshot()) > 0);
  check('Left and Right flip the bend; Both preserves the current side');
  await drag((await snapshot()).joints[22], {x: 565, y: 270});
  await page.locator('#node-ik-stretch').check(); point((await snapshot()).joints[22], {x: 565, y: 270});
  await page.locator('#node-ik-stretch').uncheck();
  assert.ok(Math.hypot((await snapshot()).joints[22].x - 565, (await snapshot()).joints[22].y - 270) > 5);
  await page.locator('#node-ik-stretch').check();
  check('Allow stretch reaches the target and disabling it restores bone lengths');
  await page.screenshot({path: 'artifacts/ik/compact-inspector.png'});
  const roundtrips = await page.evaluate(async () => {
    const {DocumentExporter} = await import('/src/document-export.mjs');
    const {ImportClient} = await import('/src/import-client.mjs');
    const {Editor} = await import('/src/editor.mjs');
    const exporter = new DocumentExporter(), importer = new ImportClient(), results = [];
    try {
      for (const format of ['styk', 'stkz', 'piv']) {
        const blob = await exporter.export(styk.editor.serialize(), {format, figureUid: 1, tick: styk.editor.tick});
        const imported = await importer.importFile(new File([blob], `ik.${format}`));
        const reopened = new Editor({demo: false}).load(imported.document);
        const g = reopened.geometry.objects.get(0);
        results.push({format, bytes: blob.size, point: format === 'piv' ? g.segments[1].end : g.joints.get(22), footAngle: g.segments[2].angle, hasControllers: Boolean(g.obj._stykIK)});
      }
    } finally {exporter.dispose(); importer.dispose();}
    return results;
  });
  const current = await snapshot();
  for (const result of roundtrips) {
    point(result.point, current.joints[22]); assert.ok(near(result.footAngle, current.angles[2]));
    assert.equal(result.hasControllers, result.format !== 'piv');
  }
  check('Real worker/backend STYK and STKZ round trips retain controllers; PIV round trip retains baked pose');
  await page.evaluate(async () => {
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const document=emptyDocument(), figure=document.figure_types[0], base=figure.segments[0];
    const segment=(id,parent,length,angle,fixed=false)=>({...base,segment_id:id,parent_id:parent,length,angle_rad:angle,is_static:fixed,aux_code:fixed?1:0});
    const groups=[[segment(11,0,90,.8)],[segment(22,0,90,2),segment(24,22,20,1.1,true)],[segment(33,0,35,0),segment(35,0,25,1.5,true),segment(36,35,40,0,true)],[segment(41,0,18,1.1,true)]];
    document.figure_types=groups.map((segments,i)=>({...structuredClone(figure),name:['Thigh','Shin','Foot','Attachment'][i],figure_type_id:i+1,segments,segment_count:segments.length}));
    document.figure_types[2].polyfills=[{polyfill_id:1,segment_ids:[0,35,36,33],color_rgb:[10,35,65],alpha_raw:0,z_order:0}];
    const objects=document.figure_types.map((f,i)=>createObject(f,i+1,300,150));
    for(const [slot,parent,handle] of [[1,0,11],[2,1,22],[3,1,22]])objects[slot].join={target_object_slot:parent,target_unique_id:parent+1,target_handle_id:handle};
    document.keyframes=[createFrame(objects,8)]; styk.editor.load(document);styk.editor.select(2,0);styk.editor._emit('selection');
  });
  await page.getByText('Joint 22',{exact:true}).waitFor(); await page.locator('#node-is-ik').check();
  assert.equal(await page.locator('#node-ik-chain').getAttribute('max'),'2');
  const joinedSnapshot=()=>page.evaluate(()=>Object.fromEntries([...styk.editor.geometry.objects.values()].flatMap(g=>g.segments.map(s=>[s.seg.segment_id,{start:s.start,end:s.end,angle:s.angle}]))));
  const joinedBefore=await joinedSnapshot();
  await drag(joinedBefore[22].end,{x:355,y:275},async()=>{
    const live=await joinedSnapshot();point(live[22].end,{x:355,y:275});assert.ok(angleNear(live[33].angle,0));
    for(const id of [35,36])assert.ok(angleNear(live[id].angle,joinedBefore[id].angle));
    for(const id of [24,41])assert.ok(angleNear(live[id].angle-live[22].angle,joinedBefore[id].angle-joinedBefore[22].angle));
  });
  check('Joined IK keeps shin attachments on the shin and the polygon foot in target space');
  const joinedPlanted=await joinedSnapshot();
  await page.evaluate(()=>{styk.editor.select(1,-1);styk.editor._emit('selection');});
  await drag(joinedPlanted[11].start,{x:310,y:140},async()=>{
    const live=await joinedSnapshot();
    for(const id of [22,33,35,36])point(live[id].end,joinedPlanted[id].end);
    for(const id of [24,41])assert.ok(angleNear(live[id].angle-live[22].angle,joinedPlanted[id].angle-joinedPlanted[22].angle));
  });
  check('Actual joined-root dragging keeps the whole foot planted');
  await drag((await joinedSnapshot())[22].end,{x:430,y:140});
  const attachmentStart=await joinedSnapshot(), pointerStart=await screen(attachmentStart[22].end);
  let maximumRelativeRotationError=0;
  await page.mouse.move(pointerStart.x,pointerStart.y);await page.mouse.down();
  for(let i=1;i<=120;i++){
    const a=i*Math.PI/60,p=await screen({x:310+120*Math.cos(a),y:140+120*Math.sin(a)});
    await page.mouse.move(p.x,p.y);await page.evaluate(()=>new Promise(requestAnimationFrame));
    const live=await joinedSnapshot();
    for(const id of [24,35,36,41]){
      const difference=live[id].angle-attachmentStart[id].angle-([24,41].includes(id)?live[22].angle-attachmentStart[22].angle:0);
      maximumRelativeRotationError=Math.max(maximumRelativeRotationError,Math.abs(Math.atan2(Math.sin(difference),Math.cos(difference))));
    }
    assert.ok(maximumRelativeRotationError<1e-5,`Attachment acquired extra rotation: ${maximumRelativeRotationError}`);
  }
  await page.mouse.up();await page.waitForFunction(()=>!styk.state.drag);
  check('Every pointer sample preserves shin attachment offsets and foot orientation');
  await page.evaluate(()=>{styk.editor.select(2,0);styk.editor._emit('selection');});
  await page.locator('#node-ik-pinned').uncheck();
  const freeFoot=await joinedSnapshot();
  await drag(freeFoot[22].end,{x:355,y:265},async()=>{
    const live=await joinedSnapshot();
    for(const id of [33,35,36])assert.ok(angleNear(live[id].angle,freeFoot[id].angle));
    for(const id of [24,41])assert.ok(angleNear(live[id].angle-live[22].angle,freeFoot[id].angle-freeFoot[22].angle));
    assert.ok(Math.abs(live[22].angle-freeFoot[22].angle)>.1);
  });
  check('Unpinned target dragging preserves the foot orientation');
  const styledFoot=await joinedSnapshot();
  await page.locator('[data-field="thickness"]').fill('32');
  await page.locator('[data-field="thickness"]').press('Tab');
  for(const [id,s] of Object.entries(styledFoot)){const live=(await joinedSnapshot())[id];point(live.end,s.end);assert.ok(near(live.angle,s.angle));}
  await page.locator('#node-ik-pinned').check();
  await drag((await joinedSnapshot())[22].end,{x:365,y:255},async()=>{const live=await joinedSnapshot();assert.ok(angleNear(live[33].angle,styledFoot[33].angle));});
  check('Thickness editing and re-pinning preserve the child articulation');
  await page.screenshot({path:'artifacts/ik/joined-attachments.png'});
  const joinedRoundtrips=await page.evaluate(async()=>{
    const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),{Editor}=await import('/src/editor.mjs');
    const exporter=new DocumentExporter(),importer=new ImportClient(),results=[];
    const sample=e=>[...e.geometry.objects.values()].map(g=>({uid:g.obj.unique_id,segments:g.segments.map(s=>({end:s.end,angle:s.angle}))}));
    try{for(const format of ['styk','piv']){
      const blob=await exporter.export(styk.editor.serialize(),{format}),loaded=await importer.importFile(new File([blob],`joined.${format}`));
      results.push({format,expected:sample(styk.editor),actual:sample(new Editor({demo:false}).load(loaded.document))});
    }}finally{exporter.dispose();importer.dispose();}return results;
  });
  for(const result of joinedRoundtrips)for(const expected of result.expected){
    const actual=result.actual.find(o=>o.uid===expected.uid);assert.ok(actual);
    expected.segments.forEach((s,i)=>{point(actual.segments[i].end,s.end);assert.ok(near(actual.segments[i].angle,s.angle));});
  }
  check('Joined IK and attachment poses survive real STYK/PIV worker and backend round trips');
  assert.deepEqual(errors, []);
  await writeFile('artifacts/ik/browser-report.json', JSON.stringify({checks, largestKneeStep, largestFoldStep, maximumRelativeRotationError, roundtrips, joinedRoundtrips, errors}, null, 2));
} finally {await browser.close();}
