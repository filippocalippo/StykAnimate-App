// Home's project list in the main process (desktop/project-library.cjs, docs/HOME.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { ProjectLibrary, MAX_FOLDERS } = createRequire(import.meta.url)('../desktop/project-library.cjs');
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');

async function fixture(names = [], options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stykanimate-projects-test-'));
  const files = [];
  for (const name of names) {
    const filename = path.join(directory, name);
    await fs.writeFile(filename, `project:${name}`);
    files.push(filename);
  }
  let clock = 1000;
  const make = () => new ProjectLibrary({ directory: path.join(directory, 'library'), now: () => clock++, ...options });
  return { directory, files, library: make(), make };
}

test('opened and saved animations are listed newest first under opaque ids; other files are not', async () => {
  const { files, library, make } = await fixture(['Walk.styk', 'Fight.piv', 'Rig.stknds', 'figure.stk', 'Notes.txt']);
  for (const file of files) await library.remember(file);
  const { projects, folders } = await library.list();
  assert.deepEqual(projects.map(item => item.name), ['Rig', 'Fight', 'Walk']);
  assert.deepEqual(projects.map(item => item.extension), ['stknds', 'piv', 'styk']);
  assert.deepEqual(folders, []);
  for (const item of projects) {
    assert.match(item.id, /^[\da-f-]{36}$/);
    assert.equal(Object.hasOwn(item, 'path'), false, 'the renderer never sees a path it did not choose');
    assert.equal(item.missing, false);
    assert.ok(item.bytes > 0 && item.modifiedAt > 0);
  }
  await library.remember(files[0]);
  const again = await make().list();
  assert.deepEqual(again.projects.map(item => item.name), ['Walk', 'Rig', 'Fight'], 'opening again moves a project to the top, across restarts');
  assert.equal(again.projects[0].id, projects[2].id, 'it keeps its id');
});

test('the projects open in the window are marked with their document', async () => {
  const { files, library } = await fixture(['A.styk', 'B.styk']);
  for (const file of files) await library.remember(file);
  const { projects } = await library.list({ open: [{ filename: files[0], documentToken: 'token-a' }, { filename: null, documentToken: 'blank' }] });
  const a = projects.find(item => item.name === 'A'), b = projects.find(item => item.name === 'B');
  assert.deepEqual([a.open, a.documentToken], [true, 'token-a']);
  assert.deepEqual([b.open, b.documentToken], [false, null]);
});

test('pins survive the limit; unpinned projects leave oldest first, and the list never grows past it', async () => {
  const { files, library } = await fixture(['1.styk', '2.styk', '3.styk', '4.styk'], { limit: 2 });
  const first = await library.remember(files[0]);
  await library.update(first.id, { pinned: true });
  await library.setPreview(files[0], { thumbnail: PNG });
  await library.remember(files[1]);
  await library.remember(files[2]);
  await library.remember(files[3]);
  const { projects } = await library.list();
  assert.deepEqual(projects.map(item => item.name).sort(), ['1', '4'], 'the pinned one stays, and the newest fills the room left');
  assert.equal(await library.preview(first.id), PNG);
});

test('Home recognizes an open project reached through a linked folder', async t => {
  const { directory, files, library } = await fixture(['Walk.styk']);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const linked = path.join(directory, 'linked');
  await fs.symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const alias = path.join(linked, 'Walk.styk');
  const project = await library.remember(alias);
  const { projects } = await library.list({ open: [{ filename: alias, documentToken: 'open-walk' }] });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, project.id);
  assert.equal(projects[0].open, true, 'Home must return to the existing tab');
  assert.equal(projects[0].documentToken, 'open-walk');
  assert.equal(await library.resolve(project.id), await fs.realpath(files[0]));
});

test('Home stores previews and counts for a project reached through a linked folder', async t => {
  const { directory, files, library, make } = await fixture(['Walk.styk']);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const linked = path.join(directory, 'linked');
  await fs.symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const alias = path.join(linked, 'Walk.styk');
  const project = await library.remember(files[0]);
  const stats = { frames: 48, fps: 24, width: 960, height: 540 };
  assert.deepEqual(await library.setPreview(alias, { thumbnail: PNG, stats }), { stored: true, id: project.id });
  const reloaded = make();
  assert.equal(await reloaded.preview(project.id), PNG);
  assert.deepEqual((await reloaded.list()).projects[0].stats, stats);
  await fs.unlink(linked);
  assert.deepEqual(await library.setPreview(alias, { thumbnail: PNG }), { stored: false });
  assert.equal(await reloaded.preview(project.id), PNG, 'a vanished alias leaves the stored preview intact');
});

