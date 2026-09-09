/** Actual sandboxed Electron renderer -> PNG worker -> IPC -> FFmpeg, decoded independently. */
import {_electron as electron} from 'playwright';
import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), output = path.join(root, 'artifacts', 'native-video-renderer');
await mkdir(output, {recursive: true});
const ffmpeg = path.join(root, 'build', 'video-encoder', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const app = await electron.launch({args: [root], cwd: root, timeout: 45000,
  env: {...process.env, STYK_USER_DATA_DIR: path.join(output, `profile-${Date.now()}`)}});
let result;
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready && typeof window.stykDesktop?.beginVideoFrame === 'function', undefined, {timeout: 30000});
  result = await page.evaluate(async () => {
    const [{encodeNativeVideo}, {getExportCapabilities}] = await Promise.all([import('/src/native-video-export.mjs'), import('/src/export-capabilities.mjs')]);
    const checks = [], assert = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
    const capabilities = await getExportCapabilities({width: 160, height: 90, fps: 16}), files = [], reports = [];
    assert(typeof window.require === 'undefined', 'Sandboxed renderer exposes no Node require');
    const canvas = new OffscreenCanvas(160, 90), ctx = canvas.getContext('2d');
    const renderFrame = index => {
      ctx.clearRect(0, 0, 160, 90);
      ctx.fillStyle = index < 8 ? '#f00000' : '#0000f0'; ctx.fillRect(10, 10, 140, 70);
      ctx.fillStyle = '#fff'; ctx.fillRect(50 + index * 3, 35, 8, 20); return canvas;
    };
    const options = {width: 160, height: 90, fps: 16, totalFrames: 16, renderFrame, quality: 0.95};
    for (const format of ['mp4', 'avi', 'wmv']) {
      const capability = capabilities.formats.find(item => item.id === format);
      assert(capability?.supported, `${format} native encoder is actually available: ${capability?.reason || ''}`);
      const progress = [], chunks = [], started = performance.now();
      const desktop = {...window.stykDesktop,
        writeVideoChunk: async (token, bytes) => { chunks.push(bytes.byteLength); return window.stykDesktop.writeVideoChunk(token, bytes); }};
      const blob = await encodeNativeVideo({...options, desktop, format, onProgress: value => progress.push(value)});
      assert(blob.size > 1000 && blob.type === capability.mimeType, `${format}: output has its real container MIME type`);
      assert(progress.filter(item => item.phase === 'rendering').map(item => item.completed).join(',') === Array.from({length: 16}, (_, i) => i + 1).join(','), `${format}: all16source frames report progress`);
      assert(Math.max(...chunks) <= 262144, `${format}: each IPC payload stays within256KiB`);
      const bytes = [...new Uint8Array(await blob.arrayBuffer())];
      files.push({name: `animation.${format}`, bytes}); reports.push({format, bytes: blob.size, encodeMs: performance.now() - started, chunkCount: chunks.length, maxChunkBytes: Math.max(...chunks)});
    }
    const losslessCanvas=new OffscreenCanvas(161,91),losslessContext=losslessCanvas.getContext('2d'),pixels=losslessContext.createImageData(161,91);
    for(let y=0;y<91;y++)for(let x=0;x<161;x++)pixels.data.set([x,(y*2)%256,(x*3+y*7)%256,255],(y*161+x)*4);
    losslessContext.putImageData(pixels,0,0);
    const presetReports=[];
    for(const [format,codec] of [['mp4','mpeg4'],['avi','ffv1'],['avi','rawvideo']]){
      const lossless=codec==='ffv1'||codec==='rawvideo',width=lossless?161:160,height=lossless?91:90;
      const blob=await encodeNativeVideo({...options,format,codec,width,height,totalFrames:lossless?2:16,renderFrame:lossless?()=>losslessCanvas:renderFrame});
      const name=`codec-${codec}.${format}`;files.push({name,bytes:[...new Uint8Array(await blob.arrayBuffer())]});presetReports.push({format,codec,name,bytes:blob.size,width,height,frames:lossless?2:16,lossless});
      assert(blob.type===(format==='avi'?'video/x-msvideo':'video/mp4'),`${codec}: explicit preset retains the actual container`);
    }
    const controller = new AbortController(); let cancelled;
    try { await encodeNativeVideo({...options, format: 'mp4', signal: controller.signal, onProgress: value => { if (value.completed === 3) controller.abort(); }}); }
    catch (error) { cancelled = error.name; }
    assert(cancelled === 'AbortError', 'Native encoding can cancel after three frames');
    const recovered = await encodeNativeVideo({...options, format: 'mp4', totalFrames: 1}); assert(recovered.size > 100, 'A new native export succeeds after cancellation');
    let rendererError;
    try { await encodeNativeVideo({...options, format: 'avi', renderFrame: () => { throw new Error('Expected renderer failure'); }}); }
    catch (error) { rendererError = error.message; }
    assert(rendererError === 'Expected renderer failure', 'Frame-rendering errors survive native cleanup');
    const afterError = await encodeNativeVideo({...options, format: 'avi', totalFrames: 1}); assert(afterError.size > 100, 'A new native export succeeds after renderer failure');
    return {checks, reports, capabilities, presetReports, files};
  });
  assert.deepEqual(errors, []); result.errors = errors;
  for (const file of result.files) await writeFile(path.join(output, file.name), Uint8Array.from(file.bytes));
  delete result.files;
  await page.evaluate(async () => {
    const {emptyDocument, createObject} = await import('/src/demo.mjs');
    const report = emptyDocument(); report.canvas_width = 160; report.canvas_height = 90; report.fps = 16;
    const figure = report.figure_types[0]; figure.segments = [{...figure.segments[0], length: 60, thickness: 6, angle_rad: 0}]; figure.segment_count = 1;
    const frame = report.keyframes[0]; frame.duration_raw = 15; frame.objects = [createObject(figure, 1, 50, 45)]; frame.object_draw_order = [0]; frame.object_draw_order_unique_ids = [1];
    report.keyframes.push({...structuredClone(frame),duration_raw:1});
    window.styk.editor.load(report);
    window.styk.editor.addAnimationKeys([{target:{kind:'scene'},property:'color',tick:0,value:0xfff00000,interpolation:'hold'}, {target:{kind:'scene'},property:'color',tick:8,value:0xff0000f0,interpolation:'hold'}]);
    window.styk.editor.markSaved();
  });
  result.uiFiles = [];
  for (const format of ['mp4', 'avi', 'wmv', 'gif-sequence', 'svg-sequence']) {
    const destination = path.join(output, `ui-${format}.${format.endsWith('sequence') ? 'zip' : format}`);
    await app.evaluate(({dialog}, filename) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: filename}); }, destination);
    await page.locator('[data-action="export"]').first().click();
    const button = page.locator(`[data-action="export-${format}"]`);
    await button.waitFor({state:'visible'});
    await page.waitForFunction(id => !document.querySelector(`[data-action="export-${id}"]`)?.disabled, format);
    if (format === 'mp4') {
      assert.ok(await page.locator('#dialog').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth+1),'Export dialog must not scroll horizontally');
      await page.screenshot({path:path.join(output,'export-dialog.png')});
    }
    await button.click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open, undefined, {timeout:30000});
    const bytes = await readFile(destination); assert.ok(bytes.length > 100, `Actual${format}button saves a nonempty native file`);
    result.uiFiles.push({format, bytes:bytes.length, filename:path.basename(destination)});
    result.checks.push(`Actual export dialog ${format}button completes rendering and native save`);
    if(format.endsWith('sequence')){
      const entries=[];let offset=0;
      while(bytes.readUInt32LE(offset)===0x04034b50){
        const size=bytes.readUInt32LE(offset+18),nameSize=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28),start=offset+30+nameSize+extra;
        entries.push({name:bytes.subarray(offset+30,offset+30+nameSize).toString(),content:[...bytes.subarray(start,start+size)]});offset=start+size;
      }
      assert.equal(entries.length,17);const metadata=JSON.parse(Buffer.from(entries.at(-1).content).toString());assert.equal(metadata.fps,16);assert.equal(metadata.totalFrames,16);
      const pixels=await page.evaluate(async({format,samples})=>{
        const output=[];
        for(const sample of samples){const url=URL.createObjectURL(new Blob([new Uint8Array(sample.content)],{type:format==='svg-sequence'?'image/svg+xml':'image/gif'})),image=new Image();
          try{image.src=url;await image.decode();const canvas=new OffscreenCanvas(160,90),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);output.push([...ctx.getImageData(20,20,1,1).data]);}
          finally{URL.revokeObjectURL(url);}}
        return output;
      },{format,samples:[entries[0],entries[15]]});
      assert.ok(pixels[0][0]>220&&pixels[0][2]<25&&pixels[1][2]>220&&pixels[1][0]<25,`Actual${format}UI export composes Scene keys at absolute ticks`);
      result.uiFiles.at(-1).decoded={frames:16,first:pixels[0],last:pixels[1]};
    }
  }
  for(const [format,codec] of [['mp4','mpeg4'],['avi','ffv1'],['avi','rawvideo']]){
    const destination=path.join(output,`ui-${format}-${codec}.${format}`);
    await app.evaluate(({dialog},filename)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:filename});},destination);
    await page.locator('[data-action="export"]').first().click();
    await page.locator('.export-settings summary').click();
    await page.locator(`#export-${format}-codec option[value="${codec}"]`).waitFor({state:'attached'});
    await page.locator(`#export-${format}-codec`).selectOption(codec);
    assert.ok(await page.locator('#dialog').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth+1),'Expanded export settings must not scroll horizontally');
    if(codec==='ffv1')await page.screenshot({path:path.join(output,'export-codecs.png')});
    await page.locator(`[data-action="export-${format}"]`).click();
    await page.waitForFunction(()=>!document.querySelector('#dialog').open,undefined,{timeout:30000});
    const bytes=await readFile(destination);assert.ok(bytes.length>100);
    result.uiFiles.push({format,codec,bytes:bytes.length,filename:path.basename(destination)});
    result.checks.push(`Actual ${format} codec selector exports ${codec} through native Save`);
  }
  const zipResults = await page.evaluate(async () => {
    // File reads remain in the test host; decode ZIPs after this process exits.
    window.styk.editor.markSaved(); return {nodeExposed:typeof window.require !== 'undefined'};
  });
  assert.equal(zipResults.nodeExposed,false);
} finally { await app.evaluate(({app}) => app.exit(0)).catch(() => {}); }

