// Prints the files of styk-core's language-neutral catalogue (engine/crates/styk-core/locales/), generated from the
// interface's catalogues: index.json (every locale of src/locales/locale-index.mjs with its direction, English first)
// and one <id>.json per locale holding its messages exactly as src/locales/en.mjs and src/locales/messages/<id>.mjs
// export them, keys sorted, one message per line. Output: path NUL content NUL, repeated. `cargo xtask locales` writes
// them (generate) or compares them (check).
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.argv[2];
const load = async file => (await import(pathToFileURL(path.join(root, 'src/locales', file)).href)).default;
const index = await load('locale-index.mjs');
const locales = [{id: 'en', direction: 'ltr', file: 'en.mjs'}];
for (const locale of index) {
  if (locale.id !== 'en') locales.push({id: locale.id, direction: locale.direction === 'rtl' ? 'rtl' : 'ltr', file: `messages/${locale.id}.mjs`});
}
const out = [];
const emit = (file, content) => out.push(`engine/crates/styk-core/locales/${file}`, content);
emit('index.json', `[\n${locales.map(({id, direction}) => `  ${JSON.stringify({id, direction})}`).join(',\n')}\n]\n`);
for (const locale of locales) {
  const messages = await load(locale.file);
  const keys = Object.keys(messages).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = keys.map(key => {
    const value = messages[key];
    const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(Object.fromEntries(Object.entries(value)));
    return `  ${JSON.stringify(key)}: ${text}`;
  });
  emit(`${locale.id}.json`, `{\n${lines.join(',\n')}\n}\n`);
}
process.stdout.write(out.join('\0'));
