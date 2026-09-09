import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startBackend } = require('../desktop/backend.cjs');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const optionIndex = process.argv.indexOf('--port');
const port = Number(optionIndex >= 0 ? process.argv[optionIndex + 1] : process.env.STYK_PORT || 47831);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a port between 1 and 65535.');
const backend = await startBackend({ appRoot, resourcesPath: appRoot, port, log: (message) => process.stdout.write(message), onError: (error) => { console.error(error); process.exit(1); } });
console.log(`StykAnimate is ready at ${backend.origin}`);
let stopped = false;
function stop() { if (stopped) return; stopped = true; backend.stop(); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', () => backend.stop());
