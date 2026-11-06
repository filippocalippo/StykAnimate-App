import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEditorSettings} from '../src/settings.mjs';

test('Alt-drag preference defaults to linked instances and only accepts supported modes', () => {
  for (const input of [null, {}, {altDragDuplicate: 'invalid'}]) assert.equal(normalizeEditorSettings(input).altDragDuplicate, 'instance');
  const settings = normalizeEditorSettings({altDragDuplicate: 'unique'});
  assert.equal(normalizeEditorSettings(JSON.parse(JSON.stringify(settings))).altDragDuplicate, 'unique');
});
