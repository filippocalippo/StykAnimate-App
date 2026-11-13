import {t as interfaceText} from './localization.mjs';
/** Lets the web build start without a network (docs/WEB.md).
 *
 * The page registers web/sw.js once it has finished loading, so the first visit's
 * own requests never compete with filling the cache. The worker stores the editor
 * at once and the Pivot runtime when asked; a new version of the site installs in
 * the background and is used the next time the app is opened, never under an open
 * project. The desktop app does not load this module: build-web.mjs adds it, with
 * the install manifest, to the web page only.
 */
export const OFFLINE_WORKER = './sw.js';

export const canWorkOffline = (env = globalThis) => Boolean(env.isSecureContext && env.navigator && 'serviceWorker' in env.navigator);

/** Resolves a moment after the page's load event. */
const afterLoad = (env, delay) => new Promise(resolve => {
  const settle = () => env.setTimeout(resolve, delay);
  if (env.document.readyState === 'complete') settle(); else env.addEventListener('load', settle, {once: true});
});

/**
 * Registers the worker, asks it to keep the Pivot runtime too (unless the browser
 * asks to save data), and reports a version that is ready for the next start.
 * Resolves with the registration, or null where offline use is unavailable.
 */
export async function enableOffline({env = globalThis, delay = 3000, onUpdate = () => {}, onError = () => {}} = {}) {
  if (!canWorkOffline(env)) return null;
  await afterLoad(env, delay);
  try {
    const {serviceWorker} = env.navigator;
    const registration = await serviceWorker.register(OFFLINE_WORKER, {scope: './'});
    // A first install has no controller yet; only a replacement is news.
    const track = worker => worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && serviceWorker.controller) onUpdate(registration); });
    registration.addEventListener('updatefound', () => track(registration.installing));
    // The browser looks for a new version on every visit, so one can be installing or already waiting before this
    // page listens (it registers a moment after loading); that version is news too.
    if (serviceWorker.controller) {
      if (registration.waiting) onUpdate(registration);
      else track(registration.installing);
    }
    const ready = await serviceWorker.ready;
    if (!env.navigator.connection?.saveData) ready.active?.postMessage({type: 'precache-codec'});
    // An installed app is where losing the browser's storage would cost the most; ask it to keep it (silently, in Chromium).
    if (env.matchMedia?.('(display-mode: standalone)').matches) env.navigator.storage?.persist?.().catch(() => {});
    return registration;
  } catch (error) {
    onError(error);
    return null;
  }
}

if (typeof document !== 'undefined' && document.querySelector('meta[name="styk-codec"][content="browser"]')) {
  enableOffline({
    onUpdate: () => globalThis.styk?.ui?.toasts?.show({message: interfaceText("webOffline.aNewVersionOfStykanimateIsReadyIt"), messageKey: "webOffline.aNewVersionOfStykanimateIsReadyIt", slot: 'update', timeout: 10000, dismissible: true}),
    onError: error => console.warn('Offline use is unavailable:', error?.message ?? error),
  });
}
