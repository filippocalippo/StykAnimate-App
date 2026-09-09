import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  mkdir,
} from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const {
  VideoExportService,
  PNGFrameValidator,
  validateConfig,
  encoderArguments,
  MAX_CHUNK_BYTES,
} = createRequire(import.meta.url)("../desktop/video-export-service.cjs");
const encoderPath = path.resolve(
  process.env.STYK_FFMPEG ||
    `build/video-encoder/ffmpeg${process.platform === "win32" ? ".exe" : ""}`,
);
const defaults = {
  format: "mp4",
  width: 32,
  height: 24,
  fps: 6,
  totalFrames: 6,
  quality: 1,
  maxBytes: 4 * 1024 * 1024,
};
const crcTable = Uint32Array.from({ length: 256 }, (_, c) => {
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buffer) => {
  let c = 0xffffffff;
  for (const b of buffer) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, -4)), out.length - 4);
  return out;
}
function png(width, height, color) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * (width * 4 + 1) + 1 + x * 4,
        rgb = typeof color === "function" ? color(x, y) : color;
      pixels[p] = rgb[0];
      pixels[p + 1] = rgb[1];
      pixels[p + 2] = rgb[2];
      pixels[p + 3] = rgb[3] ?? 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stykanimate-video-test-"));
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("stykanimate-video-test-"));
  const service = new VideoExportService({
    encoderPath,
    tempRoot: path.join(root, "jobs"),
    ...options,
  });
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { service, root };
}
async function frame(service, token, index, bytes) {
  await service.beginFrame(token, { index, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES)
    await service.writeFrameChunk(
      token,
      bytes.subarray(offset, offset + MAX_CHUNK_BYTES),
    );
  await service.endFrame(token);
}
async function encode(service, config, colorAt) {
  const started = performance.now(),
    session = await service.begin(config);
  for (let index = 0; index < config.totalFrames; index++)
    await frame(
      service,
      session.token,
      index,
      png(
        config.width,
        config.height,
        colorAt
          ? (x, y) => colorAt(x, y, index)
          : index % 2
            ? [20, 60, 230]
            : [230, 30, 20],
      ),
    );
  const info = await service.finish(session.token),
    chunks = [];
  for (;;) {
    const part = await service.read(session.token);
    assert.ok(part.bytes.byteLength <= MAX_CHUNK_BYTES);
    chunks.push(Buffer.from(part.bytes));
    if (part.done) break;
  }
  return {
    ...info,
    bytes: Buffer.concat(chunks),
    elapsedMs: performance.now() - started,
  };
}
function decode(filename, {alpha=false}={}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
        encoderPath,
        [
          "-hide_banner",
          ...(alpha?["-c:v","libvpx-vp9"]:[]),
          "-i",
          filename,
          "-an",
          "-sn",
          "-dn",
          "-f",
          "rawvideo",
          "-pix_fmt",
          alpha ? "rgba" : "rgb24",
          "-fps_mode",
          "passthrough",
          "pipe:1",
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      ),
      buffers = [];
    let details = "";
    child.stdout.on("data", (b) => buffers.push(b));
    child.stderr.on("data", (b) => (details += b.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({ bytes: Buffer.concat(buffers), details })
        : reject(new Error(details)),
    );
  });
}

