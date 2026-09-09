import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChannelTimelineTracks} from '../src/timeline.mjs';
import {animationChannelId, animationPropertyValue} from '../src/animation-channels.mjs';
import {emptyDocument, defaultFigure, createFrame, createObject} from '../src/demo.mjs';
import {Editor} from '../src/editor.mjs';

const targetA={kind:'segment',uid:7,handleId:1,figureTypeId:1};
const targetB={...targetA,figureTypeId:2};
const targetGlobal={kind:'segment',uid:7,handleId:1};
function fixture() {
  const report=emptyDocument(), a=report.figure_types[0], b=defaultFigure(2);
  a.name='Alpha rig'; b.name='Beta rig'; b.segments[0].secondary={rgb:[40,80,120],a:0};
  report.figure_types.push(b);
  report.keyframes=[createFrame([createObject(a,7,100,200)],5),createFrame([createObject(b,7,200,200)],5)];
  return report;
}
const layers=[{id:'layer-1',kind:'layer',name:'Characters',figureUids:[7],locked:false}];
function channel(target,property,tick,id) {
  return {id:animationChannelId(target,property),target,property,keys:[{id,tick,value:.5,interpolation:'linear'}]};
}
function curves() {
  return [channel(targetA,'opacity',1,'alpha'),channel(targetB,'opacity',6,'beta'),channel(targetB,'gradientOpacity',7,'gradient')];
}

test('collapsed scoped segment rows retain exact lookup, target identity and sparse summary references', () => {
  const report=fixture(), channels=curves(), projection=buildChannelTimelineTracks(layers,channels,report);
  assert.equal(projection.tracks.length,1); assert.equal(projection.byId.size,1);
  assert.deepEqual(projection.roots[0].keys.map(key=>key.tick),[1,6,7]); assert.equal(projection.byId.size,1);
  for(const source of channels) {
    const row=projection.byId.get(`channel:${source.id}`);
    assert.deepEqual(row.target,source.target);
    assert.equal(row.parentId,`segment:7:1@${source.target.figureTypeId}`);
    assert.deepEqual(row.keys[0].refs,[{channelId:source.id,keyId:source.keys[0].id}]);
  }
  assert.equal(projection.byId.get('segment:7:1@1').name,'Segment 1 · Alpha rig');
  assert.equal(projection.byId.get('segment:7:1@2').name,'Segment 1 · Beta rig');
  assert.equal(projection.byId.get(`channel:${animationChannelId(targetA,'gradientOpacity')}`),undefined);
  for(const id of ['segment:7:1@0','segment:7:1@01','segment:7:1@2@3','segment:7:1@nope','segment:7:1@2:extra']) assert.equal(projection.byId.get(id),undefined);
  assert.ok([...projection.byId.values()].every(row=>row.kind!=='figure'&&(row.target?.uid===undefined||row.target.uid===7)), 'Direct lookup does not allocate unrelated figures');
});

test('expanded mixed-rig scopes are separate rows without duplicate base placeholders or shared keys', () => {
  const report=fixture(), channels=curves(), expanded=new Set(['layer-1','figure:7','segment:7:1@1','segment:7:1@2']);
  const projection=buildChannelTimelineTracks(layers,channels,report,expanded);
  const segments=projection.tracks.filter(row=>row.kind==='segment'&&row.handleId===1);
  assert.deepEqual(segments.map(row=>row.id),['segment:7:1@1','segment:7:1@2']);
  assert.deepEqual(segments[0].keys.map(key=>key.tick),[1]);
  assert.deepEqual(segments[1].keys.map(key=>key.tick),[6,7]);
  assert.equal(projection.tracks.filter(row=>row.parentId==='segment:7:1@1').length,4);
  assert.equal(projection.tracks.filter(row=>row.parentId==='segment:7:1@2').length,6);
  assert.equal(projection.tracks.filter(row=>row.kind==='segment'&&row.handleId===2).length,1,'Unkeyed base handles retain one row');
  assert.equal(new Set(projection.tracks.map(row=>row.id)).size,projection.tracks.length);
  const global=channel(targetGlobal,'opacity',3,'global');
  const coexist=buildChannelTimelineTracks(layers,[global,...channels],report,expanded);
  assert.deepEqual(coexist.tracks.filter(row=>row.kind==='segment'&&row.handleId===1).map(row=>row.id),['segment:7:1','segment:7:1@1','segment:7:1@2']);
  assert.deepEqual(coexist.byId.get('segment:7:1').keys.map(key=>key.tick),[3]);
});

test('scoped gradient placeholders resolve their definition even when the first UID pose uses a plain segment', () => {
  const projection=buildChannelTimelineTracks(layers,[channel(targetB,'opacity',6,'beta')],fixture());
  const scoped=projection.byId.get(`channel:${animationChannelId(targetB,'gradientOpacity')}`);
  assert.equal(scoped.name,'Gradient opacity'); assert.equal(scoped.keys.length,0); assert.deepEqual(scoped.target,targetB);
  const global=projection.byId.get(`channel:${animationChannelId(targetGlobal,'gradientOpacity')}`);
  assert.equal(global,undefined);
  assert.deepEqual(projection.byId.get('figure:7').children.filter(row=>row.kind==='segment'&&row.handleId===1).map(row=>row.id),['segment:7:1','segment:7:1@2']);
});

test('dormant scoped rows preserve existing curve edits while new keys require a matching displayed pose', () => {
  const editor=new Editor({demo:false}).load(fixture());
  editor.addAnimationKeys(curves().flatMap(source=>source.keys.map(key=>({target:source.target,property:source.property,...key}))));
  const projection=buildChannelTimelineTracks(editor.layers,editor.animationChannels,editor.report);
  const row=projection.byId.get(`channel:${animationChannelId(targetB,'opacity')}`);
  editor.seek(0); assert.equal(animationPropertyValue(editor.report,editor.evaluatedFrame,row.target,row.property),undefined);
  assert.throws(()=>editor.addAnimationKey(row.target,row.property,0),/finite|missing|present|exist|value/i);
  const key=row.keys[0]; editor.moveAnimationKeys([{channelId:row.channelId,keyIds:[key.id]}],1);
  assert.equal(editor.animationChannel(targetB,'opacity').keys[0].tick,7);
  editor.seek(7); const value=editor.addAnimationKey(row.target,row.property,8);
  assert.equal(value.tick,8); assert.equal(editor.animationChannel(targetA,'opacity').keys[0].tick,1);
});
