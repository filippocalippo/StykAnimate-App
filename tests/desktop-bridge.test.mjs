// The desktop bridge (src/desktop-bridge.mjs) gives the page exactly the API the Electron preload gave, over Tauri's
// invoke and events, and rejects with Errors as the preload did.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/desktop-bridge.mjs', import.meta.url), 'utf8');
// desktop/preload.cjs's names, in its order (frozen here: the renderer calls these).
const PRELOAD_API = ["isDesktop","startupView","setUIScale","newWindow","beginSharedClipboardWrite","writeSharedClipboardChunk","finishSharedClipboardWrite","beginSharedClipboardRead","readSharedClipboardChunk","cancelSharedClipboardTransfer","platform","memoryBytes","streamingFileWrite","importTransport","getUpdateState","checkForUpdates","restartForUpdate","openUpdateReleases","onUpdateState","getReleaseInfo","getReleaseHistory","openDonate","getTelemetryState","getSupportContext","saveSupportState","supportRequest","connectSupportLive","disconnectSupportLive","onSupportLive","copySupportAccess","restoreSupportAccess","downloadSupportFile","setTelemetryConsent","recordTelemetry","previewTelemetry","syncTelemetry","exportTelemetry","deleteTelemetry","sendTelemetryFeedback","openServicePage","recordPerformanceTrace","onTelemetryState","listLibrary","createLibraryFolder","getLibraryThumbnail","beginLibrarySave","writeLibraryChunk","finishLibrarySave","cancelLibraryTransfer","beginLibraryRead","readLibraryChunk","changeLibraryItem","revealLibrary","trashLibraryItem","cacheLibraryThumbnail","listPublicLibrary","getPublicLibraryPreview","readPublicLibraryAsset","savePublicLibraryAsset","openPublicLibraryPage","takePublicLibraryLink","pageListening","onPublicLibraryLink","getWorkspacePreferences","setWorkspacePreferences","getEditorSettings","setEditorSettings","getVfxPresets","setVfxPresets","listFonts","readFont","readClipboardText","writeClipboardText","getVideoCapabilities","beginVideoExport","writeVideoAudioChunk","beginAudioImport","writeAudioImport","finishAudioImport","readAudioImport","cancelAudioImport","beginVideoFrame","writeVideoChunk","endVideoFrame","finishVideoExport","readVideoChunk","saveVideoExport","cancelVideoExport","getVfwCapabilities","configureVfwCodec","beginVfwExport","beginVfwFrame","writeVfwChunk","endVfwFrame","finishVfwExport","readVfwChunk","saveVfwExport","cancelVfwExport","activateDocument","selectDocument","releaseDocument","openFile","listRecentFiles","openRecentFile","clearRecentFiles","listProjects","openProject","updateProject","removeProject","revealProject","getProjectPreview","setProjectPreview","changeProjectFolder","saveFile","beginFileWrite","beginProjectWrite","beginRecoveryWrite","writeFileChunk","patchFileWrite","finishFileWrite","cancelFileWrite","getRecoveryInfo","listRecoveries","beginRecoveryRead","readFileChunk","closeFileRead","saveRecovery","getRecovery","deleteRecovery","minimize","maximize","close","getWindowState","setDocumentState","onMenuAction","onOpenFile","onWindowState","listSamples","readSample"];

function load({ answer = () => null, boot = { platform: 'win32', memoryBytes: 17179869184, startupView: 'editor' } } = {}) {
  const calls = [], listeners = new Map();
  let resolveListen;
  const context = {
    __STYK_BOOT__: boot,
    __TAURI__: {
      core: { invoke: async (command, args) => { calls.push([command, args]); return answer(command, args); } },
      event: {
        listen: (channel, handler) => new Promise(resolve => {
          resolveListen = () => { listeners.set(channel, handler); resolve(() => listeners.delete(channel)); };
          if (!context.holdListen) resolveListen();
        }),
      },
    },
    addEventListener() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }), setTimeout, console,
    Error, TypeError, RangeError, SyntaxError, Promise, Number, Boolean, Object, Set,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { desktop: context.stykDesktop, calls, listeners, context, release: () => resolveListen() };
}

test('the bridge has exactly the preload API', () => {
  const { desktop } = load();
  assert.deepEqual(Object.keys(desktop).sort(), [...PRELOAD_API].sort());
  assert.ok(Object.isFrozen(desktop));
  assert.equal(desktop.isDesktop, true);
  assert.equal(desktop.platform, 'win32');
  assert.equal(desktop.memoryBytes, 17179869184);
  assert.equal(desktop.startupView, 'editor');
  assert.equal(desktop.importTransport, 'source-bytes-v1');
  assert.equal(desktop.streamingFileWrite, true);
});

test('a page without the desktop app is left alone', () => {
  const context = { addEventListener() {} };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  assert.equal(context.stykDesktop, undefined);
});

test('commands carry the channel names and arguments', async () => {
  const { desktop, calls } = load();
  await desktop.close({ revision: 'r', saved: true });
  await desktop.getReleaseInfo(1);
  await desktop.restartForUpdate(undefined);
  await desktop.setDocumentState({ name: 'Walk', dirty: true });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['window', { action: 'close', checkpoint: { revision: 'r', saved: true } }],
    ['release_info', { startup: true }],
    ['update_restart', {}],
    ['document_state', { state: { name: 'Walk', dirty: true } }],
  ]);
});

test('native failures reject as Errors with their message key', async () => {
  const { desktop } = load({ answer: () => { throw { message: 'Release history unavailable.', messageKey: 'desktop.releaseHistory.errors.releaseHistoryUnavailable' }; } });
  const error = await desktop.getReleaseHistory().catch(error => error);
  assert.equal(error.constructor.name, 'Error');
  assert.equal(error.message, 'Release history unavailable.');
  assert.equal(error.messageKey, 'desktop.releaseHistory.errors.releaseHistoryUnavailable');
  const plain = await load({ answer: () => { throw 'Unknown command: x'; } }).desktop.newWindow().catch(error => error);
  assert.equal(plain.message, 'Unknown command: x');
});

test('the interface scale is checked before it is sent, as preload did', () => {
  const { desktop, calls } = load();
  assert.throws(() => desktop.setUIScale(80.5), error => error.constructor.name === 'RangeError' && error.messageKey === 'desktop.preload.errors.uiScaleMustBe75200InStepsOf5');
  assert.throws(() => desktop.setUIScale(300), error => error.constructor.name === 'RangeError');
  assert.equal(desktop.setUIScale(125), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['set_ui_scale', { percent: 125 }]);
  assert.throws(() => desktop.onMenuAction('nope'), error => error.constructor.name === 'TypeError' && error.messageKey === 'desktop.preload.errors.aCallbackIsRequired');
});

test('pageListening waits for listeners still being registered, and events reach their callbacks', async () => {
  const { desktop, calls, listeners, context, release } = load();
  context.holdListen = true;
  const seen = [];
  const stop = desktop.onMenuAction(action => seen.push(action));
  const listening = desktop.pageListening();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.some(([command]) => command === 'page_listening'), false);
  release();
  assert.equal(await listening, null);
  assert.equal(calls.at(-1)[0], 'page_listening');
  listeners.get('styk:menu-action')({ payload: 'save-and-close' });
  assert.deepEqual(seen, ['save-and-close']);
  stop();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(listeners.has('styk:menu-action'), false);
});
