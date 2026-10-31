// Runs before styles and the app's module graph to avoid a light startup flash.
// Keep this cache key in sync with THEME_CACHE_KEY in theme.mjs.
(() => {
  const resolveTheme = value => value === 'light' || value === 'dark'
    ? value : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  let theme = resolveTheme('system'), stored = null;
  try {
    stored = JSON.parse(localStorage.getItem('stykanimate.editor.settings.v1') || 'null');
    const saved = localStorage.getItem('stykanimate.theme.v1');
    const value = saved ?? stored?.theme;
    theme = resolveTheme(value);
  } catch { /* Follow the system when stored preferences cannot be read. */ }
  document.documentElement.dataset.theme = theme;
  // The touch interface's attributes (src/touch/touch-mode.mjs decides the same way and keeps them current),
  // written before the stylesheet so a phone never paints the desktop layout first.
  try {
    const root = document.documentElement, ui = new URLSearchParams(location.search).get('ui');
    const setting = ['auto', 'on', 'off'].includes(stored?.touchInterface) ? stored.touchInterface : 'auto';
    const touch = ui === 'touch' || (ui !== 'desktop' && (setting === 'on' || (setting === 'auto' && window.matchMedia?.('(pointer: coarse)').matches)));
    root.dataset.input = touch ? 'touch' : 'pointer';
    if (touch) {
      const width = window.innerWidth, height = window.innerHeight;
      const form = Math.min(width, height) < 600 ? 'phone' : 'tablet', orient = width >= height ? 'landscape' : 'portrait';
      Object.assign(root.dataset, {form, orient, touchLayout: `${form}-${orient}`});
    }
  } catch { /* The module decides once it loads. */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0b0f' : '#eceff4');
  // Desktop browser storage is cleared at each launch. Read the native preference now,
  // before the large app module graph loads, rather than relying on origin storage.
  if (window.stykDesktop?.getEditorSettings) {
    document.documentElement.dataset.themePending = '';
    window.stykInitialEditorSettings = Promise.resolve()
      .then(() => window.stykDesktop.getEditorSettings())
      .then(settings => {
        const nativeTheme = resolveTheme(settings?.theme);
        document.documentElement.dataset.theme = nativeTheme;
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', nativeTheme === 'dark' ? '#0a0b0f' : '#eceff4');
        return settings;
      })
      .catch(() => undefined)
      .finally(() => { delete document.documentElement.dataset.themePending; });
  }
})();
