// The editor's frozen recordings (engine/tests/edit, the owner references) were made before some effect parameters existed: a
// recording holds none of them, and the engine writes each one at its default into an effect it makes. A document is compared
// with a recording after those parameters, where they are at their defaults, are taken out of every effect. The engine's own
// replay does the same (`registry::ADDED` and `without_added_defaults` in engine/crates/styk-eval/src/vfx/registry.rs,
// `replay::as_recorded`); this reads the same list, so there is one.
import {readFileSync} from 'node:fs';
import {VFX_REGISTRY} from '../../src/vfx-registry.mjs';

const rust = readFileSync(new URL('../../engine/crates/styk-eval/src/vfx/registry.rs', import.meta.url), 'utf8');
const list = rust.match(/pub const ADDED: &\[\(&str, &str\)\] = &\[([\s\S]*?)\];/);
if (!list) throw new Error('registry.rs holds no ADDED list');
const ADDED = [...list[1].matchAll(/\("(\w+)", "(\w+)"\)/g)].map(([, type, param]) => [type, param, VFX_REGISTRY[type].params[param].default]);

function strip(value) {
  if (Array.isArray(value)) {
    for (const item of value) strip(item);
  } else if (value && typeof value === 'object') {
    if (typeof value.type === 'string' && value.params && typeof value.params === 'object') {
      for (const [type, param, fallback] of ADDED) {
        if (value.type === type && Number(value.params[param]) === fallback && value.params[param] !== null && value.params[param] !== undefined) delete value.params[param];
      }
    }
    for (const child of Object.values(value)) strip(child);
  }
  return value;
}

/** `text` (a document's JSON) as a recording made before the added effect parameters holds it. */
export const asRecorded = text => JSON.stringify(strip(JSON.parse(text)));

// The built-in preset catalogue the recordings were made with, frozen with them: the catalogue has changed since, so a
// recorded `addVfxGroup` or `applyVfxPreset` of a preset by name is replayed with that name's definition from then
// (the engine's replay does the same: `replay::recorded_call`, engine/crates/styk-edit/src/vfx_presets_recorded.json).
const RECORDED_PRESETS = JSON.parse(readFileSync(new URL('../../engine/crates/styk-edit/src/vfx_presets_recorded.json', import.meta.url), 'utf8'));

/** A recorded call's arguments as the engine replays them (`args` unchanged for any other call). */
export const recordedCall = (method, args) => {
  const name = args[1];
  if (!['addVfxGroup', 'applyVfxPreset'].includes(method.replace(/^@/, '')) || typeof name !== 'string' || !Object.hasOwn(RECORDED_PRESETS, name)) return args;
  return [args[0], {name, effects: RECORDED_PRESETS[name]}, ...args.slice(2)];
};
