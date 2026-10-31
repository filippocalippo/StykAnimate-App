import test from 'node:test';
import assert from 'node:assert/strict';
import {UserLibrary} from '../src/user-library.mjs';
import {interfaceLocalization, loadLocales} from '../src/localization.mjs';
await loadLocales();

const asset = (id, name, category = 'props') => ({id, name, category, kind: 'figure', author: 'Kim', tags: ['paper'], description: 'Folded artwork', sha256: id});
const owner = overrides => Object.assign(Object.create(UserLibrary.prototype), {
  source: 'mine', entries: [], publicCatalog: null, publicState: 'idle', publicGeneration: 0,
  input: {value: ''}, filterValue: 'all', render() {},
}, overrides);

test('public records keep identity across filtering and indexed actions without changing the catalogue', () => {
  const raw = asset('fan', 'Folding fan'), catalog = {categories: [{id: 'props', name: 'Props'}], items: [raw]};
  const library = owner({source: 'public', publicCatalog: catalog});
  const items = library.publicItems, item = items[0];
  assert.strictEqual(library.publicItems, items);
  assert.strictEqual(library.itemFor('fan'), item);
  for (const query of ['folding', 'props', 'kim', 'paper', 'artwork']) {
    library.input.value = query;
    assert.deepEqual(library.visibleItems(), [item]);
    assert.strictEqual(library.visibleItems()[0], item);
  }
  assert.equal(item.source, 'public'); assert.equal(item.categoryName, 'Props');
  assert.equal(Object.hasOwn(raw, 'source'), false); assert.equal(Object.hasOwn(raw, 'categoryName'), false);
  assert.equal(library.itemFor('missing'), null); assert.equal(library.itemFor(null), null);
});

test('replacing a public catalogue invalidates records, category names, searches and removed IDs', () => {
  const library = owner({source: 'public', publicCatalog: {categories: [{id: 'props', name: 'Props'}], items: [asset('fan', 'Folding fan'), asset('old', 'Removed')]}});
  const original = library.itemFor('fan'); library.input.value = 'folding'; assert.equal(library.visibleItems().length, 1);
  library.publicCatalog = {categories: [{id: 'props', name: 'Objects'}], items: [asset('fan', 'Paper crane')]};
  assert.notStrictEqual(library.itemFor('fan'), original);
  assert.equal(library.itemFor('fan').categoryName, 'Objects'); assert.equal(library.itemFor('old'), null);
  assert.equal(library.visibleItems().length, 0);
  library.input.value = 'objects'; assert.deepEqual(library.visibleItems().map(item => item.name), ['Paper crane']);
  library.publicCatalog = null;
  assert.deepEqual(library.publicItems, []); assert.equal(library.itemFor('fan'), null);
});

test('a successful public refresh rebuilds derived data even when an API reuses its snapshot object', async () => {
  const catalog = {categories: [{id: 'props', name: 'Props'}], items: [asset('fan', 'Folding fan')]};
  const library = owner({source: 'public', publicCatalog: catalog, desktop: {listPublicLibrary: async () => catalog}});
  const previous = library.itemFor('fan'); library.input.value = 'folding'; library.visibleItems();
  catalog.items[0].name = 'Paper crane'; catalog.categories[0].name = 'Objects';
  await library.loadPublic({refresh: true});
  assert.notStrictEqual(library.itemFor('fan'), previous); assert.equal(library.itemFor('fan').name, 'Paper crane');
  assert.equal(library.visibleItems().length, 0);
  library.input.value = 'objects'; assert.equal(library.visibleItems().length, 1);
});

test('obsolete public responses and refresh failures preserve the current indexed catalogue', async () => {
  const catalog = name => ({categories: [{id: 'props', name: 'Props'}], items: [asset('fan', name)]});
  const pending = [], library = owner({source: 'public', publicCatalog: catalog('Original'), desktop: {listPublicLibrary: () => new Promise(resolve => pending.push(resolve))}, say() {}});
  const first = library.loadPublic({refresh: true}), second = library.loadPublic({refresh: true});
  pending[1](catalog('Current')); await second;
  const current = library.itemFor('fan'); pending[0](catalog('Obsolete')); await first;
  assert.strictEqual(library.itemFor('fan'), current); assert.equal(current.name, 'Current');
  library.desktop.listPublicLibrary = async () => {throw new Error('Offline');};
  await library.loadPublic({refresh: true});
  assert.strictEqual(library.itemFor('fan'), current); assert.equal(library.publicState, 'ready'); assert.equal(library.publicError, 'Offline');
});

test('local listings retain folders in kind filters and update key and name lookups after replacement', () => {
  const entries = [{path: 'Characters', name: 'Characters', kind: 'folder'}, {path: 'Crowd.stkz', name: 'Crowd', kind: 'set'}, {path: 'Walk.stykmov', name: 'Walk', kind: 'movieclip'}];
  const library = owner({entries, filterValue: 'figure'});
  assert.deepEqual(library.visibleItems(), entries.slice(0, 2)); assert.strictEqual(library.itemFor('Crowd.stkz'), entries[1]);
  library.input.value = 'crowd'; assert.deepEqual(library.visibleItems(), [entries[1]]);
  const renamed = {path: 'People.stkz', name: 'People', kind: 'set'}; library.entries = [renamed];
  assert.equal(library.itemFor('Crowd.stkz'), null); assert.strictEqual(library.itemFor('People.stkz'), renamed);
  assert.deepEqual(library.visibleItems(), []); library.input.value = 'people'; assert.deepEqual(library.visibleItems(), [renamed]);
});

test('search uses the interface language and refreshes cached case folding after a language change', async () => {
  const previous = interfaceLocalization.locale;
  const local = owner({entries: [{path: 'Istanbul.stkz', name: 'Istanbul', kind: 'figure'}], input: {value: 'ıstanbul'}});
  const community = owner({source: 'public', publicCatalog: {categories: [], items: [asset('city', 'Istanbul')]}, input: {value: 'ıstanbul'}});
  try {
    await interfaceLocalization.setLocale('en');
    assert.equal(local.visibleItems().length, 0); assert.equal(community.visibleItems().length, 0);
    await interfaceLocalization.setLocale('tr');
    assert.equal(local.visibleItems().length, 1); assert.equal(community.visibleItems().length, 1);
    await interfaceLocalization.setLocale('en');
    assert.equal(local.visibleItems().length, 0); assert.equal(community.visibleItems().length, 0);
  } finally { await interfaceLocalization.setLocale(previous); }
});
