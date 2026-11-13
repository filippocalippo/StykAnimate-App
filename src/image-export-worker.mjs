import {errorMessageData, messageError} from './localized-error.mjs';

import { GIFPaletteBuilder } from "./gif-quantize.mjs";
import { APNGEncoder, GIFEncoder, SequenceZIP, validatePNGFrame } from "./image-codecs.mjs";
import {exportContext, checkExportContext} from './export-canvas.mjs';
import {GIFFrames, gifHelpers} from './gif-frames.mjs';

let output, canvas, context, config, paletteBuilder;
/** An animated GIF's first-pass frames, kept for the second (`config.retain`); each is released once encoded. */
let retained = [];
/** An animated GIF's helper workers (`config.helpers`), started with the export so they load during the first pass,
 * and the second pass spread over them. */
let helpers = [], frames = null;
const endHelpers = () => {
  frames?.close();
  for (const helper of helpers) helper.terminate();
  helpers = [];
  frames = null;
};
/** Adds a frame of the second pass: to the helpers when there are some, else here. */
const encodeFrame = (rgba) => (frames ? frames.push(rgba) : output.add(rgba));
let busy = false;
// In streaming mode the encoder's appended bytes are forwarded to the caller
// with every response instead of being retained until finish.
const respond = (id, fields = {}) => {
  const chunk = config?.stream && output ? output.drain() : null;
  self.postMessage({ id, ok: true, ...(chunk ? { output: chunk } : {}), ...fields });
};
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
      if (config.encodedPNG && !["apng", "png-sequence"].includes(config.format))
        throw new Error("Encoded PNG frames require APNG or PNG sequence export.");
      if (config.pixels && !["gif", "gif-sequence"].includes(config.format))
        throw new Error("Pixel frames require GIF or GIF sequence export.");
      retained = [];
      endHelpers();
      if (config.format === "gif" && config.helpers > 0) helpers = gifHelpers(config.helpers);
      if (config.format !== "svg-sequence" && !config.encodedPNG && !config.pixels) {
        canvas = new OffscreenCanvas(config.width, config.height);
        context = exportContext(canvas);
        if (!context) throw messageError(new Error(''), "errors.imageExportWorker.aCanvasImageEncoderIsUnavailable", {});
      }
      const Encoder =
        config.format === "gif"
          ? GIFEncoder
          : config.format === "apng"
            ? APNGEncoder
            : SequenceZIP;
      paletteBuilder = config.format === "gif" ? new GIFPaletteBuilder() : null;
      output = paletteBuilder ? null : new Encoder(config);
      respond(message.id);
    } else if (message.operation === "encode") {
      if (!paletteBuilder || paletteBuilder.frames !== config.totalFrames)
        throw messageError(new Error(''), "errors.imageExportWorker.theGifPaletteAnalysisIsIncomplete", {});
      const palette = paletteBuilder.finish();
      output = new GIFEncoder({ ...config, palette });
      paletteBuilder = null;
      if (helpers.length) {
        frames = new GIFFrames(output, palette, { width: config.width, height: config.height, dither: config.dither, helpers });
        helpers = [];
      }
      respond(message.id);
    } else if (message.operation === "frame") {
      if (!output && !paletteBuilder)
        throw messageError(new Error(''), "errors.imageExportWorker.theImageExportWasNotInitialized", {});
      if (config.encodedPNG) {
        if (!(message.png instanceof Blob) || message.png.type !== "image/png" ||
            !message.png.size || message.png.size > config.maxBytes)
          throw messageError(new Error(''), "errors.imageCodecs.theBrowserDidNotProduceAPngFrame", {});
        const data = new Uint8Array(await message.png.arrayBuffer());
        if (config.format === "png-sequence") validatePNGFrame(data, config.width, config.height);
        output.add(data);
        respond(message.id);
        return;
      }
      if (config.pixels) {
        // Pixels read from the export renderer's canvas: what drawing its bitmap here and reading it back gives.
        let rgba;
        if (message.retained) {
          if (paletteBuilder || !retained.length)
            throw messageError(new Error(''), "errors.imageExportWorker.theImageExportWasNotInitialized", {});
          rgba = retained.shift();
        } else {
          rgba = message.pixels;
          if (!(rgba instanceof Uint8ClampedArray) || rgba.length !== config.width * config.height * 4)
            throw messageError(new Error(''), "errors.imageExportWorker.theRenderedImageFrameHasTheWrongDimensions", {});
        }
        if (config.format === "gif-sequence") {
          const frame = new GIFEncoder({ ...config, totalFrames: 1, loop: false });
          frame.add(rgba);
          output.add(new Uint8Array(await frame.finish().arrayBuffer()));
        } else if (paletteBuilder) {
          paletteBuilder.add(rgba, config.width);
          if (config.retain) retained.push(rgba);
        } else await encodeFrame(rgba);
        respond(message.id);
        return;
      }
      if (config.format === "svg-sequence") {
        const svg =
          message.svg instanceof Blob
            ? message.svg
            : new Blob([message.svg], { type: "image/svg+xml" });
        if (!svg.size || svg.size > config.maxBytes)
          throw messageError(new Error(''), "errors.imageExportWorker.theSvgFrameIsEmptyOrExceedsThe", {});
        const prefix = await svg.slice(0, 1024).text();
        if (!/<svg(?:\s|>)/i.test(prefix))
          throw messageError(new Error(''), "errors.imageExportWorker.theVectorFrameDoesNotContainAnSvg", {});
        output.add(new Uint8Array(await svg.arrayBuffer()));
        respond(message.id);
        return;
      }
      const bitmap = message.bitmap;
      try {
        checkExportContext(context);
        if (bitmap.width !== config.width || bitmap.height !== config.height)
          throw messageError(new Error(''), "errors.imageExportWorker.theRenderedImageFrameHasTheWrongDimensions", {});
        context.clearRect(0, 0, config.width, config.height);
        if (config.format === "jpeg-sequence") {
          context.fillStyle = "#fff";
          context.fillRect(0, 0, config.width, config.height);
        }
        context.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      checkExportContext(context);
      if (config.format === "gif") {
        const rgba = context.getImageData(
          0,
          0,
          config.width,
          config.height,
        ).data;
        if (paletteBuilder) paletteBuilder.add(rgba, config.width);
        else await encodeFrame(rgba);
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
        checkExportContext(context);
        if (encoded.type !== type)
          throw messageError(new Error(''), "errors.imageExportWorker.theBrowserDoesNotSupportImageEncoding", {type: type});
        output.add(new Uint8Array(await encoded.arrayBuffer()));
      }
      respond(message.id);
    } else if (message.operation === "finish") {
      if (!output) throw messageError(new Error(''), "errors.imageExportWorker.theImageExportWasNotInitialized", {});
      await frames?.flush();
      endHelpers();
      if (config.stream) {
        output.finish();
        retained = [];
        if (canvas) canvas.width = canvas.height = 1;
        respond(message.id);
        output = null;
        return;
      }
      const blob = output.finish();
      output = null;
      retained = [];
      if (canvas) canvas.width = canvas.height = 1;
      self.postMessage({ id: message.id, ok: true, blob });
    } else throw messageError(new Error(''), "errors.imageExportWorker.unknownImageExportOperation", {});
  } catch (error) {
    message.bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
    output = paletteBuilder = null;
    retained = [];
    endHelpers();
    self.postMessage({
      id: message.id,
      ok: false,
      error: error?.message || String(error), ...errorMessageData(error),
    });
  } finally {
    busy = false;
  }
});