test("missing encoder has explicit portable capability failures", async () => {
  const service = new VideoExportService();
  const capabilities = await service.capabilities();
  assert.equal(capabilities.available, false);
  assert.ok(
    capabilities.formats.every(
      (f) => !f.supported && f.reason.includes("WebM"),
    ),
  );
  await assert.rejects(
    () => service.begin(defaults),
    /working native video encoder/,
  );
});
test("native formats and one-pixel video padding are advertised accurately", async (t) => {
  const { service } = await fixture(t);
  const caps = await service.capabilities({ width: 31, height: 23 });
  assert.deepEqual(
    caps.formats.map((f) => [f.id, f.supported]),
    [
      ["webm", true],
      ["mp4", true],
      ["avi", true],
      ["wmv", true],
    ],
  );
  assert.ok(caps.version.includes("ffmpeg version"));
  assert.deepEqual(
    caps.formats.map((format) => [
      format.id,
      format.defaultCodec,
      format.codecs.map((codec) => codec.id),
    ]),
    [
      ["webm", "vp9", ["vp9"]],
      ["mp4", "h264", ["h264", "mpeg4"]],
      ["avi", "mpeg4", ["mpeg4", "ffv1", "rawvideo"]],
      ["wmv", "wmv2", ["wmv2"]],
    ],
  );
  for (const codec of caps.formats.flatMap((format) => format.codecs)) {
    assert.equal(codec.supported, true);
    assert.equal(codec.quality, !codec.lossless);
    assert.equal(codec.encodedWidth, codec.lossless || codec.alpha ? 31 : 32);
    assert.equal(codec.encodedHeight, codec.lossless || codec.alpha ? 23 : 24);
    assert.equal(Boolean(codec.notice), !codec.lossless && !codec.alpha);
  }
  assert.ok(
    caps.formats.filter(f=>f.id!=="webm").every(
      (f) =>
        f.encodedWidth === 32 &&
        f.encodedHeight === 24 &&
        f.notice.includes("right and bottom"),
    ),
  );
});
test("invalid dimensions, frame rate, quality, formats and injected arguments are rejected", () => {
  for (const patch of [
    { format: "mp4;rm" },
    { codec: "libx264" },
    { codec: "ffv1" },
    { codec: "h264 -i anything" },
    { codec: null },
    { codec: "__proto__" },
    { format: "wmv", codec: "h264" },
    { format: "avi", codec: "h264" },
    { width: NaN },
    { width: 1.5 },
    { width: 16384, height: 16384 },
    { fps: Infinity },
    { fps: 0 },
    { totalFrames: 0 },
    { quality: 2 },
    { bitrate: 200000001 },
    { maxBytes: 2 ** 40 },
  ])
    assert.throws(() => validateConfig({ ...defaults, ...patch }));
});
test("PNG validation works across every byte boundary without accumulating a frame", () => {
  const bytes = png(7, 5, [200, 100, 40]),
    validator = new PNGFrameValidator({
      width: 7,
      height: 5,
      size: bytes.length,
    });
  for (const byte of bytes) validator.push(Buffer.from([byte]));
  validator.finish();
  assert.equal(validator.position, bytes.length);
  assert.ok(validator.buffer.length <= 8);
});
test("PNG validator rejects CRC corruption, dimensions, animations, trailing images and truncation", () => {
  const valid = png(7, 5, [200, 100, 40]),
    bad = Buffer.from(valid);
  bad[bad.length - 1] ^= 1;
  for (const bytes of [
    bad,
    Buffer.concat([valid, valid]),
    Buffer.concat([
      valid.subarray(0, 33),
      chunk("acTL", Buffer.alloc(8)),
      valid.subarray(33),
    ]),
    valid.subarray(0, -2),
  ]) {
    const validator = new PNGFrameValidator({
      width: 7,
      height: 5,
      size: bytes.length,
    });
    assert.throws(() => {
      validator.push(bytes);
      validator.finish();
    });
  }
  const wrong = new PNGFrameValidator({
    width: 8,
    height: 5,
    size: valid.length,
  });
  assert.throws(() => wrong.push(valid), /dimensions/);
});
test("all six MP4, AVI and WMV codec choices decode to every expected frame with correct artwork", async (t) => {
  const { service, root } = await fixture(t),
    evidence = [];
  for (const [format, codec] of [
    ["mp4", "h264"],
    ["mp4", "mpeg4"],
    ["avi", "mpeg4"],
    ["avi", "ffv1"],
    ["avi", "rawvideo"],
    ["wmv", "wmv2"],
  ]) {
    const result = await encode(service, { ...defaults, format, codec });
    assert.equal(result.codec, codec);
    const filename = path.join(root, `actual-${codec}.${format}`);
    await writeFile(filename, result.bytes);
    const decoded = await decode(filename),
      frameBytes = 32 * 24 * 3;
    assert.equal(decoded.bytes.length, frameBytes * 6);
    for (let i = 0; i < 6; i++) {
      const offset = i * frameBytes + Math.floor(24 / 2) * 32 * 3 + 16 * 3;
      const r = decoded.bytes[offset],
        b = decoded.bytes[offset + 2];
      assert.ok(
        i % 2 ? b > r + 120 : r > b + 120,
        `${format}/${codec} frame ${i} artwork`,
      );
    }
    assert.match(decoded.details, new RegExp(`Video: ${codec}`));
    evidence.push({
      format,
      size: result.size,
      frames: 6,
      codec,
      elapsedMs: result.elapsedMs,
    });
    assert.equal(service.jobs.size, 0);
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/native-video-service-decode.json",
    JSON.stringify({ passed: true, evidence }, null, 2),
  );
  assert.deepEqual(await readdir(path.join(root, "jobs")), []);
});

