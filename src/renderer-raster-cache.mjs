/** Own editor textures independently of scene entries. Evict only at publication,
 * when the complete next layout is known, never while it is being assembled. */
export class EditorRasterCache {
  constructor({maxBytes = 128 * 1024 * 1024, maxEntries = 1024} = {}) {
    this.maxBytes = Math.max(0, maxBytes);
    this.maxEntries = Math.max(0, maxEntries);
    this.variants = new WeakMap();
    this.history = new WeakMap();
    this.lru = new Map();
    this.bytes = 0;
    this.evictions = 0;
    this.leases = new Set();
  }
  get(artwork, resolution, generation) {
    const resource = this.variants.get(artwork)?.get(`${generation}:${resolution}`);
    if (!resource || resource.destroyed) return undefined;
    const entry = this.lru.get(resource);
    this.lru.delete(resource); this.lru.set(resource, entry);
    return resource;
  }
  previous(artwork) {
    const variants = this.variants.get(artwork);
    return variants?.size ? [...variants.values()].at(-1) : this.history.get(artwork);
  }
  set(artwork, resource) {
    let variants = this.variants.get(artwork);
    if (!variants) this.variants.set(artwork, variants = new Map());
    const key = `${resource.generation}:${resource.resolution}`;
    if (variants.has(key)) throw new Error('An editor raster variant already exists.');
    variants.set(key, resource);
    // Keep only diagnostic scalars after eviction, never a destroyed GPU handle.
    this.history.set(artwork, {resolution: resource.resolution, generation: resource.generation, destroyed: true});
    this.lru.set(resource, {variants, key});
    this.bytes += resource.bytes;
  }
  release(resource, entry) {
    resource.texture.destroy(); resource.destroyed = true;
    entry.variants.delete(entry.key); this.lru.delete(resource);
    this.bytes -= resource.bytes;
  }
  delete(resource) {
    const entry = this.lru.get(resource);
    if (!entry) return false;
    this.release(resource, entry); return true;
  }
  lease(resources=[]) {
    const retained=new Set(resources);this.leases.add(retained);
    return {add:resource=>{if(resource)retained.add(resource);},release:()=>this.leases.delete(retained)};
  }
  retain(active, generation) {
    const protectedResources=new Set(active);
    for(const lease of this.leases)for(const resource of lease)protectedResources.add(resource);
    for (const [resource, entry] of this.lru) {
      if (protectedResources.has(resource)) continue;
      if (resource.generation === generation && this.bytes <= this.maxBytes && this.lru.size <= this.maxEntries) continue;
      this.release(resource, entry); this.evictions++;
    }
    this.stats = {bytes: this.bytes, entries: this.lru.size, activeBytes: [...active].reduce((sum, r) => sum + (r.bytes || 0), 0),
      protectedBytes:[...protectedResources].reduce((sum,r)=>sum+(r.bytes||0),0),leases:this.leases.size,
      maxBytes: this.maxBytes, maxEntries: this.maxEntries, evictions: this.evictions};
  }
  clear() {
    for (const [resource, entry] of this.lru) this.release(resource, entry);
    this.variants = new WeakMap(); this.history = new WeakMap(); this.stats = undefined;
    this.leases.clear();
  }
}
