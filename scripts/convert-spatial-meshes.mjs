/** Convert native skin-joint surfaces of a STYK/STKZ file into figure meshes
 * (docs/SPATIAL-MESHES.md). The input is never modified.
 * Usage: node scripts/convert-spatial-meshes.mjs <input.styk|stkz> <output.styk|stkz>
 */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {decodeDocument, buildContainerV2} from '../tests/support/native-files.mjs';
import {validateScene, syncDerived} from '../src/pivot/model.mjs';
import {convertDocumentSpatialMeshes} from '../src/spatial-mesh-legacy.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/convert-spatial-meshes.mjs <input> <output>');
if (path.resolve(input) === path.resolve(output)) throw new Error('Choose a different output file; the input is kept unchanged.');
const kind = ext => ({'.styk': 'styk', '.stkz': 'stkz'})[path.extname(ext).toLowerCase()];
if (!kind(input) || kind(input) !== kind(output)) throw new Error('Convert a .styk or .stkz file to the same file type.');
const bytes = await readFile(input), {document} = await decodeDocument(new Uint8Array(bytes), kind(input));
validateScene(document);
const {document: converted, converted: figures, skipped} = convertDocumentSpatialMeshes(document);
validateScene(converted); syncDerived(converted);
const encoded = await buildContainerV2(converted, kind(output));
// Reopen the written bytes before reporting success.
validateScene((await decodeDocument(encoded, kind(output))).document);
if (figures.length) await writeFile(output, encoded);
console.log(JSON.stringify({input, output: figures.length ? output : null, inputBytes: bytes.byteLength, outputBytes: figures.length ? encoded.byteLength : null,
  converted: figures, skipped}, null, 2));
if (!figures.length) process.exitCode = 1;