test("lossless AVI preserves every RGB channel and exact odd or one-pixel dimensions", async (t) => {
  const { service, root } = await fixture(t),
    evidence = [];
  const colorAt = (x, y, frame) => [
    (x * 17 + y * 11 + frame * 71) % 256,
    (x * 73 + y * 23 + frame * 47) % 256,
    (x * 41 + y * 59 + frame * 13) % 256,
  ];
  for (const codec of ["ffv1", "rawvideo"]) {
    for (const [width, height] of [
      [1, 1],
      [1, 7],
      [7, 1],
      [3, 3],
      [31, 23],
      [32, 24],
    ]) {
      const totalFrames = 3;
      const result = await encode(
        service,
        { ...defaults, format: "avi", codec, width, height, totalFrames },
        colorAt,
      );
      assert.equal(result.width, width);
      assert.equal(result.height, height);
      const filename = path.join(root, `${codec}-${width}x${height}.avi`);
      await writeFile(filename, result.bytes);
      const decoded = await decode(filename);
      const expected = Buffer.alloc(width * height * 3 * totalFrames);
      for (let frame = 0; frame < totalFrames; frame++)
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            expected.set(
              colorAt(x, y, frame),
              ((frame * height + y) * width + x) * 3,
            );
      assert.deepEqual(
        decoded.bytes,
        expected,
        `${codec} ${width}×${height} exact RGB pixels`,
      );
      evidence.push({
        codec,
        width,
        height,
        totalFrames,
        channelsCompared: expected.length,
        exact: true,
        size: result.size,
      });
    }
  }
  await writeFile(
    "artifacts/native-video-service-lossless.json",
    JSON.stringify({ passed: true, evidence }, null, 2),
  );
});

test("codec-specific encoder settings keep lossless RGB independent of lossy quality and tags", () => {
  for (const codec of ["ffv1", "rawvideo"]) {
    const config = validateConfig({
      ...defaults,
      format: "avi",
      codec,
      width: 31,
      height: 23,
      quality: 0,
      bitrate: 1000,
    });
    const args = encoderArguments(config, "test.avi");
    assert.equal(
      args[args.indexOf("-pix_fmt") + 1],
      codec === "ffv1" ? "bgr0" : "bgr24",
    );
    for (const option of ["-vf", "-q:v", "-crf", "-b:v", "-vtag", "-preset"])
      assert.equal(args.includes(option), false);
  }
  const args = encoderArguments(
    validateConfig({ ...defaults, codec: "mpeg4" }),
    "test.mp4",
  );
  assert.equal(args[args.lastIndexOf("-c:v") + 1], "mpeg4");
  assert.equal(args.includes("-preset"), false);
  assert.equal(args.includes("-q:v"), true);
  assert.equal(args.includes("+faststart"), true);
});
test("odd canvases encode at the declared padded dimensions", async (t) => {
  const { service, root } = await fixture(t);
  const result = await encode(service, {
    ...defaults,
    width: 31,
    height: 23,
    totalFrames: 2,
  });
  assert.equal(result.width, 32);
  assert.equal(result.height, 24);
  const file = path.join(root, "odd.mp4");
  await writeFile(file, result.bytes);
  assert.equal((await decode(file)).bytes.length, 32 * 24 * 3 * 2);
});
test("one job and sequential frame chunks provide explicit backpressure", async (t) => {
  const { service } = await fixture(t);
  const first = service.begin(defaults);
  await assert.rejects(() => service.begin(defaults), /current video/);
  const { token } = await first,
    bytes = png(32, 24, [250, 20, 20]);
  await service.beginFrame(token, { index: 0, size: bytes.length });
  const writing = service.writeFrameChunk(token, bytes);
  await assert.rejects(
    () => service.writeFrameChunk(token, bytes),
    /previous video chunk/,
  );
  await writing;
  await service.endFrame(token);
  await service.cancel(token);
  assert.equal(service.jobs.size, 0);
});
test("incomplete exports and frame order errors stop the process and remove temporary files", async (t) => {
  const { service, root } = await fixture(t);
  let { token } = await service.begin(defaults);
  await assert.rejects(
    () => service.beginFrame(token, { index: 2, size: 100 }),
    /sequence/,
  );
  assert.equal(service.jobs.size, 0);
  ({ token } = await service.begin(defaults));
  await assert.rejects(() => service.finish(token), /every video frame/);
  assert.equal(service.jobs.size, 0);
  assert.deepEqual(await readdir(path.join(root, "jobs")), []);
});
test("cancellation removes a partially streamed PNG and returns immediately on repeated cancel", async (t) => {
  const { service, root } = await fixture(t),
    { token } = await service.begin(defaults),
    bytes = png(32, 24, [1, 2, 3]);
  await service.beginFrame(token, { index: 0, size: bytes.length });
  await service.writeFrameChunk(token, bytes.subarray(0, 16));
  assert.deepEqual(await service.cancel(token), { cancelled: true });
  assert.deepEqual(await service.cancel(token), { cancelled: false });
  assert.deepEqual(await readdir(path.join(root, "jobs")), []);
});
test("oversized chunks and malformed PNG frames cancel rather than feeding arbitrary data", async (t) => {
  const { service } = await fixture(t);
  let { token } = await service.begin(defaults);
  await service.beginFrame(token, { index: 0, size: MAX_CHUNK_BYTES + 1 });
  await assert.rejects(
    () => service.writeFrameChunk(token, Buffer.alloc(MAX_CHUNK_BYTES + 1)),
    /256 KiB/,
  );
  ({ token } = await service.begin(defaults));
  await service.beginFrame(token, { index: 0, size: 100 });
  await assert.rejects(
    () => service.writeFrameChunk(token, Buffer.alloc(100)),
    /PNG/,
  );
  assert.equal(service.jobs.size, 0);
});
test("encoded size limits reject partial videos and clean the output", async (t) => {
  const { service, root } = await fixture(t);
  await assert.rejects(
    () => encode(service, { ...defaults, maxBytes: 1024 }),
    /size limit|encoding failed|encoder stopped/i,
  );
  assert.equal(service.jobs.size, 0);
  assert.deepEqual(await readdir(path.join(root, "jobs")), []);
});
test("idle jobs expire and dispose cancels unconsumed output", async (t) => {
  const { service, root } = await fixture(t, { ttlMs: 30 });
  await service.begin(defaults);
  for (let i = 0; i < 50 && service.jobs.size; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.jobs.size, 0);
  assert.deepEqual(await readdir(path.join(root, "jobs")), []);
});
test("large PNG frames and finished videos both stay within chunk bounds", async (t) => {
  const { service } = await fixture(t);
  let seed = 1;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
  };
  const bytes = png(1024, 512, noise);
  assert.ok(bytes.length > MAX_CHUNK_BYTES * 4);
  const { token } = await service.begin({
    ...defaults,
    width: 1024,
    height: 512,
    totalFrames: 1,
  });
  await frame(service, token, 0, bytes);
  const info = await service.finish(token);
  assert.ok(info.size > MAX_CHUNK_BYTES);
  let chunks = 0,
    total = 0;
  for (;;) {
    const part = await service.read(token);
    assert.ok(part.bytes.byteLength <= MAX_CHUNK_BYTES);
    total += part.bytes.byteLength;
    chunks++;
    if (part.done) break;
  }
  assert.ok(chunks > 1);
  assert.equal(total, info.size);
});
test("cancelling an in-flight write releases backpressure and removes its temp file", async (t) => {
  const { service, root } = await fixture(t);
  const { token } = await service.begin(defaults),
    bytes = png(32, 24, [50, 60, 70]);
  await service.beginFrame(token, { index: 0, size: bytes.length });
  const writing = service.writeFrameChunk(token, bytes),
    cancellation = service.cancel(token);
  const results = await Promise.allSettled([writing, cancellation]);
  assert.equal(results[1].status, "fulfilled");
  assert.equal(service.jobs.size, 0);
  assert.deepEqual(await readdir(path.join(root, "jobs")), []);
});
test("dispose closes an unconsumed completed video and deletes its temporary output", async (t) => {
  const { service, root } = await fixture(t);
  const { token } = await service.begin({ ...defaults, totalFrames: 1 });
  await frame(service, token, 0, png(32, 24, [50, 60, 70]));
  await service.finish(token);
  await service.dispose();
  assert.equal(service.jobs.size, 0);
  assert.deepEqual(await readdir(path.join(root, "jobs")), []);
});


