/** Actual Akane UI joins trace. No source file is modified. Requires the local app. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts');
const origin = process.env.STYK_URL || 'http://127.0.0.1:47831';
const source = process.env.STYK_JOIN_FILE || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const frameIndex = Number(process.env.STYK_JOIN_FRAME || 1478);
const label = (process.env.STYK_JOIN_LABEL || '').replace(/[^a-z0-9_-]/gi, '-');
const stem = `joininteraction${label ? `-${label}` : ''}`;
await mkdir(output, {recursive: true});
const sourceBytes = await readFile(source);
const report = {file: source, sourceBytes: sourceBytes.length,
  sourceSHA256: createHash('sha256').update(sourceBytes).digest('hex'), frameIndex,
  traces: [], errors: [], consoleErrors: [], checkedAt: new Date().toISOString()};
const save = () => writeFile(path.join(output, `${stem}-profile.json`), JSON.stringify(report, null, 2));
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1700, height: 1100}});
page.setDefaultTimeout(180000);
page.on('pageerror', error => report.errors.push(error.stack));
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
try {
  await page.goto(origin); await page.waitForFunction(() => window.styk?.ready);
  console.log('Application ready; importing the exact Akane PIV through the file input.');
  await page.evaluate(() => styk.editor.markSaved());
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name,
    path.basename(source).replace(/\.piv$/i, ''));
  report.loaded = await page.evaluate(() => ({name: styk.editor.name, frames: styk.editor.report.keyframes.length,
    definitions: styk.editor.report.figure_types.length, import: styk.state.lastImport,
    renderer: styk.state.renderer.stats.backend, adapter: styk.state.renderer.stats.adapter}));
  if (report.loaded.renderer !== 'WebGPU') throw new Error('This trace requires actual WebGPU.');
  console.log('Imported', JSON.stringify(report.loaded)); await save();
  report.plan = await page.evaluate(async index => {
    const {worldToScreen, screenToWorld} = await import('/src/renderer-geometry.mjs');
    const {editor: e, state} = styk;
    e.selectFrame(index); e.markSaved(); state.onion = false; styk.fit();
    const frame = e.frame, geometry = e.geometry, types = new Map(e.report.figure_types.map(f => [f.figure_type_id, f]));
    const depth = slot => {
      const chain = [], seen = new Set(); let current = slot;
      while (frame.objects[current]) {
        if (seen.has(current)) return {cycle: true, chain};
        seen.add(current); chain.push(current);
        if (!frame.objects[current].join) break;
        current = frame.objects[current].join.target_object_slot;
      }
      return {depth: chain.length - 1, chain};
    };
    const candidates = frame.objects.flatMap((object, slot) => {
      if (!object.join) return [];
      const g = geometry.objects.get(slot), graph = depth(slot);
      if (!g || graph.cycle) return [];
      return [{slot, uid: object.unique_id, figureTypeId: object.figure_type_id, name: types.get(object.figure_type_id)?.name,
        ...graph, segments: g.segments.length, staticSegments: g.segments.filter(s => s.static).length}];
    }).sort((a, b) => b.depth - a.depth || b.staticSegments / Math.max(1, b.segments) - a.staticSegments / Math.max(1, a.segments));
    const child = candidates.find(candidate => candidate.staticSegments > 0) || candidates[0];
    if (!child) throw new Error('No joined child exists in the requested frame.');
    const childGeometry = geometry.objects.get(child.slot);
    const staticSegment = childGeometry.segments.filter(s => s.static)
      .sort((a, b) => Math.hypot(b.end.x-childGeometry.root.x,b.end.y-childGeometry.root.y)
        - Math.hypot(a.end.x-childGeometry.root.x,a.end.y-childGeometry.root.y))[0];
    let dynamic;
    for (let chainIndex = 1; chainIndex < child.chain.length && !dynamic; chainIndex++) {
      const slot = child.chain[chainIndex], downstream = frame.objects[child.chain[chainIndex-1]], g = geometry.objects.get(slot);
      const segmentsById = new Map(g.segments.map(s => [s.seg.segment_id, s]));
      let handle = downstream.join?.target_handle_id, seen = new Set();
      while (handle && !seen.has(handle)) {
        seen.add(handle); const s = segmentsById.get(handle); if (!s) break;
        if (!s.static && Math.hypot(s.end.x-s.start.x,s.end.y-s.start.y) > 0.2) {
          dynamic = {slot, uid: g.obj.unique_id, index: s.index, handle: s.seg.segment_id,
            name: types.get(g.obj.figure_type_id)?.name, chainIndex, controlsAttachment: true}; break;
        }
        handle = s.seg.parent_id;
      }
    }
    if (!dynamic) for (let chainIndex = 1; chainIndex < child.chain.length && !dynamic; chainIndex++) {
      const g = geometry.objects.get(child.chain[chainIndex]);
      const s = g.segments.find(s => !s.static && Math.hypot(s.end.x-s.start.x,s.end.y-s.start.y)>0.2);
      if (s) dynamic = {slot:g.slot, uid:g.obj.unique_id,index:s.index,handle:s.seg.segment_id,
        name:types.get(g.obj.figure_type_id)?.name,chainIndex,controlsAttachment:false};
    }
    const rootSlot = child.chain.at(-1), component = e.resolveTranslationSelection(new Set([child.uid]));
    window.joinTrace = {child, rootSlot, component, dynamic, types, worldToScreen, screenToWorld,
      staticSegment: staticSegment ? {slot:child.slot, uid:child.uid,index:staticSegment.index,handle:staticSegment.seg.segment_id} : null};
    window.joinTrace.capture = () => {
      const g = e.geometry;
      return {revision:e.revision, selectedUid:e.selectedUid, selectedJoint:e.selectedJoint,
        undoCount:e._undo.length, figureStates:component.affectedSlots.map(slot => {
          const object=e.frame.objects[slot], evaluated=g.objects.get(slot);
          return {slot,uid:object.unique_id,join:object.join?{...object.join}:null,
            canonicalRoot:{x:object.root_x,y:object.root_y}, evaluatedRoot:{...evaluated.root},
            angles:[...object.angles]};
        })};
    };
    return {objects:frame.objects.length, joins:frame.objects.filter(o=>o.join).length,
      child, staticSegment:window.joinTrace.staticSegment, dynamic,
      canonicalRoot:{slot:rootSlot,uid:frame.objects[rootSlot].unique_id},
      componentFigures:component.affectedSlots.length, deepestCandidates:candidates.slice(0,8),
      camera:frame.camera, view:{...state.view}};
  }, frameIndex);
  console.log('Join graph plan', JSON.stringify(report.plan)); await save();

  for (const kind of ['child-origin', 'static-endpoint', 'ancestor-dynamic-endpoint']) {
    const target = await page.evaluate(async kind => {
      const {editor:e,state}=styk, trace=joinTrace;
      const selected = kind==='child-origin' ? trace.child : kind==='static-endpoint' ? trace.staticSegment : trace.dynamic;
      if (!selected) return {skip:`No ${kind} candidate found.`};
      e.select(selected.uid, kind==='child-origin' ? -1 : selected.index); e.markSaved();
      const g=e.geometry.objects.get(selected.slot), segment=kind==='child-origin'?null:g.segments[selected.index];
      const world=segment?segment.end:g.root;
      // Keep the imported camera. Center only the editor view, at a useful zoom,
      // so the targeted native handle can receive an actual pointer event.
      const rect=document.getElementById('viewport').getBoundingClientRect();
      state.view.scale=Math.min(6,Math.max(1,state.view.scale));
      const relative=trace.worldToScreen(world,{report:e.report,frame:e.frame,view:{x:0,y:0,scale:state.view.scale}});
      state.view.x=rect.width*.5-relative.x; state.view.y=rect.height*.45-relative.y;
      state.dirtyRender=true;
      window.dispatchEvent(new Event('resize'));
      // View state is consumed by a real render request without mutating document poses.
      e.select(selected.uid, kind==='child-origin' ? -1 : selected.index);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const p=trace.worldToScreen(world,{report:e.report,frame:e.frame,view:state.view});
      const next={x:p.x+60,y:p.y-35};
      const intended=trace.screenToWorld(next,{report:e.report,frame:e.frame,view:state.view});
      trace.before=trace.capture(); trace.kind=kind;
      return {uid:selected.uid,slot:selected.slot,jointIndex:segment?.index??-1,handle:segment?.seg.segment_id??0,
        static:Boolean(segment?.static),world:{...world},screen:{x:rect.x+p.x,y:rect.y+p.y},
        expectedDelta:{x:intended.x-world.x,y:intended.y-world.y},
        originEndpointDistances:g.segments.map(s=>({index:s.index,handle:s.seg.segment_id,static:s.static,
          worldDistance:Math.hypot(s.end.x-g.root.x,s.end.y-g.root.y)})).sort((a,b)=>a.worldDistance-b.worldDistance).slice(0,8)};
    }, kind);
    if (target.skip) {report.traces.push({kind,...target}); await save(); continue;}
    await page.mouse.move(target.screen.x,target.screen.y);
    const started=performance.now(); await page.mouse.down();
    const down=await page.evaluate(()=>({dragKind:styk.state.drag?.kind??null,selectedUid:styk.editor.selectedUid,
      selectedJoint:styk.editor.selectedJoint,static:Boolean(styk.editor.geometry.objects.get(styk.editor.selectedSlot)?.segments[styk.editor.selectedJoint]?.static),
      toast:document.getElementById('toast')?.textContent,editorDragging:styk.editor.dragging}));
    await page.mouse.move(target.screen.x+60,target.screen.y-35,{steps:6});
    const moving=await page.evaluate(()=>({dragKind:styk.state.drag?.kind??null,selectedUid:styk.editor.selectedUid,
      selectedJoint:styk.editor.selectedJoint,translations:styk.state.drag?.translations?[...styk.state.drag.translations]:[],
      toast:document.getElementById('toast')?.textContent}));
    await page.screenshot({path:path.join(output,`${stem}-${kind}.png`)});
    await page.mouse.up();
    const outcome=await page.evaluate(()=>{
      const {editor:e,state}=styk, before=joinTrace.before, after=joinTrace.capture();
      e.markSaved(); clearTimeout(state.recoveryTimer);
      const changed=after.figureStates.map((a,i)=>{
        const b=before.figureStates[i];
        const angleChanges=a.angles.reduce((n,value,j)=>n+(Math.abs(value-b.angles[j])>1e-8),0);
        const canonicalDelta={x:a.canonicalRoot.x-b.canonicalRoot.x,y:a.canonicalRoot.y-b.canonicalRoot.y};
        const evaluatedDelta={x:a.evaluatedRoot.x-b.evaluatedRoot.x,y:a.evaluatedRoot.y-b.evaluatedRoot.y};
        return {slot:a.slot,uid:a.uid,join:a.join,canonicalBefore:b.canonicalRoot,canonicalAfter:a.canonicalRoot,
          evaluatedBefore:b.evaluatedRoot,evaluatedAfter:a.evaluatedRoot,canonicalDelta,evaluatedDelta,angleChanges};
      });
      const result={selectedUid:e.selectedUid,selectedJoint:e.selectedJoint,dragKind:state.drag?.kind??null,
        toast:document.getElementById('toast')?.textContent,undoCommands:after.undoCount-before.undoCount,
        changedCanonicalRoots:changed.filter(o=>Math.hypot(o.canonicalDelta.x,o.canonicalDelta.y)>1e-7).length,
        changedEvaluatedRoots:changed.filter(o=>Math.hypot(o.evaluatedDelta.x,o.evaluatedDelta.y)>1e-7).length,
        changedAngles:changed.reduce((sum,o)=>sum+o.angleChanges,0),figures:changed,
        graphIntact:changed.every((o,i)=>JSON.stringify(o.join)===JSON.stringify(before.figureStates[i].join))};
      if(result.undoCommands>0) e.undo(); e.markSaved(); clearTimeout(state.recoveryTimer);
      const restored=joinTrace.capture();
      result.undoRestoresRoots=restored.figureStates.every((o,i)=>
        Math.hypot(o.evaluatedRoot.x-before.figureStates[i].evaluatedRoot.x,o.evaluatedRoot.y-before.figureStates[i].evaluatedRoot.y)<1e-5);
      return result;
    });
    report.traces.push({kind,target,down,moving,outcome,interactionMs:performance.now()-started});
    console.log('TRACE',JSON.stringify({kind,targetUid:target.uid,targetJoint:target.jointIndex,
      down,changedCanonicalRoots:outcome.changedCanonicalRoots,changedEvaluatedRoots:outcome.changedEvaluatedRoots,
      changedAngles:outcome.changedAngles,undoCommands:outcome.undoCommands,graphIntact:outcome.graphIntact,
      undoRestoresRoots:outcome.undoRestoresRoots}));
    await save();
  }
  report.checks=[];
  const check=(name,condition)=>{assert.ok(condition,name);report.checks.push({name,passed:true});};
  const body=report.traces.find(trace=>trace.kind==='child-origin');
  check('Joined child origin begins a translation gesture',body.down.dragKind==='move');
  check('Joined child origin translates the entire 105-figure component',
    body.outcome.changedEvaluatedRoots===report.plan.componentFigures && report.plan.componentFigures===105);
  check('Connected translation preserves angles, joins and one-step undo',body.outcome.changedAngles===0
    && body.outcome.graphIntact && body.outcome.undoCommands===1 && body.outcome.undoRestoresRoots);
  const staticTrace=report.traces.find(trace=>trace.kind==='static-endpoint');
  check('Normal mode does not pick a static endpoint',!staticTrace.down.static);
  check('Normal mode does not show the inert-static-handle toast',
    !/joint follows its parent/i.test(`${staticTrace.down.toast} ${staticTrace.moving.toast}`));
  check('Former static endpoint preserves joins and any body interaction remains undoable',staticTrace.outcome.graphIntact
    && staticTrace.outcome.undoRestoresRoots && staticTrace.outcome.undoCommands<=1);
  const dynamic=report.traces.find(trace=>trace.kind==='ancestor-dynamic-endpoint');
  check('Controlling dynamic ancestor begins a pose gesture',dynamic.down.dragKind==='pose' && !dynamic.down.static);
  check('Controlling ancestor still changes 36 angles and eight attached positions',
    dynamic.outcome.changedAngles===36 && dynamic.outcome.changedEvaluatedRoots===8);
  check('Ancestor pose preserves joins and one-step undo',dynamic.outcome.graphIntact
    && dynamic.outcome.undoCommands===1 && dynamic.outcome.undoRestoresRoots);
  check('No uncaught browser exceptions',report.errors.length===0);
  report.completed=true; await save();
  console.log('Join interaction trace complete:',path.join(output,`${stem}-profile.json`));
} catch(error) {
  report.failure=error.stack; await save();
  await page.screenshot({path:path.join(output,`${stem}-failure.png`)}).catch(()=>{});
  throw error;
} finally {await browser.close();}
