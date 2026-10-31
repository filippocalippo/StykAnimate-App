// Runs first on the web page (a classic script, before the editor's modules): a browser that lacks something the
// editor cannot work without gets a plain explanation instead of a blank page. Nothing here loads the editor.
// build-web.mjs adds this script to the web page only; the desktop app ships its own Chromium.
(() => {
  const missing = [];
  const need = (name, present) => { if (!present) missing.push(name); };
  need('OffscreenCanvas (Safari 16.4 or later)', typeof OffscreenCanvas === 'function');
  need('WebAssembly', typeof WebAssembly === 'object');
  // The engine's modules use WebAssembly SIMD: a module with one 128-bit instruction validates only where it exists.
  need('WebAssembly SIMD (Chrome 91, Firefox 89, Safari 16.4 or later)', typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])));
  need('IndexedDB', !!window.indexedDB);
  need('the Web Crypto API (it needs a secure https page)', !!(window.crypto && window.crypto.subtle));
  need('createImageBitmap', typeof createImageBitmap === 'function');
  need('structuredClone', typeof structuredClone === 'function');
  need('the dialog element', typeof HTMLDialogElement === 'function');
  need('Object.hasOwn and Array.at', typeof Object.hasOwn === 'function' && typeof [].at === 'function');
  need('module workers', typeof Worker === 'function');
  if (!missing.length) return;

  const show = () => {
    const box = document.createElement('main');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1b2230';
    const title = document.createElement('h1');
    title.style.cssText = 'font-size:1.4rem;margin:0 0 .75rem';
    title.textContent = 'StykAnimate needs a newer browser';
    const why = document.createElement('p');
    why.textContent = `This browser is missing ${missing.join(', ')}.`;
    const what = document.createElement('p');
    what.textContent = 'Open this page in a current Chrome, Edge, Firefox or Safari (16.4 or later), or download the desktop app from stykanimate.com.';
    box.append(title, why, what);
    document.body.replaceChildren(box);
    document.title = 'StykAnimate — browser not supported';
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  // Let a test or the console see why.
  window.stykUnsupported = missing;
})();
