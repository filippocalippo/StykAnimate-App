// The development server: the app from source at http://127.0.0.1:47831, with the
// desktop host's rules (desktop/web-host.cjs: loopback only, read-only, cross-origin
// isolated). The Pivot codec runs in the page, so nothing else is needed.
//
//   npm run serve [-- --port 47831]        or STYK_PORT=47831
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startDesktopHost } = require('../desktop/web-host.cjs');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const optionIndex = process.argv.indexOf('--port');
const port = Number(optionIndex >= 0 ? process.argv[optionIndex + 1] : process.env.STYK_PORT || 47831);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a port between 1 and 65535.');
const host = await startDesktopHost({ appRoot, port });
console.log(`StykAnimate is ready at ${host.origin}`);
let stopped = false;
function stop() { if (stopped) return; stopped = true; void host.stop().finally(() => process.exit(0)); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
