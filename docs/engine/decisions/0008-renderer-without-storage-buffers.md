# D8: One renderer pipeline for WebGPU, native and WebGL2

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

WebGL2 has no storage buffers and binds one sampler per texture, and phones without WebGPU must keep working.

## Decision

Primitive records are instance attributes; lookup tables (paint records, isolation group placements, polyline vertices) are float textures read with `textureLoad`; every texture has one sampler, and nearest sampling is emulated at texel centres. One WGSL pipeline (`styk-render/src/prim.wgsl`) serves WebGPU, Vulkan/Metal/DX12 and WebGL2.

## Evidence

Identical output to the earlier storage-buffer pipeline on the compared frames (mean difference 0.000/255). WebGL2 is verified on SwiftShader in headless Chromium; WebGPU in Electron on the RTX 4070 SUPER.

## Consequences

Table textures grow by rows of 1,024 texels. Array textures always have at least two layers (D11).
