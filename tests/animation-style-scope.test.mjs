import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, defaultFigure, createObject, createFrame} from '../src/demo.mjs';
import {animationChannelId, normalizeAnimationTarget, findAnimationChannel, composeAnimationChannels,
  animationPropertyValue, validateAnimationDocument, sampleAnimationChannel} from '../src/animation-channels.mjs';
import {animationStyleValue, setAnimationStyle, resolveInstanceFigure} from '../src/animation-style.mjs';
import {evaluatedFrame, timeline} from '../src/pivot/geometry.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import backend from '../desktop/backend.cjs';

const globalTarget = {kind:'segment',uid:7,handleId:1};
const targetA = {...globalTarget,figureTypeId:1}, targetB = {...globalTarget,figureTypeId:2};
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-9, `${a} != ${b}`);
function fixture() {
  const report = emptyDocument(); report.figure_types.push(defaultFigure(2));
  for (const figure of report.figure_types) {
    figure.segments[0].flags |= 512;
    figure.segments[0].secondary = {rgb:[60,100,180],a:51};
  }
  report.keyframes = [1,2,1].map((id,index) => {
    const frame = createFrame([createObject(report.figure_types[id-1],7,100+index*60,200),
      createObject(report.figure_types[0],8,400,200)],index===2?1:5);
    frame._styk = {frameId:`source-${index}`}; return frame;
  });
  return report;
}
function channel(target,property,values) {
  return {id:animationChannelId(target,property),target,property,
    keys:values.map(([tick,value],index)=>({id:`k-${index}`,tick,value,interpolation:'linear'}))};
}
function curves() {
  return [channel(targetA,'opacity',[[0,1],[10,0]]),channel(targetA,'gradientOpacity',[[0,0],[10,1]]),
    channel(targetB,'opacity',[[0,.2],[10,.8]]),channel(targetB,'gradientOpacity',[[0,.8],[10,.2]])];
}
function setChannels(report,channels) { report._styk.animation = {version:1,nextKeyId:100,channels}; return report; }
function sample(report,tick) {
  const rows = timeline(report); let index=0;
  while(index+1<rows.length && rows[index+1].start<=tick) index++;
  return evaluatedFrame(report,index,rows[index].count?(tick-rows[index].start)/rows[index].count:0,tick);
}
function styleBytes(report,frame) {
  return frame.objects.map(object => {
    const figure = resolveInstanceFigure(report.figure_types.find(figure=>figure.figure_type_id===object.figure_type_id),object);
    return [figure.segments[0].transparency,figure.segments[0].secondary.a];
  });
}

test('segment definition scopes preserve legacy identities and exact independent channel lookup', () => {
  assert.deepEqual(normalizeAnimationTarget(targetA),targetA);
  assert.deepEqual(normalizeAnimationTarget({...globalTarget,figureTypeId:undefined}),globalTarget);
  assert.equal(animationChannelId(globalTarget,'opacity'),'segment:7%2F1:opacity');
  assert.equal(animationChannelId(targetA,'opacity'),'segment:7%2F1%401:opacity');
  assert.notEqual(animationChannelId(targetA,'opacity'),animationChannelId(targetB,'opacity'));
  const channels = [channel(globalTarget,'opacity',[[0,.5]]),...curves()], report=setChannels(fixture(),channels);
  assert.equal(validateAnimationDocument(report),report);
  for(const value of channels) assert.equal(findAnimationChannel(report,value.target,value.property),value);
  assert.equal(findAnimationChannel(report,{...globalTarget,figureTypeId:3},'opacity'),null,'No implicit global fallback');
  assert.deepEqual(JSON.parse(JSON.stringify(report))._styk.animation,report._styk.animation);
});

test('malformed, non-segment and missing figure scopes reject before replacing a document', () => {
  for(const figureTypeId of [0,-1,1.5,NaN,Infinity,null,'1',Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>normalizeAnimationTarget({...globalTarget,figureTypeId}),/scope|definition/);
  }
  for(const target of [{kind:'figure',uid:7},{kind:'layer',id:'layer-1'},{kind:'camera'},{kind:'scene'}]) {
    assert.throws(()=>normalizeAnimationTarget({...target,figureTypeId:1}),/Only segment/);
  }
  const editor=new Editor({demo:false}).load(fixture()), original=editor.report;
  const missing=setChannels(fixture(),[channel({...globalTarget,figureTypeId:3},'opacity',[])]);
  assert.throws(()=>validateAnimationDocument(missing),/missing figure definition 3/);
  assert.throws(()=>editor.load(missing),/missing figure definition 3/); assert.equal(editor.report,original);
});

