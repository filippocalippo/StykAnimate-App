// Compares the native band with today's, scenario by scenario: tmp/band-ref/out/{chromium,native}/<id>.png, the band's rows.
// Writes a stack (today's, native, difference x4) to out/compare/<id>.png and prints the scores.
import {readPng, writePng} from './png.mjs';
import {mkdirSync, existsSync} from 'node:fs';
import {SCENARIOS} from './scenarios.mjs';

// Output goes to the ignored tmp/band-ref of the repository.
const OUT = new URL('../../../../../tmp/band-ref/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const here = OUT;
mkdirSync(`${here}out/compare`, {recursive: true});
const only = process.argv.slice(2);
const rows = [];
for (const scenario of SCENARIOS) {
  if (only.length && !only.includes(scenario.id)) continue;
  const a = `${here}out/chromium/${scenario.id}.png`, b = `${here}out/native/${scenario.id}.png`;
  if (!existsSync(a) || !existsSync(b)) { console.log(scenario.id.padEnd(28), 'missing', existsSync(a) ? '' : 'chromium', existsSync(b) ? '' : 'native'); continue; }
  const today = readPng(a), native = readPng(b);
  const width = Math.min(today.width, native.width), height = today.height;
  let sum = 0, over = 0, squared = 0, worst = 0;
  const diff = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * today.width + x) * 4, j = (y * native.width + x) * 4, o = (y * width + x) * 4;
    let max = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(today.data[i + c] - native.data[j + c]); sum += d; squared += d * d; max = Math.max(max, d); diff[o + c] = 255 - Math.min(255, d * 4); }
    if (max > 24) over++;
    worst = Math.max(worst, max);
  }
  const count = width * height;
  const mse = squared / (count * 3), psnr = mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
  const stack = Buffer.alloc(width * (height * 3 + 4) * 4, 255);
  const put = (source, sourceWidth, top) => { for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * sourceWidth + x) * 4, o = ((top + y) * width + x) * 4; stack[o] = source[i]; stack[o + 1] = source[i + 1]; stack[o + 2] = source[i + 2]; stack[o + 3] = 255; } };
  put(today.data, today.width, 0); put(native.data, native.width, height + 2); put(diff, width, 2 * height + 4);
  writePng(`${here}out/compare/${scenario.id}.png`, {width, height: height * 3 + 4, data: stack});
  const sized = today.width === native.width ? '' : ` (width ${today.width} vs ${native.width})`;
  rows.push({id: scenario.id, psnr, wrong: 100 * over / count});
  console.log(scenario.id.padEnd(28), `PSNR ${psnr.toFixed(1).padStart(5)} dB   mean diff ${(sum / (count * 3)).toFixed(2).padStart(5)}   pixels >24: ${(100 * over / count).toFixed(2).padStart(6)} %   worst ${worst}${sized}`);
}
if (rows.length) console.log(`\n${rows.length} scenarios, lowest PSNR ${Math.min(...rows.map(r => r.psnr)).toFixed(1)} dB, most differing pixels ${Math.max(...rows.map(r => r.wrong)).toFixed(2)} %`);
