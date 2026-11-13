/**
 * The notes of a report (`--notes <file>`) as HTML: the small part of Markdown an analysis needs. Headings, paragraphs,
 * lists (nested by indentation), tables, quotes, fenced code, rules; inline bold, italics, code and links.
 *
 * Everything is escaped first: the notes are text, never markup, and a link goes only to a web page or to a place in
 * the report itself (`#env=gpu&workload=stress&scenario=pose.drag-joint` opens that scenario). Headings start at
 * `headingLevel` so the notes sit under the page's own headings.
 */

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
export const escapeHtml = text => String(text).replace(/[&<>"']/g, character => ESCAPES[character]);

/** Inline Markdown of one line or paragraph: code spans are kept literal, the rest escaped, then emphasis and links. */
export function inline(text) {
  return String(text).split(/(`+[^`]*?`+)/).map((part, index) => {
    if (index % 2) return `<code>${escapeHtml(part.replace(/^`+|`+$/g, ''))}</code>`;
    return escapeHtml(part)
      .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, label, href) => (/^(https?:\/\/|#)/i.test(href) ? `<a href="${href}"${href.startsWith('#') ? '' : ' rel="noreferrer"'}>${label}</a>` : label))
      .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=\S)(.+?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_(?=\S)(.+?)_(?!\w)/g, '$1<em>$2</em>');
  }).join('');
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));

/** A list starting at `lines[start]`: items and the deeper lists under them, until a line that is neither. */
function list(lines, start) {
  const indent = LIST_ITEM.exec(lines[start])[1].length, ordered = /\d/.test(LIST_ITEM.exec(lines[start])[2]);
  const items = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (match && match[1].length === indent) { items.push({text: match[3], children: ''}); index++; continue; }
    if (match && match[1].length > indent && items.length) { const nested = list(lines, index); items.at(-1).children += nested.html; index = nested.next; continue; }
    // A continuation line of the item before (indented, not a new item).
    if (!match && items.length && /^\s+\S/.test(lines[index]) && lines[index].search(/\S/) > indent) { items.at(-1).text += ` ${lines[index].trim()}`; index++; continue; }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  return {html: `<${tag}>${items.map(item => `<li>${inline(item.text)}${item.children}</li>`).join('')}</${tag}>`, next: index};
}

/** `source` (Markdown) as HTML. */
export function markdown(source, {headingLevel = 3} = {}) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n'), out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body = [];
      for (index++; index < lines.length && !lines[index].trim().startsWith(fence[1]); index++) body.push(lines[index]);
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      index++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { const level = Math.min(6, heading[1].length + headingLevel - 1); out.push(`<h${level}>${inline(heading[2])}</h${level}>`); index++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); index++; continue; }
    if (LIST_ITEM.test(line)) { const found = list(lines, index); out.push(found.html); index = found.next; continue; }
    if (line.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1])) {
      const head = cells(line), aligns = cells(lines[index + 1]).map(cell => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : null));
      const align = column => (aligns[column] ? ` style="text-align:${aligns[column]}"` : '');
      const body = [];
      for (index += 2; index < lines.length && lines[index].includes('|') && lines[index].trim(); index++) body.push(cells(lines[index]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((cell, column) => `<th${align(column)}>${inline(cell)}</th>`).join('')}</tr></thead>`
        + `<tbody>${body.map(row => `<tr>${head.map((_, column) => `<td${align(column)}>${inline(row[column] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      for (; index < lines.length && /^\s*>/.test(lines[index]); index++) quoted.push(lines[index].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(quoted.join('\n'), {headingLevel})}</blockquote>`);
      continue;
    }
    // A paragraph: lines until a blank line or the start of another block.
    const paragraph = [];
    for (; index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>)/.test(lines[index]) && !LIST_ITEM.test(lines[index]); index++) paragraph.push(lines[index].trim());
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}
