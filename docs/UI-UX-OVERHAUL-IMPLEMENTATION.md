# Studio UI overhaul

Implemented September 9, 2026.

The permanent scene/assets sidebar has been removed. A compact floating toolbar sits at the left of the canvas, retaining the original white, neutral gray, and blue palette. Animate and Build figure modes expose relevant tools. Assets, examples, and creation actions are available through the Add dialog.

The workspace gives the canvas the primary area, properties the right column, and the timeline a full-width bottom row. Properties and timeline have keyboard-accessible resize handles. Timeline expansion is reversible. Secondary property groups collapse, selection commands live in an actions menu, and shared figure editing has explicit scope feedback.

Export now groups formats by intended output, with a single primary action and relevant settings. Existing export implementations remain in use.

## Verification

- 957 automated tests passed, including four new layout constraint checks.
- Syntax check: 456 JavaScript files, zero errors.
- Browser inspection at 1024 × 768, 1280 × 720, and 1440 × 900.
- Exercised creation and undo, numeric property editing and undo, contextual tool switching, export category selection, and timeline expansion/restoration.
- PNG export reported completion in the app. Downloaded file bytes were not independently inspected.
- Packaged Electron behavior and native export codecs were not verified in this browser pass.

The earlier audit is in UI-UX-OVERHAUL-AUDIT-2026-09-09.md.
