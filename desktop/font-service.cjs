"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");

// Metadata and TTC repacking follow the OpenType name/table-directory specs:
// https://learn.microsoft.com/en-us/typography/opentype/spec/name
// https://learn.microsoft.com/en-us/typography/opentype/spec/otff
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_CONTAINER_BYTES = 128 * 1024 * 1024;
const MAX_NAME_BYTES = 1024 * 1024;
const MAX_TABLES = 256,
  MAX_FACES = 128;
const EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".otc"]);
const yieldTask = () => new Promise((resolve) => setImmediate(resolve));
const align4 = (size) => Math.ceil(size / 4) * 4;
const cleanName = (value) =>
  String(value || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 240);
const boundedInteger = (value, minimum, maximum, label) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`Invalid ${label}.`);
  return value;
};

/** Only conventional system/user font folders; no registry commands or home scan. */
function systemFontDirectories({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (platform === "win32")
    return [
      path.win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "Fonts"),
      ...(env.LOCALAPPDATA
        ? [path.win32.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts")]
        : []),
    ];
  if (platform === "darwin")
    return [
      "/System/Library/Fonts",
      "/Library/Fonts",
      path.posix.join(home, "Library/Fonts"),
    ];
  return [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    path.posix.join(home, ".local/share/fonts"),
    path.posix.join(home, ".fonts"),
  ];
}

function inside(file, root) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

async function readRange(
  handle,
  offset,
  length,
  size,
  maxBytes = MAX_FONT_BYTES,
) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > maxBytes ||
    offset > size - length
  )
    throw new Error("Invalid installed-font table bounds.");
  const buffer = Buffer.alloc(length);
  let completed = 0;
  while (completed < length) {
    const { bytesRead } = await handle.read(
      buffer,
      completed,
      Math.min(256 * 1024, length - completed),
      offset + completed,
    );
    if (!bytesRead)
      throw new Error("The installed font changed while reading.");
    completed += bytesRead;
  }
  return buffer;
}

async function faceDirectory(handle, offset, size) {
  const header = await readRange(handle, offset, 12, size);
  const signature = header.toString("latin1", 0, 4);
  if (
    header.readUInt32BE(0) !== 0x10000 &&
    !["OTTO", "true", "typ1"].includes(signature)
  )
    throw new Error("Unsupported font signature.");
  const count = header.readUInt16BE(4);
  if (!count || count > MAX_TABLES)
    throw new Error("Invalid installed-font table count.");
  const records = await readRange(handle, offset + 12, count * 16, size);
  const tables = [],
    tags = new Set();
  let outputSize = 12 + count * 16;
  for (let index = 0; index < count; index++) {
    const start = index * 16,
      tag = records.toString("latin1", start, start + 4);
    const table = {
      tag,
      checksum: records.readUInt32BE(start + 4),
      offset: records.readUInt32BE(start + 8),
      length: records.readUInt32BE(start + 12),
    };
    if (
      tags.has(tag) ||
      table.offset > size - table.length ||
      table.length > MAX_FONT_BYTES ||
      !/^[\x20-\x7e]{4}$/.test(tag)
    )
      throw new Error("Invalid installed-font table directory.");
    tags.add(tag);
    tables.push(table);
    outputSize += align4(table.length);
  }
  // opentype.js supports TrueType outlines and CFF1, not bitmap-only/CFF2 fonts.
  if (
    !tags.has("cmap") ||
    !tags.has("head") ||
    !((tags.has("glyf") && tags.has("loca")) || tags.has("CFF "))
  )
    throw new Error("The installed font has no supported outlines.");
  if (outputSize > MAX_FONT_BYTES)
    throw new Error("The installed font exceeds 32 MiB.");
  return {
    signature,
    tables,
    outputSize,
    format: tags.has("CFF ") ? "otf" : "ttf",
  };
}

