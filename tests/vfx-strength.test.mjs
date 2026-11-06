import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {createVfx,activeVfx,resolvedVfx,vfxPadding,validateVfxStack} from '../src/vfx.mjs';
import {newOwnedEditor} from './support/owned-editor.mjs';

test('strength defaults preserve old stacks, interpolate and become a true no-op at zero',()=>{
 const old={version:1,type:'blur',id:'old',enabled:true,params:{radius:9}};
 assert.equal(resolvedVfx(old).params.effectStrength,1);assert.equal(old.params.effectStrength,undefined);
 const a=createVfx('turbulence','t'),b={...a,params:{...a.params,effectStrength:0}};
 assert.equal(activeVfx([b]).length,0);assert.equal(vfxPadding([b]),0);
 assert.equal(vfxPadding([a],2),24);
 assert.throws(()=>validateVfxStack([{...a,params:{...a.params,effectStrength:1.1}}]));
});

test('layer poses preserve turbulence through strength edits, undo and reopening',()=>{
 const report=emptyDocument(),effect=createVfx('turbulence','t');
 report.keyframes=[0,1,2].map(i=>{
  const object=createObject(report.figure_types[0],1,70+i*150,230);
  object._stykVfx={figure:[structuredClone(effect)]};
  return {...createFrame([object],10),_styk:{easing:{interpolation:'linear'}}};
 });
 const editor=newOwnedEditor({demo:false,layerTimeline:true}).load(report);editor.seek(8);
 const target={kind:'figure',uid:1},before=structuredClone(editor.vfxEffects(target));
 editor.setVfxParameter(target,'t','effectStrength',0);assert.equal(activeVfx(editor.vfxEffects(target)).length,0);
 editor.undo();assert.deepEqual(editor.vfxEffects(target),before);
 const reopened=newOwnedEditor({demo:false}).load(structuredClone(editor.report));reopened.seek(8);assert.deepEqual(reopened.vfxEffects(target),before);
});
