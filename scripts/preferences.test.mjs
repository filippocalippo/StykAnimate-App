import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { WorkspacePreferences } = createRequire(import.meta.url)('../desktop/preferences.cjs');
const directory = () => mkdtemp(path.join(os.tmpdir(), 'stykanimate-preferences-test-'));
const preferencePath = root => path.join(root, 'workspace-preferences.json');
const rejection = action => assert.rejects(async () => { await action(); });

test('workspace preferences survive restart with exact floating panel geometry', async () => {
  const root = await directory();
  const snapshot = {
    version: 1,
    theme: 'dark',
    panels: {
      timeline: { floating: true, x: 110.125, y: 72.875, width: 923.5, height: 287.25 },
      properties: { floating: false, width: 256.125 },
    },
    window: { width: 1440, height: 900, maximized: false },
    recentColors: ['#4433ff', '#ffffff'],
    label: 'Animazione — 日本語',
    optional: null,
  };
  const first = new WorkspacePreferences(root);
  assert.deepEqual(await first.get(), {});
  assert.deepEqual(await first.set(snapshot), { saved: true });
  const restarted = new WorkspacePreferences(root);
  assert.deepEqual(await restarted.get(), snapshot);
  assert.deepEqual(JSON.parse(await readFile(preferencePath(root), 'utf8')), snapshot);
});

test('missing or malformed preferences fall back to an empty object', async () => {
  const root = await directory();
  assert.deepEqual(await new WorkspacePreferences(root).get(), {});
  for (const source of ['{', 'null', '[]', '"not an object"', '42']) {
    await writeFile(preferencePath(root), source);
    assert.deepEqual(await new WorkspacePreferences(root).get(), {});
  }
});

test('invalid preference values reject and preserve the last complete snapshot', async () => {
  const root = await directory();
  const preferences = new WorkspacePreferences(root);
  const snapshot = { timeline: { height: 280.25 }, theme: 'light' };
  await preferences.set(snapshot);
  const originalBytes = await readFile(preferencePath(root));
  const invalid = [
    null, [], 'text', 42, true,
    { panel: { width: NaN } },
    { panel: { width: Infinity } },
    { panel: { width: -Infinity } },
    new Date('2026-09-08T12:00:00Z'),
  ];
  for (const value of invalid) {
    await rejection(() => preferences.set(value));
    assert.deepEqual(await readFile(preferencePath(root)), originalBytes);
    assert.deepEqual(await new WorkspacePreferences(root).get(), snapshot);
  }
});

test('deep preference trees reject without replacing valid preferences', async () => {
  const root = await directory();
  const preferences = new WorkspacePreferences(root);
  const snapshot = { timeline: { height: 280 } };
  await preferences.set(snapshot);
  const originalBytes = await readFile(preferencePath(root));
  let deep = { value: true };
  for (let level = 0; level < 20; level++) deep = { child: deep };
  await rejection(() => preferences.set(deep));
  assert.deepEqual(await readFile(preferencePath(root)), originalBytes);
  assert.deepEqual(await new WorkspacePreferences(root).get(), snapshot);
});

test('the serialized UTF-8 byte limit rejects oversized snapshots and preserves prior bytes', async () => {
  const root = await directory();
  const preferences = new WorkspacePreferences(root, { maxBytes: 128 });
  const snapshot = { panel: { x: 12.5, y: 42.25 } };
  await preferences.set(snapshot);
  const originalBytes = await readFile(preferencePath(root));
  for (const value of [{ label: 'x'.repeat(129) }, { label: '界'.repeat(50) }]) {
    await rejection(() => preferences.set(value));
    assert.deepEqual(await readFile(preferencePath(root)), originalBytes);
    assert.deepEqual(await new WorkspacePreferences(root, { maxBytes: 128 }).get(), snapshot);
  }
});

test('caller path strings remain data and cannot redirect preference writes', async () => {
  const root = await directory();
  const outside = await directory();
  const destination = path.join(outside, 'redirected.json');
  const preferences = new WorkspacePreferences(root);
  const snapshot = { path: destination, destination, panel: { floating: true, x: 20, y: 30 } };
  await preferences.set(snapshot);
  assert.deepEqual(JSON.parse(await readFile(preferencePath(root), 'utf8')), snapshot);
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('editor settings persist independently of workspace state across restart', async () => {
  const root = await directory();
  const options = { filename: 'editor-settings.json' };
  const workspace = new WorkspacePreferences(root);
  const settings = new WorkspacePreferences(root, options);
  const layout = { timeline: { height: 280 }, properties: { floating: true, x: 430, y: 120 } };
  const editor = { version: 1, theme: 'dark', onionSkin: { before: 2, after: 1, opacity: 0.25 }, autosave: true };
  await Promise.all([workspace.set(layout), settings.set(editor)]);
  assert.deepEqual(await new WorkspacePreferences(root).get(), layout);
  assert.deepEqual(await new WorkspacePreferences(root, options).get(), editor);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, options.filename), 'utf8')), editor);

  await settings.set({ ...editor, theme: 'light' });
  assert.deepEqual(await new WorkspacePreferences(root).get(), layout);
  assert.deepEqual(await new WorkspacePreferences(root, options).get(), { ...editor, theme: 'light' });
});

test('invalid and oversized editor settings preserve both independent files', async () => {
  const root = await directory();
  const options = { filename: 'editor-settings.json' };
  const settings = new WorkspacePreferences(root, options);
  const workspace = new WorkspacePreferences(root);
  const editor = { snapping: true, autosaveInterval: 30 };
  const layout = { timeline: { height: 280 } };
  await settings.set(editor);
  await workspace.set(layout);
  const settingsPath = path.join(root, options.filename);
  const originalSettings = await readFile(settingsPath);
  const originalWorkspace = await readFile(preferencePath(root));
  for (const value of [null, [], { fps: NaN }, { shortcut: undefined }, { label: '界'.repeat(6000) }]) {
    await rejection(() => settings.set(value));
    assert.deepEqual(await readFile(settingsPath), originalSettings);
    assert.deepEqual(await readFile(preferencePath(root)), originalWorkspace);
  }
  assert.deepEqual(await new WorkspacePreferences(root, options).get(), editor);
  assert.deepEqual(await new WorkspacePreferences(root).get(), layout);
});

test('unsafe preference filenames reject before opening a store', async () => {
  const root = await directory();
  for (const filename of [
    '../editor-settings.json', '..\\editor-settings.json', '/editor-settings.json',
    'C:\\editor-settings.json', 'sub/editor-settings.json', 'sub\\editor-settings.json',
    'editor-settings.json:stream', '..', '.json', 'editor-settings.txt',
    'editor-settings.json ', 'editor-settings\u0000.json', 'CON.json', 'lpt1.json',
    '', null, 42,
  ]) {
    assert.throws(() => new WorkspacePreferences(root, { filename }), /safe JSON basename/);
  }
  assert.equal(new WorkspacePreferences(root, { filename: 'editor-settings.json' }).file,
    path.join(root, 'editor-settings.json'));
});
