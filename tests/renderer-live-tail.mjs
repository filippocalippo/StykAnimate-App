/** Actual UI playback: CPU calls, asynchronous queue completion and frame pacing. */
import {chromium, _electron as electron} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), source = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const suffix = (process.env.STYK_GPU_SUFFIX || '').replace(/[^a-z0-9-]/gi, '');
const startTick = Number(process.env.STYK_START_TICK || 1824), endTick = Number(process.env.STYK_END_TICK || 1872);
const stallTrace = process.env.STYK_TRACE_STALL === '1';
const desktop = process.env.STYK_DESKTOP === '1';
const output = path.join(root, 'artifacts', `renderer-live-tail${suffix}`); await mkdir(output, {recursive: true});
const desktopApp = desktop ? await electron.launch({args: [root], cwd: root, timeout: 45000, env: {...process.env, STYK_USER_DATA_DIR: path.join(output, 'profile')}}) : null;
const browser = desktop ? null : await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = desktop ? await desktopApp.firstWindow() : await browser.newPage({viewport: {width: 1600, height: 1000}}), errors = [];
  let resolveStall; const stallPromise = new Promise(resolve => { resolveStall = resolve; });
  if (stallTrace) await page.exposeBinding('stykTraceGap', (_, event) => resolveStall(event));
  page.on('pageerror', error => errors.push(error.message));
  if (!desktop) await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  if (desktop) {
    await desktopApp.evaluate(({BrowserWindow}) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1600, 1000); window.show(); window.focus(); });
    await page.waitForTimeout(200);
    const delta = await page.evaluate(() => ({width: 1120 - styk.state.renderer.width, height: 652 - styk.state.renderer.height}));
    await desktopApp.evaluate(({BrowserWindow}, delta) => { const window = BrowserWindow.getAllWindows()[0], [width, height] = window.getContentSize(); window.setContentSize(width + delta.width, height + delta.height); }, delta);
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => styk.editor.markSaved()); await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(source, '.piv'), {timeout: 180000});
  await page.evaluate(async ({startTick, endTick, adaptPrefetch}) => {
    const {PlaybackCache} = await import('/src/playback.mjs'); window.__workerPackets = [];
    const receive = PlaybackCache.prototype._receive; PlaybackCache.prototype._receive = function(message) {
      if (message.type === 'packet') __workerPackets.push({tick: message.tick, revision: message.revision, at: performance.now(), byteLength: message.packet?.byteLength, compileMs: message.packet?.compileMs});
      const result = receive.call(this, message);
      if (adaptPrefetch && message.type === 'packet' && message.revision === this.revision && this._prefetchRanks?.size) {
        void this.prepareRange([...this._prefetchRanks.keys()], {replacePending: true}).catch(error => { if (error.name !== 'AbortError') console.error(error); });
      }
      return result;
    };
    const e = styk.editor; e.setFPS(16); e.markSaved(); styk.state.loop = false; styk.state.loopRange = {startTick, endTick}; e.seek(startTick); styk.fit();
  }, {startTick, endTick, adaptPrefetch: process.env.STYK_ADAPT_PREFETCH === '1'});
  await page.waitForTimeout(2500);
  const configuration = await page.evaluate(async () => {
    const {cameraMatrix} = await import('/src/renderer.mjs'), renderer = styk.state.renderer;
    const records = window.__gpuLive = {uploads: [], presented: [], queues: [], regular: [], raf: [], longTasks: [], start: performance.now()};
    let previous = performance.now(); const raf = now => {
      const elapsed = now - previous; records.raf.push({at: now, elapsed}); previous = now;
      if (window.__watchGap && !records.triggered && styk.state.playing && records.presented.length > 2 && elapsed > 120) {
        records.triggered = {at: now, elapsed, lastTick: records.presented.at(-1)?.tick};
        performance.mark('styk-stall-detected'); void window.stykTraceGap(records.triggered);
      }
      requestAnimationFrame(raf);
    }; requestAnimationFrame(raf);
    new PerformanceObserver(list => { for (const entry of list.getEntries()) records.longTasks.push({at: entry.startTime, ms: entry.duration}); }).observe({entryTypes: ['longtask']});
    const prepare = renderer.prepareFrame.bind(renderer); renderer.prepareFrame = (packet, options) => {
      const start = performance.now(), result = prepare(packet, options);
      records.uploads.push({tick: packet.tick, at: start, cpuMs: performance.now() - start, packetBytes: packet.byteLength, packetScale: packet.scale, packetResolution: packet.resolution,
        matrixScale: Math.hypot(...cameraMatrix({report: options.report, frame: packet.frame, view: options.view}).slice(0, 2)) * renderer.dpr,
        workerCompileMs: packet.compileMs, clipping: packet.clipping, gpuBytes: renderer.preparedFrames.bytes});
      return result;
    };
    const prepared = renderer.renderPrepared.bind(renderer); renderer.renderPrepared = (key, options) => {
      const start = performance.now(), result = prepared(key, options), submitted = performance.now(), tick = Number(String(key).split(':').at(-1));
      records.presented.push({tick, at: submitted, cpuMs: submitted - start, success: result, playing: styk.state.playing, gpuBytes: renderer.preparedFrames.bytes});
      performance.mark(`styk-tick-${tick}`);
      renderer.device.queue.onSubmittedWorkDone().then(() => records.queues.push({tick, submitted, callbackAt: performance.now(), elapsed: performance.now() - submitted}));
      return result;
    };
    const regular = renderer.render.bind(renderer); renderer.render = options => { const start = performance.now(), result = regular(options); records.regular.push({at: start, cpuMs: performance.now() - start, tick: styk.editor.tick, stats: structuredClone(renderer.stats)}); return result; };
    return {view: {...styk.state.view}, workerScale: styk.state.playbackScale, dpr: renderer.dpr, viewport: [renderer.width, renderer.height], fps: styk.editor.report.fps, readyWorker: styk.performance().playback, adapter: renderer.stats.adapter};
  });
  let traceClient, profileClient;
  if (process.env.STYK_CPU_PROFILE === '1') {
    profileClient = await (desktop ? desktopApp.context() : page.context()).newCDPSession(page);
    await profileClient.send('Profiler.enable'); await profileClient.send('Profiler.setSamplingInterval', {interval: 500});
    await profileClient.send('Profiler.start');
  }
  if (process.env.STYK_GPU_TRACE === '1') {
    traceClient = desktop ? await desktopApp.context().newCDPSession(page) : await browser.newBrowserCDPSession();
    const {categories} = await traceClient.send('Tracing.getCategories');
    await writeFile(path.join(output, 'trace-categories.json'), JSON.stringify(categories, null, 2));
    await traceClient.send('Tracing.start', {transferMode: 'ReturnAsStream', traceConfig: {recordMode: 'recordContinuously', traceBufferSizeInKb: 65536, includedCategories: [
      'gpu', 'cc', 'viz', 'blink.user_timing', 'renderer.scheduler', 'devtools.timeline', 'v8', 'toplevel',
      'disabled-by-default-gpu.service', 'disabled-by-default-gpu.device', 'disabled-by-default-gpu.debug', 'disabled-by-default-skia', 'disabled-by-default-v8.gc',
    ]}});
  }
  await page.evaluate(value => { window.__watchGap = value; }, stallTrace);
  await page.locator('#play-button').click();
  const playbackEnded = page.waitForFunction(() => !styk.state.playing, null, {timeout: Math.max(45000, (endTick - startTick) * 100)}).then(() => null);
  const detectedStall = stallTrace ? await Promise.race([stallPromise, playbackEnded]) : await playbackEnded;
  if (!detectedStall) { await page.evaluate(() => styk.state.renderer.device.queue.onSubmittedWorkDone()); await page.waitForTimeout(350); }
  if (profileClient) {
    const {profile} = await profileClient.send('Profiler.stop');
    await writeFile(path.join(output, 'main.cpuprofile'), JSON.stringify(profile));
  }
  if (traceClient) {
    const completed = new Promise(resolve => traceClient.once('Tracing.tracingComplete', resolve)); await traceClient.send('Tracing.end');
    if (detectedStall) await page.evaluate(() => { if (styk.state.playing) document.querySelector('#play-button').click(); });
    const {stream} = await completed; const chunks = [];
    for (;;) { const item = await traceClient.send('IO.read', {handle: stream}); chunks.push(item.base64Encoded ? Buffer.from(item.data, 'base64') : Buffer.from(item.data)); if (item.eof) break; }
    await traceClient.send('IO.close', {handle: stream}); await writeFile(path.join(output, 'chrome-trace.json'), Buffer.concat(chunks));
  }
  const measurements = await page.evaluate(() => ({...__gpuLive, workerPackets: __workerPackets, playback: styk.performance().playback, endedTick: styk.editor.tick}));
  const frames = measurements.presented.filter(p => p.success && p.playing).filter((p, i, a) => i === 0 || p.tick !== a[i - 1].tick);
  const intervals = frames.slice(1).map((p, i) => ({tick: p.tick, previousTick: frames[i].tick, ms: p.at - frames[i].at}));
  const quantiles = values => { const v = values.sort((a, b) => a - b); return {p50: v[Math.floor(v.length * .5)] || 0, p95: v[Math.floor(v.length * .95)] || 0, max: v.at(-1) || 0}; };
  const workerCompileCounts = {}; for (const packet of measurements.workerPackets.filter(p => p.revision === measurements.playback.revision)) workerCompileCounts[packet.tick] = (workerCompileCounts[packet.tick] || 0) + 1;
  const summary = {frames: frames.length, firstTick: frames[0]?.tick, lastTick: frames.at(-1)?.tick, elapsedMs: frames.at(-1)?.at - frames[0]?.at, workerCompileCounts,
    intervals: quantiles(intervals.map(p => p.ms)), queueCompletionCallbacks: quantiles(measurements.queues.map(q => q.elapsed)), uploads: quantiles(measurements.uploads.map(p => p.cpuMs)), preparedCPU: quantiles(frames.map(p => p.cpuMs)),
    largestPacket: Math.max(...measurements.uploads.map(p => p.packetBytes)), slowIntervals: intervals.filter(p => p.ms > 90), longTasks: measurements.longTasks, regular: measurements.regular.map(p => ({tick: p.tick, cpuMs: p.cpuMs}))};
  await writeFile(path.join(output, 'report.json'), JSON.stringify({environment: desktop ? 'Visible Electron desktop' : 'Headless Chrome', diagnosticAdaptivePrefetch: process.env.STYK_ADAPT_PREFETCH === '1', configuration, summary, measurements, detectedStall, errors, limitation: 'One GPU. onSubmittedWorkDone callback delay includes GPU queue execution and main-thread callback scheduling; it is not a pure GPU timestamp or display scanout measurement. Optional stall mode freezes a bounded Chrome trace and stops playback at the first active rAF gap above120ms.'}, null, 2));
  console.log(JSON.stringify({configuration, summary, errors}, null, 2));
  if (errors.length || (!detectedStall && frames.length !== endTick - startTick) || frames.some((p, i) => p.tick !== startTick + i)) throw new Error('Actual playback failed to present every expected tick.');
} finally {if (desktopApp) await desktopApp.close(); else await browser.close();}
