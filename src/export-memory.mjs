import {messageError} from './localized-error.mjs';
import {exportSamplingSize} from './export-sampling.mjs';
import {deviceMemoryHint} from './playback-budget.mjs';

const MiB = 1024 * 1024;
/** Upper bound on the export-owned pixel working set. Real budgets scale with
 * the device-RAM hint; this ceiling only stops runaway reservations. */
const EXPORT_MAX_WORKING_BYTES = 2048 * MiB;
/** Smallest decoded-image allowance a tile can usefully work with. */
export const EXPORT_MIN_ASSET_BYTES = 4 * MiB;
/** A conservative allowance for export-owned pixels, not a measurement of free RAM.
 * The plan never refuses legal output dimensions: the device hint is a target,
 * while the floor is what one output frame, one tile and the minimum asset
 * working set genuinely require. A frame that exceeds the hint simply uses more
 * of the machine it is running on — export must finish, not refuse. */
export function exportMemoryPlan(width, height, smoothing = 'edges', {
  deviceMemory = deviceMemoryHint(), maxWorkingBytes,
} = {}) {
  const sampling = exportSamplingSize(width, height, smoothing);
  const tier = Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory : 4;
  const requested = maxWorkingBytes ?? Math.max(64, Math.min(EXPORT_MAX_WORKING_BYTES / MiB, tier * 64)) * MiB;
  if (!Number.isSafeInteger(requested) || requested < 8 * MiB || requested > EXPORT_MAX_WORKING_BYTES) {
    const error = messageError(new Error(''), "errors.exportMemory.exportMemoryAllowanceMustBeBetween8Mib", {value: EXPORT_MAX_WORKING_BYTES / MiB / 1024});
    error.code = 'export_memory_limit'; throw error;
  }
  const frameBytes = width * height * 4;
  // Output, transfer, encoding/readback and bounded video queue; crisp rendering
  // also needs WASM pixels and their straight-alpha copy.
  const frameWorkingBytes = frameBytes * (smoothing === 'none' ? 10 : 6);
  const scratchAllowance = Math.min(20 * MiB, requested / 8);
  let tileSize = 512;
  while ((tileSize * sampling.factor + 8) ** 2 * 4 * 4 > scratchAllowance && tileSize > 32) tileSize /= 2;
  const scratchBytes = (tileSize * sampling.factor + 8) ** 2 * 4 * 4;
  // The floor reserves what the pipeline allocates regardless of the hint:
  // the frame itself, its tile scratch and a minimal decoded-asset working set.
  const budget = Math.max(requested, frameWorkingBytes + scratchBytes + EXPORT_MIN_ASSET_BYTES);
  const assetBytes = Math.min(512 * MiB, Math.floor(budget - frameWorkingBytes - scratchBytes));
  return {...sampling, maxWorkingBytes: budget, frameWorkingBytes, scratchBytes, assetBytes, tileSize};
}
