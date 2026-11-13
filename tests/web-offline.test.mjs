import test from 'node:test';
import assert from 'node:assert/strict';
import {canWorkOffline, enableOffline, OFFLINE_WORKER} from '../src/web-offline.mjs';

/** A page and its service worker container, with what the registration does recorded. */
function environment({secure = true, worker = true, controlled = false, saveData = false, standalone = false} = {}) {
  const log = {registered: [], messages: [], persisted: 0, timers: []};
  const listeners = new Set();
  const installing = new EventTarget();
  const registration = Object.assign(new EventTarget(), {installing: null, active: {postMessage: message => log.messages.push(message)}});
  const container = {
    controller: controlled ? {} : null,
    register: async (url, options) => { log.registered.push([url, options]); return registration; },
    ready: Promise.resolve(registration),
  };
  const env = {
    isSecureContext: secure,
    navigator: {...(worker ? {serviceWorker: container} : {}), connection: {saveData}, storage: {persist: async () => { log.persisted++; return true; }}},
    document: {readyState: 'complete'},
    addEventListener: (type, listener) => { if (type === 'load') listeners.add(listener); },
    setTimeout: (callback, delay) => { log.timers.push(delay); callback(); return 0; },
    matchMedia: query => ({matches: standalone && query === '(display-mode: standalone)'}),
  };
  const install = state => { installing.state = state; installing.dispatchEvent(new Event('statechange')); };
  Object.defineProperty(installing, 'state', {value: 'installing', writable: true});
  return {env, log, registration, installing, install, listeners};
}

test('offline use needs a secure page with service workers', async () => {
  assert.equal(canWorkOffline(environment().env), true);
  assert.equal(canWorkOffline(environment({secure: false}).env), false);
  assert.equal(canWorkOffline(environment({worker: false}).env), false);
  assert.equal(await enableOffline({env: environment({worker: false}).env}), null, 'nothing is registered where it cannot work');
});

test('the worker is registered after the page has loaded, and asked to keep the Pivot runtime', async () => {
  const page = environment();
  const registration = await enableOffline({env: page.env, delay: 1234});
  assert.equal(registration, page.registration);
  assert.deepEqual(page.log.registered, [[OFFLINE_WORKER, {scope: './'}]]);
  assert.deepEqual(page.log.timers, [1234], 'a quiet moment follows the load event');
  assert.deepEqual(page.log.messages, [{type: 'precache-codec'}]);
  assert.equal(page.log.persisted, 0, 'storage is only asked to persist for an installed app');

  const waiting = environment();
  waiting.env.document.readyState = 'loading';
  const pending = enableOffline({env: waiting.env});
  await Promise.resolve();
  assert.equal(waiting.log.registered.length, 0, 'still waiting for the load event');
  for (const listener of waiting.listeners) listener();
  await pending;
  assert.equal(waiting.log.registered.length, 1);
});

test('a browser that saves data keeps the editor but not the 13 MiB Pivot runtime', async () => {
  const page = environment({saveData: true});
  await enableOffline({env: page.env});
  assert.equal(page.log.registered.length, 1);
  assert.deepEqual(page.log.messages, []);
});

test('an installed app asks the browser to keep its storage', async () => {
  const page = environment({standalone: true});
  await enableOffline({env: page.env});
  assert.equal(page.log.persisted, 1);
});

test('only a replacement version is reported, never the first install', async () => {
  for (const [controlled, expected] of [[true, 1], [false, 0]]) {
    const page = environment({controlled});
    const updates = [];
    await enableOffline({env: page.env, onUpdate: registration => updates.push(registration)});
    page.registration.installing = page.installing;
    page.registration.dispatchEvent(new Event('updatefound'));
    page.install('installing');
    assert.equal(updates.length, 0, 'not while installing');
    page.install('installed');
    assert.equal(updates.length, expected, controlled ? 'a new version waits for the next start' : 'the first install is not news');
    if (expected) assert.equal(updates[0], page.registration);
  }
});

test('a new version the browser found before the page listened is still reported', async () => {
  // The browser checks for a new version on every visit, and the page registers a moment after loading.
  const waiting = environment({controlled: true});
  waiting.registration.waiting = {state: 'installed'};
  const ready = [];
  await enableOffline({env: waiting.env, onUpdate: registration => ready.push(registration)});
  assert.deepEqual(ready, [waiting.registration], 'a version already waiting is reported once');

  const installing = environment({controlled: true});
  installing.registration.installing = installing.installing;
  const later = [];
  await enableOffline({env: installing.env, onUpdate: registration => later.push(registration)});
  assert.equal(later.length, 0, 'not while installing');
  installing.install('installed');
  assert.deepEqual(later, [installing.registration], 'a version already installing is reported when it is ready');

  const first = environment();
  first.registration.installing = first.installing;
  const none = [];
  await enableOffline({env: first.env, onUpdate: registration => none.push(registration)});
  first.install('installed');
  assert.equal(none.length, 0, 'the first install is still not news');
});

test('a registration that fails is reported and never breaks the app', async () => {
  const page = environment();
  const failure = new Error('SecurityError');
  page.env.navigator.serviceWorker.register = async () => { throw failure; };
  const errors = [];
  assert.equal(await enableOffline({env: page.env, onError: error => errors.push(error)}), null);
  assert.deepEqual(errors, [failure]);
});
