/**
 * Where a person sees and changes what statistics send (docs/STATISTICS.md, "On and off"): when Home shows the
 * first-start line, the Privacy section of Preferences, and "See the last report". The desktop bridge
 * (window.stykDesktop, the table in STATISTICS.md) is the only source of the state; the browser build has no bridge
 * and shows none of this.
 *
 * Every way to the section goes through openPrivacy: the Help menu's item, the `privacy` command and a
 * stykanimate://privacy link.
 */
import {icon} from './icons.mjs';
import {escapeHTML} from './inspector-kit.mjs';
import {messageAttributes, localizedText, appendLocalized} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';
import {createDialog} from './ui/ui-dialog.mjs';

/** True while Home shows the first-start line: statistics on, not forced off, and the line not answered yet. */
export const statsNoticeWanted = state => Boolean(state?.enabled && !state.forcedOff && !state.noticeSeen);

/**
 * The Privacy section's switch: {on, disabled, note}, `note` being the key of the one line under it (or null).
 * Forced off: off and disabled. A development run that uploads nothing: on, with a line that says so.
 */
export function privacySwitch(state) {
  if (!state) return {on: false, disabled: true, note: null};
  if (state.forcedOff) return {on: false, disabled: true, note: 'privacy.forcedOff'};
  return {on: Boolean(state.enabled), disabled: false, note: state.enabled && !state.uploads ? 'privacy.notUploaded' : null};
}

/**
 * What "See the last report" shows: `previewStats()`'s answer as readable JSON (null when there is nothing, neither a
 * batch sent nor a report waiting), and whether anything was sent yet.
 */
export function lastReport(preview) {
  const sent = Boolean(preview?.lastSent), waiting = Array.isArray(preview?.waiting) && preview.waiting.length > 0;
  return {sent, json: sent || waiting ? JSON.stringify(preview, null, 2) : null};
}

/** Opens Preferences at the Privacy section (Preferences itself where the section does not exist, the browser build). */
export function openPrivacy(settings) { return settings?.open(settings.hasTab?.('privacy') ? 'privacy' : undefined); }

/**
 * The statistics' state as the page knows it, and what the person can do with it.
 * ctx: {desktop, overlays, icon(name), t(key, params)}.
 */
