# Project: StykAnimate AI Auto-Rigging & Asset Tooling Pipeline

## Architecture
The StykAnimate AI Auto-Rigging pipeline synthesizes editable 2-bone IK-ready stick figures from input images and SVGs while providing a programmatic creative AI asset suite for generating SVGs, icons, mascots, and animations.

```
[Input: PNG / JPG / WebP / SVG]
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ Web Worker (src/workers/pose-estimation-worker.mjs)         │
│ - Off-thread raster decoding (createImageBitmap)            │
│ - Off-thread SVG rasterization (vendor/resvg WASM)          │
│ - MediaPipe Pose inference (33 normalized landmarks)        │
│ - Error isolation (never stalls main-thread WebGPU)         │
└──────────────────────────────┬──────────────────────────────┘
                               │ Structured Clone (<0.05ms)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Client & UI Staging (src/pose-estimation-client.mjs,        │
│                      src/ui/auto-rig-dialog.mjs)            │
│ - Drag/drop file picker & skeleton overlay preview          │
│ - Error presentation (presentError, localized strings)      │
└──────────────────────────────┬──────────────────────────────┘
                               │ User Confirm
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Topology & IK Synthesizer (src/pose-topology.mjs)           │
│ - 10-segment hierarchy (pelvis root, torso, head, 4 limbs)  │
│ - Automated 2-bone IK controllers (segments 4, 6, 8, 10)    │
│ - Atomic insertion (figure-range transaction, 1-step undo)  │
└─────────────────────────────────────────────────────────────┘
                               ▲
┌──────────────────────────────┴──────────────────────────────┐
│ Mascot Presets & Fixtures (src/claude-figure-data.mjs,      │
│                            src/rig-examples.mjs)            │
│ - Terracotta #D97757 palette, block torso, 4 IK legs        │
└─────────────────────────────────────────────────────────────┘
                               ▲
┌──────────────────────────────┴──────────────────────────────┐
│ Creative AI Studio CLI (scripts/creative-studio-cli.mjs)    │
│ - Multi-engine CLI: Antigravity, Claude, Codex, OpenCode    │
│ - Procedural deterministic fallback for offline testing     │
└─────────────────────────────────────────────────────────────┘
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Pose Estimation Worker | Off-thread inference bundling @mediapipe/pose | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Image & SVG Rasterization | OffscreenCanvas rasterization via createImageBitmap and resvg WASM | M1 | ORIGINAL_REQUEST §R1 |
| 3 | 33 Landmark Extraction | Non-blocking extraction of normalized coordinates & visibility scores | M1 | ORIGINAL_REQUEST §R1 |
| 4 | Localized Error Handling | Localized notices for invalid/unrecognized images without polluting definitions | M1 | ORIGINAL_REQUEST §Acceptance |
| 5 | Topology Synthesis | 10-segment StykAnimate native hierarchy from 33 landmarks | M2 | ORIGINAL_REQUEST §R2 |
| 6 | 2-Bone IK Rigging | Automated 2-bone IK controllers via editor.setNodeIK on 4 terminal limb segments | M2 | ORIGINAL_REQUEST §R3 |
| 7 | Atomic Transaction & Undo | Atomic insertion into builder/figure table with single-step undo | M2 | ORIGINAL_REQUEST §R2, §Acceptance |
| 8 | Builder UI Action & Command | Quick-action tile and command catalog entry for Auto-Rig from Image | M3 | ORIGINAL_REQUEST §R4 |
| 9 | Staging Overlay Dialog | Modal dialog with image drop zone, skeleton preview canvas, and confirm action | M3 | ORIGINAL_REQUEST §R4 |
| 10 | Claude Mascot Figure Rig | Terracotta #D97757 palette, block head/torso, dual arms, 4 IK-controlled legs | M4 | ORIGINAL_REQUEST §R5 |
| 11 | Claude Mascot Preset & Library | Loadable figure preset (.stkz) and rig example in StykAnimate library | M4 | ORIGINAL_REQUEST §R5, §Acceptance |
| 12 | Creative AI Studio CLI | scripts/creative-studio-cli.mjs generating SVGs, icons, mascots, animations | M5 | ORIGINAL_REQUEST §R6 |
| 13 | Multi-Engine & Offline Support | Interfaces with Antigravity, Claude, Codex, OpenCode with deterministic fallback | M5 | ORIGINAL_REQUEST §R6, §Acceptance |
| 14 | E2E Test Suite (Tiers 1-4) | Comprehensive test suite tests/auto-rig.test.mjs covering all features headlessly | M6 | ORIGINAL_REQUEST §Acceptance |
| 15 | Adversarial Coverage Hardening | Tier 5 adversarial edge cases, stress testing, and mutation verification | M6 | ORIGINAL_REQUEST §Acceptance |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M0 | Survey & Architecture | Codebase survey, interface contract definition, and project mapping | none | DONE |
| M1 | Pose Estimation Inference Worker | `src/workers/pose-estimation-worker.mjs`, `src/pose-estimation-client.mjs`, error localization | M0 | IN_PROGRESS |
| M2 | Topology Synthesis & IK Rigging | `src/pose-topology.mjs`, 2-bone IK configuration, atomic undo transaction | M0 | PLANNED |
| M3 | Builder UI & Staging Overlay | `src/ui/auto-rig-dialog.mjs`, `src/ui/quick-actions.mjs`, `src/ui/command-catalog.mjs` | M1, M2 | PLANNED |
| M4 | Claude Mascot Rig & Presets | `src/claude-figure-data.mjs`, `src/rig-examples.mjs`, `.stkz` preset packaging | M2 | PLANNED |
| M5 | Creative AI Asset Tooling Suite | `scripts/creative-studio-cli.mjs` CLI tool and creative-agent-studio skill | M0 | PLANNED |
| M6 | E2E Test Suite & Adversarial Hardening | `tests/auto-rig.test.mjs` covering Tiers 1-5 headlessly | M1, M2, M3, M4, M5 | PLANNED |

## Interface Contracts

### 1. Pose Estimation Worker ↔ Client
- **Worker File**: `src/workers/pose-estimation-worker.mjs`
- **Client File**: `src/pose-estimation-client.mjs`
- **Request Message**:
  ```javascript
  {
    id: string,
    type: 'estimatePose',
    buffer: ArrayBuffer, // Image file binary data
    mimeType: string     // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'
  }
  ```
- **Success Response**:
  ```javascript
  {
    id: string,
    ok: true,
    landmarks: Array<{ x: number, y: number, z: number, visibility: number }> // 33 normalized elements
  }
  ```
- **Error Response**:
  ```javascript
  {
    id: string,
    ok: false,
    messageKey: 'errors.poseEstimationWorker.noPoseDetected' | 'errors.poseEstimationWorker.invalidImageFormat' | 'errors.poseEstimationWorker.inferenceFailed',
    messageParams: Record<string, string | number>
  }
  ```

### 2. Topology Synthesizer API
- **Module**: `src/pose-topology.mjs`
- **Function**:
  ```javascript
  export function buildFigureFromPoseLandmarks(landmarks, options = {})
  ```
- **Options**:
  - `name`: string (default: `"Auto-Rig Figure"`)
  - `scale`: number (default: `300`)
  - `center`: `{ x: number, y: number }` (default: `{ x: 0, y: 0 }`)
  - `color`: `[r, g, b]` (default: `[40, 40, 40]`)
  - `headFill`: boolean (default: `true`)
- **Return Value**:
  ```javascript
  {
    figure: { figure_type_id, name, segments, polyfills },
    ikSetup: {
      "4": { enabled: true, pinned: false, allowStretch: false, chainLength: 2, bendDirection: 0 },
      "6": { enabled: true, pinned: false, allowStretch: false, chainLength: 2, bendDirection: 0 },
      "8": { enabled: true, pinned: false, allowStretch: false, chainLength: 2, bendDirection: 0 },
      "10": { enabled: true, pinned: false, allowStretch: false, chainLength: 2, bendDirection: 0 }
    },
    rootPosition: { x: number, y: number }
  }
  ```

### 3. Editor Atomic Figure Insertion Contract
- **Module**: `src/editor.mjs`
- **Method**:
  ```javascript
  editor.importFigure(figureDocument, { position: { x, y } })
  ```
- **Transaction Guarantee**: Emits exactly one `'figure-range'` command in `editor._undo`. Calling `editor.undo()` reverts both the figure definition from `report.figure_types` and the figure instance from the active frame in a single atomic operation.

### 4. Creative Studio CLI Contract
- **Script**: `scripts/creative-studio-cli.mjs`
- **Invocation**:
  ```bash
  node scripts/creative-studio-cli.mjs generate --type <svg|icon|mascot|animation> --prompt "<description>" [--engine <antigravity|claude|codex|opencode>] [--out <output_path>]
  ```
- **Behaviors**:
  - When `--engine antigravity` or no engine specified: generates deterministically using the built-in procedural asset engine.
  - When `--engine claude|codex|opencode`: invokes the respective CLI or falls back gracefully if the CLI binary is not installed.
  - Outputs valid SVG markup for `svg`, `icon`, `mascot` or valid StykAnimate JSON keyframe data for `animation`.

## Code Layout
- `src/workers/pose-estimation-worker.mjs`: Standalone ES module worker for pose estimation. Owned by M1.
- `src/pose-estimation-client.mjs`: Main-thread client wrapper for worker communication. Owned by M1.
- `src/locales/en-features/errors.mjs`: Error message keys for pose estimation. Owned by M1.
- `src/pose-topology.mjs`: Pose landmark to StykAnimate segment conversion & IK setup. Owned by M2.
- `src/ui/auto-rig-dialog.mjs`: Modal dialog with drag/drop and skeleton canvas preview. Owned by M3.
- `src/ui/quick-actions.mjs`: Build mode quick action tile registration. Owned by M3.
- `src/ui/command-catalog.mjs`: Auto-rig command definition. Owned by M3.
- `src/claude-figure-data.mjs`: Claude Mascot stick figure definition. Owned by M4.
- `src/rig-examples.mjs`: Built-in library rig examples and presets. Owned by M4.
- `scripts/creative-studio-cli.mjs`: Unified AI asset generation CLI. Owned by M5.
- `tests/auto-rig.test.mjs`: Comprehensive test suite for Auto-Rig pipeline. Owned by M6.
