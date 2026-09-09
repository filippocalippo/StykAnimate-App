/** Worker-owned raster originals. Packets receive independent transferable clones.
 * Keys include exact artwork content, crop and resolution; document assets own
 * this cache's lifetime so frame-only revisions can safely keep unchanged pixels. */
export class PlaybackRasterCache {
  constructor({maxBytes = 128 * 1024 * 1024, clone = bitmap => createImageBitmap(bitmap)} = {}) {
    Object.assign(this, {maxBytes, clone});
    this.entries = new Map(); this.bytes = 0; this.disposed = false;
    this.hits = 0; this.misses = 0;
  }
  async packetBitmap(key, rasterize) {
    if (this.disposed) throw new DOMException('Playback rasters were invalidated.', 'AbortError');
    let original = key && this.entries.get(key);
    if (original) {
      this.hits++; this.entries.delete(key); this.entries.set(key, original);
    } else {
      this.misses++; original = rasterize();
      const bytes = original.width * original.height * 4;
      if (!key || bytes > this.maxBytes) return original;
      for (const [oldKey, old] of this.entries) {
        if (this.bytes + bytes <= this.maxBytes) break;
        this.entries.delete(oldKey); this.bytes -= old.width * old.height * 4; old.close();
      }
      this.entries.set(key, original); this.bytes += bytes;
    }
    const packet = await this.clone(original);
    if (this.disposed) { packet.close(); throw new DOMException('Playback rasters were invalidated.', 'AbortError'); }
    return packet;
  }
  dispose() {
    this.disposed = true;
    for (const bitmap of this.entries.values()) bitmap.close();
    this.entries.clear(); this.bytes = 0;
  }
}
