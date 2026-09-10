export const DONATE_URL = 'https://ko-fi.com/Q5Q41WY7QC';

export function supportCard({ compact = false, desktop = globalThis.stykDesktop } = {}) {
  const card = document.createElement('section');
  card.className = `support-card${compact ? ' support-card-compact' : ''}`;
  card.setAttribute('aria-label', 'Support StykAnimate');
  card.innerHTML = `<div><strong>Free to create. Powered by your support.</strong><p>StykAnimate is completely free. If it helps bring your ideas to life, a donation helps keep development moving.</p></div><a class="support-donate" href="${DONATE_URL}" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">♥</span> Donate on Ko-fi <span aria-hidden="true">↗</span></a>`;
  card.querySelector('a').addEventListener('click', async event => {
    if (!desktop?.openDonate) return;
    event.preventDefault();
    try { await desktop.openDonate(); }
    catch { card.querySelector('p').textContent = `Open ${DONATE_URL} in your browser to support development.`; }
  });
  return card;
}

export class ReleaseSplash {
  constructor(desktop) { this.desktop = desktop; }
  async open({ startup = false } = {}) {
    if (!this.desktop?.getReleaseInfo || this.opening) return;
    if (this.dialog?.open) { this.dialog.focus(); return; }
    this.opening = true;
    try {
      const info = await this.desktop.getReleaseInfo(startup);
      if (!info) return;
      // Startup dialogs are queued so they never hide file/recovery/privacy prompts.
      if (startup && document.querySelector('dialog[open]')) {
        await new Promise(resolve => {
          const closed = () => { if (!document.querySelector('dialog[open]')) { document.removeEventListener('close', closed, true); resolve(); } };
          document.addEventListener('close', closed, true);
        });
      }
      this.dialog?.remove();
      const modal = this.dialog = document.createElement('dialog');
      modal.className = 'release-splash';
      modal.setAttribute('aria-labelledby', 'release-splash-title');
      modal.innerHTML = `<button class="splash-close" aria-label="Close welcome screen" type="button" autofocus>×</button><div class="splash-intro"><img src="./mark.svg" width="42" height="42" alt=""><span class="splash-eyebrow">WELCOME TO STYKANIMATE</span><span class="splash-version"></span><h1 id="release-splash-title"></h1><p>Your ideas, one frame at a time.</p></div><section class="splash-notes" aria-label="Release notes"><h2>What’s new</h2><ul></ul></section><footer class="splash-footer"><span>Thank you for animating with us.</span><button class="button" type="button">Start animating <span aria-hidden="true">→</span></button></footer>`;
      modal.querySelector('.splash-version').textContent = `Version ${info.version}`;
      modal.querySelector('h1').textContent = info.title;
      for (const note of info.notes || []) { const li = document.createElement('li'); li.textContent = note; modal.querySelector('ul').append(li); }
      modal.querySelector('footer').before(supportCard({ desktop: this.desktop }));
      modal.querySelector('.splash-close').onclick = () => modal.close();
      modal.querySelector('footer button').onclick = () => modal.close();
      document.body.append(modal);
      modal.showModal();
    } finally { this.opening = false; }
  }
}
