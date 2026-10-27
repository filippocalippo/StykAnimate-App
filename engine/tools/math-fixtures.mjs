#!/usr/bin/env node
// What V8's Math returns, for styk-math's tests (engine/crates/styk-math/tests/v8.rs).
//   node engine/tools/math-fixtures.mjs
// sincos.bin: [x, Math.sin(x), Math.cos(x)] per input; atan2-hypot.bin: [y, x, Math.atan2(y, x),
// Math.hypot(y, x)]; asin-acos.bin: [x, Math.asin(x), Math.acos(x)]; exp.bin: [x, Math.exp(x)];
// log1p.bin: [x, Math.log1p(x)]; pow.bin: [x, y, Math.pow(x, y)] (V8's own pow, v8-pin.mjs).
// Little-endian doubles. Inputs come from a fixed sequence, so the files only
// change if V8's results do. Ordinary angles, tiny and large values, every n·π/2 up to 64 and its
// neighbours, the kernel's switch points and special values.
import './v8-pin.mjs';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
const out = fileURLToPath(new URL('../crates/styk-math/tests/', import.meta.url));
// V8's NaN comes back with different payload bits on Windows and Linux (same value, different
// bytes), so every NaN is written as the canonical quiet NaN and the files are byte-stable.
const save = (name, values) => {
  const words = new Uint32Array(values.buffer);
  values.forEach((value, i) => { if (value !== value) { words[2 * i] = 0; words[2 * i + 1] = 0x7ff80000; } });
  writeFileSync(`${out}${name}`, Buffer.from(values.buffer));
};
let seed = 2026; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const nudge = (value, ulps) => { const f = new Float64Array([value]), u = new BigInt64Array(f.buffer); u[0] += BigInt(ulps); return f[0]; };
const xs = [0, -0, NaN, Infinity, -Infinity, 5e-324, -5e-324, 2.2250738585072014e-308, 1e-300, 1e300, -1e300, 1.7976931348623157e308, 823550, 823551, 1e6, 1e9, 1e15, 1e22, 1e100];
for (let n = 1; n <= 64; n++) for (const d of [-1, 0, 1]) xs.push(nudge(n * Math.PI / 2, d), -nudge(n * Math.PI / 2, d));
for (let i = 0; i < 1500; i++) xs.push((rnd() - .5) * 4 * Math.PI, 0.29 + rnd() * 0.02, 0.78 + rnd() * 0.01, (rnd() - .5) * 10 ** (rnd() * 30));
const sincos = new Float64Array(xs.length * 3);
xs.forEach((x, i) => sincos.set([x, Math.sin(x), Math.cos(x)], i * 3));
save('sincos.bin', sincos);
const pairs = [[0, 0], [-0, 0], [0, -0], [-0, -0], [1, 0], [0, -1], [NaN, 1], [Infinity, Infinity], [-Infinity, 3], [1e-320, 1e-320], [3, 4], [1e308, 1e308], [5, 1], [-0, 1], [Infinity, -Infinity], [-Infinity, -Infinity], [2, -Infinity], [-2, Infinity], [1, NaN]];
for (let e = 55; e <= 70; e++) for (const [sy, sx] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) pairs.push([sy * 2 ** e * 1.37, sx * 1.01], [sy * 0.73, sx * 2 ** e * 1.13]);
for (let i = 0; i < 2000; i++) pairs.push([(rnd() - .5) * 800, (rnd() - .5) * 800], [(rnd() - .5) * 10 ** (rnd() * 20 - 10), (rnd() - .5) * 10 ** (rnd() * 20 - 10)]);
const atan = new Float64Array(pairs.length * 4);
pairs.forEach(([y, x], i) => atan.set([y, x, Math.atan2(y, x), Math.hypot(y, x)], i * 4));
save('atan2-hypot.bin', atan);
// asin and acos: the whole domain, fdlibm's switch points (|x| = 0.5, 0.975, 2^-26) and
// their neighbours, values next to ±1, out of range and special values.
const unit = [0, -0, NaN, Infinity, -Infinity, 1, -1, 5e-324, -5e-324, 2 ** -26, -(2 ** -26), 2 ** -27, 1e-300, 1.0000000000000002, -1.0000000000000002, 2, -3];
for (const point of [0.5, 0.975, 1, 2 ** -26]) for (const d of [-3, -2, -1, 0, 1, 2, 3]) unit.push(nudge(point, d), -nudge(point, d));
for (let i = 0; i < 3000; i++) unit.push(rnd() * 2 - 1, 0.45 + rnd() * 0.1, 0.97 + rnd() * 0.03, -(0.97 + rnd() * 0.03), (rnd() - .5) * 10 ** (-rnd() * 20));
const inverse = new Float64Array(unit.length * 3);
unit.forEach((x, i) => inverse.set([x, Math.asin(x), Math.acos(x)], i * 3));
save('asin-acos.bin', inverse);
// exp.bin: [x, Math.exp(x)]: special values, the overflow and underflow thresholds and their
// neighbours, ordinary values, and the drag decays of generated effects (exp(-drag · age)).
const es = [0, -0, NaN, Infinity, -Infinity, 5e-324, -5e-324, 1e-300, 709.782712893384, 709.7827128933841, -745.1332191019411, -745.1332191019412, -708.3964185322641, 1, -1, 0.5, Math.LN2, -Math.LN2];
for (const t of [0.34657359027997264, 1.0397207708399179, 3.725290298461914e-9]) for (const d of [-2, -1, 0, 1, 2]) es.push(nudge(t, d), -nudge(t, d));
for (let i = 0; i < 2000; i++) es.push((rnd() - .5) * 60, -rnd() * .5 * rnd() * 400, (rnd() - .5) * 10 ** (rnd() * 6 - 4));
const exps = new Float64Array(es.length * 2);
es.forEach((x, i) => exps.set([x, Math.exp(x)], i * 2));
save('exp.bin', exps);
// log1p.bin: [x, Math.log1p(x)]: special values, -1 and below, fdlibm's switch points (2^-54,
// 2^-29, 1 + x near √2 and √2/2, 2^53) and their neighbours, ordinary values, and the zoom
// range of camera motion clips (-0.8 to 4).
const ls = [0, -0, NaN, Infinity, -Infinity, -1, -1.0000000000000002, -0.9999999999999999, -2, 5e-324, -5e-324, 1e-300, 1e300, 1.7976931348623157e308, 2 ** 53, 2 ** 53 + 2, 2 ** 1023];
for (const t of [2 ** -54, 2 ** -29, 0.41421356237309503, -0.2928932188134524, 0.414213562373095, Math.SQRT2 - 1, Math.SQRT1_2 - 1, 2 ** 53]) for (const d of [-3, -2, -1, 0, 1, 2, 3]) ls.push(nudge(t, d), -nudge(t, d));
for (let i = 0; i < 3000; i++) ls.push(rnd() * 4.8 - 0.8, (rnd() - .5) * 10 ** (rnd() * 8 - 6), rnd() * 10 ** (rnd() * 20), -rnd());
const logs = new Float64Array(ls.length * 2);
ls.forEach((x, i) => logs.set([x, Math.log1p(x)], i * 2));
save('log1p.bin', logs);
// log.bin: [x, Math.log(x)]. Independent full-range inputs and fdlibm's normalization
// branches, plus follow-camera fit ratios and maximum zoom. Preserve signed-zero/domain
// behavior and subnormals, not only the camera's ordinary positive range.
const ns = [0, -0, NaN, Infinity, -Infinity, -1, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 1e-6, 1, 2, 3, 20];
const fromHigh = word => new Float64Array(new BigUint64Array([BigInt(word) << 32n]).buffer)[0];
for (const point of [1, Math.SQRT2, Math.SQRT1_2, fromHigh(0x3ff6147a), fromHigh(0x3ff6b851), fromHigh(0x3ff6a09c), fromHigh(0x3ff00002), fromHigh(0x3ff6147a) / 2, 2.2250738585072014e-308, 1e-6])
  for (const d of [-3, -2, -1, 0, 1, 2, 3]) ns.push(nudge(point, d));
