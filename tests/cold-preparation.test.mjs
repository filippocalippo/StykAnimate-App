import test from 'node:test';
import assert from 'node:assert/strict';
import {createFrame,createObject,emptyDocument} from '../src/demo.mjs';
import {documentChunks,applyDocumentChunk} from '../src/document-transport.mjs';
import {movieclipAsset} from '../src/movieclips.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

function clipFixture(){
  const editor=ownedEditorFor();editor.select(1);
  const figure=editor.createMovieclip({start:0,end:20,replace:false});
  return {editor,figure};
}
function transport(report,options){
  const chunks=[...documentChunks(report,options)];let received;
  for(const chunk of chunks)received=applyDocumentChunk(received,structuredClone(chunk));
  return {received,chunks};
}
test('shared figure transport retains exact native content and existing aliases across nested clips',()=>{
  const {figure}=clipFixture(),child=movieclipAsset(figure).document.figure_types[0];
  const other=structuredClone(figure);other.figure_type_id++;
  movieclipAsset(other).document.figure_types=[child];
  const report={figure_types:[child,figure,other,structuredClone(child)],keyframes:[]};
  const {received,chunks}=transport(report,{maxBytes:4096,maxRecords:4,sharedFigures:true});
  assert.deepEqual(received,report);
  assert.equal(JSON.stringify(received),JSON.stringify(report));
  assert.equal(received.figure_types[0],movieclipAsset(received.figure_types[1]).document.figure_types[0]);
  assert.equal(received.figure_types[0],movieclipAsset(received.figure_types[2]).document.figure_types[0]);
  assert.notEqual(received.figure_types[0],received.figure_types[3],'Equal but independent definitions must stay independent.');
  assert.ok(chunks.some(c=>c.operations?.some(op=>op.figureReference)));
  assert.ok(chunks.every(c=>!c.estimatedBytes||c.estimatedBytes<=4096));
});
test('figure transport rejects cyclic and out-of-order aliases without accepting general object references',()=>{
  const {figure}=clipFixture();movieclipAsset(figure).document.figure_types.push(figure);
  assert.throws(()=>transport({figure_types:[figure]},{sharedFigures:true}),/Cyclic/);
  const report={figure_types:[],keyframes:[],opaque:{segments:[],figure_type_id:1}};
  for(const figureReference of [['figure_types',3],['opaque'],['__proto__','figure_types',0]])
    assert.throws(()=>applyDocumentChunk(report,{operations:[{path:['figure_types',0],figureReference}]}),/reference/i);
  assert.deepEqual(report.figure_types,[]);
});
test('sheet pose edits and history preserve definition revisions',()=>{
  const report=emptyDocument();report.keyframes=[0,10].map(x=>createFrame([createObject(report.figure_types[0],1,x,100)],10));
  const editor=ownedEditorFor({demo:false,layerTimeline:true}, report),events=[];
  editor.addEventListener('change',e=>{if(['edit','history'].includes(e.detail.kind))events.push(e.detail);});
  const revision=editor.definitionRevision,before=editor.serialize();editor.select(1);editor.moveSelection(12,-4);
  assert.equal(editor.definitionRevision,revision);
  assert.ok(events.at(-1).layerSheet);assert.ok(events.at(-1).sourceIds.length);assert.deepEqual(events.at(-1).frameIndices,[]);
  editor.undo();assert.deepEqual(editor.serialize(),before);assert.equal(editor.definitionRevision,revision);
  editor.redo();assert.equal(editor.definitionRevision,revision);
  const definition=structuredClone(editor.report.figure_types[0]);definition.segments[0].thickness+=5;
  editor.replaceFigureDefinition(definition.figure_type_id,definition);
  assert.ok(editor.definitionRevision>revision);
});
