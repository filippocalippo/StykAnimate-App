import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import backend from "../desktop/backend.cjs";
const output = path.resolve("artifacts/gif-dithering");
await mkdir(output, { recursive: true });
const service = await backend.startBackend({ appRoot: process.cwd() });
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(service.origin + "/api/health");
  const result = await page.evaluate(async () => {
    const { exportAnimation } = await import("/src/image-export.mjs"),
      { gifFixture } = await import("/tests/gif-fixtures.mjs");
    const checks = [],
      files = [],
      sources = [],
      metrics = [];
    const check = (name, ok) => {
      if (!ok) throw new Error(name);
      checks.push(name);
    };
    for (const kind of ["gradient", "sprite", "grayscale"]) {
      const width = kind === "grayscale" ? 256 : 256,
        height = kind === "grayscale" ? 16 : 128,
        data = gifFixture(kind, width, height);
      sources.push({ name: kind + ".rgba", bytes: [...data], width, height });
      const canvas = new OffscreenCanvas(width, height),
        context = canvas.getContext("2d");
      context.putImageData(new ImageData(data, width, height), 0, 0);
      for (const dither of [false, true]) {
        const progress = [],
          calls = [];
        const start = performance.now();
        const blob = await exportAnimation({
          format: "gif",
          width,
          height,
          fps: 24,
          totalFrames: 1,
          dither,
          renderFrame: (i) => {
            calls.push(i);
            return canvas;
          },
          onProgress: (value) => progress.push(value),
        });
        check(
          kind + " " + dither + " runs palette then encoding pass",
          calls.length === 2 &&
            progress.length === 2 &&
            progress[0].phase === "palette" &&
            progress[1].phase === "encode" &&
            progress[1].completed === 2 &&
            progress[1].total === 2,
        );
        files.push({
          name: kind + "-" + (dither ? "on" : "off") + ".gif",
          bytes: [...new Uint8Array(await blob.arrayBuffer())],
        });
        metrics.push({
          kind,
          dither,
          bytes: blob.size,
          elapsedMs: performance.now() - start,
        });
      }
    }
    const width = 192,
      height = 96,
      canvas = new OffscreenCanvas(width, height),
      context = canvas.getContext("2d"),
      calls = [],
      progress = [];
    const renderFrame = (i) => {
      calls.push(i);
      context.putImageData(
        new ImageData(
          gifFixture("gradient", width, height, i === 1 ? 1 : 0),
          width,
          height,
        ),
        0,
        0,
      );
      return canvas;
    };
    const blob = await exportAnimation({
      format: "gif",
      width,
      height,
      fps: 24,
      totalFrames: 3,
      dither: true,
      loop: false,
      renderFrame,
      onProgress: (v) => progress.push(v),
    });
    check(
      "animation keeps deterministic frame order in both passes",
      JSON.stringify(calls) === "[0,1,2,0,1,2]",
    );
    check(
      "two-pass progress reaches its exact total",
      progress.length === 6 &&
        progress.at(-1).completed === 6 &&
        progress.at(-1).progress === 1,
    );
    files.push({
      name: "movement.gif",
      bytes: [...new Uint8Array(await blob.arrayBuffer())],
    });
    const sequence = await exportAnimation({
      format: "gif-sequence",
      width,
      height,
      fps: 24,
      totalFrames: 3,
      dither: true,
      renderFrame,
    });
    files.push({
      name: "sequence.zip",
      bytes: [...new Uint8Array(await sequence.arrayBuffer())],
    });
    check("GIF sequence retains one render pass", calls.length === 9);
    for (const phase of ["palette", "encode"]) {
      const controller = new AbortController();
      let reason;
      try {
        await exportAnimation({
          format: "gif",
          width,
          height,
          fps: 24,
          totalFrames: 3,
          dither: true,
          renderFrame,
          signal: controller.signal,
          onProgress: (value) => {
            if (value.phase === phase) controller.abort();
          },
        });
      } catch (e) {
        reason = e.name;
      }
      check(phase + " cancellation terminates worker", reason === "AbortError");
    }
    return { checks, files, sources, metrics };
  });
  if (errors.length) throw new Error(errors.join("\n"));
  for (const file of [...result.files, ...result.sources])
    await writeFile(path.join(output, file.name), Uint8Array.from(file.bytes));
  const report = {
    checks: result.checks,
    metrics: result.metrics,
    sources: result.sources.map(({ bytes, ...source }) => source),
    errors,
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ checks: report.checks.length, errors }));
} finally {
  await browser?.close();
  await service.stop();
}