/** Reads bounded name records without parsing glyphs or allocating font paths. */
function nameMetadata(buffer, fallback) {
  if (buffer.length < 6)
    return { family: fallback, style: "Regular", fullName: fallback };
  const count = buffer.readUInt16BE(2),
    strings = buffer.readUInt16BE(4),
    names = new Map();
  if (count > 4096 || 6 + count * 12 > buffer.length || strings > buffer.length)
    return { family: fallback, style: "Regular", fullName: fallback };
  let decodedBytes = 0;
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 12,
      platform = buffer.readUInt16BE(at),
      encoding = buffer.readUInt16BE(at + 2),
      language = buffer.readUInt16BE(at + 4),
      name = buffer.readUInt16BE(at + 6);
    const length = buffer.readUInt16BE(at + 8),
      offset = strings + buffer.readUInt16BE(at + 10);
    if (
      ![1, 2, 4, 6, 16, 17].includes(name) ||
      length > 8192 ||
      offset > buffer.length - length ||
      ![0, 1, 3].includes(platform)
    )
      continue;
    decodedBytes += length;
    if (decodedBytes > MAX_NAME_BYTES) break;
    let text;
    try {
      const bytes = buffer.subarray(offset, offset + length);
      if (platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding)))
        text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
      else if (platform === 1 && encoding === 0)
        text = new TextDecoder("macintosh", { fatal: true }).decode(bytes);
      else continue;
    } catch {
      continue;
    }
    text = cleanName(text);
    if (!text) continue;
    const score =
      (platform === 3 ? 4 : platform === 0 ? 3 : 1) +
      (language === 0x409 ? 8 : language === 0 ? 2 : 0);
    if (!names.has(name) || names.get(name).score < score)
      names.set(name, { text, score });
  }
  const family = names.get(16)?.text || names.get(1)?.text || fallback;
  const style = names.get(17)?.text || names.get(2)?.text || "Regular";
  return {
    family,
    style,
    fullName:
      names.get(4)?.text ||
      `${family}${style === "Regular" ? "" : ` ${style}`}`,
    postScriptName: names.get(6)?.text || "",
  };
}

async function checksum(buffer) {
  let sum = 0;
  for (let start = 0; start < buffer.length; start += 256 * 1024) {
    const end = Math.min(buffer.length, start + 256 * 1024);
    for (let offset = start; offset < end; offset += 4) {
      let value = 0;
      for (let byte = 0; byte < 4; byte++)
        value = (value << 8) | (buffer[offset + byte] || 0);
      sum = (sum + (value >>> 0)) >>> 0;
    }
    if (end < buffer.length) await yieldTask();
  }
  return sum;
}

