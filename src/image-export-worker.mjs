import { GIFPaletteBuilder } from "./gif-quantize.mjs";
import { APNGEncoder, GIFEncoder, SequenceZIP } from "./image-codecs.mjs";

let output, canvas, context, config, paletteBuilder;
let busy = false;
self.addEventListener("message", async (event) => {
  const message = event.data;
  if (busy) {
    self.postMessage({
      id: message.id,
      ok: false,
      error: "The image export worker is busy.",
    });
    return;
  }
  busy = true;
  try {
    if (message.operation === "start") {
      config = message.config;
      if (config.format !== "svg-sequence") {
        canvas = new OffscreenCanvas(config.width, config.height);
        context = canvas.getContext("2d", {
          willReadFrequently:
            config.format === "gif" || config.format === "gif-sequence",
        });
        if (!context) throw new Error("A canvas image encoder is unavailable.");
      }
      const Encoder =
        config.format === "gif"
          ? GIFEncoder
          : config.format === "apng"
            ? APNGEncoder
            : SequenceZIP;
      paletteBuilder = config.format === "gif" ? new GIFPaletteBuilder() : null;
      output = paletteBuilder ? null : new Encoder(config);
      self.postMessage({ id: message.id, ok: true });
    } else if (message.operation === "encode") {
      if (!paletteBuilder || paletteBuilder.frames !== config.totalFrames)
        throw new Error("The GIF palette analysis is incomplete.");
      output = new GIFEncoder({ ...config, palette: paletteBuilder.finish() });
      paletteBuilder = null;
      self.postMessage({ id: message.id, ok: true });
    } else if (message.operation === "frame") {
      if (!output && !paletteBuilder)
        throw new Error("The image export was not initialized.");
      if (config.format === "svg-sequence") {
        const svg =
          message.svg instanceof Blob
            ? message.svg
            : new Blob([message.svg], { type: "image/svg+xml" });
        if (!svg.size || svg.size > config.maxBytes)
          throw new Error(
            "The SVG frame is empty or exceeds the configured size limit.",
          );
        const prefix = await svg.slice(0, 1024).text();
        if (!/<svg(?:\s|>)/i.test(prefix))
          throw new Error("The vector frame does not contain an SVG document.");
        output.add(new Uint8Array(await svg.arrayBuffer()));
        self.postMessage({ id: message.id, ok: true });
        return;
      }
      const bitmap = message.bitmap;
      try {
        if (bitmap.width !== config.width || bitmap.height !== config.height)
          throw new Error("The rendered image frame has the wrong dimensions.");
        context.clearRect(0, 0, config.width, config.height);
        if (config.format === "jpeg-sequence") {
          context.fillStyle = "#fff";
          context.fillRect(0, 0, config.width, config.height);
        }
        context.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      if (config.format === "gif") {
        const rgba = context.getImageData(
          0,
          0,
          config.width,
          config.height,
        ).data;
        if (paletteBuilder) paletteBuilder.add(rgba, config.width);
        else output.add(rgba);
      } else if (config.format === "gif-sequence") {
        const frame = new GIFEncoder({
          ...config,
          totalFrames: 1,
          loop: false,
        });
        frame.add(context.getImageData(0, 0, config.width, config.height).data);
        output.add(new Uint8Array(await frame.finish().arrayBuffer()));
      } else {
        const type =
          config.format === "jpeg-sequence" ? "image/jpeg" : "image/png";
        const encoded = await canvas.convertToBlob({
          type,
          quality: config.quality,
        });
        if (encoded.type !== type)
          throw new Error(
            `The browser does not support ${type} image encoding.`,
          );
        output.add(new Uint8Array(await encoded.arrayBuffer()));
      }
      self.postMessage({ id: message.id, ok: true });
    } else if (message.operation === "finish") {
      if (!output) throw new Error("The image export was not initialized.");
      const blob = output.finish();
      output = null;
      self.postMessage({ id: message.id, ok: true, blob });
    } else throw new Error("Unknown image export operation.");
  } catch (error) {
    output = paletteBuilder = null;
    self.postMessage({
      id: message.id,
      ok: false,
      error: error?.message || String(error),
    });
  } finally {
    busy = false;
  }
});
