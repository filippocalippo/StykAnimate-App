/** Workspace samples for browser tests on the development server.
 *
 * The desktop app reads a sample from the folder beside the app (desktop/samples.cjs) and imports its
 * bytes; a browser page has no such bridge. `exposeWorkspaceSamples(page)` gives the page the same
 * reader, under the same rules, as `window.stykTestReadSample`; in the page,
 * `(await import('/tests/support/page-samples.mjs')).sampleReader()` is the ImportClient's `readSample`:
 *
 *   await exposeWorkspaceSamples(page);
 *   // in page.evaluate:
 *   const importer = new ImportClient({readSample: (await import('/tests/support/page-samples.mjs')).sampleReader()});
 *   const opened = await importer.openSample('Pivot Animator v5/Animations/tween_camera.piv');
 */
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const {readSample, sampleRoot} = createRequire(import.meta.url)('../../desktop/samples.cjs');
const appRoot = fileURLToPath(new URL('../..', import.meta.url));

export async function exposeWorkspaceSamples(page, root) {
  const folder = root ?? await sampleRoot({appRoot, packaged: false});
  await page.exposeFunction('stykTestReadSample', async relative => {
    const answer = await readSample(folder, relative);
    return answer.ok ? {ok: true, name: answer.name, base64: Buffer.from(answer.bytes).toString('base64')} : answer;
  });
  return folder;
}
