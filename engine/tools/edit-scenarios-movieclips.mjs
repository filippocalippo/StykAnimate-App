// Movieclip command recordings built with the editor before their Rust ports.
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {documentOf, limb, open, nextKey, prune} from './fixture-kit.mjs';
const out = fileURLToPath(new URL('../tests/edit/', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const write = (name, editor, steps, document) => {
  writeFileSync(`${out}/${name}.document.json`, JSON.stringify(prune(document), (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document: `${name}.document.json`, editor, steps}, null, 1) + '\n');
};
const base = () => {
  const e = open(documentOf([limb(), limb(), limb()], i => [170 + i * 150, 150]));
  nextKey(e, 6); e.select(1); e.moveSelection(31.25, -6.5); e.rotateFigure(0.17); e.seek(0);
  e.report.figure_types[0]._styk = {...e.report.figure_types[0]._styk, privateMetadata: {kept: [1, 2]}};
  return e;
};
for (const [suffix, options] of [['native', {}], ['sheet', app]]) {
  write(`clip-empty-${suffix}`, options, [['createEmptyMovieclip'], ['createEmptyMovieclip', 'Custom clip'], ['undo'], ['undo'], ['redo'], ['redo']], base().report);
  write(`clip-create-definition-${suffix}`, options, [['@select', 1, -1], ['createMovieclip', {start: 2, end: 6, replace: false, name: 'Motion'}], ['undo'], ['redo'], ['createMovieclip', {start: 0, end: 1, replace: false}], ['undo']], base().report);
}
for (const joined of [false, true]) {
  const e = base(); if (joined) {e.select(2); e.joinTo(1, 33);}
  write(`clip-create-${joined ? 'joined' : 'loose'}-sheet`, app, [['@select', 1, -1], ['createMovieclip', {start: 2, end: 6, name: 'Motion'}], ['@seek', 3], ['moveSelection', 4.5, -2], ['undo'], ['undo'], ['redo'], ['@seek', 0], ['@seek', 6]], e.report);
}
{
  const e = open(base().report, app); e.select(1); e.createMovieclip({start: 0, end: 7}); const id = e.selectedUid;
  write('clip-unique-sheet', app, [['@seek', 3], ['@select', id, -1], ['makeMovieclipUnique'], ['undo'], ['redo'], ['@seek', 4], ['@select', id, -1], ['makeMovieclipUnique'], ['undo'], ['undo'], ['redo'], ['@seek', 2]], e.report);
  write('clip-break-sheet', app, [['@seek', 3], ['@select', id, -1], ['breakApartMovieclip'], ['undo'], ['redo'], ['@seek', 4], ['@select', id, -1], ['breakApartMovieclip'], ['moveSelection', 7, -3], ['undo'], ['undo'], ['undo'], ['redo']], e.report);
}
{
  const e = open(base().report); e.select(1); e.createMovieclip({start: 0, end: 7}); const id = e.selectedUid;
  write('clip-placement-native', {}, [['@select', id, -1], ['placeMovieclip', {end: 6}], ['placeMovieclip', {start: 2, end: 8}, {move: true}], ['undo'], ['redo'], ['@seek', 4], ['splitMovieclip'], ['undo'], ['redo']], e.report);
}
{
 const e=open(base().report,app);const second=e.createLayer('Second');e.assignFiguresToLayer([2],second.id);e.select(1);
 write('clip-create-multilayer-sheet',app,[['createMovieclip',{start:2,end:6,uids:[2,3]}],['undo'],['redo'],['@seek',3]],e.report);
}
for(const variant of ['joined','flip','nested']) {
 const e=base();if(variant==='joined'){e.select(2);e.joinTo(1,33);}
 const editor=open(e.report,app);editor.select(1);editor.createMovieclip({start:0,end:7});if(variant==='nested')editor.createMovieclip({start:0,end:7});const id=editor.selectedUid;
 if(variant==='flip')for(const frame of Object.values(editor.report._styk.frameSources))for(const object of frame.objects)if(object.unique_id===id){object.image_text_flags=1;object.angles=[.37];object.scale=1.375;}
 write(`clip-break-${variant}-sheet`,app,[['@seek',3],['@select',id,-1],['breakApartMovieclip'],['undo'],['redo'],['@seek',4],['@select',id,-1],['breakApartMovieclip'],['undo'],['undo'],['redo']],editor.report);
}
{
 const e=open(base().report,app);e.setLayerLocked('layer-1',true);
 write('clip-create-locked-sheet',app,[['@select',1,-1],['createMovieclip',{start:2,end:6}],['createEmptyMovieclip'],['undo']],e.report);
}
write('clip-create-errors-sheet',app,[['createMovieclip',{start:-1,end:2}],['createMovieclip',{start:1,end:10}],['createMovieclip',{start:1,end:4,uids:[1,3]}],['createMovieclip',{start:0,end:1,uids:[]}],['undo'],['redo']],base().report);
