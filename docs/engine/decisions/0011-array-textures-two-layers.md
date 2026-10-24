# D11: Array textures always have at least two layers

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

WebGL2 creates a one-layer array texture as a plain 2D texture; isolation groups and onion composites then sampled black.

## Decision

`array_texture` (`styk-render/src/resources.rs`) allocates `max(layers, 2)` layers.

## Evidence

Onion skins and translucent figures render on WebGL2 since; the app parity steps pass there.

## Consequences

One extra page of memory for single-page atlases.
