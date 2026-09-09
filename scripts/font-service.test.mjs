import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
  open,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { parseTextFont } from "../src/text-authoring.mjs";
import { Font, Glyph, Path } from "../vendor/text/opentype.mjs";
const { FontService, systemFontDirectories, MAX_FONT_BYTES } = createRequire(
  import.meta.url,
)("../desktop/font-service.cjs");
const regular = await readFile(
  new URL("../vendor/text/NotoSans-Regular.ttf", import.meta.url),
);
const bold = await readFile(
  new URL("../vendor/text/NotoSans-Bold.ttf", import.meta.url),
);
const align4 = (value) => Math.ceil(value / 4) * 4;
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stykanimate-fonts-"));
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("stykanimate-fonts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function collection(faces) {
  const header = align4(12 + faces.length * 4),
    out = Buffer.alloc(
      header + faces.reduce((sum, face) => sum + align4(face.length), 0),
    );
  out.write("ttcf");
  out.writeUInt32BE(0x10000, 4);
  out.writeUInt32BE(faces.length, 8);
  let offset = header;
  faces.forEach((face, index) => {
    out.writeUInt32BE(offset, 12 + index * 4);
    face.copy(out, offset);
    for (let table = 0; table < face.readUInt16BE(4); table++) {
      const record = 12 + table * 16;
      out.writeUInt32BE(
        face.readUInt32BE(record + 8) + offset,
        offset + record + 8,
      );
    }
    offset += align4(face.length);
  });
  return out;
}
function replaceTag(bytes, from, to) {
  const out = Buffer.from(bytes);
  for (let index = 0; index < out.readUInt16BE(4); index++) {
    const at = 12 + index * 16;
    if (out.toString("latin1", at, at + 4) === from) {
      out.write(to, at, 4, "latin1");
      break;
    }
  }
  return out;
}
function sum32(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    let value = 0;
    for (let j = 0; j < 4; j++) value = (value << 8) | (bytes[i + j] || 0);
    sum = (sum + (value >>> 0)) >>> 0;
  }
  return sum;
}

