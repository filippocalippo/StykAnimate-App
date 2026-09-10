import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const {LibraryStore} = createRequire(import.meta.url)('../desktop/library-store.cjs');
const thumbnail = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEl0AAAAASUVORK5CYII=';
async function store(t) { const root = await mkdtemp(path.join(os.tmpdir(),'styk-library-')); const value = new LibraryStore(path.join(root,'StykAnimate','library')); await value.init(); t.after(() => value.dispose()); return value; }
async function save(s, name = 'Actor', folder = '') { const job = await s.beginSave({folder, name, extension:'.stkz', size:3, thumbnail}); await s.write(job.token,new Uint8Array([1,2,3])); return s.finish(job.token); }
test('creates Documents layout and retains assets, thumbnails, folders across service restarts', async t => {
  const s = await store(t); await s.createFolder({name:'Characters'}); const saved = await save(s,'Hero','Characters');
  const reopened = new LibraryStore(s.root); t.after(() => reopened.dispose());
  assert.equal((await reopened.list('Characters')).entries[0].name,'Hero'); assert.equal(await reopened.thumbnail(saved.path),thumbnail);
  const job = await reopened.beginRead(saved.path), chunk = await reopened.read(job.token); assert.deepEqual([...new Uint8Array(chunk.bytes)],[1,2,3]);
  await reopened.createFolder({folder:'Characters',name:'Extras'});
  await reopened.change({path:saved.path,name:'Hero blue'}); await reopened.change({path:'Characters/Hero blue.stkz',folder:'Characters/Extras'});
  assert.equal(await reopened.thumbnail('Characters/Extras/Hero blue.stkz'),thumbnail);
  await reopened.change({path:'Characters',name:'Cast'}); assert.equal((await reopened.list('Cast/Extras')).entries[0].name,'Hero blue');
});
test('duplicate saves never overwrite; cancellations and incomplete transfers remain invisible', async t => {
  const s=await store(t); await save(s); await save(s); assert.equal((await s.list()).entries.length,2);
  const job=await s.beginSave({name:'Actor',extension:'.stkz',size:4,thumbnail}); await s.write(job.token,new Uint8Array([4]));
  await assert.rejects(s.finish(job.token),/incomplete/); assert.equal((await s.list()).entries.length,2);
  const cancelled=await s.beginSave({name:'Cancelled',extension:'.stkz',size:1,thumbnail}); await s.cancel(cancelled.token);
  assert.equal((await s.list()).entries.length,2); assert.deepEqual([...await readFile(path.join(s.root,'Actor.stkz'))],[1,2,3]);
});
test('rejects traversal, reserved names, collisions, links, and moving a folder inside itself',async t=>{
  const s=await store(t); for(const name of ['../escape','A/B','CON','NUL.stkz','bad:stream','..','A.']) await assert.rejects(s.createFolder({name}));
  await assert.rejects(s.list('../')); await assert.rejects(s.list('C:/Windows'));
  await s.createFolder({name:'A'}); await s.createFolder({folder:'A',name:'B'}); await assert.rejects(s.change({path:'A',folder:'A/B'}),/itself/);
  await save(s); await assert.rejects(s.change({path:'Actor.stkz',name:'Actor (2)'}).then(()=>s.change({path:'Actor (2).stkz',name:'../bad'})));
  const outside=path.join(path.dirname(s.root),'outside'); await mkdir(outside); await symlink(outside,path.join(s.root,'Linked'),'junction'); await assert.rejects(s.list('Linked'),/Linked/);
  assert.ok(!(await s.list()).entries.some(item=>item.name==='Linked'));
});
test('external files are discoverable and a concurrent external save is protected',async t=>{
  const s=await store(t); await writeFile(path.join(s.root,'Imported.stykmov'),new Uint8Array([3])); assert.equal((await s.list()).entries[0].kind,'movieclip');
  const job=await s.beginSave({name:'Taken',extension:'.stkz',size:1,thumbnail}); await s.write(job.token,new Uint8Array([9])); await writeFile(path.join(s.root,'Taken.stkz'),'external');
  await assert.rejects(s.finish(job.token),/taken/); assert.equal(await readFile(path.join(s.root,'Taken.stkz'),'utf8'),'external');
});
