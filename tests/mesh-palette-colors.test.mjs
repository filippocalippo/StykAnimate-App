import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {figurePalette} from '../src/figure-colors.mjs';
import {resolveInstanceFigure,validateAnimationStyle} from '../src/animation-style.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {validateScene} from '../src/pivot/model.mjs';

/** `edit(document)` changes the document before the engine opens it. */
function fixture(options={}, edit=null) {
  const q=construction();q.add(0,0,0,'Figure rotation');
  const x=q.add(0,30,0,'Surface X'),y=q.add(0,30,Math.PI/2,'Surface Y');
  const turn=q.add(0,0,0,'Head turn'),pitch=q.add(0,0,0,'Head tilt');
  const bone=q.add(0,30,-Math.PI/2,'Head',{control:true,rig:{spatial:{parent:0,origin:[0,0,0],tip:[0,-30,0],turn,pitch}}});
  const mesh={positions:[-12,-30,3,0,-30,3,-6,-18,3,2,-30,3,14,-30,3,8,-18,3],
    bones:Array.from({length:6},()=>[bone,0,0,0]).flat(),weights:Array.from({length:6},()=>[1,0,0,0]).flat(),
    indices:[0,1,2,3,4,5],materials:[0,1],colors:[[210,145,100],[60,130,190]],basis:[0,x,y]};
  const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[],_styk:{colorMode:'segments',spatialMesh:mesh}};
  const document={...emptyDocument(),figure_types:[figure],keyframes:[0,1,2].map(i=>createFrame([createObject(figure,1,100+i*10,100),createObject(figure,2,300,100)],10))};
  edit?.(document);
  const editor=ownedEditorFor({demo:false,...options}, document);editor.select(1);return editor;
}
/** The colours the selected figure's mesh shows, one per mesh colour: what its palette says (the engine draws the mesh; the interface holds the swatches). */
const colors=e=>{const shown=[];for(const entry of e.figurePalette())for(const index of entry.meshColors??[])shown[index]=[1,3,5].map(at=>parseInt(entry.color.slice(at,at+2),16));return shown;};

for(const options of [{layerTimeline:true},{layerTimeline:false,propertyChannels:false}])test(`mesh palette edits preserve other colors, instances and history: ${JSON.stringify(options)}`,async()=>{
  const e=fixture(options),mesh=e.figure._styk.spatialMesh,before=e.serialize(),other=structuredClone(e.evaluatedFrame.objects[1]);
  const skin=e.figurePalette().find(entry=>entry.color==='#d29164');
  assert.deepEqual(skin.meshColors,[0]);assert.deepEqual(skin.segments,[]);assert.deepEqual(skin.polygons,[]);
  e.replaceFigureColor(skin.color,'#778899',{targets:skin});
  assert.deepEqual(colors(e),[[119,136,153],[60,130,190]]);
  assert.equal(e._undo.length,1);assert.deepEqual(e.evaluatedFrame.objects[1],other);
  assert.equal(e.figure._styk.spatialMesh,mesh);assert.equal(resolveInstanceFigure(e.figure,e.object)._styk.spatialMesh,mesh);
  const saved=e.serialize(),decoded=await decodeDocument(await buildContainerV2(saved,'styk'),'styk');
  const loaded=ownedEditorFor({demo:false,...options},decoded.document);loaded.select(1);
  assert.deepEqual(colors(loaded),colors(e));
  e.undo();assert.deepEqual(colors(e),[[210,145,100],[60,130,190]]);
  // Authored pose tracks retain their source snapshots for redo, as ordinary
  // joint edits do. Undo restores the authored keyframes and definitions.
  assert.deepEqual(e.serialize().keyframes,before.keyframes);assert.deepEqual(e.serialize().figure_types,before.figure_types);
  e.redo();assert.deepEqual(colors(e),[[119,136,153],[60,130,190]]);
  e.resetFigureColors();assert.deepEqual(colors(e),[[210,145,100],[60,130,190]]);
});

test('partial figure tints are normalized once while replacing a mesh color',()=>{
  const e=fixture({layerTimeline:false,propertyChannels:false},document=>{document.keyframes[0].objects[0].color_override_raw=0x80603020;});
  const original=colors(e),entry=figurePalette(e.report,e.figure,e.object).find(row=>row.meshColors?.includes(0));
  e.replaceFigureColor(entry.color,'#123456',{targets:entry});
  assert.deepEqual(colors(e),[[18,52,86],original[1]]);assert.equal(e.object.color_override_raw,0);
  e.setFigureColor('#abcdef');assert.deepEqual(colors(e),[[171,205,239],[171,205,239]]);
});

test('attached mesh palettes preserve instance membership after swatches merge',()=>{
  const e=fixture({layerTimeline:true}),figure=e.figure;
  const source=e.serialize();source.keyframes=source.keyframes.map(()=>createFrame([
    createObject(figure,1,100,100),createObject(figure,2,100,100,{join:{target_object_slot:0,target_handle_id:0}}),createObject(figure,3,300,100)],10));
  e.load(source);e.select(1);
  const skin=e.figurePalette().find(row=>row.color==='#d29164');
  assert.deepEqual(Object.keys(skin.instances),['1','2']);
  e.replaceFigureColor(skin.color,'#3c82be',{targets:skin});
  const mergedStyle=e.evaluatedFrame.objects[0]._stykStyle.meshColors;
  e.replaceFigureColor(skin.color,'#778899',{targets:skin});
  assert.deepEqual(mergedStyle,{0:0x3c82be},'editing a palette keeps earlier instance overlays immutable');
  // Each attached instance shows its own overlay: the first two the new colour, the third the definition's.
  for(const [uid,expected] of [[1,[[119,136,153],[60,130,190]]],[2,[[119,136,153],[60,130,190]]],[3,[[210,145,100],[60,130,190]]]]){e.select(uid);assert.deepEqual(colors(e),expected,`UID ${uid}`);}
});

test('mesh palettes reject malformed and out-of-definition indices before editing',()=>{
  const e=fixture(),before=e.serialize();
  for(const meshColors of [[],{0:-1},{0:0x1000000},{'-1':1},{'01':1},{1024:1},{2:1}]){
    const object={...e.object,_stykStyle:{meshColors}};
    assert.throws(()=>validateAnimationStyle(object,e.figure));
    const invalid=structuredClone(before);invalid.keyframes[0].objects[0]._stykStyle={meshColors};assert.throws(()=>validateScene(invalid));
  }
  for(const indices of [[-1],[1024],[0,0],['0'],new Array(1)])assert.throws(()=>e.replaceFigureColor('#d29164','#112233',{targets:{segments:[],polygons:[],meshColors:indices}}));
  assert.throws(()=>e.replaceFigureColor('#d29164','#123456',{targets:{segments:[],polygons:[],meshColors:[2]}}));
  assert.deepEqual(e.serialize(),before);
});
