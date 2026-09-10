export class UpdateUI {
  constructor(desktop, { onRestart, document: doc = document } = {}) {
    this.desktop = desktop;
    if (!desktop?.getUpdateState) return;
    this.element = doc.createElement('aside');
    this.element.className = 'update-notice';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', 'App update');
    this.element.innerHTML = `<div class="update-copy" role="status" aria-live="polite"><strong></strong><span></span></div><progress max="100" aria-label="Update download progress"></progress><div class="update-actions"><button class="button primary" type="button"></button><button class="button subtle update-dismiss" type="button" aria-label="Dismiss update notice">Later</button></div>`;
    doc.body.append(this.element);
    this.title = this.element.querySelector('strong');
    this.detail = this.element.querySelector('.update-copy span');
    this.progress = this.element.querySelector('progress');
    this.action = this.element.querySelector('.primary');
    this.dismiss = this.element.querySelector('.update-dismiss');
    this.dismiss.onclick = () => { this.dismissed = this.state?.status; this.element.hidden = true; };
    this.action.onclick = async () => {
      this.action.disabled = true;
      try {
        if (this.state.status === 'ready') await onRestart?.();
        else if (this.state.status === 'unavailable') await desktop.openUpdateReleases();
        else await this.check();
      } catch { this.render({ ...this.state, status: 'error', message: 'The update could not be completed. Please try again.' }); }
      finally { this.action.disabled = false; }
    };
    let received = false;
    this.unsubscribe = desktop.onUpdateState(state => { received = true; this.render(state); });
    desktop.getUpdateState().then(state => { if (!received) this.render(state); }).catch(() => {});
  }

  async check() {
    if (!this.element) return;
    this.dismissed = null;
    this.manual = true;
    this.render(await this.desktop.getUpdateState());
    this.render(await this.desktop.checkForUpdates());
  }

  render(state) {
    this.state = state;
    const { status, version, currentVersion, message } = state;
    const active = ['downloading', 'ready', 'restarting'].includes(status);
    this.element.hidden = !(active || this.manual || status === 'error') || this.dismissed === status;
    if (status === 'idle') this.element.hidden = true;
    const labels = {
      checking: ['Checking for updates…', `Installed version ${currentVersion}`],
      downloading: [`Downloading StykAnimate ${version}`, `${Math.floor(state.percent || 0)}%${state.total ? ` · ${(state.transferred / 1048576).toFixed(1)} of ${(state.total / 1048576).toFixed(1)} MB` : ''} · You can keep working.`],
      ready: [`StykAnimate ${version} is ready`, 'Restart to install the update. You can save your work first.'],
      restarting: ['Restarting StykAnimate…', 'Installing the downloaded update.'],
      current: ['You’re up to date', `StykAnimate ${currentVersion}`],
      unavailable: ['Automatic updates', message],
      error: ['Update interrupted', message],
    };
    [this.title.textContent, this.detail.textContent] = labels[status] || ['', ''];
    this.progress.hidden = status !== 'downloading';
    this.progress.value = state.percent || 0;
    this.action.hidden = !['ready', 'error', 'unavailable'].includes(status);
    this.action.textContent = status === 'ready' ? 'Restart to update' : status === 'unavailable' ? 'Open downloads' : 'Try again';
    this.dismiss.hidden = status === 'restarting';
    this.dismiss.textContent = status === 'ready' || status === 'downloading' ? 'Later' : 'Dismiss';
  }
}
