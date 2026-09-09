# Builder branch property edits

The Builder inspector's **Apply builder changes to branch** checkbox applies numeric width and opacity edits to the selected segment and its descendants. It is visible only in Builder tools. Ordinary Pose controls continue to edit the selected object or its explicit animation channel.

## Native definition and authored instance behavior

Width and unoverridden opacity edits use small patches to the shared figure definition. A width input assigns the same absolute width to every branch member, even when the selected segment already has that value. Undo restores each member's previous width; Cancel also restores absent optional fields. Membership is computed once per gesture, and pointer previews do not copy poses, embedded images, or complete documents.

When an affected branch opacity already has an authored channel or a captured instance override, the input instead creates or updates all affected scalar keys at the current tick in one animation command. The displayed branch changes immediately. Other instances of the same figure type, native source definitions, captured source poses, and polygon alpha remain unchanged. Figure-type-scoped channels keep their scope, and foreign rig channels retain their contents.

Primary opacity covers the branch's segments. The native, unoverridden definition path also updates enclosed polygons according to the existing branch binding. Numeric secondary opacity covers only segments that already have a gradient, preserving each endpoint's RGB. It does not invent a gradient or change polygon alpha. The authored path likewise leaves polygons unchanged because it has no authored polygon-opacity representation.

Selecting an explicit scalar row in the timeline turns off branch scope and edits that exact curve. Enabling the branch checkbox retains the selected joint and switches the inspector to the figure's composed value, so a global curve cannot silently substitute a different starting value for a scoped branch edit.

## Native chooser distinction

The supplied Pivot executable exposes a combined color-and-alpha chooser. It assigns the chosen RGB to each target; when the chosen alpha differs from the selected segment's initial alpha, it also assigns that alpha. Color-only changes preserve each member's alpha. Its gradient chooser can create gradients on members without one. The [native branch evidence](../artifacts/native-static/builder-branch-rules.md) records these paths and their limits.

The separate numeric opacity fields described here are an intentional convenience: they preserve each endpoint's existing RGB. They are not presented as an identical copy of Pivot's combined chooser. The combined Builder color controls retain their own native branch behavior.

## Implementation and verification

[editor-branch-style.mjs](../src/editor-branch-style.mjs) plans targets using stable handle IDs. Beginning an authored gesture scans channels and branch membership, then copies only the affected channels and their key arrays. Each preview updates the cached branch keys. Commit restores the original animation header and calls the bulk key API once with exact targets; Cancel restores the original header directly. Generic animation commit and cancel dispatch include this batch, so Save can finalize a held drag without losing members or creating a second Undo entry.

[native-property-edit.mjs](../src/native-property-edit.mjs) selects the shared-definition or authored path. It uses the cached binding from [editor-builder-branch.mjs](../src/editor-builder-branch.mjs) for width and native primary opacity, and a small secondary-alpha binding for gradient opacity.

Five [branch opacity model checks](../tests/branch-opacity.test.mjs), three [branch width checks](../tests/native-branch-thickness.test.mjs), and 13 existing [native property checks](../tests/native-property-edit.test.mjs) pass together. They cover shared definitions, enclosed polygons, distinct endpoint RGB, authored and captured overrides, scoped targets, one-step Undo, and exact Cancel restoration.

The [actual application report](../artifacts/branch-opacity/report.json) records 13 passing checks, including exact global-curve versus composed branch selection, F12 with the current checkbox explicitly focused, both members changing through the inspector, Escape, Save during a held drag, and reopening the resulting STYK document. The [inspector screenshot](../artifacts/branch-opacity/inspector.png) was visually inspected. The separate [Builder aids report](../artifacts/builder-aids/report.json) includes actual branch width editing and one Undo.
