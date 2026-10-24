#!/usr/bin/env node
// Prints the rectangles the editor filters each object's effects on at one tick
// (`objectBounds` with and without effect padding, as `rasterObject` and
// `filterArtworkVfx` compute them), to compare with `styk layers <file> <tick>`.
//
//   node engine/tools/vfx-layer-bounds.mjs <project.json|.styk> <tick>
import {readFileSync} from 'node:fs';
import {repo, repoUrl, open} from './fixture-kit.mjs';

const {openDocument} = await import(`${repoUrl}/tests/support/native-files.mjs`);
const {activeVfx, vfxStack} = await import(`${repoUrl}/src/vfx.mjs`);

const {buildGeometry} = await import(`${repoUrl}/src/pivot/geometry.mjs`);
const {connectedVfxGeometry} = await import(`${repoUrl}/src/vfx-connected.mjs`);
const {objectBounds} = await import(`${repoUrl}/src/renderer-geometry.mjs`);
const {drawableVfxPadding, hasDrawableVfx} = await import(`${repoUrl}/src/vfx-drawable.mjs`);

const [file, tick = '0'] = process.argv.slice(2);
const kind = /\.(styk|stkz|stykmov)$/i.exec(file)?.[1].toLowerCase();
const document = kind ? await openDocument(new Uint8Array(readFileSync(file)), kind, {verifySource: false}) : JSON.parse(readFileSync(file, 'utf8'));
const editor = open(document);
editor.seek(Number(tick));
const frame = editor.evaluatedFrame || editor.frame, report = editor.report;
const geometry = connectedVfxGeometry(buildGeometry(report, frame), frame, report);

for (const g of geometry.orderedObjects) {
  const items = g.drawables;
  if (!items.some(hasDrawableVfx)) continue;
  const bounds = objectBounds(items), domain = g.drawables[0]?._movieclipOwner?.domainBounds ?? objectBounds(items, {vfxBounds: false});
  const padding = items.reduce((n, item) => Math.max(n, drawableVfxPadding(item)), 0);
  const rect = r => [r.x, r.y, r.width, r.height].join(', ');
  const owner = items[0]?._movieclipOwner, stacks = owner ? activeVfx(owner.effects).map(e => e.type) : activeVfx(vfxStack(g.obj)).map(e => e.type);
  console.log(`slot ${g.slot} (uid ${g.obj.unique_id}, opacity ${items[0]?.opacity}${owner ? `, owner opacity ${owner.opacity}` : ''}): [${stacks.join(', ')}] bounds [${rect(bounds)}] domain [${rect(domain)}] padding ${padding}`);
  if (process.env.VERBOSE) {
    const parts = new Map();
    for (const item of items) { const key = `${item._movieclipPart ?? item.slot}/${item.obj.unique_id}/op ${item.opacity}/inner ${item._movieclipInner ? item._movieclipInner.owner.opacity + ':' + activeVfx(item._movieclipInner.owner.effects).map(e => e.type) : '-'}/own ${activeVfx(vfxStack(item.obj)).map(e => e.type)}`; parts.set(key, (parts.get(key) ?? 0) + 1); }
    for (const [key, count] of parts) console.log(`   ${count} items: ${key}`);
  }
}
