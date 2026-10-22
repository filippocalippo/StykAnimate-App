'use strict';
// BEGIN generated localization diagnostics
const diagnosticEnglish = {
  "desktop.preload.errors.aCallbackIsRequired": "A callback is required.",
  "desktop.preload.errors.uiScaleMustBe75200InStepsOf5": "UI scale must be 75–200 in steps of 5."
};
function diagnosticError(error, source, messageKey, messageParams = {}) {
  if (typeof source !== 'string') throw new TypeError(`Unknown error message: ${messageKey}`);
  messageParams = Object.fromEntries(Object.entries(messageParams).map(([name, value]) => {
    // Only an explicit scalar diagnostic value can accompany a display reference.
    // Original English diagnostics remain stable through worker/IPC round trips.
    if (value && typeof value.messageKey === 'string' && Object.hasOwn(value, 'diagnosticValue'))
      return [name, {messageKey:value.messageKey, diagnosticValue:String(value.diagnosticValue),
        ...(value.messageParams ? {messageParams:Object.fromEntries(Object.entries(value.messageParams).map(([key, scalar]) => [key, typeof scalar === 'number' && Number.isFinite(scalar) ? scalar : String(scalar)]))} : {})}];
    return [name, typeof value === 'number' && Number.isFinite(value) ? value : String(value)];
  }));
  const message = source.replace(/\{([A-Za-z]\w*)\}/g, (token, name) => Object.hasOwn(messageParams, name) ? String(messageParams[name]?.diagnosticValue ?? messageParams[name]) : token);
  Object.defineProperty(error, 'message', {value: message, configurable: true, writable: true});
  error.messageKey = messageKey;
  error.messageParams = messageParams;
  return error;
}
const messageError = (error, key, params) => diagnosticError(error, diagnosticEnglish[key], key, params);
// END generated localization diagnostics


const { contextBridge, ipcRenderer, webFrame } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw messageError(new TypeError(''), 'desktop.preload.errors.aCallbackIsRequired', {});
  // Menu actions carry a second argument, {fromKeyboard}; other channels send one value.
  const listener = (_event, value, details) => callback(value, details);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Sandboxed preloads cannot require('os'); total memory is a synchronous
// main-process value. Failure degrades to the navigator.deviceMemory hint.
function systemMemoryBytes() {
  try { return ipcRenderer.sendSync('styk:memory-bytes') || 0; } catch { return 0; }
}

// The loopback codec rejects /api/* requests without this per-launch token.
function apiToken() {
  try { return ipcRenderer.sendSync('styk:api-token') || ''; } catch { return ''; }
}

// Where this window starts ('home' or 'editor'), when the launch decides it (main.cjs startupView); else null.
function startupView() {
  const value = (process.argv ?? []).find(argument => argument.startsWith('--styk-startup-view='))?.slice('--styk-startup-view='.length);
  return value === 'home' || value === 'editor' ? value : null;
}

