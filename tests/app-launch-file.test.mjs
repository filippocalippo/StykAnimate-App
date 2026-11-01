import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// The main process sends the file the app was launched with as soon as the page has loaded. src/app.mjs waits for the engine at the top of its body
// (a module that waits does not hold the load event back), so a listener registered after that wait can miss the message: the file silently does not
// open. Launching a packaged app with a file lost it in most runs. (The behaviour itself is checked by launching the app with a file: scripts/smoke-home.mjs.)
test('the listener for the launch file is on before the application waits for the engine, and is registered once', async () => {
  const source = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const listener = source.indexOf('onOpenFile?.(');
  const wait = source.indexOf('await loadEngine()');
  assert.ok(listener > 0 && wait > 0);
  assert.ok(listener < wait, 'the listener comes before the wait for the engine');
  assert.equal(source.split('onOpenFile?.(').length - 1, 1, 'one listener for the launch file');
  assert.match(source, /openFileListener = guarded\(async \(result\) => \{ await editorReady;/);
});
