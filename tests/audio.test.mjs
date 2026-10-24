import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {audioState, validateAudioState, audibleClips, rippleAudio, clipGainAt} from '../src/audio-model.mjs';
import {inspectWave, pcmWave, wavePeaks, mixAudio} from '../src/audio-pcm.mjs';
import {playbackProperties} from '../src/playback-patch.mjs';
import {documentChunks, applyDocumentChunk} from '../src/document-transport.mjs';
import {buildContainerV2, decodeDocument} from './support/native-files.mjs';

const asset = (duration = 2) => ({id:'sound-test', name:'Voice.wav', size:3, duration, chunks:[{data_base64:'AQID'}], peaks:[0,.5,1,.5]});
const editorWithAudio = () => { const editor = new Editor({layerTimeline:true}); editor.importAudio(asset(),{start:0}); return editor; };

test('repeated audio control commits do not create empty undo steps', () => {
  const editor = editorWithAudio(), track = audioState(editor.report).tracks[0], clip = track.clips[0];
  editor.setAudioTrack(track.id, {gain:.8}); const trackHistory = editor._undo.length;
  assert.equal(editor.setAudioTrack(track.id, {gain:.8}), false); assert.equal(editor._undo.length, trackHistory);
  editor.undo(); assert.equal(audioState(editor.report).tracks[0].gain, 1);
  editor.setAudioClip(clip.id, {gain:.75}); const clipHistory = editor._undo.length;
  assert.equal(editor.setAudioClip(clip.id, {gain:.75}), false); assert.equal(editor._undo.length, clipHistory);
  editor.undo(); assert.equal(audioState(editor.report).tracks[0].clips[0].gain, 1);
});
test('undoing the first import restores the exact original document',()=>{
  const editor=new Editor({layerTimeline:true}),before=JSON.stringify(editor.serialize());editor.importAudio(asset(),{start:0});editor.undo();assert.equal(JSON.stringify(editor.serialize()),before);
});
test('audio edits preserve poses, store immutable assets once and undo exactly', () => {
  const editor = editorWithAudio(), report = editor.report, pose = report.keyframes, imported = audioState(report), clip = imported.tracks[0].clips[0];
  editor.markSaved(); editor.setAudioClip(clip.id,{start:1,duration:1,fadeIn:.2,gain:.4});
  assert.equal(report.keyframes,pose); assert.equal(audioState(report).assets,imported.assets); assert.ok(editor.dirty);
  assert.ok(editor._undo.at(-1).bytes < 6000); assert.equal(editor._undo.at(-1).before,imported);
  editor.undo(); assert.equal(audioState(report),imported); assert.equal(editor.dirty,false); editor.redo(); assert.equal(audioState(report).tracks[0].clips[0].start,1);
});
test('splitting and duplicating retain source offsets without copying recordings', () => {
  const editor = editorWithAudio(), clip = audioState(editor.report).tracks[0].clips[0];
  const rightId = editor.splitAudioClip(clip.id,.75), [left,right] = audioState(editor.report).tracks[0].clips;
  assert.equal(left.duration,.75); assert.equal(right.id,rightId); assert.equal(right.offset,.75); assert.equal(right.duration,1.25);
  const copy = editor.duplicateAudioClip(rightId); assert.equal(audioState(editor.report).tracks[0].clips.find(c=>c.id===copy).start,2);
  assert.equal(Object.keys(audioState(editor.report).assets).length,1);
  editor.undo(); editor.undo(); assert.equal(audioState(editor.report).tracks[0].clips.length,1);
});
test('invalid clip edits, missing media and invalid imports reject before publication', () => {
  const editor = editorWithAudio(), state = audioState(editor.report), revision = editor.revision, clip = state.tracks[0].clips[0];
  for (const patch of [{offset:10},{start:-1},{duration:0},{gain:NaN},{fadeOut:Infinity},{assetId:'missing'}]) assert.throws(()=>editor.setAudioClip(clip.id,patch));
  assert.equal(editor.revision,revision); assert.equal(audioState(editor.report),state);
  const broken = structuredClone(editor.report); broken._styk.audio.assets = {};
  assert.throws(()=>editor.load(broken)); assert.equal(audioState(editor.report),state);
  assert.throws(()=>validateAudioState({...state,assets:{'sound-test':{...asset(),chunks:[{data_base64:'not data'}]}}}));
});
test('asset deletion is undoable and track mute/solo determine the same mix', () => {
  const editor = editorWithAudio(), first = audioState(editor.report).tracks[0], second = editor.addAudioTrack('Effects');
  editor.importAudio({...asset(),id:'sound-fx'},{trackId:second,start:0});
  editor.setAudioTrack(second,{solo:true,gain:.5}); assert.equal(audibleClips(audioState(editor.report)).length,1); assert.equal(audibleClips(audioState(editor.report))[0].gain,.5);
  editor.setAudioTrack(second,{mute:true}); assert.equal(audibleClips(audioState(editor.report)).length,0);
  editor.deleteAudioTrack(first.id); assert.equal(audioState(editor.report).assets['sound-test'],undefined); editor.undo(); assert.ok(audioState(editor.report).assets['sound-test']);
});
test('audio clipboard survives document replacement and pastes one independent clip', () => {
  const editor=editorWithAudio(),original=audioState(editor.report).tracks[0].clips[0];editor.setAudioClip(original.id,{offset:.25,duration:1});editor.copyAudioClip(original.id);
  editor.newDocument();const id=editor.pasteAudioClip(undefined,1),state=audioState(editor.report);
  assert.equal(state.tracks[0].clips[0].id,id);assert.equal(state.tracks[0].clips[0].offset,.25);assert.equal(state.tracks[0].clips[0].start,1);
  assert.equal(state.tracks[0].clips[0].duration,1);editor.undo();assert.equal(audioState(editor.report).tracks.length,0);
});
test('overlap admission bounds the mixer and prototype names cannot impersonate an asset', () => {
  const editor=editorWithAudio(),state=structuredClone(audioState(editor.report)),clip=state.tracks[0].clips[0];
  state.tracks[0].clips=Array.from({length:33},(_,index)=>({...clip,id:`clip-${index}`}));assert.throws(()=>validateAudioState(state),/32 audio/);
  state.tracks[0].clips=[{...clip,assetId:'toString'}];assert.throws(()=>validateAudioState(state),/missing recording/);
});
test('FPS edits leave recording speed and source offsets unchanged', () => {
  const editor = editorWithAudio(), state = audioState(editor.report); editor.setFPS(60); assert.equal(audioState(editor.report),state);
});
test('explicit ripple splits at inserted time and joins surviving source ranges after removal', () => {
  const editor = editorWithAudio(), original = audioState(editor.report), insert = rippleAudio(original,.5,0,1);
  assert.deepEqual(insert.tracks[0].clips.map(c=>[c.start,c.offset,c.duration]),[[0,0,.5],[1.5,.5,1.5]]);
  const removed = rippleAudio(original,.5,.5,0);
  assert.deepEqual(removed.tracks[0].clips.map(c=>[c.start,c.offset,c.duration]),[[0,0,.5],[.5,1,1]]);
  const ids=['scene','camera',...editor.report._styk.layers.order]; editor.audioRipple=true;
  const frames=editor.totalTicks; editor.sheetInsertFrames(ids,1,2); editor.undo(); assert.equal(editor.totalTicks,frames); assert.equal(audioState(editor.report),original);
});
test('save transport retains original bytes but prepared render metadata excludes them', () => {
  const editor = editorWithAudio(); let copy;
  for (const chunk of documentChunks(editor.report,{maxBytes:4096})) copy=applyDocumentChunk(copy,chunk);
  assert.deepEqual(copy._styk.audio,editor.report._styk.audio); assert.equal(playbackProperties(editor.report)._styk.audio,undefined);
  const loaded = new Editor({layerTimeline:true}); loaded.load(copy); assert.deepEqual(audioState(loaded.report),audioState(editor.report));
});
test('WAV parsing and waveform peaks read original mono/stereo PCM', async () => {
  const samples=Float32Array.from({length:48000},(_,i)=>Math.sin(i*Math.PI/24)*.5), blob=pcmWave([samples]);
  const source=await inspectWave(blob); assert.equal(source.duration,1); assert.equal(source.channels,1);
  const peaks=await wavePeaks(source); assert.equal(peaks.length,80); assert.ok(peaks.every(p=>Math.abs(p-.5)<.001));
  await assert.rejects(inspectWave(blob.slice(0,blob.size-1)),/truncated/);
});
test('native binary project round trip preserves embedded recordings and edit state', async () => {
  const editor = editorWithAudio();
  const saved = await buildContainerV2(editor.report,'styk'), {document} = await decodeDocument(saved,'styk');
  assert.deepEqual(document._styk.audio,editor.report._styk.audio);
  const reopened = new Editor({layerTimeline:true}); reopened.load(document); assert.deepEqual(audioState(reopened.report),audioState(editor.report));
});
test('mixing is invariant to chunk boundaries, seeks, overlaps, fades and silence', async () => {
  const mono=new Float32Array(48000).fill(.25), source=await inspectWave(pcmWave([mono])), sources=new Map([['sound',source]]);
  const clip={assetId:'sound',start:.125,offset:.2,duration:.5,gain:1,fadeIn:.1,fadeOut:.1};
  const all=await mixAudio([clip],sources,0,48000), a=await mixAudio([clip],sources,0,12000), b=await mixAudio([clip],sources,12000,36000);
  assert.deepEqual(all,new Float32Array([...a,...b])); assert.equal(all[0],0); assert.equal(all[24000],.25); assert.equal(all[70000],0);
  const overlap=await mixAudio([clip,{...clip,gain:10}],sources,12000,100); assert.ok(overlap.every(sample=>sample===1));
  assert.equal(clipGainAt(clip,.125),0); assert.ok(Math.abs(clipGainAt(clip,.175)-.5)<1e-9);
});