/** Collection offsets are absolute; repack one selected face for ordinary parsers. */
async function standaloneFace(handle, entry, size) {
  const { directory } = entry,
    tables = directory.tables
      .filter((table) => table.tag !== "DSIG")
      .toSorted((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const length =
    12 +
    tables.length * 16 +
    tables.reduce((total, table) => total + align4(table.length), 0);
  if (length > MAX_FONT_BYTES)
    throw new Error("The installed font exceeds 32 MiB.");
  const output = Buffer.alloc(length),
    power = 2 ** Math.floor(Math.log2(tables.length));
  output.write(directory.signature, 0, 4, "latin1");
  output.writeUInt16BE(tables.length, 4);
  output.writeUInt16BE(power * 16, 6);
  output.writeUInt16BE(Math.log2(power), 8);
  output.writeUInt16BE(tables.length * 16 - power * 16, 10);
  let offset = 12 + tables.length * 16,
    headOffset = null;
  for (let index = 0; index < tables.length; index++) {
    const table = tables[index],
      data = await readRange(handle, table.offset, table.length, size),
      record = 12 + index * 16;
    if (table.tag === "head") {
      if (data.length < 12) throw new Error("Invalid font header.");
      data.writeUInt32BE(0, 8);
      headOffset = offset;
    }
    output.write(table.tag, record, 4, "latin1");
    output.writeUInt32BE(await checksum(data), record + 4);
    output.writeUInt32BE(offset, record + 8);
    output.writeUInt32BE(data.length, record + 12);
    data.copy(output, offset);
    offset += align4(data.length);
  }
  if (headOffset !== null)
    output.writeUInt32BE(
      (0xb1b0afba - (await checksum(output))) >>> 0,
      headOffset + 8,
    );
  return output;
}

class FontService {
  constructor({
    directories = systemFontDirectories(),
    maxFonts = 4096,
    maxDepth = 8,
    maxCacheBytes = 64 * 1024 * 1024,
    maxCachedFonts = 8,
  } = {}) {
    if (
      !Array.isArray(directories) ||
      directories.some(
        (root) => typeof root !== "string" || !path.isAbsolute(root),
      )
    )
      throw new TypeError("Font directories must be trusted absolute paths.");
    this.directories = [...directories];
    this.maxFonts = boundedInteger(maxFonts, 1, 10000, "font limit");
    this.maxDepth = boundedInteger(maxDepth, 0, 12, "font folder depth");
    this.maxCacheBytes = boundedInteger(
      maxCacheBytes,
      0,
      128 * 1024 * 1024,
      "font cache budget",
    );
    this.maxCachedFonts = boundedInteger(
      maxCachedFonts,
      0,
      32,
      "font cache count",
    );
    this.entries = new Map();
    this.bytes = new Map();
    this.roots = [];
    this.list = null;
    this.loading = null;
    this.reads = new Map();
    this.readChain = Promise.resolve();
    this.activeReads = 0;
    this.stats = {
      scans: 0,
      cacheHits: 0,
      fontCount: 0,
      directories: 0,
      candidates: 0,
      skipped: 0,
      metadataBytes: 0,
      scanMs: 0,
      fontReads: 0,
      cachedBytes: 0,
      readCacheHits: 0,
    };
  }
  async listFonts() {
    if (this.list) {
      this.stats.cacheHits++;
      return this.list;
    }
    if (!this.loading) {
      this.loading = this._scan();
      this.loading.catch(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }
  async _scan() {
    const started = performance.now();
    this.stats.scans++;
    this.roots = [];
    for (const root of this.directories) {
      try {
        const real = await fs.realpath(root);
        if (!this.roots.includes(real) && (await fs.stat(real)).isDirectory())
          this.roots.push(real);
      } catch {}
    }
    const visited = new Set(),
      files = new Set(),
      queue = this.roots.map((root) => ({ root, depth: 0 }));
    while (
      queue.length &&
      this.entries.size < this.maxFonts &&
      visited.size < 2048 &&
      files.size < 20000
    ) {
      const { root, depth } = queue.shift();
      let real;
      try {
        real = await fs.realpath(root);
      } catch {
        continue;
      }
      if (
        visited.has(real) ||
        !this.roots.some((allowed) => inside(real, allowed))
      )
        continue;
      visited.add(real);
      this.stats.directories++;
      let contents;
      try {
        contents = await fs.readdir(real, { withFileTypes: true });
      } catch {
        continue;
      }
      contents.sort((a, b) => a.name.localeCompare(b.name, "en"));
      for (const item of contents) {
        if (this.entries.size >= this.maxFonts || files.size >= 20000) break;
        const full = path.join(real, item.name);
        let actual = full,
          stat;
        try {
          if (item.isSymbolicLink()) actual = await fs.realpath(full);
          if (!this.roots.some((allowed) => inside(actual, allowed))) continue;
          if (item.isDirectory() || item.isSymbolicLink())
            stat = await fs.stat(actual);
          if (
            (item.isDirectory() || stat?.isDirectory()) &&
            depth < this.maxDepth
          ) {
            queue.push({ root: actual, depth: depth + 1 });
            continue;
          }
          if (
            !EXTENSIONS.has(path.extname(item.name).toLowerCase()) ||
            files.has(actual)
          )
            continue;
          stat ||= await fs.stat(actual);
          if (!stat.isFile()) continue;
          files.add(actual);
          this.stats.candidates++;
          await this._inspect(actual, item.name);
        } catch {
          this.stats.skipped++;
        }
      }
      await yieldTask();
    }
    this.list = Object.freeze(
      [...this.entries.values()]
        .map((entry) => Object.freeze(entry.metadata))
        .sort(
          (a, b) =>
            a.family.localeCompare(b.family) ||
            a.style.localeCompare(b.style) ||
            a.id.localeCompare(b.id),
        ),
    );
    this.stats.fontCount = this.list.length;
    this.stats.scanMs = performance.now() - started;
    return this.list;
  }
  async _inspect(filename, displayName) {
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 12 || stat.size > MAX_CONTAINER_BYTES)
        throw new Error("Invalid installed-font file size.");
      const header = await readRange(handle, 0, 12, stat.size),
        collection = header.toString("latin1", 0, 4) === "ttcf";
      let offsets = [0];
      if (collection) {
        const count = header.readUInt32BE(8);
        if (
          ![0x10000, 0x20000].includes(header.readUInt32BE(4)) ||
          !count ||
          count > MAX_FACES
        )
          throw new Error("Invalid font collection header.");
        const table = await readRange(handle, 12, count * 4, stat.size);
        offsets = Array.from({ length: count }, (_, i) =>
          table.readUInt32BE(i * 4),
        );
      } else if (stat.size > MAX_FONT_BYTES)
        throw new Error("The font exceeds 32 MiB.");
      for (
        let face = 0;
        face < offsets.length && this.entries.size < this.maxFonts;
        face++
      ) {
        try {
          const directory = await faceDirectory(
              handle,
              offsets[face],
              stat.size,
            ),
            name = directory.tables.find((table) => table.tag === "name");
          const fallback = cleanName(
            path.basename(displayName, path.extname(displayName)),
          );
          let metadata = {
            family: fallback,
            style: "Regular",
            fullName: fallback,
          };
          if (name && name.length <= MAX_NAME_BYTES) {
            const data = await readRange(
              handle,
              name.offset,
              name.length,
              stat.size,
              MAX_NAME_BYTES,
            );
            this.stats.metadataBytes += data.length;
            metadata = nameMetadata(data, fallback);
          }
          const id =
            "font_" +
            createHash("sha256")
              .update(
                `${process.platform === "win32" ? filename.toLowerCase() : filename}\0${face}`,
              )
              .digest("hex")
              .slice(0, 32);
          this.entries.set(id, {
            filename,
            face,
            directory,
            collection,
            fingerprint: {
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              ino: stat.ino,
              dev: stat.dev,
            },
            metadata: {
              id,
              ...metadata,
              format: directory.format,
              collection,
              byteLength: collection ? directory.outputSize : stat.size,
            },
          });
        } catch {
          this.stats.skipped++;
        }
      }
    } finally {
      await handle.close();
    }
  }
  async readFont(id) {
    if (typeof id !== "string" || !/^font_[a-f0-9]{32}$/.test(id))
      throw new TypeError("Choose an installed font from the font list.");
    if (this.activeReads >= 8)
      throw new Error("Too many installed fonts are being loaded.");
    this.activeReads++;
    try {
      await this.listFonts();
      const entry = this.entries.get(id);
      if (!entry) throw new Error("The installed font is unavailable.");
      if (this.bytes.has(id)) {
        const data = this.bytes.get(id);
        this.bytes.delete(id);
        this.bytes.set(id, data);
        this.stats.readCacheHits++;
        return Buffer.from(data);
      }
      if (!this.reads.has(id)) {
        const task = this.readChain
          .catch(() => {})
          .then(() => this._read(entry))
          .finally(() => this.reads.delete(id));
        this.reads.set(id, task);
        this.readChain = task;
      }
      return Buffer.from(await this.reads.get(id));
    } finally {
      this.activeReads--;
    }
  }
  async _read(entry) {
    const real = await fs.realpath(entry.filename);
    if (
      real !== entry.filename ||
      !this.roots.some((root) => inside(real, root))
    )
      throw new Error("The installed font location changed.");
    const handle = await fs.open(
      real,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    let data;
    try {
      const stat = await handle.stat(),
        before = entry.fingerprint;
      if (
        !stat.isFile() ||
        stat.size !== before.size ||
        stat.mtimeMs !== before.mtimeMs ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev
      )
        throw new Error(
          "The installed font changed. Restart StykAnimate to refresh the font list.",
        );
      data = entry.collection
        ? await standaloneFace(handle, entry, stat.size)
        : await readRange(handle, 0, stat.size, stat.size);
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw new Error("The installed font changed while reading.");
    } finally {
      await handle.close();
    }
    this.stats.fontReads++;
    if (data.length <= this.maxCacheBytes && this.maxCachedFonts) {
      while (
        this.bytes.size &&
        (this.stats.cachedBytes + data.length > this.maxCacheBytes ||
          this.bytes.size >= this.maxCachedFonts)
      ) {
        const [id, old] = this.bytes.entries().next().value;
        this.bytes.delete(id);
        this.stats.cachedBytes -= old.length;
      }
      this.bytes.set(entry.metadata.id, data);
      this.stats.cachedBytes += data.length;
    }
    return data;
  }
}

module.exports = {
  FontService,
  systemFontDirectories,
  MAX_FONT_BYTES,
  nameMetadata,
};
