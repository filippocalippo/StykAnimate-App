# Timeline identity

Figure identity is `unique_id`; it is never inferred from a name, definition, object slot, layer or pose-source ID. Distinct imported figures may legitimately share the name Fig 107.

The replacement Advanced timeline has persistent layer rows and time cells. A key owns one layer pose; moving it changes time without creating a figure. A retained pose can include external attachment ancestors as evaluation context, but layer ownership determines which objects are displayed. Copying to another layer creates new identities once across the entire range and does not duplicate external parents.

Layer selection follows the contents at each time, including blank spans and replacement poses. Simple and Advanced read the same exposure sheet. The old standalone authored-key navigation strip and assembly/property rows have been removed.

See [layer timeline architecture](layer-timeline.md). `tests/layer-sheet.test.mjs` covers retiming, interpolation, ownership, connected figures, history and clipboard identity; `tests/layer-timeline.browser.mjs` covers interactive cells and binary save/reopen. Older native-reader regressions remain in `tests/timeline-identity.test.mjs`.
