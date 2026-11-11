// Where the StykAnimate app lives: this repository, unless STYK_APP_ROOT points
// elsewhere. The server runs the app's own modules and codec service from there.
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(process.env.STYK_APP_ROOT || path.join(here, '..', '..'));

if (!existsSync(path.join(APP_ROOT, 'src', 'editor.mjs')))
  throw new Error(`StykAnimate app not found at ${APP_ROOT}. Set STYK_APP_ROOT to a StykAnimate-App checkout.`);

/** Imports a module from the app checkout, for example appModule('src/demo.mjs'). */
export const appModule = relative => import(pathToFileURL(path.join(APP_ROOT, relative)).href);
