import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

const {PagePushes} = createRequire(import.meta.url)('../desktop/page-pushes.cjs');
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('what is sent before the page listens is kept and goes out first, in order, when it does', () => {
  const sent = [];
  const pushes = new PagePushes((channel, args) => sent.push([channel, ...args]));
  pushes.send('styk:file-opened', {name: 'a'});
  pushes.send('styk:menu-action', 'privacy');
  assert.deepEqual(sent, []);
  assert.equal(pushes.held, 2);
  pushes.listen();
  assert.deepEqual(sent, [['styk:file-opened', {name: 'a'}], ['styk:menu-action', 'privacy']]);
  pushes.send('styk:menu-action', 'save');
  assert.deepEqual(sent.at(-1), ['styk:menu-action', 'save'], 'once it listens, a message goes straight out');
  assert.equal(pushes.held, 0);
});

test('a page that loads again has no listeners until it says so, and keeps what is sent meanwhile', () => {
  const sent = [];
  const pushes = new PagePushes((channel, args) => sent.push([channel, ...args]));
  pushes.listen();
  pushes.reset();
  pushes.send('styk:menu-action', 'home');
  assert.deepEqual(sent, []);
  pushes.listen();
  assert.deepEqual(sent, [['styk:menu-action', 'home']]);
});

// The main process sends the file the app was launched with and a stykanimate:// link's menu action as soon as the page has loaded, and the page's
// load event does not wait for src/app.mjs (which waits for the engine) to have registered its listeners: a message sent then was dropped, and the
// link or the file silently did nothing (0 of 3 launches of a bundled app opened stykanimate://privacy; 1 of 8 opened a file). Everything the main
// process pushes goes through PagePushes, and the page says when its listeners are on. (The behaviour itself: scripts/smoke-launch-link.mjs.)
test('the main process pushes menu actions, launch files and library links only through the held queue, and the page says when it listens', async () => {
  const main = await read('desktop/main.cjs');
  for (const channel of ['styk:menu-action', 'styk:file-opened', 'styk:public-library-link'])
    assert.ok(!main.includes(`webContents.send('${channel}'`), `${channel} is not sent straight to the page`);
  assert.ok(main.includes("pushes.send('styk:menu-action'") && main.includes("pushes.send('styk:file-opened'") && main.includes("pushes.send('styk:public-library-link'"));
  assert.match(main, /handle\('styk:page-listening', event => \{ trusted\(event\); pushes\.listen\(\);/);
  assert.ok(main.includes('pushes.reset()'), 'a page that loads again has to say so again');
  assert.ok((await read('desktop/preload.cjs')).includes("pageListening: () => ipcRenderer.invoke('styk:page-listening')"));
  const app = await read('src/app.mjs');
  const listening = app.indexOf('desktop?.pageListening?.()');
  assert.ok(listening > 0, 'the page says it listens');
  for (const listener of ['onOpenFile?.(', 'onMenuAction?.(']) assert.ok(app.indexOf(listener) > 0 && app.indexOf(listener) < listening, `${listener} is registered before the page says it listens`);
});
