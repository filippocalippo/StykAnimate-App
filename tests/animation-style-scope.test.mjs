import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, defaultFigure, createObject, createFrame} from '../src/demo.mjs';
import {animationChannelId, normalizeAnimationTarget, findAnimationChannel, validateAnimationDocument} from '../src/animation-channels.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

const globalTarget = {kind:'segment',uid:7,handleId:1};
const targetA = {...globalTarget,figureTypeId:1}, targetB = {...globalTarget,figureTypeId:2};
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
  const editor=ownedEditorFor({demo:false}, fixture()), original=editor.report;
  const missing=setChannels(fixture(),[channel({...globalTarget,figureTypeId:3},'opacity',[])]);
  assert.throws(()=>validateAnimationDocument(missing),/missing figure definition 3/);
  // The engine refuses the document with the editor's message key (its parameters are not carried).
  assert.throws(()=>editor.load(missing),error=>error.messageKey==='errors.animationChannels.animationSegmentScopeReferencesMissingFigureDefinition'); assert.equal(editor.report,original);
});
