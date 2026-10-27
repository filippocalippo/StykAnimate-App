import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {readdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {diagnosticDetails,sanitizeError,validateSnapshot,ERROR_MODULES} from '../src/telemetry-schema.mjs';
import {TelemetryAccumulator} from '../src/telemetry-core.mjs';
import {TelemetryService} from '../desktop/telemetry.cjs';

test('worker diagnostics retain cause, stage and safe source frames through wrapping',()=>{
  const error=Object.assign(new RangeError('SECRET PROJECT'),{code:'export_memory_limit',stack:'RangeError: SECRET PROJECT\n at f (C:\\PRIVATE\\src\\export-memory.mjs:42:2)\n at f (https://private.example/src/engine/engine-export-worker.mjs:100:2)'});
  const details=diagnosticDetails(error,'prepare','worker_failed');
  assert.ok(!/SECRET|PRIVATE|private.example/.test(JSON.stringify(details)));
  const wrapped=Object.assign(new Error('Worker failed'),details);
  const entry=sanitizeError(wrapped,'export');
  assert.equal(entry.type,'RangeError');assert.equal(entry.code,'out_of_memory');assert.equal(entry.stage,'prepare');
  assert.deepEqual(entry.frames,[{module:'export-memory.mjs',line:42},{module:'engine-export-worker.mjs',line:100}]);
  assert.equal(sanitizeError({code:'export_canvas_lost'}).code,'device_lost');
  assert.equal(sanitizeError({code:'ENOSPC'}).code,'disk_full');
  assert.deepEqual(sanitizeError({telemetryFrames:[{module:'camera-monitor.mjs',line:20,secret:'private'},{module:'secret.mjs',line:2},{module:'app.mjs',line:-1}]}).frames,[{module:'camera-monitor.mjs',line:20}]);
});

test('the error module allowlist names the modules that ship, the engine modules among them',()=>{
  const shipped=new Set();
  const walk=directory=>{for(const entry of readdirSync(new URL(directory,import.meta.url),{withFileTypes:true})){
    if(entry.isDirectory()){if(!['node_modules','pkg','locales'].includes(entry.name))walk(`${directory}${entry.name}/`);}
    else shipped.add(entry.name);
  }};
  walk('../src/');walk('../desktop/');
  assert.equal(new Set(ERROR_MODULES).size,ERROR_MODULES.length,'no module is listed twice');
  assert.deepEqual(ERROR_MODULES.filter(name=>!shipped.has(name)),[],'every listed module exists');
  for(const name of ['engine-stage.mjs','engine-owner.mjs','engine-export-worker.mjs','engine-preview-worker.mjs','engine-drawing-worker.mjs','engine-worker.mjs'])assert.ok(ERROR_MODULES.includes(name),name);
  const stack=['Error: SECRET',' at a (https://private.example/src/engine/engine-owner.mjs:7:1)',' at b (https://private.example/src/engine/engine-stage.mjs:9:2)',' at c (https://private.example/src/playback-worker.mjs:3:4)'].join('\n');
  assert.deepEqual(sanitizeError(Object.assign(new Error('SECRET'),{stack}),'app').frames,[{module:'engine-owner.mjs',line:7},{module:'engine-stage.mjs',line:9}]);
});

function saturated() {
  const acc=new TelemetryAccumulator();acc.configure({analytics:true,diagnostics:true});
  for(const size of ['unknown','under-1mb','1-10mb'])for(const complexity of ['unknown','under-100','100-999','1000-9999'])
    for(let i=0;i<3;i++)acc.operation({operation:'playback',stage:'playback',size,complexity,outcome:'succeeded'},17);
  return acc;
}
const failure={operation:'save',stage:'complete',format:'native',outcome:'failed'};
test('failure context displaces playback without exceeding the fixed allowance or hiding dropped samples',()=>{
  const acc=saturated();assert.equal(acc.data.operationContexts.length,12);
  acc.operation(failure,200);acc.operation(failure,400);
  assert.equal(acc.data.operationContexts.length,12);assert.equal(acc.data.counters.dropped_operation_contexts,3);
  const row=acc.data.operationContexts.find(row=>row.outcome==='failed');assert.equal(row.timing.count,2);assert.equal(row.timing.sum,600);
  acc.operation({operation:'playback',stage:'playback',format:'pivot',outcome:'succeeded'},20);
  assert.equal(acc.data.counters.dropped_operation_contexts,4);
});

test('desktop aggregation also retains later failures and validates a bounded upload',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'styk-diagnostic-priority-'));
  const service=await new TelemetryService({directory,schemaPath:path.resolve('src/telemetry-schema.mjs'),version:'0.5.6',siteUrl:'https://example.test'}).init({timers:false});
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  await service.setConsent({analytics:true,diagnostics:true});
  service.record({epoch:service.epoch,data:saturated().drain()});
  const acc=new TelemetryAccumulator();acc.configure({analytics:true,diagnostics:true});acc.operation(failure,600);
  acc.error(Object.assign(new Error('PRIVATE'),diagnosticDetails({code:'export_canvas_lost',telemetryFrames:[{module:'export-canvas.mjs',line:10}]},'encode')),'export');
  service.record({epoch:service.epoch,data:acc.drain()});
  const snapshot=service.preview().snapshots[0];validateSnapshot(snapshot);
  assert.equal(snapshot.operationContexts.length,12);assert.equal(snapshot.counters.dropped_operation_contexts,3);
  assert.equal(snapshot.operationContexts.find(row=>row.outcome==='failed').timing.count,1);
  assert.equal(snapshot.errors[0].code,'device_lost');assert.ok(JSON.stringify(snapshot).length<=32768);
});
