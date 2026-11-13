/**
 * The Logs tab (developer build only; docs/DEVTOOLS.md "Panels"): the early script's structured log lines, filtered by
 * least level, module and text, newest last; Copy JSON lines takes what the filter shows. New lines are appended, the
 * list is rebuilt only when the filter changes, and it keeps the newest 500.
 */
import {filterLogs} from '../control.mjs';
import {button, element, format, setText} from './dom.mjs';

const SHOWN = 500;

export function createLogsTab({runtime}) {
  const {early} = runtime;
  const filter = {level: 'debug', module: '', text: ''};
  const level = element('select', {}, ...early.LEVELS.map(name => element('option', {value: name, textContent: name, selected: filter.level === name})));
  const module = element('input', {placeholder: 'module', size: 12});
  const text = element('input', {placeholder: 'search', size: 20});
  const list = element('div', {className: 'dt-mono'});
  const trimmed = element('span', {className: 'dt-dim'});
  /** The last log sequence number shown; -1 rebuilds the list. */
  let lastShown = -1;
  const rows = (since = 0) => filterLogs(early.logs.rows, {least: early.LEVELS.indexOf(filter.level), levels: early.LEVELS, module: filter.module, text: filter.text, since});
  const update = () => { Object.assign(filter, {level: level.value, module: module.value, text: text.value}); lastShown = -1; refresh(); };
  level.onchange = update; module.oninput = update; text.oninput = update;
  const copy = button('Copy JSON lines', () => navigator.clipboard?.writeText(rows().map(row => JSON.stringify(row)).join('\n')));
  const root = element('div', {}, element('div', {className: 'dt-row'}, level, module, text, copy, trimmed), list);
  const line = row => element('div', {className: row.level === 'error' ? 'dt-error' : row.level === 'warn' ? 'dt-warn' : '', textContent: `${format(row.at / 1000, 3)} ${row.level.padEnd(5)} [${row.module}] ${row.message}`});

  function refresh() {
    if (lastShown === early.logs.sequence) return;
    const scroller = root.parentElement, atBottom = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    if (lastShown < 0) list.replaceChildren(...rows().slice(-SHOWN).map(line));
    else list.append(...rows(lastShown).map(line));
    while (list.childElementCount > SHOWN) list.firstChild.remove();
    lastShown = early.logs.sequence;
    setText(trimmed, `${early.logs.dropped ? `${early.logs.dropped} trimmed · ` : ''}newest last`);
    if (atBottom && scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  return {name: 'Logs', root, refresh, interval: 500, shown() { lastShown = -1; refresh(); }};
}
