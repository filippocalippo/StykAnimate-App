/** Resident bytes per CPU/GPU cache. Keep the conservative legacy budget when
 * the runtime has no memory hint. Cap each cache at 1/16 of the reported RAM
 * tier and 512 MiB; explicit constructor budgets always take precedence.
 * Packet sharing makes this a working-set budget, not a per-frame multiplier. */
export function playbackMemoryBudget(deviceMemory=globalThis.navigator?.deviceMemory){
  const mib=1024*1024;
  return typeof deviceMemory==='number'&&Number.isFinite(deviceMemory)&&deviceMemory>0
    ? Math.max(32,Math.min(512,deviceMemory*64))*mib : 128*mib;
}