test('folders are labels: create, move into, rename and delete, and the files never move', async () => {
  const { files, library } = await fixture(['Walk.styk', 'Run.styk']);
  const walk = await library.remember(files[0]);
  await library.remember(files[1]);
  assert.deepEqual(await library.createFolder('  Practice   reel '), { folder: 'Practice reel', created: true });
  assert.deepEqual(await library.createFolder('practice REEL'), { folder: 'Practice reel', created: false }, 'names are unique whatever the case');
  await assert.rejects(library.createFolder('   '), { messageKey: 'desktop.projectLibrary.errors.giveTheFolderAName' });
  await library.update(walk.id, { folder: 'PRACTICE reel' });
  await assert.rejects(library.update(walk.id, { folder: 'Nowhere' }), { messageKey: 'desktop.projectLibrary.errors.thisFolderNoLongerExists' });
  await library.createFolder('Clients');
  await assert.rejects(library.renameFolder('Clients', 'practice reel'), { messageKey: 'desktop.projectLibrary.errors.aFolderNamedValueAlreadyExists' });
  await library.renameFolder('Practice reel', 'Drills');
  let listed = await library.list();
  assert.deepEqual(listed.folders, ['Drills', 'Clients']);
  assert.equal(listed.projects.find(item => item.id === walk.id).folder, 'Drills', 'renaming carries the projects along');
  assert.deepEqual(await library.deleteFolder('drills'), { deleted: true });
  listed = await library.list();
  assert.deepEqual(listed.folders, ['Clients']);
  assert.equal(listed.projects.find(item => item.id === walk.id).folder, '', 'the projects stay, outside any folder');
  await fs.access(files[0]);
});

test('there is a limit to folders', async () => {
  const { library } = await fixture();
  for (let index = 0; index < MAX_FOLDERS; index++) await library.createFolder(`Folder ${index}`);
  await assert.rejects(library.createFolder('One more'), { messageKey: 'desktop.projectLibrary.errors.thereCanBeAtMostFolders' });
});

test('a moved file is listed as missing, cannot open, and can be removed while its file stays', async () => {
  const { directory, files, library } = await fixture(['Moved.styk']);
  const moved = await library.remember(files[0]);
  const elsewhere = path.join(directory, 'Elsewhere.styk');
  await fs.rename(files[0], elsewhere);
  const { projects } = await library.list();
  assert.deepEqual([projects[0].missing, projects[0].bytes, projects[0].modifiedAt], [true, null, null]);
  await assert.rejects(library.resolve(moved.id), { messageKey: 'desktop.projectLibrary.errors.valueWasMovedOrDeleted' });
  assert.deepEqual(await library.remove(moved.id), { removed: true });
  assert.deepEqual((await library.list()).projects, []);
  await fs.access(elsewhere);
  await assert.rejects(library.resolve(moved.id), { messageKey: 'desktop.projectLibrary.errors.thisProjectIsNoLongerInTheList' });
});

test('a picture is a small PNG for a listed project; counts are kept clean', async () => {
  const { files, library } = await fixture(['Walk.styk']);
  const walk = await library.remember(files[0]);
  assert.deepEqual(await library.setPreview(path.join(path.dirname(files[0]), 'Unlisted.styk'), { thumbnail: PNG }), { stored: false });
  await assert.rejects(library.setPreview(files[0], { thumbnail: 'data:image/png;base64,AAAA' }), { messageKey: 'desktop.projectLibrary.errors.aProjectPictureMustBeASmallPNG' });
  await assert.rejects(library.setPreview(files[0], { thumbnail: 'data:image/jpeg;base64,AAAA' }), { messageKey: 'desktop.projectLibrary.errors.aProjectPictureMustBeASmallPNG' });
  assert.deepEqual(await library.setPreview(files[0], { thumbnail: PNG, stats: { frames: 48.4, fps: 24, width: 960, height: 540, extra: 'x' } }), { stored: true, id: walk.id });
  const [listed] = (await library.list()).projects;
  assert.deepEqual(listed.stats, { frames: 48, fps: 24, width: 960, height: 540 });
  assert.equal(listed.hasPreview, true);
  assert.equal(await library.preview(walk.id), PNG);
  await library.setPreview(files[0], { stats: { frames: 'many' } });
  assert.deepEqual((await library.list()).projects[0].stats, { frames: 48, fps: 24, width: 960, height: 540 }, 'bad counts leave the stored ones');
});

test('a damaged list keeps what can be read', async () => {
  const { directory, files } = await fixture(['Walk.styk']);
  const storage = path.join(directory, 'library');
  await fs.mkdir(storage, { recursive: true });
  const id = '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6';
  await fs.writeFile(path.join(storage, 'projects.json'), JSON.stringify({ version: 1, folders: ['Drills', 'drills', 7, ''],
    projects: [{ id, path: files[0], pinned: true, folder: 'DRILLS', openedAt: 5 }, { id: 'not-an-id', path: files[0] }, { id, path: 'relative.styk' }] }));
  const library = new ProjectLibrary({ directory: storage });
  const { projects, folders } = await library.list();
  assert.deepEqual(folders, ['Drills']);
  assert.deepEqual(projects.map(item => [item.id, item.pinned, item.folder]), [[id, true, 'Drills']]);
  await fs.writeFile(path.join(storage, 'projects.json'), '{broken');
  assert.deepEqual(await new ProjectLibrary({ directory: storage }).list(), { projects: [], folders: [] });
  assert.throws(() => new ProjectLibrary({ directory: 'relative' }), { messageKey: 'desktop.projectLibrary.errors.theProjectListNeedsAnAbsoluteStorageDirectory' });
});