test("native WebM retains transparent, semitransparent and opaque pixels at odd dimensions", async(t)=>{
  const {service,root}=await fixture(t), config={...defaults,format:'webm',codec:'vp9',width:65,height:33,quality:1,bitrate:8000000,totalFrames:4,fps:8};
  const result=await encode(service,config,(x,y,index)=>[190,80,35,x<20?0:x<43?128:255]);
  const file=path.join(root,'transparent.webm');await writeFile(file,result.bytes);
  await mkdir('artifacts/webm-alpha',{recursive:true});await writeFile('artifacts/webm-alpha/native-alpha.webm',result.bytes);
  const decoded=await decode(file,{alpha:true}),frameBytes=config.width*config.height*4;
  assert.equal(decoded.bytes.length,frameBytes*config.totalFrames);assert.match(decoded.details,/alpha_mode\s*:\s*1/);
  const observed=[];
  for(let tick=0;tick<config.totalFrames;tick++)for(const [x,alpha] of [[10,0],[30,128],[55,255]]){
    const value=decoded.bytes[tick*frameBytes+(16*config.width+x)*4+3];
    assert.equal(value,alpha);observed.push({tick,x,alpha:value});
  }
  await mkdir('artifacts/webm-alpha',{recursive:true});await writeFile('artifacts/webm-alpha/native-alpha.webm',result.bytes);
  await writeFile('artifacts/webm-alpha/service-report.json',JSON.stringify({passed:true,width:config.width,height:config.height,frames:config.totalFrames,fps:config.fps,observed},null,2));
});
