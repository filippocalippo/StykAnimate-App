// Pins Math.pow to V8's own implementation. Import it first, before the editor, in every tool
// that records what the editor computes and in every child process such a tool starts.
//
// V8 13.6 (Node 24) computes Math.pow and ** with the C library's pow by default
// (--use-std-math-pow): glibc on Linux, the C runtime linked into the binary on Windows, Apple's
// on macOS, which differ from each other for about 0.05 % of inputs. V8's own pow (fdlibm 5.3
// with V8's last step, which Node 22 uses) is the same on every platform, and it is what
// styk-math::pow computes. Every tool that records what the editor computes pins it, so the
// recordings do not depend on the machine they are made on.
import v8 from 'node:v8';

// Inputs where V8's pow differs from the platform's on Windows and Linux.
const pins = [
  [936916874.799099, -17.218922165878823, 3.2883477091933536e-155],
  [0.014227945981589461, -18.36041002922876, 8.110849315737477e33],
  [0.21000381859714912, -27.40014443513526, 3.7245416855376026e18],
];
const pinned = () => pins.every(([x, y, own]) => Object.is(Math.pow(x, y), own) && Object.is(x ** y, own));

if (!pinned()) {
  v8.setFlagsFromString('--no-use-std-math-pow');
  if (!pinned()) throw new Error("Math.pow is not V8's own implementation (node --no-use-std-math-pow)");
}