test("font roots are confined to conventional OS font directories", () => {
  assert.deepEqual(
    systemFontDirectories({
      platform: "win32",
      env: { SystemRoot: "D:\\Windows", LOCALAPPDATA: "D:\\User\\Local" },
      home: "unused",
    }),
    ["D:\\Windows\\Fonts", "D:\\User\\Local\\Microsoft\\Windows\\Fonts"],
  );
  assert.deepEqual(
    systemFontDirectories({
      platform: "darwin",
      home: "/Users/example",
      env: {},
    }),
    ["/System/Library/Fonts", "/Library/Fonts", "/Users/example/Library/Fonts"],
  );
  assert.deepEqual(
    systemFontDirectories({
      platform: "linux",
      home: "/home/example",
      env: {},
    }),
    [
      "/usr/share/fonts",
      "/usr/local/share/fonts",
      "/home/example/.local/share/fonts",
      "/home/example/.fonts",
    ],
  );
  assert.throws(() => new FontService({ directories: ["relative"] }));
  assert.throws(() => new FontService({ maxFonts: 0 }));
});
test("font names and styles are discovered without exposing paths", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "Regular.ttf"), regular);
  await writeFile(path.join(root, "Bold.ttf"), bold);
  const service = new FontService({ directories: [root] }),
    fonts = await service.listFonts();
  assert.equal(fonts.length, 2);
  assert.deepEqual(
    fonts.map((font) => font.family),
    ["Noto Sans", "Noto Sans"],
  );
  assert.deepEqual(
    fonts.map((font) => font.style),
    ["Bold", "Regular"],
  );
  assert.ok(
    fonts.every(
      (font) => /^font_[a-f0-9]{32}$/.test(font.id) && font.format === "ttf",
    ),
  );
  assert.ok(!JSON.stringify(fonts).includes(root));
  assert.ok(!fonts.some((font) => "path" in font || "filename" in font));
});
test("metadata cache shares concurrent scans and keeps stable immutable IDs", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "Regular.ttf"), regular);
  const service = new FontService({ directories: [root] });
  const [first, concurrent] = await Promise.all([
    service.listFonts(),
    service.listFonts(),
  ]);
  assert.equal(first, concurrent);
  assert.equal(await service.listFonts(), first);
  assert.equal(service.stats.scans, 1);
  assert.throws(() => first.push({}));
  assert.throws(() => (first[0].family = "mutated"));
  const restarted = await new FontService({ directories: [root] }).listFonts();
  assert.equal(restarted[0].id, first[0].id);
});
test("arbitrary paths, forged IDs and non-string input cannot read files", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "Font.ttf"), regular);
  const service = new FontService({ directories: [root] });
  for (const id of [
    path.join(root, "Font.ttf"),
    "../secret",
    "file:///etc/passwd",
    "font_" + "0".repeat(32),
    null,
    {},
    ["font"],
  ])
    await assert.rejects(() => service.readFont(id));
});
test("read cache is bounded and returned bytes cannot mutate the cache", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "Regular.ttf"), regular);
  await writeFile(path.join(root, "Bold.ttf"), bold);
  const service = new FontService({ directories: [root], maxCachedFonts: 1 });
  const fonts = await service.listFonts();
  const first = await service.readFont(fonts[0].id);
  assert.equal(parseTextFont(first).family, "Noto Sans");
  first.fill(0);
  const again = await service.readFont(fonts[0].id);
  assert.notEqual(again.readUInt32BE(0), 0);
  assert.equal(service.stats.fontReads, 1);
  assert.equal(service.stats.readCacheHits, 1);
  await service.readFont(fonts[1].id);
  assert.equal(service.bytes.size, 1);
  assert.ok(service.stats.cachedBytes <= 64 * 1024 * 1024);
  await service.readFont(fonts[0].id);
  assert.equal(service.stats.fontReads, 3);
});
test("parallel reads deduplicate and reject an unbounded request backlog", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "Regular.ttf"), regular);
  const service = new FontService({ directories: [root] });
  const [font] = await service.listFonts();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 24 }, () => service.readFont(font.id)),
  );
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    8,
  );
  assert.equal(service.stats.fontReads, 1);
  assert.equal(service.activeReads, 0);
});
test("TTC faces become independent valid TTFs with corrected offsets and checksums", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "Collection.ttc"),
    collection([regular, bold]),
  );
  const service = new FontService({ directories: [root] }),
    fonts = await service.listFonts();
  assert.equal(fonts.length, 2);
  assert.ok(fonts.every((font) => font.collection));
  for (const font of fonts) {
    const bytes = await service.readFont(font.id);
    assert.equal(bytes.readUInt32BE(0), 0x10000);
    assert.equal(sum32(bytes), 0xb1b0afba);
    const parsed = parseTextFont(bytes);
    assert.equal(parsed.family, "Noto Sans");
    assert.ok(
      parsed.font.charToGlyph("A").getPath(0, 0, 40).commands.length > 10,
    );
    assert.equal(parsed.bold, font.style === "Bold");
  }
});
test("CFF OpenType outlines remain compatible with the existing parser", async (t) => {
  const root = await fixture(t),
    outline = new Path();
  outline.moveTo(0, 0);
  outline.lineTo(300, 700);
  outline.lineTo(600, 0);
  outline.close();
  const font = new Font({
    familyName: "Fixture CFF",
    styleName: "Regular",
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [
      new Glyph({ name: ".notdef", advanceWidth: 600, path: new Path() }),
      new Glyph({ name: "A", unicode: 65, advanceWidth: 600, path: outline }),
    ],
  });
  await writeFile(
    path.join(root, "Fixture.otf"),
    Buffer.from(font.toArrayBuffer()),
  );
  const service = new FontService({ directories: [root] }),
    [record] = await service.listFonts();
  assert.equal(record.format, "otf");
  assert.equal(
    parseTextFont(await service.readFont(record.id))
      .font.charToGlyph("A")
      .getPath(0, 0, 40).commands.length,
    4,
  );
});
test("corrupt names fall back to the filename and invalid outlines are omitted", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "Fallback Name.ttf"),
    replaceTag(regular, "name", "zzzz"),
  );
  await writeFile(
    path.join(root, "Unsupported.ttf"),
    replaceTag(regular, "glyf", "CFF2"),
  );
  await writeFile(path.join(root, "Broken.ttf"), Buffer.alloc(12));
  const [record, ...rest] = await new FontService({
    directories: [root],
  }).listFonts();
  assert.equal(record.family, "Fallback Name");
  assert.equal(record.style, "Regular");
  assert.equal(rest.length, 0);
});
test("oversized files and malformed table bounds are rejected before font loading", async (t) => {
  const root = await fixture(t),
    oversized = await open(path.join(root, "Large.ttf"), "w");
  await oversized.write(regular);
  await oversized.truncate(MAX_FONT_BYTES + 1);
  await oversized.close();
  const malformed = Buffer.from(regular);
  malformed.writeUInt32BE(0xfffffff0, 20);
  await writeFile(path.join(root, "Malformed.ttf"), malformed);
  const service = new FontService({ directories: [root] });
  assert.equal((await service.listFonts()).length, 0);
  assert.equal(service.stats.fontReads, 0);
});
test("folder traversal obeys depth and font limits and excludes external junctions", async (t) => {
  const root = await fixture(t),
    allowed = path.join(root, "fonts"),
    outside = path.join(root, "other");
  await mkdir(allowed);
  await mkdir(outside);
  await mkdir(path.join(allowed, "deep"));
  await writeFile(path.join(allowed, "one.ttf"), regular);
  await writeFile(path.join(allowed, "deep", "two.ttf"), bold);
  await writeFile(path.join(outside, "three.ttf"), regular);
  await symlink(
    outside,
    path.join(allowed, "external"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const service = new FontService({ directories: [allowed], maxDepth: 0 });
  assert.equal((await service.listFonts()).length, 1);
  assert.equal(
    (await new FontService({ directories: [allowed], maxFonts: 1 }).listFonts())
      .length,
    1,
  );
  assert.equal(
    (await new FontService({ directories: [allowed] }).listFonts()).length,
    2,
  );
});
test("changed or removed fonts cannot silently read a different file", async (t) => {
  const root = await fixture(t),
    file = path.join(root, "Font.ttf");
  await writeFile(file, regular);
  const service = new FontService({ directories: [root] }),
    [font] = await service.listFonts();
  await writeFile(file, bold);
  await assert.rejects(() => service.readFont(font.id), /changed/);
  await rm(file);
  await assert.rejects(() => service.readFont(font.id));
});
test(
  "real Windows TTF and collection faces produce text outlines",
  { skip: process.platform !== "win32" },
  async () => {
    const service = new FontService(),
      fonts = await service.listFonts();
    assert.ok(fonts.length > 20);
    const selection = [
      fonts.find((font) => font.family === "Arial" && font.style === "Regular"),
      fonts.find((font) => font.collection && font.family === "Cambria"),
    ];
    assert.ok(selection.every(Boolean));
    for (const font of selection) {
      const bytes = await service.readFont(font.id);
      assert.ok(bytes.length < MAX_FONT_BYTES);
      assert.ok(
        parseTextFont(bytes).font.charToGlyph("A").getPath(0, 0, 48).commands
          .length > 0,
      );
    }
    assert.equal((await service.listFonts()).length, fonts.length);
    assert.equal(service.stats.scans, 1);
  },
);
