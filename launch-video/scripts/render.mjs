import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { getCompositions, renderStill, renderMedia } from "@remotion/renderer";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "out");
await mkdir(path.join(out, "review"), { recursive: true });
const browserExecutable =
  process.env.REMOTION_BROWSER_EXECUTABLE ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const serveUrl = await bundle({
  entryPoint: path.join(root, "src/index.ts"),
  outDir: path.join(root, "build"),
  rspack: false,
  onProgress: (p) => {
    if (p === 100) console.log("Bundle complete");
  },
});
const compositions = await getCompositions(serveUrl, { browserExecutable });
const composition = compositions.find((c) => c.id === "StykAnimate-Launch");
if (!composition || composition.durationInFrames !== 1920)
  throw new Error("Unexpected composition metadata");
await writeFile(
  path.join(out, "composition.json"),
  JSON.stringify(composition, null, 2),
);
console.log(
  `Composition validated: ${composition.width}x${composition.height}, ${composition.fps}fps, ${composition.durationInFrames} frames`,
);

if (process.argv.includes("--stills")) {
  const frames = [
    12, 38, 62, 112, 205, 335, 495, 610, 792, 917, 1045, 1109, 1173, 1320, 1560,
    1790, 1919,
  ];
  for (let i = 0; i < frames.length; i += 3) {
    await Promise.all(
      frames.slice(i, i + 3).map(async (frame) => {
        await renderStill({
          serveUrl,
          composition,
          browserExecutable,
          frame,
          output: path.join(
            out,
            "review",
            `${String(frame).padStart(4, "0")}.png`,
          ),
          scale: 0.5,
        });
        console.log(`Reviewed frame ${frame}`);
      }),
    );
  }
} else {
  const preview = process.argv.includes("--preview");
  const outputLocation = path.join(
    out,
    preview ? "StykAnimate-launch-preview.mp4" : "StykAnimate-launch-1080p.mp4",
  );
  let milestone = -1;
  await renderMedia({
    serveUrl,
    composition,
    browserExecutable,
    codec: "h264",
    outputLocation,
    scale: preview ? 0.5 : 1,
    crf: preview ? 23 : 16,
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioBitrate: "320k",
    concurrency: 4,
    overwrite: true,
    onProgress: ({ progress }) => {
      const next = Math.floor(progress * 20);
      if (next > milestone) {
        milestone = next;
        console.log(`Render ${next * 5}%`);
      }
    },
  });
  console.log(`Saved ${outputLocation}`);
}
