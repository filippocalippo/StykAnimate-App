# E2E Test Infra: StykAnimate AI Auto-Rigging Pipeline

## Test Philosophy
- Opaque-box, requirement-driven derived from `ORIGINAL_REQUEST.md`.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.
- Execution environment: Headless Node.js built-in `node:test` (`tests/auto-rig.test.mjs`), with offline deterministic execution.

## Feature Inventory & Test Coverage Map
| # | Feature | Source | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Cross-Feature) | Tier 4 (Workload) |
|---|---------|--------|:-----------------:|:-----------------:|:----------------------:|:-----------------:|
| 1 | Pose Estimation Worker | R1 | 5 | 5 | ✓ | ✓ |
| 2 | Image & SVG Rasterization | R1 | 5 | 5 | ✓ | ✓ |
| 3 | 33 Landmark Extraction | R1 | 5 | 5 | ✓ | ✓ |
| 4 | Localized Error Handling | Acceptance | 5 | 5 | ✓ | ✓ |
| 5 | Topology Synthesis | R2 | 5 | 5 | ✓ | ✓ |
| 6 | 2-Bone IK Rigging | R3 | 5 | 5 | ✓ | ✓ |
| 7 | Atomic Transaction & Undo | Acceptance | 5 | 5 | ✓ | ✓ |
| 8 | Builder UI & Staging Overlay | R4 | 5 | 5 | ✓ | ✓ |
| 9 | Claude Mascot Rig & Presets | R5 | 5 | 5 | ✓ | ✓ |
| 10 | Creative AI Studio CLI | R6 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test Runner: Node.js native test runner via `node --test tests/auto-rig.test.mjs` and `node --test tests/*.test.mjs`.
- Pass/Fail Semantics: Exit code 0, all assertions pass, 0 unhandled promise rejections.
- Test Structure:
  - Tier 1: Feature Isolation (Landmark parsing, segment generation, IK config attachment, preset serialization, CLI generation).
  - Tier 2: Boundary & Corner Cases (Empty landmarks, collapsed coordinates, invalid image headers, zero-length segments, missing bones, invalid CLI arguments).
  - Tier 3: Cross-Feature Combinations (Image decode -> Landmark extraction -> Topology synthesis -> Editor import -> Canvas drag IK solve -> Undo).
  - Tier 4: Real-World Workloads (Full human stick figure animation sequence, 4-legged Claude mascot walk cycle, multi-format asset generation).
  - Tier 5: Adversarial Stress & Mutation Testing (High-frequency canvas drag mutations, extreme coordinates, malformed WASM payloads, memory leak checks).

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Expected Outcome |
|---|----------|--------------------|------------------|
| 1 | Human pose photo auto-rigging | F1, F2, F3, F5, F6, F7 | Clean stick figure with 4 active IK chains |
| 2 | SVG stick figure illustration import | F2, F3, F5, F6, F7 | Pixel-crisp rasterization and accurate landmark extraction |
| 3 | Corrupt/non-pose image import | F1, F4, F7 | Localized error notice without modifying figure definitions |
| 4 | Full undo/redo cycle on rigged figure | F5, F6, F7 | Clean state restoration without leftover IK nodes |
| 5 | Claude mascot walk cycle animation | F6, F9 | 4 independent IK handles pose smoothly under joint transforms |
| 6 | Creative Studio asset generation pipeline | F10 | Programmatic SVG, icon, mascot, and animation file generation |

## Coverage Thresholds
- Tier 1: ≥50 test cases across 10 features
- Tier 2: ≥50 test cases covering boundary extremes
- Tier 3: ≥10 pairwise interaction test cases
- Tier 4: ≥6 end-to-end realistic application workloads
- Total Suite Target: ≥116 verified assertions and cases
