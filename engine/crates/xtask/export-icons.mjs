// Prints the interface's own icons (src/icons.mjs: Lucide, with the app's adaptations) for `cargo xtask design`.
//
// One line per icon: `shape <name> <svg>`, then one line per alias the interface also uses: `alias <alias> <name>`.
// Each svg is the markup `icon(name)` returns, made standalone: an XML namespace instead of the CSS class and the
// accessibility attributes, and a fixed black for `currentColor` (the native interface tints icons at draw time).
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = resolve(root, 'src/icons.mjs');
const {icon, iconNames} = await import(pathToFileURL(source).href);

const text = readFileSync(source, 'utf8');
const block = text.match(/const aliases = Object\.freeze\(\{([\s\S]*?)\}\);/);
if (!block) throw new Error('src/icons.mjs no longer has `const aliases = Object.freeze({...})`');
const aliases = [...block[1].matchAll(/^\s*(?:"([^"]+)"|([\w-]+)):\s*"([^"]+)",?\s*$/gm)].map((m) => [m[1] ?? m[2], m[3]]);

const standalone = (svg) =>
  svg
    .replace(' class="icon"', ' xmlns="http://www.w3.org/2000/svg"')
    .replace(' aria-hidden="true" focusable="false"', '')
    .replaceAll('currentColor', '#000');

const lines = [];
for (const name of iconNames) {
  const svg = standalone(icon(name));
  if (svg.includes('\n')) throw new Error(`icon ${name} spans several lines`);
  lines.push(`shape ${name} ${svg}`);
}
for (const [alias, target] of aliases) {
  if (!iconNames.includes(target)) throw new Error(`alias ${alias} points at ${target}, which is not an icon`);
  lines.push(`alias ${alias} ${target}`);
}
process.stdout.write(lines.join('\n') + '\n');
