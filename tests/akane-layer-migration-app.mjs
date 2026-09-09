/** Real app worker-backed joined layer assignment on the imported Akane scene. */
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output = path.resolve('artifacts/akane-layer-migration-app'); await mkdir(output, {recursive: true});
const source = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1600, height: 1000}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => styk.editor.markSaved()); await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(source, '.piv'), {timeout: 180000});
  await page.evaluate(async () => {
    const {PlaybackCache} = await import('/src/playback.mjs');
    const prepare = PlaybackCache.prototype.prepareRange;
    PlaybackCache.prototype.prepareRange = function(...args) {window.__migrationPlayback = this; return prepare.apply(this, args);};
    const editor = styk.editor; styk.state.settings.autosaveSeconds = 0;
    editor.createLayer('Moved rig'); editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
    editor.seek(1871); editor.select(460611);
    if (!editor.object?.join) throw new Error('Expected Akane child UID460611 to remain attached at the final pose.');
    window.__migration = {longTasks: [], frames: [], progress: [], uid: 460611, ticks: [0, 300, 800, 1200, 1500, 1700, 1850, 1870, 1871]};
    const records = window.__migration, pointSnapshot = () => {
      const snapshot = []; for (const tick of records.ticks) {
        editor.seek(tick); snapshot.push({tick, points: [...editor.geometry.objects.values()].map(g => ({uid:g.obj.unique_id, root:g.root,
          joints:[...g.joints].map(([id,p])=>[id,p.x,p.y])})).sort((a,b)=>a.uid-b.uid)});
      } return snapshot;
    };
    window.__migrationSnapshot = pointSnapshot; records.beforePoints = pointSnapshot();
    records.before = {revision: editor.revision, history: editor._undo.length, sources: Object.keys(editor.report._styk.frameSources || {}).length};
    const planner = editor._layerMigrationPlanner;
    editor.setLayerMigrationPlanner((params, options) => planner(params, {...options, onProgress(value) {records.progress.push({...value, at:performance.now()}); options.onProgress?.(value);}}));
    const edit = editor._layerEdit;
    editor._layerEdit = function(...args) {const start=performance.now(); try{return edit.apply(this,args);} finally {records.commitMs=performance.now()-start;}};
    new PerformanceObserver(list => {for(const entry of list.getEntries()) records.longTasks.push({at:entry.startTime,ms:entry.duration});}).observe({entryTypes:['longtask']});
    let previous=performance.now(); const frame=now=>{records.frames.push({at:now,ms:now-previous});previous=now;requestAnimationFrame(frame);};requestAnimationFrame(frame);
  });
  await page.waitForFunction(() => window.__migrationPlayback?.has(1871), null, {timeout: 120000}); await page.waitForTimeout(250);
  await page.evaluate(() => {
    const records=__migration;records.loadChunksBefore=__migrationPlayback.stats.loadChunks;records.started=performance.now();
    window.__migrationPromise=styk.layers.onAssignFigures([records.uid],'layer-2').then(value=>{records.result=value;records.ended=performance.now();}, error=>{records.error=error.message;records.ended=performance.now();});
  });
  const dialog = page.locator('dialog[open]').filter({hasText:'Move figures to layer'});
  await dialog.waitFor({state:'visible',timeout:30000}); await page.screenshot({path:path.join(output,'migration-progress.png')});
  await page.waitForFunction(() => __migration.ended, null, {timeout: 180000});
  const result = await page.evaluate(async () => {
    const records=__migration, editor=styk.editor; records.afterPoints=__migrationSnapshot();
    records.after={revision:editor.revision,history:editor._undo.length,sources:Object.keys(editor.report._styk.frameSources||{}).length,
      layer:editor.layerForUid(records.uid),historyBytes:editor._undo.at(-1)?.bytes};
    records.loadChunksAfter=__migrationPlayback.stats.loadChunks;
    records.longTasks=records.longTasks.filter(entry=>entry.at+entry.ms>=records.started&&entry.at<records.ended);
    records.frames=records.frames.filter(entry=>entry.at>=records.started&&entry.at<records.ended);
    editor.undo();records.undo={layer:editor.layerForUid(records.uid),sources:Object.keys(editor.report._styk.frameSources||{}).length,points:__migrationSnapshot()};
    editor.redo();records.redo={layer:editor.layerForUid(records.uid),points:__migrationSnapshot()};
    records.renderer=styk.state.renderer.stats.backend;return records;
  });
  assert.equal(result.error,undefined);assert.equal(result.after.layer,'layer-2');assert.equal(result.after.history,result.before.history+1);
  assert.deepEqual(result.afterPoints,result.beforePoints);assert.deepEqual(result.undo.points,result.beforePoints);assert.deepEqual(result.redo.points,result.beforePoints);
  assert.equal(result.undo.layer,'layer-1');assert.equal(result.undo.sources,result.before.sources);assert.equal(result.redo.layer,'layer-2');assert.deepEqual(errors,[]);
  const summary={uid:result.uid,ticks:result.ticks,elapsedMs:result.ended-result.started,commitMs:result.commitMs,
    maxFrameGapMs:Math.max(0,...result.frames.map(frame=>frame.ms)),longTasks:result.longTasks,before:result.before,after:result.after,
    progressEvents:result.progress.length,loadChunksBefore:result.loadChunksBefore,loadChunksAfter:result.loadChunksAfter,renderer:result.renderer,errors,
    verified:'Nine complete-scene joint snapshots exact after joined assignment, undo and redo; layer panel callback uses actual retained playback planner and visible cancellable progress dialog.'};
  await writeFile(path.join(output,'report.json'),JSON.stringify(summary,null,2));await page.screenshot({path:path.join(output,'moved-akane.png')});console.log(JSON.stringify(summary,null,2));
} catch(error) {await writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,errors,state:await page.evaluate(()=>window.__migration).catch(()=>null)},null,2));throw error;}
finally {await browser.close();}
