// Actual movieclip instance insertion, recorded before its Rust implementation.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {withDraws} from '../../src/editor-draws.mjs';
import {documentOf, limb, open, nextKey, writeProject, writeReference} from './fixture-kit.mjs';
const folder = fileURLToPath(new URL('../tests/movieclip-insertion/', import.meta.url));
const views = fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-insertion/', import.meta.url));
mkdirSync(folder, {recursive: true}); mkdirSync(views, {recursive: true});
const json = value => JSON.stringify(value, (key, value) => key === 'runtime_segments' ? undefined : value);
const base = (sheet, {empty = false, slow = false, secondLayer = false, locked = false, saved = false} = {}) => {
  const e = open(documentOf([limb(), limb(), limb()], i => [180 + i * 170, 150]));
  nextKey(e, 4); e.select(1); e.moveSelection(9.5, -3.25); nextKey(e, 4); e.select(1); e.rotateFigure(.125); e.seek(0); e.select(2);
  const figure = empty ? e.createEmptyMovieclip('Empty insert') : e.createMovieclip({uids: [2], start: 0, end: 9, replace: false, name: 'Inserted clip'});
  if (slow) figure._styk.movieclip.document.fps = 12;
  const app = sheet ? {layerTimeline: true, propertyChannels: true} : {};
  const result = open(structuredClone(e.report), app);
  if (saved) result.addFigure(4);
  if (secondLayer) { result.createLayer('Second'); result.setActiveLayer('layer-2'); }
  if (locked) result.setLayerLocked(result.activeLayerId, true);
  return result;
};
const historyEvidence=(name,document,steps,app)=>{
 const editor=open(JSON.parse(json(document)),app),records=[],record=editor._record,captured=new WeakMap();let step=0,drawn=0;
 editor._record=function(command){const capturedPendingBytes=this._pendingSourceBytes??0;record.call(this,command);captured.set(command,capturedPendingBytes);const {bytes,...sized}=command;
  if(sized.sourceBytes!==undefined&&sized.frameSourceChanges)sized.frameSourceChanges=sized.frameSourceChanges.map(change=>({id:change.id,before:{exists:change.before.exists},after:{exists:change.after.exists}}));
  records.push({step,kind:command.kind,label:command.label,bytes,capturedPendingBytes,sourceBytes:command.sourceBytes??null,precomputedBytes:command.precomputedBytes??null,enumerableJSON:JSON.stringify(sized)});
 };
 const entry=command=>({kind:command.kind,label:command.label,bytes:command.bytes,capturedPendingBytes:captured.get(command)??0,layerChanges:command.layerChanges??[],...(command.commands?{commands:command.commands.map(entry)}:{})});
 const state=()=>({historySize:editor._historySize,undo:editor._undo.map(entry),redo:editor._redo.map(entry),pendingSourceBytes:editor._pendingSourceBytes??0,pendingSourceLayerChanges:editor._pendingSourceLayerChanges??[]});
 const states=[{step:0,...state()}],run=([method,...args])=>method==='@batch'?editor.movieclipBatch(args[0],()=>{let last;for(const call of args[1])last=run(call);return last;}):editor[method==='@seek'?'seek':method==='@select'?'select':method](...args);
 const source=kind=>{drawn++;if(kind==='uuid')return `d0d0d0d0-0000-4000-8000-${String(drawn).padStart(12,'0')}`;const bits=Math.imul(drawn,0x9e3779b1)>>>0;return kind==='seed'?bits:bits/2**32;};
 for(const call of steps){step++;try{withDraws(()=>run(call),source);}catch{}states.push({step,...state()});}
 return {scenario:name,historyLimit:editor.historyLimit,historyBytes:editor.historyBytes,records,states};
};

