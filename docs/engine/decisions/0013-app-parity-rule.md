# D13: What counts as the same picture in the app

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

Two renderers cover edge pixels by different rules, and two correct 8-bit blends of the same translucent layers may round differently by a level or two. A comparison that fails on those says nothing; one that ignores area changes says less.

## Decision

The app-parity rule (applied by `scripts/engine-app-parity.mjs` while the JavaScript renderers could be compared, and by `styk raster-parity` for the CPU rasterizer) fails a step when any pixel differs by more than 32 levels together with all eight neighbours (a solid area), or when the mean difference over the stage, not counting differences of two levels or less, exceeds 0.25 levels. The raw mean is reported too. Steps compare against the WebGPU renderer in Electron (the default desktop configuration) and against the Canvas 2D fallback in headless Chromium.

## Evidence

Introduced after the first app comparisons; refined once (the two-level quantum) when svr_uriel.piv tick 445 differed by one level over every pixel of a translucent overlay. Every failing step is inspected and classified (plan section 7).

## Consequences

Fixed thresholds: they are not tuned per document. Differences the rule lets through along edges are still listed when they are systematic (Canvas 2D seams, crisper small features).
