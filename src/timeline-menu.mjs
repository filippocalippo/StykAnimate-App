import {icon} from './icons.mjs';

/** Small, keyboard-accessible context menu used by the two timeline views. */
export function showTimelineMenu(host, event, groups) {
  host.menuEvents?.abort();
  host.menu?.remove();
  const events = host.menuEvents = new AbortController();
  const menu = host.menu = document.createElement('div');
  const focusTarget = host.scroll ?? host.strip;
  menu.className = 'sheet-menu';
  menu.setAttribute('role', 'menu');
  const close = (focus = false) => {
    events.abort();
    menu.remove();
    if (host.menu === menu) host.menu = null;
    if (focus) focusTarget.focus({preventScroll: true});
  };
  for (const group of groups.map(items => items.filter(Boolean)).filter(items => items.length)) {
    if (menu.childElementCount) {
      const separator = document.createElement('div');
      separator.className = 'menu-separator';
      separator.setAttribute('role', 'separator');
      menu.append(separator);
    }
    for (const {label, symbol, shortcut = '', action, checked, danger} of group) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      button.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
      if (danger) button.dataset.danger = 'true';
      button.innerHTML = icon(symbol);
      const name = document.createElement('span'), key = document.createElement('kbd');
      name.textContent = label;
      key.textContent = shortcut;
      button.append(name, key);
      button.addEventListener('click', () => { close(true); host._run(action); }, {signal: events.signal});
      menu.append(button);
    }
  }
  if (!menu.childElementCount) { close(); return; }
  document.body.append(menu);
  const anchor = event?.currentTarget?.getBoundingClientRect?.() ?? focusTarget.getBoundingClientRect();
  const x = event?.clientX || anchor.left, y = event?.clientY || anchor.bottom;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  document.addEventListener('pointerdown', e => { if (!menu.contains(e.target)) close(); }, {capture: true, signal: events.signal});
  window.addEventListener('resize', () => close(), {signal: events.signal});
  focusTarget.addEventListener('scroll', () => close(), {signal: events.signal});
  host.editor.addEventListener('change', () => close(), {signal: events.signal});
  menu.addEventListener('keydown', e => {
    e.stopPropagation();
    const buttons = [...menu.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape' || e.key === 'Tab') { close(true); if (e.key === 'Escape') e.preventDefault(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 :
        (index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    }
  }, {signal: events.signal});
  menu.querySelector('button')?.focus();
}
