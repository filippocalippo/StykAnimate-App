'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const { startBackend } = require('./backend.cjs');
const { RecoveryStore, atomicWrite } = require('./recovery.cjs');
const { FileStreams } = require('./file-streams.cjs');
const { WorkspacePreferences } = require('./preferences.cjs');
const { ProjectFiles } = require('./project-files.cjs');
const { FontService } = require('./font-service.cjs');
const { VideoExportService } = require('./video-export-service.cjs');
const { VfwExportService } = require('./vfw-export-service.cjs');
const { RecentFiles } = require('./recent-files.cjs');
const { LibraryStore } = require('./library-store.cjs');

const APP_ROOT = path.resolve(__dirname, '..');
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const FILE_FILTERS = [
  { name: 'Animation and stick figures', extensions: ['styk', 'stykmov', 'stkz', 'piv', 'stk', 'json', 'nodes', 'nodemc', 'stknds', 'zip'] },
  { name: 'StykAnimate movieclip', extensions: ['stykmov'] },
  { name: 'StykAnimate figure', extensions: ['stkz'] },
  { name: 'Pivot animation', extensions: ['piv'] },
  { name: 'Pivot stick figure', extensions: ['stk'] },
  { name: 'StykAnimate project', extensions: ['styk', 'json'] },
];
let window;
let backend;
let fileStreams;
let videoExports;
let vfwExports;
let recentFiles;
let library;
const projectFiles = new ProjectFiles();
let documentState = { name: 'Untitled', dirty: false };
let quitting = false;
let pendingFiles = process.argv.slice(app.isPackaged ? 1 : 2).filter((arg) => /\.(piv|stk|styk|stkz|stykmov|json|nodes|nodemc|stknds|zip)$/i.test(arg));

// WebGPU uses Chromium's normal driver allowlist. The opt-in switch is useful
// for Linux development on drivers Chromium has not yet qualified.
if (process.env.STYK_GPU_UNSAFE === '1') app.commandLine.appendSwitch('enable-unsafe-webgpu');

app.setName('StykAnimate');
const profileDirectory = process.env.STYK_USER_DATA_DIR || (!app.isPackaged ? path.join(APP_ROOT, '.desktop-data') : null);
if (profileDirectory) {
  mkdirSync(profileDirectory, { recursive: true });
  app.setPath('userData', profileDirectory);
  app.setPath('sessionData', profileDirectory);
  app.setPath('crashDumps', path.join(profileDirectory, 'crashes'));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
    for (const file of argv.filter((arg) => /\.(piv|stk|styk|stkz|stykmov|json|nodes|nodemc|stknds|zip)$/i.test(arg))) queueOpenFile(file);
  });
  app.on('open-file', (event, file) => { event.preventDefault(); queueOpenFile(file); });
  app.whenReady().then(start).catch(async (error) => {
    dialog.showErrorBox('StykAnimate could not start', error.message);
    app.quit();
  });
}

function trusted(event) {
  const url = event.senderFrame?.url || '';
  if (!window || event.sender !== window.webContents || !backend || new URL(url).origin !== backend.origin) {
    throw new Error('This operation is restricted to the StykAnimate workspace.');
  }
}

function sendAction(action) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send('styk:menu-action', action);
}

function windowState() {
  return { maximized: window?.isMaximized() || false, fullscreen: window?.isFullScreen() || false, focused: window?.isFocused() || false };
}

