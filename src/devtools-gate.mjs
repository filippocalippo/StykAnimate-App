/**
 * Starts the developer tools in the developer build only (docs/DEVTOOLS.md).
 *
 * The developer build's early script (src/devtools/early.js) marks the page before any module runs; without that mark
 * this does nothing. The tools' modules are never bundled and never shipped: they load here, by URL, from the developer
 * build's own copy of `src/devtools/`, so the shipping bundle holds no line of them (scripts/check-devtools-shipping.mjs).
 */
export function startDevtools(app, owners) {
  if (globalThis.__STYK_DEVTOOLS__ !== true) return null;
  // A URL the bundler does not follow: the tools stay out of every bundle.
  const url = new URL('./devtools/devtools.mjs', import.meta.url).href;
  return import(url).then(tools => tools.start(app, owners), error => { console.error('[devtools] The developer tools did not load:', error); return null; });
}