// Every privileged operation has a narrow handler in main.cjs. No filesystem,
// Node.js, Electron object, or arbitrary IPC channel crosses this boundary.
contextBridge.exposeInMainWorld('stykDesktop', Object.freeze({
  isDesktop: true,
  apiToken: apiToken(),
  startupView: startupView(),
  // Page zoom keeps CSS layout, pointer coordinates and devicePixelRatio aligned.
  setUIScale: percent => {
    if (!Number.isFinite(percent) || percent < 75 || percent > 200 || percent % 5 !== 0)
      throw messageError(new RangeError(''), 'desktop.preload.errors.uiScaleMustBe75200InStepsOf5', {});
    webFrame.setZoomFactor(percent / 100);
  },
  newWindow: () => ipcRenderer.invoke('styk:new-window'),
  beginSharedClipboardWrite: () => ipcRenderer.invoke('styk:shared-clipboard-write-begin'),
  writeSharedClipboardChunk: (token, bytes) => ipcRenderer.invoke('styk:shared-clipboard-write', token, bytes),
  finishSharedClipboardWrite: token => ipcRenderer.invoke('styk:shared-clipboard-finish', token),
  beginSharedClipboardRead: id => ipcRenderer.invoke('styk:shared-clipboard-read-begin', id),
  readSharedClipboardChunk: token => ipcRenderer.invoke('styk:shared-clipboard-read', token),
  cancelSharedClipboardTransfer: token => ipcRenderer.invoke('styk:shared-clipboard-cancel', token),
  platform: process.platform,
  memoryBytes: systemMemoryBytes(),
  streamingFileWrite: true,
  importTransport: 'source-bytes-v1',
  getUpdateState: () => ipcRenderer.invoke('styk:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('styk:update-check'),
  restartForUpdate: checkpoint => ipcRenderer.invoke('styk:update-restart', checkpoint),
  openUpdateReleases: () => ipcRenderer.invoke('styk:update-releases'),
  onUpdateState: callback => subscribe('styk:update-state-changed', callback),
  getReleaseInfo: (startup = false) => ipcRenderer.invoke('styk:release-info', Boolean(startup)),
  getReleaseHistory: () => ipcRenderer.invoke('styk:release-history'),
  openDonate: () => ipcRenderer.invoke('styk:donate'),
  getTelemetryState: () => ipcRenderer.invoke('styk:telemetry-state'),
  getSupportContext: () => ipcRenderer.invoke('styk:support-context'),
  saveSupportState: value => ipcRenderer.invoke('styk:support-save-state', value),
  supportRequest: value => ipcRenderer.invoke('styk:support-request', value),
  connectSupportLive: id => ipcRenderer.invoke('styk:support-live', id),
  disconnectSupportLive: connection => ipcRenderer.invoke('styk:support-live-close', connection),
  onSupportLive: callback => subscribe('styk:support-live-event', callback),
  copySupportAccess: () => ipcRenderer.invoke('styk:support-copy-access'),
  restoreSupportAccess: key => ipcRenderer.invoke('styk:support-restore', key),
  downloadSupportFile: value => ipcRenderer.invoke('styk:support-download', value),
  setTelemetryConsent: value => ipcRenderer.invoke('styk:telemetry-consent', value),
  recordTelemetry: value => ipcRenderer.invoke('styk:telemetry-record', value),
  previewTelemetry: () => ipcRenderer.invoke('styk:telemetry-preview'),
  syncTelemetry: () => ipcRenderer.invoke('styk:telemetry-sync'),
  exportTelemetry: () => ipcRenderer.invoke('styk:telemetry-export'),
  deleteTelemetry: () => ipcRenderer.invoke('styk:telemetry-delete'),
  sendTelemetryFeedback: value => ipcRenderer.invoke('styk:telemetry-feedback', value),
  openServicePage: page => ipcRenderer.invoke('styk:service-page', page),
  recordPerformanceTrace: () => ipcRenderer.invoke('styk:performance-trace'),
  onTelemetryState: callback => subscribe('styk:telemetry-state-changed', callback),
  listLibrary: folder => ipcRenderer.invoke('styk:library-list', folder),
  createLibraryFolder: options => ipcRenderer.invoke('styk:library-mkdir', options),
  getLibraryThumbnail: path => ipcRenderer.invoke('styk:library-thumbnail', path),
  beginLibrarySave: options => ipcRenderer.invoke('styk:library-save-begin', options),
  writeLibraryChunk: (token, bytes) => ipcRenderer.invoke('styk:library-write', token, bytes),
  finishLibrarySave: token => ipcRenderer.invoke('styk:library-finish', token),
  cancelLibraryTransfer: token => ipcRenderer.invoke('styk:library-cancel', token),
  beginLibraryRead: path => ipcRenderer.invoke('styk:library-read-begin', path),
  readLibraryChunk: token => ipcRenderer.invoke('styk:library-read', token),
  changeLibraryItem: options => ipcRenderer.invoke('styk:library-change', options),
  revealLibrary: folder => ipcRenderer.invoke('styk:library-reveal', folder),
  trashLibraryItem: path => ipcRenderer.invoke('styk:library-trash', path),
  cacheLibraryThumbnail: options => ipcRenderer.invoke('styk:library-thumbnail-cache', options),
  listPublicLibrary: (refresh = false) => ipcRenderer.invoke('styk:public-library-list', refresh === true),
  getPublicLibraryPreview: id => ipcRenderer.invoke('styk:public-library-preview', id),
  readPublicLibraryAsset: id => ipcRenderer.invoke('styk:public-library-read', id),
  savePublicLibraryAsset: options => ipcRenderer.invoke('styk:public-library-save', options),
  openPublicLibraryPage: id => ipcRenderer.invoke('styk:public-library-page', id),
  takePublicLibraryLink: () => ipcRenderer.invoke('styk:public-library-link'),
  onPublicLibraryLink: callback => subscribe('styk:public-library-link', callback),
  getWorkspacePreferences: () => ipcRenderer.invoke('styk:workspace-preferences-get'),
  setWorkspacePreferences: (preferences) => ipcRenderer.invoke('styk:workspace-preferences-set', preferences),
  getEditorSettings: () => ipcRenderer.invoke('styk:editor-settings-get'),
  setEditorSettings: (settings) => ipcRenderer.invoke('styk:editor-settings-set', settings),
  getVfxPresets: () => ipcRenderer.invoke('styk:vfx-presets-get'),
  setVfxPresets: (presets) => ipcRenderer.invoke('styk:vfx-presets-set', presets),
  listFonts: () => ipcRenderer.invoke('styk:fonts-list'),
  readFont: (id) => ipcRenderer.invoke('styk:fonts-read', id),
  readClipboardText: () => ipcRenderer.invoke('styk:clipboard-text-read'),
  writeClipboardText: text => ipcRenderer.invoke('styk:clipboard-text-write', text),
  getVideoCapabilities: options => ipcRenderer.invoke('styk:video-capabilities', options),
  beginVideoExport: options => ipcRenderer.invoke('styk:video-begin', options),
  writeVideoAudioChunk: (token, bytes) => ipcRenderer.invoke('styk:video-audio-chunk', token, bytes),
  beginAudioImport: options => ipcRenderer.invoke('styk:audio-begin', options),
  writeAudioImport: (token, bytes) => ipcRenderer.invoke('styk:audio-write', token, bytes),
  finishAudioImport: token => ipcRenderer.invoke('styk:audio-finish', token),
  readAudioImport: token => ipcRenderer.invoke('styk:audio-read', token),
  cancelAudioImport: token => ipcRenderer.invoke('styk:audio-cancel', token),
  beginVideoFrame: (token, options) => ipcRenderer.invoke('styk:video-frame-begin', token, options),
  writeVideoChunk: (token, bytes) => ipcRenderer.invoke('styk:video-frame-chunk', token, bytes),
  endVideoFrame: token => ipcRenderer.invoke('styk:video-frame-end', token),
  finishVideoExport: token => ipcRenderer.invoke('styk:video-finish', token),
  readVideoChunk: token => ipcRenderer.invoke('styk:video-read', token),
  saveVideoExport: (token, options) => ipcRenderer.invoke('styk:video-save', token, options),
  cancelVideoExport: token => ipcRenderer.invoke('styk:video-cancel', token),
  getVfwCapabilities: options => ipcRenderer.invoke('styk:vfw-capabilities', options),
  configureVfwCodec: options => ipcRenderer.invoke('styk:vfw-configure', options),
  beginVfwExport: options => ipcRenderer.invoke('styk:vfw-begin', options),
  beginVfwFrame: (token, options) => ipcRenderer.invoke('styk:vfw-frame-begin', token, options),
  writeVfwChunk: (token, bytes) => ipcRenderer.invoke('styk:vfw-frame-chunk', token, bytes),
  endVfwFrame: token => ipcRenderer.invoke('styk:vfw-frame-end', token),
  finishVfwExport: token => ipcRenderer.invoke('styk:vfw-finish', token),
  readVfwChunk: token => ipcRenderer.invoke('styk:vfw-read', token),
  saveVfwExport: (token, options) => ipcRenderer.invoke('styk:vfw-save', token, options),
  cancelVfwExport: token => ipcRenderer.invoke('styk:vfw-cancel', token),
  activateDocument: (options) => ipcRenderer.invoke('styk:document-activate', options),
  selectDocument: (documentToken) => ipcRenderer.invoke('styk:document-select', documentToken),
  releaseDocument: (documentToken) => ipcRenderer.invoke('styk:document-release', documentToken),
  openFile: () => ipcRenderer.invoke('styk:open-file'),
  listRecentFiles: () => ipcRenderer.invoke('styk:recent-list'),
  openRecentFile: id => ipcRenderer.invoke('styk:recent-open', id),
  clearRecentFiles: () => ipcRenderer.invoke('styk:recent-clear'),
  listProjects: () => ipcRenderer.invoke('styk:projects-list'),
  openProject: id => ipcRenderer.invoke('styk:projects-open', id),
  updateProject: (id, changes) => ipcRenderer.invoke('styk:projects-update', id, changes),
  removeProject: id => ipcRenderer.invoke('styk:projects-remove', id),
  revealProject: id => ipcRenderer.invoke('styk:projects-reveal', id),
  getProjectPreview: id => ipcRenderer.invoke('styk:projects-preview', id),
  setProjectPreview: options => ipcRenderer.invoke('styk:projects-preview-set', options),
  changeProjectFolder: change => ipcRenderer.invoke('styk:projects-folder', change),
  saveFile: (options) => ipcRenderer.invoke('styk:save-file', options),
  beginFileWrite: (options) => ipcRenderer.invoke('styk:file-write-begin', options),
  beginProjectWrite: (options) => ipcRenderer.invoke('styk:project-write-begin', options),
  beginRecoveryWrite: (options) => ipcRenderer.invoke('styk:recovery-write-begin', options),
  beginClipboardWrite: (options) => ipcRenderer.invoke('styk:clipboard-write-begin', options),
  beginClipboardRead: () => ipcRenderer.invoke('styk:clipboard-read-begin'),
  writeFileChunk: (token, bytes) => ipcRenderer.invoke('styk:file-write-chunk', token, bytes),
  patchFileWrite: (token, offset, bytes) => ipcRenderer.invoke('styk:file-write-patch', token, offset, bytes),
  finishFileWrite: (token) => ipcRenderer.invoke('styk:file-write-finish', token),
  cancelFileWrite: (token) => ipcRenderer.invoke('styk:file-write-cancel', token),
  getRecoveryInfo: () => ipcRenderer.invoke('styk:recovery-info'),
  listRecoveries: () => ipcRenderer.invoke('styk:recovery-list'),
  beginRecoveryRead: (id) => ipcRenderer.invoke('styk:recovery-read-begin', id),
  readFileChunk: (token) => ipcRenderer.invoke('styk:file-read-chunk', token),
  closeFileRead: (token) => ipcRenderer.invoke('styk:file-read-close', token),
  saveRecovery: (options) => ipcRenderer.invoke('styk:recovery-save', options),
  getRecovery: () => ipcRenderer.invoke('styk:recovery-get'),
  deleteRecovery: (target) => ipcRenderer.invoke('styk:recovery-delete', target),
  minimize: () => ipcRenderer.invoke('styk:window', 'minimize'),
  maximize: () => ipcRenderer.invoke('styk:window', 'maximize'),
  close: checkpoint => ipcRenderer.invoke('styk:window', 'close', checkpoint),
  getWindowState: () => ipcRenderer.invoke('styk:window-state'),
  setDocumentState: (state) => ipcRenderer.invoke('styk:document-state', state),
  onMenuAction: (callback) => subscribe('styk:menu-action', callback),
  editText: (command) => ipcRenderer.invoke('styk:edit-text', command),
  onOpenFile: (callback) => subscribe('styk:file-opened', callback),
  onWindowState: (callback) => subscribe('styk:window-state', callback),
  onBackendError: (callback) => subscribe('styk:backend-error', callback),
}));
