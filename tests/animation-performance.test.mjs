import test from 'node:test';
import assert from 'node:assert/strict';
import {createPerformanceEditor} from './animation-mode-performance-fixture.mjs';
import {planAuthoredClipboard} from '../src/frame-clipboard-authored.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit} from '../src/native-property-edit.mjs';

test('edit history and Simple undo/redo do not serialize or revalidate unrelated keys',()=>{
  const e=createPerformanceEditor({frames:20,figures:4,channels:4,keys:1000});e.enableFrameDrafts();
  const before=e.report._styk.animation,unrelated=before.channels.slice(1);let reads=0;
  for(const channel of unrelated){const key=channel.keys[900],value=key.value;Object.defineProperty(key,'value',{enumerable:true,get(){reads++;return value;}});}
  e.beginAnimationEdit({kind:'figure',uid:1},'x');e.previewAnimationEdit(700);e.commitAnimationEdit();
  const after=e.report._styk.animation;
  assert.ok(e.historySize<1000000,'Only changed channels should be charged to this command.');
  e.undo();assert.equal(e.report._styk.animation,before);
  e.redo();assert.equal(e.report._styk.animation,after);
  assert.equal(reads,0,'Untouched key payloads must not be visited by history.');
  assert.deepEqual(e.animationChannels.slice(1),unrelated);
});

test('history replay remains copy-on-write through subsequent key edits',()=>{
  const e=createPerformanceEditor({frames:20,figures:4,channels:4,keys:100});
  const initial=structuredClone(e.report._styk.animation);
  e.addAnimationKey({kind:'figure',uid:1},'x',e.tick,700);
  const after=structuredClone(e.report._styk.animation);
  e.undo();e.redo();
  e.addAnimationKey({kind:'figure',uid:1},'x',e.tick,900);
  e.undo();assert.deepEqual(e.report._styk.animation,after);
  e.undo();assert.deepEqual(e.report._styk.animation,initial);
  e.redo();e.redo();assert.equal(e.evaluatedFrame.objects[0].root_x,900);
});

test('bounded pose history releases expired captures on long native tracks',()=>{
  const e=createPerformanceEditor({frames:1000,figures:5,channels:5,keys:100});e.historyLimit=8;e.enableFrameDrafts();
  for(let i=0;i<60;i++) {
    const token=beginNativePropertyEdit(e,'root_y');previewNativePropertyEdit(token,300+i);commitNativePropertyEdit(token);
    e.commitFrameDraft({mode:'update'});
  }
  assert.equal(e._undo.length,8);
  assert.ok(Object.keys(e.report._styk.frameSources).length<=10,'Expired working poses should not accumulate.');
  for(let i=0;i<8;i++)e.undo();for(let i=0;i<8;i++)e.redo();
  assert.equal(e.evaluatedFrame.objects[0].root_y,359);validateAnimationDocument(e.report);
});

test('incremental Add validation produces the same animation as full validation',()=>{
  for(const automatic of [false,true]) {
    const e=createPerformanceEditor({frames:20,figures:4,channels:4,keys:100});e.report.auto_easing=automatic;
    const frame=structuredClone(e.evaluatedFrame);e._assignFrameId(frame);
    const input={frames:[frame],assets:{layers:{additions:[]}},index:e.report.keyframes.length,nextFrameIdentity:e._nextFrameIdentity};
    assert.deepEqual(planAuthoredClipboard(e,{...input,trustedSource:true}),planAuthoredClipboard(e,input));
    frame._styk.easing={interpolation:'not-an-easing'};
    assert.throws(()=>planAuthoredClipboard(e,{...input,trustedSource:true}));
  }
});

test('an append keeps untouched native Scene/Camera tracks native and enforces shifted tick limits',()=>{
  const e=createPerformanceEditor({frames:1000,figures:5,channels:5,keys:100});e.enableFrameDrafts({mode:'add'});
  e.addDraftFrame();
  assert.ok(e.animationChannels.every(channel=>channel.property!=='pose'));
  const channel=e.animationChannels[0];e.setAnimationKey(channel.id,channel.keys.at(-1).id,{tick:10000000});
  e.commitFrameDraft({mode:'update'});
  const before=e.report.keyframes.length;
  assert.throws(()=>e.addDraftFrame(),/ten-million/);assert.equal(e.report.keyframes.length,before);
});

test('native append fast path preserves earlier figure, camera and background interpolation',()=>{
  for(const interpolation of ['hold','linear','ease-in','ease-out','bezier']) {
    const e=createPerformanceEditor({frames:6,figures:3,channels:1,keys:5}),report=e.serialize();
    report.backgrounds=[{background_id:4,kind:2,color:0xff112233,name:'A'},{background_id:5,kind:2,color:0xff887766,name:'B'}];
    report.keyframes.forEach((frame,i)=>{
      frame.camera={is_default:false,x:i*30,y:17,scale:1+i/10,angle_rad:i/20};
      Object.assign(frame,{background_id:4,background_id_b:5,background_mix:i*20});
      frame._styk.easing={interpolation,...(interpolation==='bezier'?{bezier:[.2,.1,.6,.9]}:{})};
    });
    e.load(report);e.selectFrame(5);
    const sample=tick=>{
      e.seek(tick);const frame=e.evaluatedFrame;
      return structuredClone({objects:frame.objects.map(({runtime_segments,...object})=>object),camera:frame.camera,
        background:[frame.background_id,frame.background_id_b,frame.background_mix,frame._stykBackgroundColor]});
    };
    const before=Array.from({length:e.totalTicks},(_,tick)=>sample(tick));
    e.selectFrame(5);e.enableFrameDrafts({mode:'add'});e.addDraftFrame();
    assert.ok(e.animationChannels.every(channel=>channel.property!=='pose'));
    before.forEach((frame,tick)=>assert.deepEqual(sample(tick),frame,`${interpolation} at tick ${tick}`));
    validateAnimationDocument(e.report);
  }
});