const write = (name, e, steps, sheet) => {
  const app = sheet ? {layerTimeline: true, propertyChannels: true} : {};
  writeFileSync(`${folder}/${name}.document.json`, json(e.report) + '\n');
  writeFileSync(`${folder}/${name}.scenario.json`, JSON.stringify({name, document: `${name}.document.json`, editor: app, steps}, null, 1) + '\n');
  execFileSync(process.execPath, [fileURLToPath(new URL('./edit-replay.mjs', import.meta.url)), `${folder}/${name}.scenario.json`, `${folder}/${name}.reference.json`], {stdio: 'inherit'});
  writeFileSync(`${folder}/${name}.history.json`, JSON.stringify(historyEvidence(name,e.report,steps,app))+'\n');
  const reference = JSON.parse(readFileSync(`${folder}/${name}.reference.json`, 'utf8'));
  const applied = reference.steps.find(step => step.call?.[0] === 'addFigure' && step.document && !step.error) ?? reference.steps[0];
  for (const [suffix, step] of [['applied', applied], ['final', reference.steps.findLast(step => step.document)]]) {
    const document = JSON.parse(step.document), last = open(structuredClone(document), app).totalTicks - 1;
    const ticks = [0, .25, .75, 1.5, 2.25, 3.75, 4, 4.25, 5.75, 7.5, 8, 8.25, 9.75, 11.5, 12, 12.25, 13.75, 15.5, 16, 18].filter(tick => tick <= last);
    writeReference(writeProject(views, `${name}-${suffix}`, document, ticks, {vfx: true, camera: true, scene: true}), `${name}-${suffix}`);
  }
};
for (const sheet of [false, true]) {
  const mode = sheet ? 'sheet' : 'native';
  const standard = [['@select', 1, -1], ['addFigure', 4], ['@seek', 4.25], ['undo'], ['redo'], ['undo'], ['createEmptyMovieclip', 'Drop inserted branch'], ['redo']];
  write(`insert-${mode}`, base(sheet), standard, sheet);
  write(`insert-${mode}-fraction`, base(sheet), [['@seek', 2.25], ['addFigure', 4], ['@seek', 5.75], ['undo'], ['redo'], ['undo'], ['redo']], sheet);
  write(`insert-${mode}-layer2`, base(sheet, {secondLayer: true}), standard, sheet);
  write(`insert-${mode}-empty`, base(sheet, {empty: true}), standard, sheet);
  write(`insert-${mode}-slow`, base(sheet, {slow: true}), standard, sheet);
  write(`insert-${mode}-locked`, base(sheet, {locked: true}), [['addFigure', 4], ['setLayerLocked', 'layer-1', false], ['addFigure', 4], ['undo'], ['redo']], sheet);
  write(`insert-${mode}-live`, base(sheet), [['@select', 1, -1], ['beginTranslationDrag', 'Insert after drag'], ['moveSelection', 4.5, -2.25], ['addFigure', 999],
    ['moveSelection', 1, 1], ['cancelDrag'], ['beginTranslationDrag', 'Insert after accepted drag'], ['moveSelection', 3, -1], ['addFigure', 4], ['undo'], ['redo']], sheet);
  if (!sheet) {
    write('insert-native-saved-layer2', base(false, {saved: true, secondLayer: true}), standard, false);
    write('insert-native-saved-fraction', base(false, {saved: true}), [['@seek', 2.25], ['addFigure', 4], ['addFigure', 999], ['@seek', 4], ['addFigure', 4], ['undo'], ['redo']], false);
    write('insert-native-triple', base(false), [['@seek', 2], ['addFigure', 4], ['@seek', 5], ['addFigure', 4], ['@seek', 6], ['addFigure', 4], ['undo'], ['undo'], ['redo'], ['redo']], false);
  }
  write(`insert-${mode}-repeat`, base(sheet), [['@seek', 2], ['addFigure', 4], ['@seek', 5], ['addFigure', 4], ['@seek', 7.75], ['undo'], ['undo'], ['redo'], ['redo']], sheet);
}
