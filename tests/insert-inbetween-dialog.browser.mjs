import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'artifacts');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Insert Inbetween verification</title><style>
body{margin:0;padding:24px;background:#f5f5f5;font:12px 'Segoe UI',sans-serif;color:#333}h1{font-size:16px;font-weight:500;margin:0 0 18px}.workspace{background:#fff;border:1px solid #dedede;border-radius:6px;padding:20px}h2{font-size:12px;font-weight:500}#simple{height:142px;border:1px solid #dedede;border-radius:5px}#advanced{height:230px;margin-top:20px;border:1px solid #dedede;border-radius:5px}.controls{display:flex;gap:8px;margin-bottom:12px}.controls button{padding:8px 12px;background:white;border:1px solid #ddd;border-radius:5px}
</style></head><body><h1>StykAnimate · Insert Inbetween</h1><div class="workspace"><div class="controls"><button id="open">Preview selected frames</button><button id="reset">Reset fixture</button></div><div id="simple"></div><div id="advanced"></div></div><script type="module">
import {Editor} from '/src/editor.mjs';import {createFrame,createObject,emptyDocument} from '/src/demo.mjs';
import {InsertInbetweenDialog} from '/src/insert-inbetween-dialog.mjs';import {SimpleTimeline} from '/src/simple-timeline.mjs';import {Timeline} from '/src/timeline.mjs';
window.errors=[];window.applied=[];window.opened=[];window.editor=new Editor({demo:false});
window.reset=()=>{const report=emptyDocument(),figure=report.figure_types[0];report.canvas_width=480;report.canvas_height=270;report.auto_easing=true;
report.keyframes=[4,3,5,1].map((duration,index)=>{const object=createObject(figure,5,120+index*55,165);object.scale=.55;object.angles=object.angles.map((angle,joint)=>angle+(joint%2?-1:1)*index*.18);return createFrame([object],duration)});editor.load(report);editor.selectFrame(1);};reset();
window.inbetween=new InsertInbetweenDialog({editor,getSettings:()=>({onionCount:3,onionAhead:true,onionOpacity:.22}),onApply:result=>{applied.push(result);simple.update();},onError:error=>errors.push(error.message)});
const open=indices=>{opened.push(indices);return inbetween.open(indices)};
window.simple=new SimpleTimeline(document.querySelector('#simple'),editor,{onInsertInbetween:open});
window.advanced=new Timeline(document.querySelector('#advanced'),editor,{mode:'frames',onInsertInbetween:open,onError:error=>errors.push(error.message)});
document.querySelector('#open').onclick=()=>open([1,3]);document.querySelector('#reset').onclick=()=>{reset();simple.update();};window.ready=true;
</script></body></html>`;
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  const file = path.resolve(root, `.${new URL(req.url, 'http://localhost').pathname}`);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try { res.setHeader('content-type', file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream'); res.end(await readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({...(process.env.STYK_BROWSER_PATH ? {executablePath: process.env.STYK_BROWSER_PATH}
  : process.platform === 'win32' ? {channel: 'chrome'} : {}), headless: true, args: ['--disable-gpu']});
const page = await browser.newPage({viewport: {width: 1180, height: 880}, deviceScaleFactor: 1});
const pageErrors = [], timings = {};
page.on('pageerror', error => pageErrors.push(error.message));
const waitPreview = () => page.locator('[data-inbetween-insert]').waitFor({state: 'visible'}).then(() => page.waitForFunction(() => !document.querySelector('[data-inbetween-insert]').disabled));
try {
  await page.goto(url); await page.waitForFunction(() => window.ready);
  const original = await page.evaluate(() => JSON.stringify(editor.report));
  await page.locator('#open').click(); await waitPreview();
  assert.deepEqual(await page.evaluate(() => [editor._undo.length, JSON.stringify(editor.report)]), [0, original]);
  assert.equal(await page.locator('[aria-label="Interpolation ratio"]').getAttribute('step'), '0.001');
  await page.locator('[aria-label="Interpolation percentage"]').fill('37.5'); await waitPreview();
  assert.equal(await page.locator('[aria-label="Interpolation ratio"]').inputValue(), '.375'.replace(/^\./, '0.'));
  await page.locator('[aria-label="Cycle onion skins"]').click(); await waitPreview();
  assert.equal(await page.evaluate(() => inbetween.onionMode), 'settings');
  await page.locator('[aria-label="Cycle onion skins"]').click(); await waitPreview();
  assert.equal(await page.evaluate(() => inbetween.onionMode), 'none');
  await page.locator('[aria-label="Cycle onion skins"]').click(); await waitPreview();
  assert.equal(await page.evaluate(() => inbetween.onionMode), 'adjacent');
  const pixels = await page.locator('canvas[aria-label="Inbetween pose preview"]').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data; let dark=0;
    for(let i=0;i<data.length;i+=4)if(data[i]<160&&data[i+1]<160&&data[i+2]<160)dark++;
    return dark;
  });
  assert.ok(pixels > 100, 'The worker preview must contain the figure, not an empty placeholder.');
  await page.locator('[aria-label="Preview selected keyframe"]').selectOption('3'); await waitPreview();
  assert.match(await page.locator('.styk-inbetween-timing').innerText(), /before keyframe 4/);
  const burst = await page.evaluate(async () => {
    for(let i=0;i<160;i++)inbetween.setRatio(i/200);inbetween.setRatio(.375);
    const started=performance.now();await new Promise(requestAnimationFrame);return performance.now()-started;
  });
  timings.inputBurstRafMs = burst; await waitPreview();
  const workerStats = await page.evaluate(() => ({...inbetween.renderer.stats}));
  assert.equal(workerStats.snapshots, 1, 'Ratio previews should reuse the worker document snapshot.');
  assert.ok(workerStats.pending <= 1, 'Slider changes must coalesce to one in-flight preview.');
  await mkdir(artifacts, {recursive: true}); await page.screenshot({path: path.join(artifacts, 'insert-inbetween-dialog.png')});
  await page.locator('[data-inbetween-cancel]').click();
  assert.deepEqual(await page.evaluate(() => [editor._undo.length, JSON.stringify(editor.report)]), [0, original]);

  // Simple mode context menu dispatches the actual selected native range.
  await page.evaluate(() => {simple.selected=new Set([1,3]);simple.showMenu(1,230,190)});
  await page.getByRole('menuitem', {name: 'Insert inbetween…', exact: true}).click(); await waitPreview();
  assert.deepEqual(await page.evaluate(() => opened.at(-1)), [1,3]);
  await page.locator('[data-inbetween-insert]').click();
  await page.waitForFunction(() => !inbetween.dialog.open);
  assert.deepEqual(await page.evaluate(() => [editor.report.keyframes.length,editor._undo.length,applied.at(-1).indices]), [6,1,[1,4]]);
  assert.deepEqual(await page.evaluate(() => simple.selectedFrameIndices), [1,4]);
  assert.deepEqual(await page.evaluate(() => advanced.selectedFrameIndices), [1,4]);
  await page.evaluate(() => editor.undo()); assert.equal(await page.evaluate(() => JSON.stringify(editor.report)), original);
  await page.evaluate(() => editor.redo()); assert.equal(await page.evaluate(() => editor.report.keyframes.length), 6);
  await page.evaluate(() => {editor.undo();simple.update();advanced._setSelectedFrames([1,3],3);advanced._contextMenu({clientX:500,clientY:350,preventDefault(){},stopPropagation(){}},true)});
  await page.getByRole('menuitem', {name: 'Insert inbetween…', exact: true}).click(); await waitPreview();
  assert.deepEqual(await page.evaluate(() => opened.at(-1)), [1,3]);
  await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => inbetween.dialog.open), false);

  // Invalid text and unsupported blend never mutate document/history.
  await page.locator('#open').click(); await waitPreview();
  await page.locator('[aria-label="Interpolation percentage"]').fill('150');
  assert.equal(await page.locator('[data-inbetween-insert]').isDisabled(), true);
  await page.evaluate(async()=>{inbetween.setRatio(.2);inbetween.setRatio(NaN);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)});
  assert.equal(await page.locator('[data-inbetween-insert]').isDisabled(), true,'A queued valid preview must not re-enable Insert after invalid text.');
  await page.locator('[data-inbetween-cancel]').click();
  await page.evaluate(() => {editor.report.keyframes[0].background_id=1;editor.report.keyframes[0].background_id_b=2;editor.report.keyframes[0].background_mix=100;editor.report.keyframes[1].background_id=3;inbetween.open([1])});
  await page.getByRole('alert').waitFor({state:'visible'});
  assert.match(await page.getByRole('alert').innerText(), /more than two background/);
  assert.equal(await page.evaluate(() => editor._undo.length), 0);
  await page.locator('[data-inbetween-cancel]').click();
  await page.evaluate(() => {reset();simple.update();inbetween.open([1])}); await waitPreview();
  await page.evaluate(() => editor.setFPS(30));
  assert.match(await page.getByRole('alert').innerText(), /animation changed/);
  assert.equal(await page.locator('[data-inbetween-insert]').isDisabled(), true);
  await page.locator('[data-inbetween-cancel]').click();
  // Gate the real async planner so progress/cancellation races are deterministic.
  await page.evaluate(async () => {
    const {planInsertInbetweens} = await import('/src/editor-inbetween.mjs');
    const {inbetweenPlanWire} = await import('/src/editor-inbetween-async.mjs');
    reset(); simple.update(); advanced.update();
    window.realInsertAsync = editor.insertInbetweenFramesAsync.bind(editor);
    window.jobs = [];
    editor.insertInbetweenFramesAsync = (ratio, indices, options) => realInsertAsync(ratio, indices, {
      ...options,
      planInbetweens: () => {
        const wire = inbetweenPlanWire(planInsertInbetweens(editor, ratio, indices));
        return new Promise(resolve => {
          const job = {ratio, indices, options, finish: () => resolve(wire)}; jobs.push(job);
          options.onProgress({phase: 'sampling', completed: 1, total: 9});
          // Deliberately retain the promise after abort to exercise stale delivery.
        });
      }
    });
    inbetween.ratio = .375; inbetween.open([1, 3]);
  }); await waitPreview();
  const beforeAsync = await page.evaluate(() => JSON.stringify(editor.report));
  await page.locator('[data-inbetween-insert]').click();
  assert.equal(await page.locator('dialog').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('[aria-label="Interpolation percentage"]').isDisabled(), true);
  assert.equal(await page.locator('[data-inbetween-cancel]').isEnabled(), true);
  assert.match(await page.locator('[role=status]').innerText(), /Preparing poses.*1.*9/);
  assert.equal(await page.locator('progress').getAttribute('value'), '1');
  await page.screenshot({path: path.join(artifacts, 'insert-inbetween-progress.png')});
  await page.locator('[data-inbetween-cancel]').click();
  assert.equal(await page.evaluate(() => jobs[0].options.signal.aborted), true);
  assert.deepEqual(await page.evaluate(() => [editor._undo.length, JSON.stringify(editor.report)]), [0, beforeAsync]);
  await page.evaluate(() => inbetween.open([1])); await waitPreview();
  await page.evaluate(() => { jobs[0].options.onProgress({phase:'staging',completed:9,total:9}); jobs[0].finish(); });
  await page.waitForFunction(() => !inbetween.applying);
  assert.equal(await page.evaluate(() => inbetween.dialog.open), true);
  assert.match(await page.locator('[role=status]').innerText(), /Click preview/);
  assert.equal(await page.locator('[data-inbetween-insert]').isEnabled(), true);
  await page.locator('[data-inbetween-insert]').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => jobs[1].options.signal.aborted), true);
  await page.evaluate(() => jobs[1].finish());
  assert.deepEqual(await page.evaluate(() => [editor._undo.length, JSON.stringify(editor.report)]), [0, beforeAsync]);

  await page.evaluate(() => inbetween.open([1,3])); await waitPreview();
  await page.locator('[data-inbetween-insert]').click();
  await page.evaluate(() => {
    jobs[2].options.onProgress({phase:'animation',completed:2,total:3});
    inbetween.setRatio(.9); // Disabled controls and programmatic updates are inert.
  });
  assert.equal(await page.evaluate(() => inbetween.ratio), .375);
  await page.evaluate(() => jobs[2].finish());
  await page.waitForFunction(() => !inbetween.dialog.open);
  assert.deepEqual(await page.evaluate(() => [editor.report.keyframes.length, editor._undo.length, applied.at(-1).indices]), [6,1,[1,4]]);
  await page.evaluate(() => editor.undo());
  assert.equal(await page.evaluate(() => JSON.stringify(editor.report)), beforeAsync);
  await page.evaluate(() => inbetween.open([1])); await waitPreview();
  await page.locator('[data-inbetween-insert]').click();
  await page.evaluate(() => editor.setFPS(31));
  await page.evaluate(() => jobs[3].finish());
  await page.getByRole('alert').waitFor({state:'visible'});
  assert.match(await page.getByRole('alert').innerText(), /animation changed/);
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 4);
  assert.equal(await page.locator('[aria-label="Interpolation percentage"]').isEnabled(), true);
  await page.locator('[data-inbetween-cancel]').click();

  await page.evaluate(() => {reset();inbetween.open([1]);}); await waitPreview();
  await page.locator('[data-inbetween-insert]').click();
  await page.evaluate(() => reset());
  assert.equal(await page.evaluate(() => jobs[4].options.signal.aborted), true);
  await page.evaluate(() => jobs[4].finish());
  await page.getByRole('alert').waitFor({state:'visible'});
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 4);
  await page.locator('[data-inbetween-cancel]').click();
  assert.deepEqual(pageErrors, []);
  const result = {passed:true, verified:['Worker preview contains actual geometry','Ratio/onion changes reuse one bounded worker snapshot','160-input burst coalesces','Cancel and Escape preserve document','Simple and Advanced context callbacks preserve selected range','Multiple insertions use one undo and select inserted keys','Undo/redo','Invalid and unsupported transitions reject','Concurrent document edit invalidates preview','Async progress disables editing while Cancel stays active','Cancel and Escape abort real async planning with no history','Stale completion/progress cannot affect a reopened dialog','Async range commit is one undo','Concurrent edits and document replacement reject async insertion'], pixels, workerStats, timings, pageErrors};
  await writeFile(path.join(artifacts,'insert-inbetween-dialog.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2));
} catch (error) {
  await mkdir(artifacts,{recursive:true}); await page.screenshot({path:path.join(artifacts,'insert-inbetween-dialog-failure.png')});
  console.error(JSON.stringify(await page.evaluate(()=>({dialog:inbetween.dialog.outerHTML,errors,busy:inbetween.busy,pending:inbetween.pendingPreview,ratio:inbetween.ratio,worker:inbetween.renderer?.stats,frames:editor.report.keyframes.slice(0,2).map(frame=>[frame.background_id,frame.background_id_b,frame.background_mix])})),null,2));
  throw error;
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