test('native poses sharing a UID use independent continuous primary and gradient scope curves', () => {
  const report=setChannels(fixture(),curves()), before=structuredClone(report.keyframes);
  for(const tick of [0,2.5,5,7.5,10]) {
    const frame=sample(report,tick), object=frame.objects[0], target=object.figure_type_id===1?targetA:targetB;
    const other=target===targetA?targetB:targetA;
    assert.equal(object.figure_type_id,tick>=5&&tick<10?2:1);
    for(const property of ['opacity','gradientOpacity']) {
      near(animationPropertyValue(report,frame,target,property),sampleAnimationChannel(findAnimationChannel(report,target,property),tick));
      assert.equal(animationPropertyValue(report,frame,other,property),undefined);
    }
    assert.equal(frame.objects[1]._stykStyle,undefined,'Other figure identities retain native styles');
  }
  assert.deepEqual(report.keyframes,before);
});

test('retimed authored and retained poses select scope by displayed definition instead of native time', () => {
  const report=fixture(), retained=structuredClone(report.keyframes[1]); retained._styk.frameId='retained-b';
  retained.objects[0]._stykStyle={segments:{1:{opacity:.99,gradientOpacity:.98}}};
  report._styk.frameSources={'retained-b':retained};
  const editor=new Editor({demo:false}).load(report), layer=editor.layers.find(layer=>['layer','user'].includes(layer.kind));
  editor.addAnimationKeys([
    {target:{kind:'layer',id:layer.id},property:'pose',tick:0,value:{frameId:'retained-b'},interpolation:'hold'},
    {target:{kind:'layer',id:layer.id},property:'pose',tick:5,value:{frameId:'source-0'},interpolation:'hold'},
    ...curves().flatMap(value=>value.keys.map(key=>({target:value.target,property:value.property,...key}))),
  ]);
  for(const [tick,id] of [[2.5,2],[7.5,1]]) {
    const frame=sample(editor.report,tick), target=id===1?targetA:targetB;
    assert.equal(frame.objects.find(object=>object.unique_id===7).figure_type_id,id);
    for(const property of ['opacity','gradientOpacity']) near(animationPropertyValue(editor.report,frame,target,property),sampleAnimationChannel(findAnimationChannel(editor.report,target,property),tick));
  }
  assert.equal(retained.objects[0]._stykStyle.segments[1].opacity,.99,'Retained pose overlays remain immutable');
  assert.equal(validateAnimationDocument(editor.report),editor.report);
});

test('applicable scopes override global styles in either order while dormant scopes preserve fallback', () => {
  const scoped=channel(targetA,'opacity',[[0,.2],[10,.8]]), global=channel(globalTarget,'opacity',[[0,.9]]);
  for(const channels of [[scoped,global],[global,scoped]]) {
    const report=setChannels(fixture(),channels);
    near(animationPropertyValue(report,sample(report,2.5),targetA,'opacity'),.35);
    near(animationPropertyValue(report,sample(report,7.5),targetB,'opacity'),.9);
  }
  for(const scoped of [channel(targetA,'opacity',[[4,.2]]),
    {...channel(targetA,'opacity',[[0,.2]]),keys:[{id:'gap',tick:0,value:.2,passthrough:true}]}]) {
    const report=setChannels(fixture(),[scoped,global]);
    near(animationPropertyValue(report,sample(report,2),targetA,'opacity'),.9);
  }
});

test('direct style reads, writes and dormant composition never touch a mismatched definition', () => {
  const report=fixture(), frame=report.keyframes[1], object=frame.objects[0], before=structuredClone(object);
  for(const property of ['opacity','gradientOpacity']) {
    assert.equal(animationStyleValue(report.figure_types[1],object,targetA,property),undefined);
    assert.equal(setAnimationStyle(object,targetA,property,.25),object);
  }
  assert.deepEqual(object,before);
  setChannels(report,[channel(targetA,'opacity',[[0,.1]]),channel(targetA,'gradientOpacity',[[0,.2]])]);
  assert.equal(composeAnimationChannels(report,frame,6),frame);
});

test('scoped curves materialize into actual PIV primary and gradient alpha without cross-definition leakage', () => {
  const report=setChannels(fixture(),curves()), original=structuredClone(report), output=materializePivotDocument(report);
  const python=String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
store=server.ProjectStore(server.WORKSPACE)
raw,name=store.export({'document':json.load(sys.stdin),'format':'piv'})
print(json.dumps(store.import_bytes(raw,name)['document']))
`;
  const candidate=backend.pythonCandidates()[0], result=spawnSync(candidate.command,[...candidate.args,'-c',python],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify(output),encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.error?.message||result.stderr); const native=JSON.parse(result.stdout);
  assert.equal(output._styk.animation,undefined);
  for(let tick=0;tick<11;tick++) assert.deepEqual(styleBytes(native,sample(native,tick)),styleBytes(report,sample(report,tick)),`Frame ${tick}`);
  assert.deepEqual(report,original);
});
