// The desktop bridge: `window.stykDesktop`, the API desktop/preload.cjs gave the page in the Electron app, with the
// same names, arguments, answers and errors, over Tauri's `invoke` and events (docs/tauri/README.md).
//
// The desktop app (engine/crates/styk-desktop) runs this file before any of the page's own scripts, after the values
// preload knew synchronously (`window.__STYK_BOOT__`). It is a plain script, not a module: it imports and exports
// nothing, so it runs as an initialization script, and a browser page without the desktop app is left alone.
//
// Every privileged operation is one narrow native command, and the app's capabilities (capabilities/main.json) allow
// exactly those. No file system, process or arbitrary command crosses this boundary.
//
// A command's name is the Electron channel without `styk:`, `-` replaced by `_` (`styk:file-write-begin` is
// `file_write_begin`); events keep their channel names (`styk:file-opened`). Each area of the port fills its own
// section below.
(() => {
  'use strict';
  const boot = globalThis.__STYK_BOOT__;
  const tauri = globalThis.__TAURI__;
  if (!boot || !tauri?.core?.invoke || !tauri?.event?.listen || globalThis.stykDesktop) return;
  const { invoke } = tauri.core;
  const { listen } = tauri.event;

  // ---- Common: errors, calls and events -------------------------------------------------------------------------

  const ERRORS = { RangeError, TypeError, SyntaxError };
  /** A native failure ({message, messageKey, messageParams, name}) as the Error the Electron bridge rejected with. */
  function failure(error) {
    if (error instanceof Error) return error;
    if (error && typeof error === 'object' && typeof error.message === 'string') {
      const visible = new (ERRORS[error.name] ?? Error)(error.message);
      if (typeof error.messageKey === 'string') {
        visible.messageKey = error.messageKey;
        visible.messageParams = error.messageParams && typeof error.messageParams === 'object' ? error.messageParams : {};
      }
      return visible;
    }
    return new Error(String(error));
  }
  const call = (command, args = {}) => invoke(command, args).catch(error => { throw failure(error); });
  const keyed = (error, messageKey) => Object.assign(error, { messageKey, messageParams: {} });

  // Listens are registered with the native side asynchronously; `pageListening` waits for those still on their way,
  // so nothing pushed after it can reach a listener that is not there yet.
  const registering = new Set();
  function subscribe(channel, callback) {
    if (typeof callback !== 'function') throw keyed(new TypeError('A callback is required.'), 'desktop.preload.errors.aCallbackIsRequired');
    let stopped = false;
    const ready = listen(channel, event => { if (!stopped) callback(event.payload); });
    registering.add(ready);
    ready.then(() => registering.delete(ready), () => registering.delete(ready));
    return () => {
      if (stopped) return;
      stopped = true;
      ready.then(unlisten => unlisten()).catch(() => {});
    };
  }

  // ---- Area 1: shell, window and updates ------------------------------------------------------------------------

  // The engine's threads need cross-origin isolation; the native side logs what the page found, and a packaged copy
  // that is not isolated says so.
  addEventListener('load', () => setTimeout(async () => {
    let adapter = null;
    try { const found = await navigator.gpu?.requestAdapter(); adapter = found ? (found.info?.description || found.info?.vendor || 'WebGPU') : null; }
    catch { adapter = null; }
    void call('startup_report', { report: {
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      webgpu: adapter !== null, adapter,
    } }).catch(() => {});
  }, 1500), { once: true });

  const shell = {
    isDesktop: true,
    platform: boot.platform,
    memoryBytes: Number(boot.memoryBytes) || 0,
    startupView: boot.startupView === 'home' || boot.startupView === 'editor' ? boot.startupView : null,
    streamingFileWrite: true,
    importTransport: 'source-bytes-v1',
    // Page zoom keeps CSS layout, pointer coordinates and devicePixelRatio aligned.
    setUIScale: percent => {
      if (!Number.isFinite(percent) || percent < 75 || percent > 200 || percent % 5 !== 0)
        throw keyed(new RangeError('UI scale must be 75–200 in steps of 5.'), 'desktop.preload.errors.uiScaleMustBe75200InStepsOf5');
      void call('set_ui_scale', { percent }).catch(error => console.warn('Interface scale:', error.message));
    },
    newWindow: () => call('new_window'),
    getUpdateState: () => call('update_state'),
    checkForUpdates: () => call('update_check'),
    restartForUpdate: checkpoint => call('update_restart', { checkpoint }),
    openUpdateReleases: () => call('update_releases'),
    onUpdateState: callback => subscribe('styk:update-state-changed', callback),
    getReleaseInfo: (startup = false) => call('release_info', { startup: Boolean(startup) }),
    getReleaseHistory: () => call('release_history'),
    openDonate: () => call('donate'),
    // The page's listeners for what the native side pushes (menu actions, the launch file) are on.
    pageListening: async () => {
      await Promise.allSettled([...registering]);
      return call('page_listening');
    },
    minimize: () => call('window', { action: 'minimize' }),
    maximize: () => call('window', { action: 'maximize' }),
    close: checkpoint => call('window', { action: 'close', checkpoint }),
    getWindowState: () => call('window_state'),
    setDocumentState: state => call('document_state', { state }),
    onMenuAction: callback => subscribe('styk:menu-action', callback),
    onOpenFile: callback => subscribe('styk:file-opened', callback),
    onWindowState: callback => subscribe('styk:window-state', callback),
  };

  // ---- Area 2: files, library, recent files, preferences and recovery -------------------------------------------

  const files = {
    listLibrary: folder => call('library_list', { folder }),
    createLibraryFolder: options => call('library_mkdir', { options }),
    getLibraryThumbnail: path => call('library_thumbnail', { path }),
    beginLibrarySave: options => call('library_save_begin', { options }),
    writeLibraryChunk: (token, bytes) => call('library_write', { token, bytes }),
    finishLibrarySave: token => call('library_finish', { token }),
    cancelLibraryTransfer: token => call('library_cancel', { token }),
    beginLibraryRead: path => call('library_read_begin', { path }),
    readLibraryChunk: token => call('library_read', { token }),
    changeLibraryItem: options => call('library_change', { options }),
    revealLibrary: folder => call('library_reveal', { folder }),
    trashLibraryItem: path => call('library_trash', { path }),
    cacheLibraryThumbnail: options => call('library_thumbnail_cache', { options }),
    getWorkspacePreferences: () => call('workspace_preferences_get'),
    setWorkspacePreferences: preferences => call('workspace_preferences_set', { value: preferences }),
    getEditorSettings: () => call('editor_settings_get'),
    setEditorSettings: settings => call('editor_settings_set', { value: settings }),
    getVfxPresets: () => call('vfx_presets_get'),
    setVfxPresets: presets => call('vfx_presets_set', { value: presets }),
    activateDocument: options => call('document_activate', { options }),
    selectDocument: documentToken => call('document_select', { documentToken }),
    releaseDocument: documentToken => call('document_release', { documentToken }),
    openFile: () => call('open_file'),
    listRecentFiles: () => call('recent_list'),
    openRecentFile: id => call('recent_open', { id }),
    clearRecentFiles: () => call('recent_clear'),
    listProjects: () => call('projects_list'),
    openProject: id => call('projects_open', { id }),
    updateProject: (id, changes) => call('projects_update', { id, changes }),
    removeProject: id => call('projects_remove', { id }),
    revealProject: id => call('projects_reveal', { id }),
    getProjectPreview: id => call('projects_preview', { id }),
    setProjectPreview: options => call('projects_preview_set', { options }),
    changeProjectFolder: change => call('projects_folder', { change }),
    saveFile: options => call('save_file', { options }),
    beginFileWrite: options => call('file_write_begin', { options }),
    beginProjectWrite: options => call('project_write_begin', { options }),
    beginRecoveryWrite: options => call('recovery_write_begin', { options }),
    writeFileChunk: (token, bytes) => call('file_write_chunk', { token, bytes }),
    patchFileWrite: (token, offset, bytes) => call('file_write_patch', { token, offset, bytes }),
    finishFileWrite: token => call('file_write_finish', { token }),
    cancelFileWrite: token => call('file_write_cancel', { token }),
    getRecoveryInfo: () => call('recovery_info'),
    listRecoveries: () => call('recovery_list'),
    beginRecoveryRead: id => call('recovery_read_begin', { id }),
    readFileChunk: token => call('file_read_chunk', { token }),
    closeFileRead: token => call('file_read_close', { token }),
    saveRecovery: options => call('recovery_save', { options }),
    getRecovery: () => call('recovery_get'),
    deleteRecovery: target => call('recovery_delete', { target }),
  };

  // ---- Area 3: export, audio, fonts, the public library, samples, clipboard, support and telemetry ---------------

  const services = {
    beginSharedClipboardWrite: () => call('shared_clipboard_write_begin'),
    writeSharedClipboardChunk: (token, bytes) => call('shared_clipboard_write', { token, bytes }),
    finishSharedClipboardWrite: token => call('shared_clipboard_finish', { token }),
    beginSharedClipboardRead: id => call('shared_clipboard_read_begin', { id }),
    readSharedClipboardChunk: token => call('shared_clipboard_read', { token }),
    cancelSharedClipboardTransfer: token => call('shared_clipboard_cancel', { token }),
    getTelemetryState: () => call('telemetry_state'),
    getSupportContext: () => call('support_context'),
    saveSupportState: value => call('support_save_state', { value }),
    supportRequest: value => call('support_request', { value }),
    connectSupportLive: id => call('support_live', { id }),
    disconnectSupportLive: connection => call('support_live_close', { connection }),
    onSupportLive: callback => subscribe('styk:support-live-event', callback),
    copySupportAccess: () => call('support_copy_access'),
    restoreSupportAccess: key => call('support_restore', { key }),
    downloadSupportFile: value => call('support_download', { value }),
    setTelemetryConsent: value => call('telemetry_consent', { value }),
    recordTelemetry: value => call('telemetry_record', { value }),
    previewTelemetry: () => call('telemetry_preview'),
    syncTelemetry: () => call('telemetry_sync'),
    exportTelemetry: () => call('telemetry_export'),
    deleteTelemetry: () => call('telemetry_delete'),
    sendTelemetryFeedback: value => call('telemetry_feedback', { value }),
    openServicePage: page => call('service_page', { page }),
    recordPerformanceTrace: () => call('performance_trace'),
    onTelemetryState: callback => subscribe('styk:telemetry-state-changed', callback),
    listPublicLibrary: (refresh = false) => call('public_library_list', { refresh: refresh === true }),
    getPublicLibraryPreview: id => call('public_library_preview', { id }),
    readPublicLibraryAsset: id => call('public_library_read', { id }),
    savePublicLibraryAsset: options => call('public_library_save', { options }),
    openPublicLibraryPage: id => call('public_library_page', { id }),
    takePublicLibraryLink: () => call('public_library_link'),
    onPublicLibraryLink: callback => subscribe('styk:public-library-link', callback),
    listFonts: () => call('fonts_list'),
    readFont: id => call('fonts_read', { id }),
    readClipboardText: () => call('clipboard_text_read'),
    writeClipboardText: text => call('clipboard_text_write', { text }),
    getVideoCapabilities: options => call('video_capabilities', { options }),
    beginVideoExport: options => call('video_begin', { options }),
    writeVideoAudioChunk: (token, bytes) => call('video_audio_chunk', { token, bytes }),
    beginAudioImport: options => call('audio_begin', { options }),
    writeAudioImport: (token, bytes) => call('audio_write', { token, bytes }),
    finishAudioImport: token => call('audio_finish', { token }),
    readAudioImport: token => call('audio_read', { token }),
    cancelAudioImport: token => call('audio_cancel', { token }),
    beginVideoFrame: (token, options) => call('video_frame_begin', { token, options }),
    writeVideoChunk: (token, bytes) => call('video_frame_chunk', { token, bytes }),
    endVideoFrame: token => call('video_frame_end', { token }),
    finishVideoExport: token => call('video_finish', { token }),
    readVideoChunk: token => call('video_read', { token }),
    saveVideoExport: (token, options) => call('video_save', { token, options }),
    cancelVideoExport: token => call('video_cancel', { token }),
    getVfwCapabilities: options => call('vfw_capabilities', { options }),
    configureVfwCodec: options => call('vfw_configure', { options }),
    beginVfwExport: options => call('vfw_begin', { options }),
    beginVfwFrame: (token, options) => call('vfw_frame_begin', { token, options }),
    writeVfwChunk: (token, bytes) => call('vfw_frame_chunk', { token, bytes }),
    endVfwFrame: token => call('vfw_frame_end', { token }),
    finishVfwExport: token => call('vfw_finish', { token }),
    readVfwChunk: token => call('vfw_read', { token }),
    saveVfwExport: (token, options) => call('vfw_save', { token, options }),
    cancelVfwExport: token => call('vfw_cancel', { token }),
    // The sample list ({ok, samples}) and one sample's bytes ({ok, name, bytes} or {ok: false, status, code, error}).
    listSamples: () => call('samples_list'),
    readSample: relative => call('sample_read', { relative: typeof relative === 'string' ? relative : null }),
  };

  Object.defineProperty(globalThis, 'stykDesktop', {
    value: Object.freeze({ ...shell, ...files, ...services }),
    writable: false, configurable: false, enumerable: true,
  });
})();