function nativeMenu() {
  const item = (label, action, accelerator) => ({ label, accelerator, click: () => sendAction(action) });
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      item('New animation', 'new', 'CmdOrCtrl+N'),
      item('Open…', 'open', 'CmdOrCtrl+O'),
      { type: 'separator' },
      item('Save', 'save', 'CmdOrCtrl+S'),
      item('Save as…', 'save-as', 'CmdOrCtrl+Shift+S'),
      item('Save figure…', 'export-stkz'),
      item('Export…', 'export', 'CmdOrCtrl+Shift+E'),
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [
      item('Undo', 'undo', 'CmdOrCtrl+Z'), item('Redo', 'redo', process.platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Y'),
      { type: 'separator' },
      item('Cut', 'cut', 'CmdOrCtrl+X'), item('Copy', 'copy', 'CmdOrCtrl+C'), item('Paste', 'paste', 'CmdOrCtrl+V'),
      item('Duplicate', 'duplicate', 'CmdOrCtrl+D'), item('Delete', 'delete', 'Delete'),
      { type: 'separator' }, item('Select all', 'select-all', 'CmdOrCtrl+A'),
    ] },
    { label: 'Animation', submenu: [
      item('Play / pause', 'play'), item('Add frame', 'add-frame', 'F6'),
      item('Previous frame', 'previous-frame', ','), item('Next frame', 'next-frame', '.'),
      { type: 'separator' }, item('Onion skin', 'toggle-onion', 'O'),
    ] },
    { label: 'View', submenu: [
      item('Zoom in', 'zoom-in', 'CmdOrCtrl+Plus'), item('Zoom out', 'zoom-out', 'CmdOrCtrl+-'),
      item('Fit canvas', 'zoom-reset', 'Shift+1'), { type: 'separator' }, { role: 'togglefullscreen' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
    ] },
    { label: 'Help', submenu: [item('Keyboard shortcuts', 'help'), item('About StykAnimate', 'about')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function readImportFile(file) {
  const started = performance.now();
  const extension = path.extname(file).toLowerCase();
  if (!['.piv', '.stk', '.styk', '.stkz', '.stykmov', '.json', '.nodes', '.nodemc', '.stknds', '.zip'].includes(extension)) throw new Error('Choose a StykAnimate, Pivot or Stick Nodes file.');
  const limit = ['.styk', '.stkz', '.stykmov', '.json'].includes(extension) ? MAX_FILE_BYTES : 128 * 1024 * 1024;
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Choose an animation or stick figure file.');
  if (stat.size > limit) throw new Error(`This file exceeds the ${limit / 1024 / 1024} MB import limit.`);
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) throw new Error('This file grew past the import limit while being read.');
  app.addRecentDocument(file);
  await rememberRecent(file);
  // The renderer transfers these compact source bytes to its import worker.
  // Expanded JSON is never parsed or transported through Electron main.
  return {
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    filename: path.basename(file),
    nativePath: file,
    openToken: projectFiles.rememberOpen(path.resolve(file)),
    kind: extension === '.stykmov' ? 'stykmov' : extension === '.stkz' ? 'stkz' : extension === '.stk' ? 'stk' : extension === '.piv' ? 'piv' : 'styk',
    sourceBytes: bytes.length,
    timings: { native_read_ms: +(performance.now() - started).toFixed(3) },
  };
}

async function rememberRecent(file) {
  if (!recentFiles || !/\.(piv|stk|styk|stkz|stykmov|json|nodes|nodemc|stknds|zip)$/i.test(file)) return;
  // A damaged preferences directory must not turn a completed save into failure.
  try { await recentFiles.remember(path.resolve(file)); }
  catch (error) { console.warn('Recent files could not be updated:', error.message); }
}

async function queueOpenFile(file) {
  if (!window || !backend || window.webContents.isLoading()) { pendingFiles.push(file); return; }
  try { window.webContents.send('styk:file-opened', await readImportFile(file)); }
  catch (error) { dialog.showErrorBox('Unable to open file', error.message); }
}

function registerIpc() {
  for (const [channel, method] of [['list','list'], ['mkdir','createFolder'], ['thumbnail','thumbnail'], ['save-begin','beginSave'], ['write','write'], ['finish','finish'], ['cancel','cancel'], ['read-begin','beginRead'], ['read','read'], ['change','change']])
    ipcMain.handle(`styk:library-${channel}`, (event, ...args) => { trusted(event); return library[method](...args); });
  ipcMain.handle('styk:library-reveal', async (event, folder = '') => { trusted(event); const error = await shell.openPath(await library.folder(folder)); if (error) throw new Error(error); });
  recentFiles = new RecentFiles({directory: app.getPath('userData'), limit: 20});
  ipcMain.handle('styk:recent-list', event => { trusted(event); return recentFiles.list(); });
  ipcMain.handle('styk:recent-open', async (event, id) => { trusted(event); return readImportFile(await recentFiles.resolve(id)); });
  ipcMain.handle('styk:recent-clear', event => { trusted(event); return recentFiles.clear(); });
  ipcMain.handle('styk:clipboard-text-read', event => {
    trusted(event); const text = clipboard.readText();
    if (text.length > 100) throw new Error('The clipboard does not contain a short segment value.');
    return text;
  });
  ipcMain.handle('styk:clipboard-text-write', (event, text) => {
    trusted(event);
    if (typeof text !== 'string' || text.length > 100) throw new Error('Segment clipboard text must contain at most 100 characters.');
    clipboard.writeText(text); return true;
  });
  const encoderRoot = app.isPackaged ? process.resourcesPath : path.join(APP_ROOT, 'build');
  videoExports = new VideoExportService({encoderPath: path.join(encoderRoot, 'video-encoder', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), tempRoot: app.getPath('temp')});
  for (const [channel, method] of [
    ['video-capabilities', 'capabilities'], ['video-begin', 'begin'], ['video-frame-begin', 'beginFrame'], ['video-frame-chunk', 'writeFrameChunk'],
    ['video-frame-end', 'endFrame'], ['video-finish', 'finish'], ['video-read', 'read'], ['video-cancel', 'cancel'],
  ]) ipcMain.handle(`styk:${channel}`, (event, ...args) => { trusted(event); return videoExports[method](...args); });
  const vfwRoot = app.isPackaged ? path.join(process.resourcesPath, 'vfw') : path.join(APP_ROOT, 'native', 'bin');
  vfwExports = new VfwExportService({helperPaths: {x86: path.join(vfwRoot, 'x86', 'styk-vfw.exe'), x64: path.join(vfwRoot, 'x64', 'styk-vfw.exe')}, tempRoot: app.getPath('temp')});
  for (const [channel, method] of [
    ['vfw-capabilities', 'capabilities'], ['vfw-begin', 'begin'], ['vfw-frame-begin', 'beginFrame'], ['vfw-frame-chunk', 'writeFrameChunk'],
    ['vfw-frame-end', 'endFrame'], ['vfw-finish', 'finish'], ['vfw-read', 'read'], ['vfw-cancel', 'cancel'],
  ]) ipcMain.handle(`styk:${channel}`, (event, ...args) => { trusted(event); return vfwExports[method](...args); });
  ipcMain.handle('styk:vfw-configure', async (event, options) => {
    trusted(event); const owner = window;
    const handle = owner.getNativeWindowHandle();
    const hwnd = (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
    try { return await vfwExports.configure(options, hwnd); }
    finally { if (!owner.isDestroyed()) { owner.setEnabled(true); owner.focus(); } }
  });
  const recovery = new RecoveryStore(app.getPath('userData'));
  const preferences = new WorkspacePreferences(app.getPath('userData'));
  const editorSettings = new WorkspacePreferences(app.getPath('userData'), { filename: 'editor-settings.json' });
  const fonts = new FontService();
  ipcMain.handle('styk:fonts-list', event => { trusted(event); return fonts.listFonts(); });
  ipcMain.handle('styk:fonts-read', async (event, id) => {
    trusted(event); const bytes = await fonts.readFont(id);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });
  ipcMain.handle('styk:workspace-preferences-get', (event) => { trusted(event); return preferences.get(); });
  ipcMain.handle('styk:workspace-preferences-set', (event, value) => { trusted(event); return preferences.set(value); });
  ipcMain.handle('styk:editor-settings-get', (event) => { trusted(event); return editorSettings.get(); });
  ipcMain.handle('styk:editor-settings-set', (event, value) => { trusted(event); return editorSettings.set(value); });
  fileStreams = new FileStreams();
  const clipboardFile = path.join(app.getPath('userData'), 'frame-clipboard.styk');
  let clipboardWriteToken = null, clipboardControl = Promise.resolve();
  ipcMain.handle('styk:clipboard-write-begin', (event, options) => {
    trusted(event); fileStreams.validateSize(options?.size);
    if (!options.size) throw new Error('The frame clipboard is empty.');
    const pending = clipboardControl.then(async () => {
      if (clipboardWriteToken) await fileStreams.cancel(clipboardWriteToken);
      const transfer = await fileStreams.beginWrite({destination: clipboardFile, size: options.size});
      clipboardWriteToken = transfer.token; return transfer;
    });
    clipboardControl = pending.catch(() => {}); return pending;
  });
  ipcMain.handle('styk:clipboard-read-begin', async event => {
    trusted(event); const transfer = await fileStreams.beginRead(clipboardFile);
    return transfer ? {...transfer, name: 'Copied keyframes'} : null;
  });
  const projectTransfers = new Map();
  let projectRequestPending = false;
  ipcMain.handle('styk:document-activate', async (event, options) => {
    trusted(event);
    const document = projectFiles.activate(options || {});
    const stale = [...projectTransfers.keys()];
    projectTransfers.clear();
    await Promise.all(stale.map((token) => fileStreams.cancel(token)));
    return document;
  });
  ipcMain.handle('styk:project-write-begin', async (event, options) => {
    trusted(event);
    fileStreams.validateSize(options?.size);
    const document = projectFiles.requireCurrent(options?.documentToken);
    for (const token of projectTransfers.keys()) if (!fileStreams.jobs.has(token)) projectTransfers.delete(token);
    if (projectRequestPending || projectTransfers.size) throw new Error('A project save is already in progress.');
    projectRequestPending = true;
    try {
      let destination = document.filename;
      if (options.saveAs || !destination) {
        const result = await dialog.showSaveDialog(window, {
          title: options.saveAs ? 'Save animation as' : 'Save animation',
          defaultPath: destination || path.basename(String(options.defaultPath || 'Untitled.styk')),
          filters: [{ name: 'StykAnimate project', extensions: ['styk'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        });
        if (result.canceled || !result.filePath) return null;
        destination = projectFiles.validateDestination(result.filePath);
      }
      projectFiles.requireCurrent(document.documentToken);
      const transfer = await fileStreams.beginWrite({ destination, size: options.size, onCommit: async () => {
        // A document switch invalidates old capabilities, including pending dialogs.
        if (projectFiles.current?.documentToken === document.documentToken) projectFiles.commit(document.documentToken, destination);
        app.addRecentDocument(destination);
        await rememberRecent(destination);
      } });
      try { projectFiles.requireCurrent(document.documentToken); }
      catch (error) { await fileStreams.cancel(transfer.token); throw error; }
      projectTransfers.set(transfer.token, document.documentToken);
      return { ...transfer, filename: path.basename(destination), documentToken: document.documentToken };
    } finally { projectRequestPending = false; }
  });
  let recoveryWriteToken = null;
  let recoveryControl = Promise.resolve();
  function controlRecovery(operation) {
    const result = recoveryControl.then(operation);
    recoveryControl = result.catch(() => {});
    return result;
  }
  ipcMain.handle('styk:file-write-begin', async (event, options) => {
    trusted(event);
    fileStreams.validateSize(options?.size);
    const filters = Array.isArray(options.filters) ? options.filters.slice(0, 8).map((filter) => ({
      name: String(filter.name || 'File').slice(0, 80),
      extensions: Array.isArray(filter.extensions) ? filter.extensions.filter((ext) => /^[a-z0-9*]{1,12}$/i.test(ext)) : [],
    })).filter((filter) => filter.extensions.length) : [{ name: 'StykAnimate project', extensions: ['styk'] }];
    const result = await dialog.showSaveDialog(window, {
      title: 'Save animation', defaultPath: path.basename(String(options.defaultPath || 'Untitled.styk')), filters,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    return fileStreams.beginWrite({ destination: result.filePath, size: options.size, onCommit: async () => {
      app.addRecentDocument(result.filePath);
      await rememberRecent(result.filePath);
    } });
  });
  ipcMain.handle('styk:recovery-write-begin', async (event, options) => {
    trusted(event);
    fileStreams.validateSize(options?.size);
    if (!options.size) throw new Error('Recovery data is empty.');
    return controlRecovery(async () => {
      if (recoveryWriteToken) await fileStreams.cancel(recoveryWriteToken);
      const result = await fileStreams.beginWrite({ destination: recovery.file, size: options.size, onCommit: () => recovery.updateMetadata(options.name) });
      recoveryWriteToken = result.token;
      return result;
    });
  });
  ipcMain.handle('styk:file-write-chunk', (event, token, bytes) => { trusted(event); return fileStreams.write(token, bytes); });
  ipcMain.handle('styk:file-write-finish', async (event, token) => {
    trusted(event);
    const documentToken = projectTransfers.get(token);
    if (documentToken) projectFiles.requireCurrent(documentToken);
    try {
      const result = await fileStreams.finish(token);
      if (token === recoveryWriteToken) recoveryWriteToken = null;
      return documentToken ? { ...result, documentToken, filename: path.basename(result.path) } : result;
    } finally { if (!fileStreams.jobs.has(token)) projectTransfers.delete(token); }
  });
  ipcMain.handle('styk:file-write-cancel', async (event, token) => {
    trusted(event);
    const result = await fileStreams.cancel(token);
    projectTransfers.delete(token);
    if (token === recoveryWriteToken) recoveryWriteToken = null;
    return result;
  });
  ipcMain.handle('styk:recovery-info', (event) => { trusted(event); return recovery.info(); });
  ipcMain.handle('styk:recovery-read-begin', async (event) => {
    trusted(event);
    const info = await recovery.info();
    if (!info) return null;
    const transfer = await fileStreams.beginRead(recovery.file);
    return transfer ? { ...info, ...transfer } : null;
  });
  ipcMain.handle('styk:file-read-chunk', (event, token) => { trusted(event); return fileStreams.read(token); });
  ipcMain.handle('styk:file-read-close', (event, token) => { trusted(event); return fileStreams.closeRead(token); });
  ipcMain.handle('styk:recovery-save', (event, options) => {
    trusted(event);
    return controlRecovery(async () => {
      if (recoveryWriteToken) { await fileStreams.cancel(recoveryWriteToken); recoveryWriteToken = null; }
      return recovery.save(options);
    });
  });
  ipcMain.handle('styk:recovery-get', (event) => { trusted(event); return recovery.get(); });
  ipcMain.handle('styk:recovery-delete', async (event) => {
    trusted(event);
    return controlRecovery(async () => {
      if (recoveryWriteToken) { await fileStreams.cancel(recoveryWriteToken); recoveryWriteToken = null; }
      return recovery.delete();
    });
  });
  ipcMain.handle('styk:open-file', async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: 'Open animation or stick figure', properties: ['openFile'], filters: FILE_FILTERS });
    return result.canceled ? null : readImportFile(result.filePaths[0]);
  });
  ipcMain.handle('styk:save-file', async (event, options) => {
    trusted(event);
    if (!options || typeof options !== 'object') throw new Error('Save options are required.');
    let data;
    if (typeof options.data === 'string') {
      if (!['base64', 'utf8', undefined].includes(options.encoding)) throw new Error('Unsupported file encoding.');
      data = Buffer.from(options.data, options.encoding || 'utf8');
    } else if (options.data instanceof Uint8Array || Array.isArray(options.data)) data = Buffer.from(options.data);
    else throw new Error('The file must contain text or bytes.');
    if (data.byteLength > MAX_FILE_BYTES) throw new Error('This export exceeds the 256 MB limit.');
    const filters = Array.isArray(options.filters) ? options.filters.slice(0, 8).map((filter) => ({
      name: String(filter.name || 'File').slice(0, 80),
      extensions: Array.isArray(filter.extensions) ? filter.extensions.filter((ext) => /^[a-z0-9*]{1,12}$/i.test(ext)) : [],
    })).filter((filter) => filter.extensions.length) : [{ name: 'StykAnimate project', extensions: ['styk'] }];
    const result = await dialog.showSaveDialog(window, {
      title: 'Save animation',
      defaultPath: path.basename(String(options.defaultPath || 'Untitled.styk')),
      filters,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    // Only the path selected by the native dialog is writable through this API.
    await atomicWrite(result.filePath, data);
    app.addRecentDocument(result.filePath);
    await rememberRecent(result.filePath);
    return { saved: true, path: result.filePath };
  });
  ipcMain.handle('styk:window', (event, action) => {
    trusted(event);
    if (action === 'minimize') window.minimize();
    else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (action === 'close') window.close();
    else throw new Error('Unknown window action.');
    return windowState();
  });
  ipcMain.handle('styk:window-state', (event) => { trusted(event); return windowState(); });
  ipcMain.handle('styk:document-state', (event, state) => {
    trusted(event);
    documentState = { name: String(state?.name || 'Untitled').slice(0, 180), dirty: Boolean(state?.dirty) };
    window.setTitle(`${documentState.dirty ? '• ' : ''}${documentState.name} — StykAnimate`);
    window.setDocumentEdited(documentState.dirty);
  });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1560, height: 1000, minWidth: 1000, minHeight: 680,
    backgroundColor: '#191a1d', show: false,
    title: 'StykAnimate',
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 16 } } : {}),
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
      backgroundThrottling: true, spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(?:github\.com|pivotanimator\.net)\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== backend.origin) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    window.on(event, () => window.webContents.send('styk:window-state', windowState()));
  }
  window.on('close', async (event) => {
    if (!quitting && documentState.dirty) {
      event.preventDefault();
      const answer = await dialog.showMessageBox(window, {
        type: 'question', title: 'Unsaved animation', message: `Save changes to ${documentState.name}?`,
        detail: 'Your animation has changes that have not been saved.',
        buttons: ['Save', 'Cancel', 'Discard'], defaultId: 0, cancelId: 1,
      });
      if (answer.response === 0) sendAction('save-and-close');
      else if (answer.response === 2) { documentState.dirty = false; window.close(); }
    }
  });
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(backend.origin);
  if (process.env.STYK_DEVTOOLS === '1') window.webContents.openDevTools({ mode: 'detach' });
  const files = pendingFiles.splice(0);
  for (const file of files) await queueOpenFile(file);
}

async function start() {
  library = new LibraryStore(process.env.STYK_LIBRARY_DIR || path.join(app.getPath('documents'), 'StykAnimate', 'library'));
  // A temporarily unavailable Documents volume should not prevent animation work.
  await library.init().catch(error => console.warn('Library initialization:', error.message));
  backend = await startBackend({
    appRoot: APP_ROOT, resourcesPath: process.resourcesPath, packaged: app.isPackaged,
    log: (message) => { if (process.env.STYK_DEBUG === '1') process.stderr.write(message); },
    onError: (message) => { if (window && !window.isDestroyed()) window.webContents.send('styk:backend-error', message); },
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  nativeMenu();
  registerIpc();
  await createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
}

app.on('before-quit', (event) => {
  if (window && documentState.dirty && !quitting) { event.preventDefault(); window.close(); }
  else quitting = true;
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { backend?.stop(); library?.dispose().catch(() => {}); fileStreams?.dispose().catch(() => {}); videoExports?.dispose().catch(() => {}); vfwExports?.dispose().catch(() => {}); });
process.on('exit', () => backend?.stop());
