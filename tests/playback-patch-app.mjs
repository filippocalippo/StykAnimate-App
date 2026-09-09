/** Actual imported Akane edit commits, app routing, and ACK-to-ready worker timing. */
import {_electron as electron, chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const profileEnabled = process.env.STYK_PATCH_PROFILE === '1';
const suffix = (process.env.STYK_PATCH_SUFFIX || (profileEnabled ? '-profile' : '')).replace(/[^a-z0-9-]/gi, '');
const root = process.cwd(), output = path.resolve(`artifacts/playback-patch-app${suffix}`); await mkdir(output, {recursive: true});
const source = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const headless = process.env.STYK_PATCH_HEADLESS === '1';
const app = headless ? null : await electron.launch({args: [root], cwd: root, timeout: 45000, env: {...process.env, STYK_USER_DATA_DIR: path.join(output, 'profile')}});
const browser = headless ? await chromium.launch({channel: 'chrome', headless: true}) : null;
let page, profileClient, phase = 'startup'; const errors = [];
const progress = value => {phase = value; console.log(`Patch benchmark: ${value}`);};
try {
  page = app ? await app.firstWindow() : await browser.newPage({viewport: {width: 1600, height: 1000}});
  page.on('pageerror', error => errors.push(error.message));
  if (headless) await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  if (app) await app.evaluate(({BrowserWindow}) => {const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1600, 1000); win.show(); win.focus();});
  progress('import');
  await page.evaluate(() => styk.editor.markSaved()); await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(source, '.piv'), {timeout: 180000});
  await page.evaluate(async () => {
    const {PlaybackCache} = await import('/src/playback.mjs');
    const records = window.__patchBenchmark = {rows: [], longTasks: [], frames: [], load: structuredClone(styk.performance().playback)};
    records.inputs = []; for (const type of ['pointerdown', 'pointerup', 'keydown']) window.addEventListener(type, event => {
      records.inputs.push({type, at: performance.now(), trusted: event.isTrusted, target: event.target.id, key: event.key});
    }, true);
    const prepare = PlaybackCache.prototype.prepareRange;
    PlaybackCache.prototype.prepareRange = function(...args) {window.__actualPlayback = this; return prepare.apply(this, args);};
    const update = PlaybackCache.prototype.updateDocument;
    PlaybackCache.prototype.updateDocument = function(options) {
      const row = records.active, started = performance.now(), result = update.call(this, options);
      if (row) {
        row.updateCallMs = performance.now() - started; row.playbackRevision = this.revision;
        row.options = {...options};
        this._loadPromise?.then(() => {row.ackAt = performance.now(); row.patchStats = structuredClone(this.stats);}, error => {row.patchError = error.message;});
      }
      return result;
    };
    const send = PlaybackCache.prototype._sendLoad;
    PlaybackCache.prototype._sendLoad = function(message, responseType) {
      const row = records.active;
      if (row) {row.wireTypes[message.type] = (row.wireTypes[message.type] || 0) + 1; row.estimatedWireBytes += message.chunk?.estimatedBytes || 0;}
      return send.call(this, message, responseType);
    };
    const receive = PlaybackCache.prototype._receive;
    PlaybackCache.prototype._receive = function(message) {
      const row = records.active;
      if (row && message.type === 'packet' && message.tick === row.tick && message.revision === row.playbackRevision && !row.packetAt) {
        row.packetAt = performance.now(); row.workerCompileMs = message.packet.compileMs;
        const transform = message.packet.uids.indexOf(460616); row.packetRootX = message.packet.transforms[transform * 4];
      }
      return receive.call(this, message);
    };
    new PerformanceObserver(list => {for (const entry of list.getEntries()) records.longTasks.push({at: entry.startTime, ms: entry.duration});}).observe({entryTypes: ['longtask']});
    let previous = performance.now(); const frame = now => {records.frames.push({at: now, elapsed: now - previous}); previous = now; requestAnimationFrame(frame);}; requestAnimationFrame(frame);
    styk.state.settings.autosaveSeconds = 0; styk.editor.seek(1871); styk.editor.select(460616); styk.fit();
  });
  progress('warm late frame');
  await page.waitForFunction(() => window.__actualPlayback?.has(1871), null, {timeout: 120000}); await page.waitForTimeout(300);
  profileClient = profileEnabled ? await page.context().newCDPSession(page) : null;
  if (profileClient) {await profileClient.send('Profiler.enable'); await profileClient.send('Profiler.setSamplingInterval', {interval: 500});}
  for (const name of ['native', 'authored-1', 'authored-2', 'authored-3']) {
    progress(name);
    if (name === 'authored-1') {
      await page.evaluate(() => styk.editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}));
      await page.waitForFunction(() => __actualPlayback.documentRevision === styk.editor.revision && __actualPlayback.has(1871), null, {timeout: 120000});
      await page.waitForTimeout(250);
    }
    if (profileClient) await profileClient.send('Profiler.start');
    await page.evaluate(name => {
      const editor = styk.editor, preparation = performance.now();
      if (editor.selectedUid !== 460616 || styk.state.drag) throw new Error('Benchmark selection changed or an external pointer gesture is active.');
      editor.beginTranslationDrag(); editor.moveSelection(1, 0, {fromStart: true});
      const row = {name, tick: editor.tick, gesturePreparationMs: performance.now() - preparation,
        selectedUid: editor.selectedUid,
        sourceCountBefore: Object.keys(editor.report._styk.frameSources || {}).length, wireTypes: {}, estimatedWireBytes: 0, started: performance.now()};
      __patchBenchmark.rows.push(row); __patchBenchmark.active = row;
      editor.commitDrag(); row.commitMs = performance.now() - row.started;
      row.expectedRootX = Math.fround(editor.geometry.objects.get(editor.selectedSlot).root.x);
    }, name);
    await page.waitForFunction(() => __patchBenchmark.active?.packetAt, null, {timeout: 120000}); await page.waitForTimeout(300);
    await page.evaluate(() => {const row = __patchBenchmark.active; row.ended = performance.now(); __patchBenchmark.active = null;});
    if (profileClient) {
      const {profile} = await profileClient.send('Profiler.stop');
      await writeFile(path.join(output, `${name}.cpuprofile`), JSON.stringify(profile));
    }
  }
  const result = await page.evaluate(() => ({...__patchBenchmark, active: undefined, renderer: styk.state.renderer.stats.backend, adapter: styk.state.renderer.stats.adapter}));
  for (const row of result.rows) {
    row.ackMs = row.ackAt - row.started; row.readyMs = row.packetAt - row.started;
    row.longTasks = result.longTasks.filter(task => task.at + task.ms >= row.started && task.at < row.packetAt);
    row.maxFrameGapMs = Math.max(0, ...result.frames.filter(frame => frame.at >= row.started && frame.at < row.packetAt).map(frame => frame.elapsed));
    if (row.wireTypes['load-chunk'] || row.patchStats.loadKind === 'document' || row.packetRootX !== row.expectedRootX)
      throw new Error(`Edit ${row.name} did not use a correct retained playback mirror.`);
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({...result, errors, headless,
    limitation: 'Four actual editor translation commits on one GPU. Ready latency includes the application\'s 250ms idle prefetch debounce; gesture preparation, commit calls, patch ACK and worker compilation are separately recorded. Autosave disabled for this isolated benchmark.'}, null, 2));
  await page.screenshot({path: path.join(output, 'edited-akane.png')});
  console.log(JSON.stringify({rows: result.rows, errors}, null, 2)); if (errors.length) throw new Error('Browser errors during edit patch benchmark.');
} catch (error) {
  const snapshot = await page?.evaluate(() => ({ready: window.styk?.ready, tick: window.styk?.editor.tick,
    revision: window.styk?.editor.revision, playback: window.styk?.performance?.().playback,
    records: window.__patchBenchmark, cached: window.__actualPlayback ? [...__actualPlayback.cache.keys()] : null})).catch(() => null);
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({phase, error: error.stack, errors, snapshot}, null, 2));
  if (profileClient) {const result = await profileClient.send('Profiler.stop').catch(() => null);
    if (result?.profile) await writeFile(path.join(output, `${phase}-failure.cpuprofile`), JSON.stringify(result.profile));}
  throw error;
} finally {
  if (app) {await app.evaluate(({BrowserWindow}) => {for (const win of BrowserWindow.getAllWindows()) win.destroy();}).catch(() => {}); await app.close();}
  await browser?.close();
}
