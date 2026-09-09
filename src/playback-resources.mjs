import { RasterSurfacePool } from "./raster-surfaces.mjs";
import { PlaybackRasterCache } from './playback-raster-cache.mjs';

const assetURL = (a) =>
  a?.asset_url ||
  a?.data_url ||
  a?.url ||
  (a?.base64
    ? `data:${a.mime_type || "image/png"};base64,${a.base64}`
    : null) ||
  a?.asset_path_relative ||
  a?.asset_path ||
  a?.path;

/** Worker-owned decoded assets. Figure and background pixels never cross the UI thread to decode. */
export class PlaybackResources {
  constructor({
    baseURL = globalThis.location?.href,
    token = "",
    maxBytes = 96 * 1024 * 1024,
    maxPacketBytes = 128 * 1024 * 1024,
  } = {}) {
    Object.assign(this, { baseURL, token, maxBytes });
    this.images = new Map();
    this.bytes = 0;
    this.disposed = false;
    this.rasterSurfaces = new RasterSurfacePool();
    this.artworkBitmaps = new PlaybackRasterCache({maxBytes: Math.min(128 * 1024 * 1024, maxPacketBytes)});
    this.geometryDescriptors = new WeakMap();
  }
  url = assetURL;
  image = (url) => {
    const image = this.images.get(url);
    if (image) {
      this.images.delete(url);
      this.images.set(url, image);
    }
    return image;
  };
  async preload(items) {
    const needed = new Set(
      items
        .filter((s) => s.type === "image")
        .map((s) => this.url(s.asset))
        .filter(Boolean),
    );
    for (const url of needed) {
      if (this.images.has(url)) continue;
      const resolved = new URL(url, this.baseURL),
        headers = {};
      if (this.token && resolved.origin === new URL(this.baseURL).origin)
        headers.Authorization = `Bearer ${this.token}`;
      const response = await fetch(resolved, { headers });
      if (!response.ok)
        throw new Error(`Playback image could not load (${response.status}).`);
      const bitmap = await createImageBitmap(await response.blob());
      if (this.disposed) {
        bitmap.close();
        throw new DOMException(
          "Playback assets were invalidated.",
          "AbortError",
        );
      }
      const decodedBytes = bitmap.width * bitmap.height * 4;
      for (const [oldURL, old] of this.images) {
        if (this.bytes + decodedBytes <= this.maxBytes) break;
        if (needed.has(oldURL)) continue;
        this.images.delete(oldURL);
        this.bytes -= old.width * old.height * 4;
        old.close();
      }
      if (this.bytes + decodedBytes > this.maxBytes) {
        bitmap.close();
        throw new Error(
          "A playback figure exceeds the decoded asset memory budget.",
        );
      }
      // Native drawGeometry deliberately accepts the same image contract in both contexts.
      bitmap.complete = true;
      bitmap.naturalWidth = bitmap.width;
      bitmap.naturalHeight = bitmap.height;
      this.images.set(url, bitmap);
      this.bytes += decodedBytes;
    }
  }
  dispose() {
    this.disposed = true;
    for (const image of this.images.values()) image.close();
    this.images.clear();
    this.bytes = 0;
    this.rasterSurfaces.dispose();
    this.artworkBitmaps.dispose();
  }
}
