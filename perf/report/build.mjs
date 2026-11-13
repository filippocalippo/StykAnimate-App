/**
 * The report page (`npm run perf -- report`): one or more runs as one self-contained HTML file that opens from disk.
 * Its style, its script and its data are inside it; it makes no network request and loads no library.
 *
 *   model.mjs      what the page shows, decided in Node with the helpers the text summary uses;
 *   markdown.mjs   the notes of an analysis (`--notes`), rendered into the page as HTML;
 *   page/          the page: template.html, page.css, and its script as small ES modules from main.mjs down.
 *
 * The page's modules are joined into one script here, so they stay readable and checkable files and the page stays
 * one file. A page module imports only named values, either from another page module (`./x.mjs`) or from the runner's
 * own pure modules (`../../lib/metrics.mjs`): those values are copied in, functions as their source and data as JSON,
 * so a number is formatted on the page by the same function as in summary.txt. A copied function may use only what
 * the page also imports.
 */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {escapeHtml, markdown} from './markdown.mjs';
import {reportModel} from './model.mjs';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page');
const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';[ \t]*$/gm;
const EXPORT = /^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm;

/** The page's script: its modules in dependency order, inside one function so their names stay off the window. */
export async function pageScript(entry = path.join(PAGE, 'main.mjs')) {
  const modules = [], seen = new Set(), library = new Map();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, names, from] of source.matchAll(IMPORT)) {
      const target = path.resolve(path.dirname(file), from);
      if (path.dirname(target) === PAGE) { visit(target); continue; }
      const wanted = library.get(target) ?? new Set();
      for (const name of names.split(',').map(part => part.trim()).filter(Boolean)) {
        if (/\s/.test(name)) throw new Error(`${path.relative(PAGE, file)}: the page cannot rename an import (${name}).`);
        wanted.add(name);
      }
      library.set(target, wanted);
    }
    const body = source.replace(IMPORT, '').replace(EXPORT, '');
    const left = /^\s*(import|export)\b.*$/m.exec(body);
    if (left) throw new Error(`${path.relative(PAGE, file)}: the page's modules may only import {named} values and export declarations; found "${left[0].trim()}".`);
    modules.push(`// ${path.relative(PAGE, file).replace(/\\/g, '/')}\n${body.trim()}`);
  };
  visit(entry);
  const copied = [];
  for (const [file, names] of library) {
    const module = await import(pathToFileURL(file).href);
    for (const name of names) {
      const value = module[name];
      if (value === undefined) throw new Error(`${path.basename(file)} has no export ${name}.`);
      if (typeof value !== 'function') { copied.push(`const ${name} = ${JSON.stringify(value)};`); continue; }
      const source = value.toString();
      if (/^(async\s+)?function\b/.test(source) && value.name !== name) throw new Error(`${path.basename(file)}: ${name} is a function named ${value.name}.`);
      copied.push(/^(async\s+)?function\b|^class\b/.test(source) ? source : `const ${name} = ${source};`);
    }
  }
  return `(() => {\n'use strict';\n// Copied from the runner's modules (perf/lib/).\n${copied.join('\n')}\n\n${modules.join('\n\n')}\n})();\n`;
}

/**
 * Text inside a <script> or <style> element ends at the first "</script" or "</style", and "<!--" changes how a script
 * is read: the page's own code must not hold them, and the data never does (every "<" in it is written as \u003c).
 */
function inert(text, element) {
  if (new RegExp(`</${element}|<!--`, 'i').test(text)) throw new Error(`The report's ${element} contains "</${element}" or "<!--", which would end it early.`);
  return text;
}
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

/** The notes section: an analysis written after reading the data, above everything the page computes. */
function notesSection(notes, source) {
  if (!notes?.trim()) return '';
  return `<section class="panel notes" id="conclusions" aria-labelledby="conclusions-title"><header class="panel-head"><h2 id="conclusions-title">Conclusions</h2>`
    + `<p class="notes-source">Written after reading this data${source ? ` (${escapeHtml(source)})` : ''}; everything below it is computed from the runs.</p></header>\n${markdown(notes, {headingLevel: 3})}\n</section>`;
}

/**
 * The page for `runs` (results as perf/lib/result.mjs `read` returns them, in the order named) as HTML text.
 * `notes` is Markdown shown at the top; `notesName` says where it came from; `generated` dates the page.
 */
export async function buildReport(runs, {notes = null, notesName = null, generated} = {}) {
  if (!runs.length) throw new Error('A report needs at least one run.');
  const model = reportModel(runs, {generated});
  const title = `Performance · ${runs.map(run => run.label).join(' → ')}`;
  const parts = {
    title: escapeHtml(title),
    style: inert(readFileSync(path.join(PAGE, 'page.css'), 'utf8'), 'style'),
    notes: notesSection(notes, notesName),
    data: json(model),
    script: inert(await pageScript(), 'script'),
  };
  return readFileSync(path.join(PAGE, 'template.html'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, name) => parts[name]);
}
