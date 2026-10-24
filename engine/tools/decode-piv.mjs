// Decodes a Pivot .piv with the repository's Python codec (the development oracle) into a
// JSON document for records-reference.mjs and reference.mjs. The interpreter
// is the one scripts/run-python.mjs picks (STYK_PYTHON, the repository's .venv, then PATH), so
// it runs the same on every platform.
//
//   node engine/tools/decode-piv.mjs <file.piv> <out.json>
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolvePython} from '../../scripts/run-python.mjs';

const codec = path.resolve(import.meta.dirname, '../../codecs/piv_codec.py');

/** Writes the decoded document of `file` to `out`; throws when the codec refuses the file. */
export function decodePiv(file, out, {stdio = 'ignore'} = {}) {
  const python = resolvePython();
  if (!python) throw new Error('Python 3.11 or newer was not found. Install it, or set STYK_PYTHON to its executable.');
  execFileSync(python.command, [...python.args, codec, file, '--out', out], {stdio, windowsHide: true});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, out] = process.argv.slice(2);
  if (!file || !out) { console.error('usage: node engine/tools/decode-piv.mjs <file.piv> <out.json>'); process.exit(2); }
  decodePiv(file, out, {stdio: 'inherit'});
}
