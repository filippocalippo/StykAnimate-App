import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VFX_PRESETS} from '../src/vfx-presets.mjs';

// The engine applies the built-in presets from its own copy (styk-edit/src/vfx_presets.json) while the
// inspector still lists them from src/vfx-presets.mjs: the two must stay the same until the interface
// reads the catalogue from the engine.
test('the engine\'s preset catalogue holds the effects the inspector lists', () => {
  const engine = JSON.parse(readFileSync(new URL('../engine/crates/styk-edit/src/vfx_presets.json', import.meta.url), 'utf8'));
  const listed = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(VFX_PRESETS).map(([name, preset]) => [name, preset.effects]))));
  assert.deepEqual(Object.keys(engine), Object.keys(listed));
  assert.deepEqual(engine, listed);
});
