// Convert real Core Debug output to typed Rust fixture expressions, without a runtime codec.
// Run the app's prepare_inspector example first; this never writes screenshot references.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {catalogueIds} from './native-screen-guards.mjs';

const files = ['inspector/model', 'inspector/property', 'inspector/order', 'commands/metadata', 'i18n'];
const schema = new Map();
const tokens = text => text.match(/"(?:\\.|[^"\\])*"|'static|[A-Za-z_][A-Za-z_0-9]*|-?(?:\d+\.?\d*(?:e[+-]?\d+)?|inf)|[^\s]/g) ?? [];
function split(list, separator = ',') {
  const out = []; let start = 0, depth = 0;
  list.forEach((t, i) => { if ('(<[{'.includes(t)) depth++; if (')>]}'.includes(t)) depth--; if (t === separator && depth === 0) { out.push(list.slice(start, i)); start = i + 1; } });
  if (start < list.length) out.push(list.slice(start));
  return out;
}
function body(ts, at) {
  let depth = 1, end = at + 1;
  while (depth && end < ts.length) { if (ts[end] === ts[at]) depth++; if (ts[end] === ({'{':'}','(':')','[':']','<':'>'})[ts[at]]) depth--; end++; }
  if (depth) throw Error('unclosed schema item');
  return [ts.slice(at + 1, end - 1), end];
}
const fields = ts => split(ts).map(f => { const colon = f.indexOf(':'); return [f[colon - 1], f.slice(colon + 1).join('')]; });
for (const file of files) {
  const source = readFileSync(`engine/crates/styk-core/src/${file}.rs`, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/#\[[^\n]*\]\s*/g, '');
  const ts = tokens(source);
  for (let i = 0; i < ts.length; i++) {
    if (!['struct', 'enum'].includes(ts[i]) || ts[i + 2] !== '{') continue;
    const kind = ts[i], name = ts[i + 1], [inside, end] = body(ts, i + 2);
    schema.set(name, {kind, path: `styk_core::${file.replaceAll('/', '::')}::${name}`, fields: kind === 'struct' ? fields(inside) : new Map(split(inside).map(v => [v[0], {shape:v[1], fields: v[1] === '{' ? fields(v.slice(2,-1)) : split(v.slice(2,-1)).map(t => t.join(''))}]))});
    i = end - 1;
  }
}
// CommandId is declared by the registry macro; read its one row list, not the macro placeholder.
const registry = readFileSync('engine/crates/styk-core/src/commands/metadata/data.rs', 'utf8');
const variants = [...registry.matchAll(/^\s*(\w+)\s*=>/gm)].map(match => [match[1], {shape: undefined, fields: []}]);
if (!variants.length) throw Error('command registry supplied no variants');
schema.set('CommandId', {kind: 'enum', path: 'styk_core::commands::CommandId', fields: new Map(variants)});
function expression(source) {
  const ts = tokens(source); let at = 0;
  const take = expected => { const got = ts[at++]; if (expected && expected !== got) throw Error(`expected ${expected}, got ${got} at ${at}`); return got; };
  function sequence(close, types, repeat) { const values=[]; while (ts[at] !== close) { values.push(value(types[repeat ? 0 : values.length])); if (ts[at] === ',') take(','); else break; } take(close); return values.join(', '); }
  function members(fs) { take('{'); const result=fs.map(([name,type]) => { take(name); take(':'); const v=value(type); if(ts[at]===',')take(','); return `${name}: ${v}`; }); take('}'); return `{ ${result.join(', ')} }`; }
  function value(type) {
    if(type.startsWith('Option<')) { const variant=take(); if(variant==='None')return 'None'; if(variant!=='Some')throw Error(variant); take('('); const v=value(type.slice(7,-1)); if(ts[at]===',')take(','); take(')'); return `Some(${v})`; }
    if(type.startsWith('Vec<')) { take('['); return `vec![${sequence(']',[type.slice(4,-1)],true)}]`; }
    if(type.startsWith('[')) { take('['); return `[${sequence(']',[type.slice(1,type.indexOf(';'))],true)}]`; }
    if(type.startsWith('(')) { take('('); return `(${sequence(')',split(tokens(type.slice(1,-1))).map(t=>t.join('')),false)})`; }
    if(type.includes('str') || type==='String') { const s=take(); if(!s.startsWith('"'))throw Error(`expected string: ${s}`); return type.startsWith("&") ? s : `${s}.into()`; }
    const entry=schema.get(type);
    if(entry) { const name=take(); if(entry.kind==='struct') { if(name!==type)throw Error(`expected ${type}, got ${name}`); return `${entry.path} ${members(entry.fields)}`; }
      const variant=entry.fields.get(name); if(!variant)throw Error(`unknown ${type}::${name}`);
      const prefix=`${entry.path}::${name}`;
      if(variant.shape==='{')return `${prefix} ${members(variant.fields)}`;
      if(variant.shape==='(') { take('('); return `${prefix}(${sequence(')',variant.fields,false)})`; }
      return prefix;
    }
    const v=take(); if(type==='f64' && /inf$/.test(v))return v==='inf'?'f64::INFINITY':'f64::NEG_INFINITY';
    if(!/^(?:true|false|-?\d)/.test(v))throw Error(`unsupported ${type}: ${v}`); return v;
  }
  const result=value('Inspector'); if(at!==ts.length)throw Error('trailing data'); return result;
}
const input=process.argv[2]; if(!input)throw Error('pass the prepare_inspector output directory');
const out=resolve('engine/crates/styk-ui/src/screens/models'); mkdirSync(out,{recursive:true});
const names = new Set(catalogueIds(readFileSync('engine/crates/styk-ui/src/screens.rs', 'utf8')).filter(id => id.startsWith('inspector-')).map(id => id.slice('inspector-'.length).replace(/-dark$/, '')));
for(const name of names) {
  writeFileSync(resolve(out,`${name}.rs`), `// Generated by prepare_inspector + native-inspector-models.mjs. Do not hand-edit.\n${expression(readFileSync(resolve(input,`${name}.debug`),'utf8'))}\n`);
}
