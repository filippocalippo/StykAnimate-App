/**
 * The Inspector tab (developer build only; docs/DEVTOOLS.md "Panels"): the read view's document tree, paged, the
 * evaluated frame on show, the history labels and the log of edit session calls (src/devtools/inspector.mjs reads
 * them). It reads as the interface does and never writes; it is rebuilt when shown and on Refresh.
 */
import {commandLog, documentSummary, framePage, historyPage, treePage} from '../inspector.mjs';
import {button, download, element, stamped, table} from './dom.mjs';

export function createInspectorTab({runtime}) {
  const root = element('div');
  let path = [], cursor = 0;
  const go = (nextPath, nextCursor = 0) => { path = nextPath; cursor = nextCursor; build(); };

  function build() {
    const editor = runtime.app.editor;
    if (!editor) { root.replaceChildren(element('div', {className: 'dt-dim', textContent: 'The editor is not ready.'})); return; }
    const summary = documentSummary(editor);
    const crumbs = element('div', {className: 'dt-row dt-mono'}, element('span', {className: 'dt-link', textContent: 'document', onclick: () => go([])}));
    path.forEach((key, index) => crumbs.append(' / ', element('span', {className: 'dt-link', textContent: String(key), onclick: () => go(path.slice(0, index + 1))})));
    let page;
    try { page = treePage(editor.report, {path, cursor}); }
    catch { path = []; page = treePage(editor.report, {}); }
    const tree = page.rows.length ? table(['Key', 'Value'], page.rows.map(row => [row.container ? element('span', {className: 'dt-link', textContent: String(row.key), onclick: () => go([...path, row.key])}) : String(row.key), row.preview]))
      : element('pre', {textContent: page.value ?? '(empty)'});
    const pager = element('div', {className: 'dt-row dt-dim'}, `${page.kind}, ${page.size} entries`,
      page.cursor > 0 ? button('Previous', () => go(path, Math.max(0, page.cursor - 50))) : null,
      page.next !== null ? button('Next', () => go(path, page.next)) : null);
    const history = historyPage(editor), frame = framePage(editor), calls = commandLog(runtime.early.ring, {limit: 30});
    const saveLog = button('Save command log', () => download(stamped('commands'), JSON.stringify(commandLog(runtime.early.ring, {limit: 100000}), null, 1)));
    root.replaceChildren(
      element('pre', {textContent: `${summary.name ?? '(untitled)'} · revision ${summary.revision}${summary.dirty ? ' (unsaved)' : ''} · tick ${summary.tick}/${summary.totalTicks} · ${summary.figureTypes} figure types · ${summary.keyframes} keyframes · ${summary.layers ?? '?'} layers · selection ${JSON.stringify(summary.selection)}`}),
      element('div', {className: 'dt-row'}, button('Refresh', build)),
      crumbs, pager, tree,
      element('h4', {textContent: `Evaluated frame, tick ${frame.tick} (${frame.size} figures)`}),
      table(['uid', 'type', 'joints', 'visible', 'layer'], frame.rows.slice(0, 20).map(row => [row.uid, row.type, row.joints, String(row.visible), row.layer])),
      element('h4', {textContent: `History (${history.size})`}),
      table(['Stack', 'Label'], history.rows.slice(0, 30).map(row => [row.stack, row.label])),
      element('div', {className: 'dt-row'}, element('h4', {textContent: 'Edit session calls, newest first'}), saveLog),
      table(['Method', 'ms'], calls.map(row => [row.method, row.ms]), [1]));
  }

  return {name: 'Inspector', root, shown: build};
}
