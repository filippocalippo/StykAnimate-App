'use strict';

// Keep the release feed and filesystem access in the main process. The renderer
// receives only status, never installer paths or a configurable download URL.
function updateAvailability({ packaged, platform, portable, installed }) {
  if (!packaged) return 'Updates are available in the installed app. Development copies do not update.';
  if (platform !== 'win32') return 'Automatic updates currently require the Windows installer.';
  if (portable || !installed) return 'Install StykAnimate using the Windows Setup installer to enable automatic updates.';
  return '';
}

class UpdateService {
  constructor({ updater, currentVersion, unavailable = '', onState = () => {} }) {
    this.updater = updater;
    this.onState = onState;
    this.state = { status: unavailable ? 'unavailable' : 'idle', currentVersion, version: null, percent: 0, transferred: 0, total: 0, message: unavailable };
    if (unavailable) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => this.set({ status: 'checking', message: '', percent: 0, transferred: 0, total: 0 }));
    updater.on('update-available', info => this.set({ status: 'downloading', version: info.version, message: '' }));
    updater.on('update-not-available', () => this.set({ status: 'current', version: null, message: '' }));
    updater.on('download-progress', progress => this.set({
      status: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
      transferred: Math.max(0, Number(progress.transferred) || 0), total: Math.max(0, Number(progress.total) || 0),
    }));
    updater.on('update-downloaded', info => this.set({ status: 'ready', version: info.version, percent: 100, message: '' }));
    updater.on('error', error => this.fail(error));
  }

  snapshot() { return { ...this.state }; }
  set(next) { Object.assign(this.state, next); this.onState(this.snapshot()); }
  fail(error) {
    console.warn('Update failed:', error?.message || error);
    this.set({ status: 'error', message: 'The update could not be completed. Check your connection and try again.' });
  }

  async check() {
    if (this.busy || ['unavailable', 'ready', 'restarting'].includes(this.state.status)) return this.snapshot();
    this.busy = true;
    this.set({ status: 'checking', message: '', percent: 0, transferred: 0, total: 0 });
    try {
      const result = await this.updater.checkForUpdates();
      if (this.state.status === 'downloading') await this.updater.downloadUpdate(result?.cancellationToken);
      else if (!result && this.state.status === 'checking') throw new Error('Update check did not run.');
    } catch (error) { this.fail(error); }
    finally { this.busy = false; }
    return this.snapshot();
  }

  async restart(prepare, onFailure = () => {}) {
    if (this.state.status !== 'ready' || this.restarting) return false;
    this.restarting = true;
    try {
      if (!await prepare()) return false;
      this.set({ status: 'restarting' });
      // NSIS silent installation followed by an explicit relaunch.
      this.updater.quitAndInstall(true, true);
      if (this.state.status === 'error') { onFailure(); return false; }
      return true;
    } catch (error) { onFailure(); this.fail(error); return false; }
    finally { this.restarting = false; }
  }

  start() {
    if (this.state.status === 'unavailable' || this.timer) return;
    this.initialTimer = setTimeout(() => void this.check(), 10000);
    this.timer = setInterval(() => void this.check(), 4 * 60 * 60 * 1000);
    this.initialTimer.unref?.(); this.timer.unref?.();
  }
  dispose() { clearTimeout(this.initialTimer); clearInterval(this.timer); }
}

module.exports = { UpdateService, updateAvailability };
