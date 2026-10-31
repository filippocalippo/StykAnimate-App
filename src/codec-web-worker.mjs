/** Worker shell around the Pivot codec: the WebAssembly codec (codec-engine.mjs)
 * behind the request queue in codec-web-shell.mjs. The page sends
 * {type: 'configure', limits} first; loading the module is reported to it as
 * {type: 'status', state, stage?, message?}. */
import {createCodecEngine} from './codec-engine.mjs';
import {createCodecShell} from './codec-web-shell.mjs';

// scripts/engine-build.mjs builds the module beside the engine's.
const MODULE = new URL('./engine/pkg/styk_codec.js', import.meta.url);

let shell = null;
const post = message => self.postMessage(message);

function configure(limits) {
  const engine = createCodecEngine({
    limits,
    onStatus: status => post({type: 'status', ...status}),
    async loadModule() {
      const glue = await import(MODULE.href);
      await glue.default();
      return glue;
    },
  });
  shell = createCodecShell({engine, post});
}

self.addEventListener('message', ({data}) => {
  if (data?.type === 'configure') { if (!shell) configure(data.limits === 'desktop' ? 'desktop' : 'web'); return; }
  shell?.handleMessage(data);
});