for (let exponent = -1074; exponent <= 1023; exponent++) ns.push(2 ** exponent, (2 ** exponent) * 1.37);
for (let i = 0; i < 5000; i++) ns.push(1 + rnd() * 19, 10 ** (rnd() * 620 - 310), .5 + rnd(), rnd() * 4);
const natural = new Float64Array(ns.length * 2);
ns.forEach((x, i) => natural.set([x, Math.log(x)], i * 2));
save('log.bin', natural);
// pow.bin: [x, y, Math.pow(x, y)] with full-precision inputs (a second generator: the one above
// has 32 bits). The drawing engine's pressure curves (x in [0, 1], y in (0, 10]), Bezier easing
// (t ** 3), the generators' and the rig's exponents, integers and halves, negative bases, powers
// of two and ten from subnormal to huge, fdlibm's interval boundaries, bases near 1 with huge
// exponents, the overflow and underflow edges and the special values.
let state = 2026;
const next = () => { state = (state + 0x6D2B79F5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const wide = () => next() + next() / 4294967296;
const anyBits = () => new Float64Array(new BigUint64Array([(BigInt(Math.floor(next() * 4294967296)) << 32n) | BigInt(Math.floor(next() * 4294967296))]).buffer)[0];
const ps = [];
const pair = (x, y) => ps.push(x, y);
const special = [0, -0, 1, -1, 2, -2, .5, -.5, 3, -3, 10, Infinity, -Infinity, NaN, 5e-324, -5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308, 1e-300, 1e300, 2 ** 31, 2 ** 53, 2 ** 64, 2 ** 1023, 1.5, 0.1, 0.9999999999999999, 1.0000000000000002, 1074, -1074, 1075, -1075, 1024, -1024, 1023.9999999999999, 31, 32, 4294967296.5];
for (const a of special) for (const b of special) pair(a, b), pair(nudge(a, 1), b), pair(a, nudge(b, -1));
for (let x = -8; x <= 8; x += .5) for (let y = -8; y <= 8; y += .5) pair(x, y);
for (let x = -20; x <= 20; x++) for (let y = -70; y <= 70; y++) pair(x, y);
for (let e = -1074; e <= 1023; e += 2) for (const y of [-3, 1 / 3, 1.7, 10]) pair(2 ** e, y);
for (let e = -1074; e <= 1023; e += 3) for (const y of [1.7, -.6]) pair(2 ** e * 1.37, y);
for (let e = -320; e <= 308; e++) for (const y of [-1, .5, 3]) pair(10 ** e, y);
// The drawing engine's pressure curves.
for (let i = 0; i < 15000; i++) pair(wide(), 10 * (1 - wide()));
for (let n = 0; n <= 255; n++) for (let y = .5; y <= 10; y += .5) pair(n / 255, y);
for (let n = 0; n <= 255; n++) pair(n / 255, 1.7), pair(n / 255, .6);
// Bezier easing: t ** 3 for t in [0, 1].
for (let i = 0; i < 8000; i++) pair(wide(), 3);
for (let i = 0; i < 2000; i++) pair(1 - wide() * 1e-3, 3);
// The generators' and the rig's exponents.
const exponents = [1.5, .85, 1.3, .9, .7, 2.2, .35, 1.15, .52, 1.6, .45, 3, 4, 1 / 3, 2.5, .8, 1.2];
for (let i = 0; i < 5000; i++) pair([wide(), wide() * 10, 1e-6 + wide() * 1e3, 1 - wide()][i & 3], exponents[i % exponents.length]);
for (let i = 0; i < 3000; i++) pair([wide(), wide() * 10, 0.01 + wide() * 100][i % 3], 1 + Math.floor(next() * 80));
for (let i = 0; i < 4000; i++) pair(.01 + wide() * 100, (wide() - .5) * 6);
// Anything: wide magnitudes, random bit patterns, bases near 1, the overflow and underflow edges.
for (let i = 0; i < 10000; i++) pair((next() < .5 ? -1 : 1) * 10 ** (wide() * 60 - 30), (wide() - .5) * 80);
for (let i = 0; i < 3000; i++) pair(anyBits(), anyBits());
for (let i = 0; i < 3000; i++) pair(anyBits(), (wide() - .5) * 8);
for (let i = 0; i < 2000; i++) pair(1 + (wide() - .5) * 1e-5, (wide() - .5) * 1e10);
for (let i = 0; i < 2000; i++) pair(1 + (wide() - .5) * 1e-12, (wide() - .5) * 1e18);
for (let i = 0; i < 3000; i++) { const y = (wide() - .5) * 2000; pair(2 ** ((next() < .5 ? 1 : -1) * (1000 + wide() * 100) / y), y); }
// fdlibm's mantissa intervals (|x| < sqrt(3/2), < sqrt(3)) and their neighbours.
for (const high of [0x3ff3988e, 0x3ff3988f, 0x3ffbb679, 0x3ffbb67a, 0x3ff00000, 0x3ff7ffff]) for (let d = -20; d <= 20; d++) for (const y of [.3, 1.7, 3, -1.5, 40, .6]) pair(nudge(fromHigh(high), d), y);
const power = new Float64Array(ps.length / 2 * 3);
for (let i = 0; i < ps.length; i += 2) power.set([ps[i], ps[i + 1], Math.pow(ps[i], ps[i + 1])], i / 2 * 3);
save('pow.bin', power);
console.log(`${xs.length} sine and cosine inputs, ${pairs.length} atan2 and hypot pairs, ${unit.length} asin and acos inputs, ${es.length} exponentials, ${ls.length} log1p inputs, ${ns.length} logarithms, ${ps.length / 2} powers`);
