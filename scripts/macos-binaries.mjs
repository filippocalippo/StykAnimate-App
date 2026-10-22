// Mach-O facts the macOS packaging checks rely on: each binary's architectures,
// the oldest macOS it declares, and a digest that ignores its code signature.
//
// Packaging re-signs native files (PyInstaller ad-hoc signs what it collects,
// electron-builder signs the whole bundle), so their bytes legitimately change
// after the verified build. Removing the signature restores the bytes the linker
// produced (apart from one size field, see clearLinkEditMapping), which is what the
// integrity checks compare.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CPU = new Map([[0x0100000c, 'arm64'], [0x01000007, 'x64']]);
const LC_VERSION_MIN_MACOSX = 0x24, LC_BUILD_VERSION = 0x32, PLATFORM_MACOS = 1;
const HEADER_BYTES = 64 * 1024;

const version = value => `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`;
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let index = 0; index < 3; index++) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
  return 0;
}

/** One thin Mach-O image starting at `offset` in `bytes`: {arch, minimum}, or null if it is not one. */
function thinSlice(bytes, offset = 0) {
  if (bytes.length < offset + 28) return null;
  const magic = bytes.readUInt32LE(offset);
  if (magic !== 0xfeedfacf && magic !== 0xfeedface) return null;
  const cpu = bytes.readUInt32LE(offset + 4), count = bytes.readUInt32LE(offset + 16);
  let cursor = offset + (magic === 0xfeedfacf ? 32 : 28), minimum = null;
  for (let index = 0; index < count && cursor + 8 <= bytes.length; index++) {
    const command = bytes.readUInt32LE(cursor), size = bytes.readUInt32LE(cursor + 4);
    if (size < 8) break;
    if (command === LC_BUILD_VERSION && cursor + 16 <= bytes.length && bytes.readUInt32LE(cursor + 8) === PLATFORM_MACOS) minimum = version(bytes.readUInt32LE(cursor + 12));
    else if (command === LC_VERSION_MIN_MACOSX && cursor + 12 <= bytes.length) minimum = version(bytes.readUInt32LE(cursor + 8));
    cursor += size;
  }
  return { arch: CPU.get(cpu) ?? `cpu-${cpu.toString(16)}`, minimum };
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length), { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** The Mach-O slices in a file, or null for anything else (scripts, data, Java classes). */
export async function machOSlices(file) {
  const handle = await open(file, 'r');
  try {
    const head = await readAt(handle, 0, HEADER_BYTES);
    if (head.length < 8) return null;
    const fat = head.readUInt32BE(0), wide = fat === 0xcafebabf;
    if (fat === 0xcafebabe || wide) {
      // Java class files share 0xcafebabe; their next word is a version far above any slice count.
      const count = head.readUInt32BE(4), entry = wide ? 32 : 20;
      if (count === 0 || count > 16 || 8 + count * entry > head.length) return null;
      const slices = [];
      for (let index = 0; index < count; index++) {
        const at = 8 + index * entry, offset = wide ? Number(head.readBigUInt64BE(at + 8)) : head.readUInt32BE(at + 8);
        const slice = thinSlice(await readAt(handle, offset, HEADER_BYTES));
        if (!slice) return null;
        slices.push(slice);
      }
      return slices;
    }
    const slice = thinSlice(head);
    return slice ? [slice] : null;
  } finally { await handle.close(); }
}

async function* files(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    // Framework version links point inside the same bundle; following them would count files twice.
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
  }
}

/**
 * Every Mach-O file under `root` must contain `arch` and declare a minimum macOS no
 * newer than `minimum`. Returns {count, problems}; an empty problem list passes.
 */
export async function checkMachOTree(root, { arch, minimum }) {
  const problems = [];
  let count = 0;
  for await (const file of files(root)) {
    const slices = await machOSlices(file);
    if (!slices) continue;
    count++;
    const relative = path.relative(root, file), slice = slices.find(item => item.arch === arch);
    if (!slice) problems.push(`${relative}: no ${arch} code (${slices.map(item => item.arch).join(', ')})`);
    else if (!slice.minimum) problems.push(`${relative}: declares no minimum macOS version`);
    else if (compareVersions(slice.minimum, minimum) > 0) problems.push(`${relative}: requires macOS ${slice.minimum}, newer than ${minimum}`);
  }
  return { count, problems };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Zeroes each slice's __LINKEDIT vmsize. Removing a signature truncates the file and fixes the
 * segment's file size but leaves its mapped size rounded to the old signature's length, which
 * differs between signers; everything else must still match.
 */
function clearLinkEditMapping(bytes) {
  const slices = [];
  const fat = bytes.readUInt32BE(0);
  if (fat === 0xcafebabe || fat === 0xcafebabf) {
    const wide = fat === 0xcafebabf, entry = wide ? 32 : 20;
    for (let index = 0; index < bytes.readUInt32BE(4); index++)
      slices.push(wide ? Number(bytes.readBigUInt64BE(8 + index * entry + 8)) : bytes.readUInt32BE(8 + index * entry + 8));
  } else slices.push(0);
  for (const offset of slices) {
    const magic = bytes.readUInt32LE(offset), wide = magic === 0xfeedfacf;
    if (!wide && magic !== 0xfeedface) continue;
    let cursor = offset + (wide ? 32 : 28);
    for (let index = 0; index < bytes.readUInt32LE(offset + 16); index++) {
      const command = bytes.readUInt32LE(cursor);
      if ((command === 0x19 || command === 0x1) && bytes.toString('latin1', cursor + 8, cursor + 24).replace(/\0+$/, '') === '__LINKEDIT')
        bytes.fill(0, cursor + (wide ? 32 : 28), cursor + (wide ? 40 : 32));
      cursor += bytes.readUInt32LE(cursor + 4);
    }
  }
  return bytes;
}

/** SHA-256 of a Mach-O file with its code signature removed (macOS only; uses the system codesign). */
export async function unsignedDigest(file) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'styk-unsigned-'));
  try {
    const copy = path.join(directory, path.basename(file));
    await copyFile(file, copy);
    try { await run('codesign', ['--remove-signature', copy]); }
    catch (error) { if (!/not signed at all/i.test(error.stderr || '')) throw error; }
    return sha256(clearLinkEditMapping(await readFile(copy)));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** True when two files are byte-identical, or identical Mach-O code that differs only in its signature. */
export async function sameBinary(source, packaged) {
  const [left, right] = await Promise.all([readFile(source), readFile(packaged)]);
  if (sha256(left) === sha256(right)) return true;
  if (process.platform !== 'darwin' || !(await machOSlices(source)) || !(await machOSlices(packaged))) return false;
  return await unsignedDigest(source) === await unsignedDigest(packaged);
}

/** The deployment target declared once in package.json (build.mac.minimumSystemVersion). */
export async function macMinimumVersion(appRoot) {
  const minimum = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8')).build?.mac?.minimumSystemVersion;
  if (!/^\d+\.\d+(\.\d+)?$/.test(minimum || '')) throw new Error('package.json build.mac.minimumSystemVersion must name the oldest supported macOS, such as 12.0.');
  return minimum;
}