for (const report of result.reports) {
  const filename = path.join(output, `animation.${report.format}`);
  const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', filename, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    {windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.equal(decoded.status, 0, decoded.stderr?.toString() || decoded.error?.message);
  const frameBytes = 160 * 90 * 3;
  assert.equal(decoded.stdout.length, frameBytes * 16, `${report.format} must independently decode all16frames at160×90`);
  const sample = (frame, x, y) => [...decoded.stdout.subarray(frame * frameBytes + (y * 160 + x) * 3, frame * frameBytes + (y * 160 + x) * 3 + 3)];
  const first = sample(0, 25, 25), last = sample(15, 25, 25), black = sample(0, 1, 1);
  assert.ok(first[0] > 220 && first[1] < 25 && first[2] < 25, `${report.format} firstframe red decode ${first}`);
  assert.ok(last[2] > 220 && last[0] < 25 && last[1] < 25, `${report.format} lastframe blue decode ${last}`);
  assert.ok(black.every(value => value < 15), `${report.format} alpha renders over native black ${black}`);
  report.decoded = {frames: 16, width: 160, height: 90, first, last, black};
}
for (const file of result.uiFiles.filter(file => !file.format.endsWith('sequence'))) {
  const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-i',path.join(output,file.filename),'-map','0:v:0','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true,maxBuffer:8*1024*1024});
  assert.equal(decoded.status,0,decoded.stderr?.toString());assert.equal(decoded.stdout.length,160*90*3*16);
  const first=[...decoded.stdout.subarray((20*160+20)*3,(20*160+20)*3+3)],offset=15*160*90*3+(20*160+20)*3,last=[...decoded.stdout.subarray(offset,offset+3)];
  assert.ok(first[0]>220&&first[2]<25&&last[2]>220&&last[0]<25,`Actual${file.format}UI export composes Scene keys at each absolute output tick`);
  file.decoded={frames:16,width:160,height:90,first,last};
  const info=spawnSync(ffmpeg,['-hide_banner','-i',path.join(output,file.filename),'-vf','showinfo','-fps_mode','passthrough','-f','null','-'],{windowsHide:true,encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(info.status,0,info.stderr);const header=info.stderr.split('Output #')[0],expectedCodec=file.codec==='rawvideo'?'rawvideo':file.codec||(file.format==='mp4'?'h264':file.format==='avi'?'mpeg4':'wmv2');
  assert.ok(new RegExp(`Video: ${expectedCodec}\\b`).test(header),`${file.filename} actual decoder codec must be${expectedCodec}`);
  const timestamps=[...info.stderr.matchAll(/\bn:\s*\d+\s+pts:\s*\d+\s+pts_time:([\d.]+)/g)].map(match=>Number(match[1]));
  assert.equal(timestamps.length,16);timestamps.forEach((value,index)=>assert.ok(Math.abs(value-index/16)<=.0011,`${file.filename} frame${index} exacttimestamp`));
  file.decoded.codec=expectedCodec;file.decoded.timestampsSeconds=timestamps;
}
for(const preset of result.presetReports){
  const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-i',path.join(output,preset.name),'-map','0:v:0','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true,maxBuffer:8*1024*1024});
  assert.equal(decoded.status,0,decoded.stderr?.toString());assert.equal(decoded.stdout.length,preset.width*preset.height*3*preset.frames);
  if(preset.lossless){
    const expected=Buffer.alloc(preset.width*preset.height*3);
    for(let y=0;y<preset.height;y++)for(let x=0;x<preset.width;x++)expected.set([x,(y*2)%256,(x*3+y*7)%256],(y*preset.width+x)*3);
    for(let index=0;index<preset.frames;index++)assert.ok(decoded.stdout.subarray(index*expected.length,(index+1)*expected.length).equals(expected),`${preset.codec} must preserve every RGB byte at odd161×91dimensions`);
    preset.decoded={frames:preset.frames,width:preset.width,height:preset.height,pixelDifferences:0};
  }else{
    const first=[...decoded.stdout.subarray((20*160+20)*3,(20*160+20)*3+3)],offset=15*160*90*3+(20*160+20)*3,last=[...decoded.stdout.subarray(offset,offset+3)];
    assert.ok(first[0]>220&&first[2]<25&&last[2]>220&&last[0]<25);preset.decoded={frames:16,width:160,height:90,first,last};
  }
}
await writeFile(path.join(output, 'report.json'), JSON.stringify({...result, checkedAt: new Date().toISOString()}, null, 2));
console.log(JSON.stringify(result, null, 2));