export function createPrivacy({desktop, overlays = null, t = interfaceText} = {}) {
  const available = typeof desktop?.getStatsState === 'function';
  const listeners = new Set();
  let state = null;
  const set = next => {
    if (next && typeof next === 'object') { state = next; for (const listener of listeners) listener(state); }
    return state;
  };
  if (available) desktop.onStatsState?.(set);

  /** "See the last report": the exact answer of `previewStats()`, with Copy, and the privacy note one click away. */
  async function showReport() {
    const preview = await desktop.previewStats();
    const {sent, json} = lastReport(preview);
    const body = document.createElement('div');
    body.className = 'privacy-report';
    const line = (key, className = 'ui-dialog-desc') => { const node = document.createElement('p'); node.className = className; localizedText(node, key, {}); return node; };
    appendLocalized(body, line('privacy.reportIntro'));
    if (!sent) appendLocalized(body, line('privacy.nothingSent', 'privacy-report-empty'));
    if (json) {
      const pre = document.createElement('pre'), code = document.createElement('code');
      pre.className = 'privacy-report-json';
      // The JSON scrolls on its own: reachable with the keyboard, named for a screen reader.
      pre.tabIndex = 0;
      pre.setAttribute('aria-label', t('privacy.reportTitle'));
      code.textContent = json;
      pre.append(code);
      appendLocalized(body, pre);
    }
    const dialog = createDialog({
      size: 'md', id: 'privacy-report', overlays, t, icon: name => icon(name),
      title: t('privacy.reportTitle'), titleKey: 'privacy.reportTitle', body,
      actions: [
        {label: t('privacy.note'), labelKey: 'privacy.note', value: 'note', id: 'privacy-report-note', variant: 'ghost'},
        ...(json ? [{label: t('common.copy'), labelKey: 'common.copy', value: 'copy', id: 'privacy-report-copy', variant: 'ghost'}] : []),
        {label: t('common.close'), labelKey: 'common.close', cancel: true, variant: 'secondary'},
      ],
      // Copy and the privacy note keep the dialog open.
      onSubmit: value => {
        if (value === 'copy') navigator.clipboard?.writeText(json).then(() => dialog.setMeta({messageKey: 'appDialogs.copied'}), () => dialog.setMeta({messageKey: 'appDialogs.couldNotCopy'}));
        else if (value === 'note') Promise.resolve().then(() => desktop.openServicePage('privacy')).catch(error => dialog.setError(error?.message || String(error)));
        else return undefined;
        return false;
      },
    });
    return dialog.showModal();
  }

  /**
   * The Privacy section of Preferences, from the row builders of `settings` (src/settings.mjs). Its controls carry
   * data-privacy-*; settings.mjs routes their events to `handle`.
   */
  function sectionHTML(settings) {
    const say = key => settings.t(key);
    const {on, disabled, note} = privacySwitch(state);
    const label = say('privacy.send'), hint = say('privacy.sendNote');
    const notes = note ? `<small class="styk-settings-hint" data-privacy-state ${messageAttributes(note, {})}>${escapeHTML(say(note))}</small>` : '';
    const toggle = `<label class="styk-settings-row"><span class="styk-settings-text"><span class="styk-settings-label" ${messageAttributes('privacy.send', {})}>${escapeHTML(label)}</span><small class="styk-settings-hint" ${messageAttributes('privacy.sendNote', {})}>${escapeHTML(hint)}</small>${notes}</span><input type="checkbox" role="switch" class="ui-switch" data-privacy-enabled aria-label="${escapeHTML(label)}" ${messageAttributes('privacy.send', {}, 'aria-label')} ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label>`;
    const link = (name, key, glyph = '') => `<button type="button" class="ui-button" data-variant="ghost" data-size="sm" data-privacy-${name}>${glyph}<span ${messageAttributes(key, {})}>${escapeHTML(say(key))}</span></button>`;
    const links = `<div class="styk-settings-row styk-privacy-links">${link('report', 'privacy.seeReport')}${link('note', 'privacy.note', icon('externalLink'))}</div>`;
    return settings.group(say('privacy.statistics'), toggle + links);
  }

  /** A click or change in the section; true when it was one of its controls. Failures go to `fail`. */
  function handle(event, fail) {
    const target = event.target;
    const run = work => { Promise.resolve().then(work).catch(fail); return true; };
    if (event.type === 'change' && target.matches?.('[data-privacy-enabled]')) return run(() => api.setEnabled(target.checked));
    if (event.type !== 'click') return false;
    if (target.closest?.('[data-privacy-report]')) return run(showReport);
    if (target.closest?.('[data-privacy-note]')) return run(() => desktop.openServicePage('privacy'));
    return false;
  }

  const api = {
    available,
    get state() { return state; },
    /** The state from the desktop process; null in the browser build. */
    async refresh() { return available ? set(await desktop.getStatsState()) : null; },
    /** Calls `listener(state)` on every change; returns the unsubscribe. */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setEnabled: async on => set(await desktop.setStatsEnabled(on)),
    /**
     * The first-start line's answer: 'ok' or 'off'. Both answer it for good; 'off' also turns statistics off. Resolves
     * with the key of the message to show once (where to turn them on again), or null.
     */
    async answer(choice) {
      if (choice !== 'ok' && choice !== 'off') throw new TypeError('The first-start line is answered with ok or off.');
      set(await desktop.markStatsNoticeSeen());
      if (choice === 'ok') return null;
      set(await desktop.setStatsEnabled(false));
      return 'privacy.notice.turnedOff';
    },
    /** Home displayed the first-start line: uploads may go from now on. */
    markShown: () => desktop.markStatsNoticeShown?.(),
    showReport, sectionHTML, handle,
  };
  return api;
}
