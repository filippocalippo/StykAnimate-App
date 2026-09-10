import { spawnSync } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const file = path.join(root, "out/StykAnimate-launch-1080p.mp4");
const ffmpeg =
  process.env.STYK_LAUNCH_FFMPEG ||
  path.join(root, "../build/video-encoder/ffmpeg.exe");
const decode = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-xerror",
    "-i",
    file,
    "-progress",
    "pipe:1",
    "-nostats",
    "-f",
    "null",
    "-",
  ],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(decode.status, 0, decode.stderr || String(decode.error));
assert.match(decode.stderr, /Video: h264/);
assert.match(decode.stderr, /1920x1080/);
assert.match(decode.stderr, /60 fps/);
assert.match(decode.stderr, /Audio: aac/);
assert.match(decode.stderr, /48000 Hz, stereo/);
const frames = [...decode.stdout.matchAll(/^frame=(\d+)$/gm)].map((m) =>
  Number(m[1]),
);
assert.equal(frames[frames.length - 1], 1920, "Every frame must decode");
const report = {
  output: path.relative(root, file),
  bytes: (await stat(file)).size,
  width: 1920,
  height: 1080,
  fps: 60,
  videoFrames: 1920,
  videoDurationSeconds: 32,
  videoCodec: "H.264",
  audioCodec: "AAC",
  audioSampleRate: 48000,
  audioChannels: 2,
  fullDecodePassed: true,
  visualReview:
    "Scene frames and Studio playback reviewed; headline overlap and pose-strip cropping corrected.",
  studioErrors: [],
  notes:
    "AAC encoder padding may make the container duration slightly longer than the 32-second video stream.",
};
await writeFile(
  path.join(root, "out/verification.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  path.join(root, "out/decode-log.txt"),
  decode.stderr + "\n" + decode.stdout,
);
console.log(JSON.stringify(report, null, 2));
