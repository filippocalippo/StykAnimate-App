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
