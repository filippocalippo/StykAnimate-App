# Portable text authoring

Use **T** to create text or **Edit text** in the selected figure’s properties. The dialog previews the actual vector outlines, including multiline alignment, fill, opacity, gradient and outline. Preview is fitted to the panel. Apply replaces a figure definition in one undoable command; Cancel and Escape discard the draft.

Font choices include four bundled Noto Sans styles, user-selected TTF/OTF files, and installed fonts. The desktop service discovers known system/user font directories and returns font bytes through opaque font IDs; collection faces are repacked into standalone fonts before parsing. The browser can use Local Font Access when available, requested from the Installed fonts button. An explicit font choice is used to generate embedded paths. Opening or rendering saved PIV/STK text does not require that font to be installed.

Imported Pivot text remains editable without private StykAnimate metadata. Its font family, style flags, glyphs and character positions are read from the native text asset. Unchanged text retains the exact native paths, UTF-16 units, CRLF and positions. Known characters reuse those paths. A missing visible glyph produces an actionable font-selection error; the editor does not substitute a different font silently.

Native text assets do **not** contain the original point size, advance widths or kerning tables. These assets show **Scale · %**, rather than an invented point size. Existing layout is exact; new combinations use observed character spacing where available and estimated spacing otherwise. The preview explicitly identifies estimated spacing. Choosing the original font supplies exact new metrics. Native character limits remain: BMP characters, at most 255 distinct UTF-16 units, and at most 16,384 characters per authored figure. Unsupported characters are rejected before Apply.

`TextDialog` owns an isolated draft and a dedicated worker. Font parsing and outline layout run off the interaction thread; live changes are debounced with one in-flight compilation and one replaceable latest draft. A session accepts at most eight font faces, 32 MiB per file and 64 MiB total input font bytes. Preview uses `Path2D`, without platform text drawing. Closing the dialog terminates the worker and disconnects its resize observer. There is no idle animation loop.

Integration uses `new TextDialog({dialog, content, fontService?, onClose?})`, then `open({figure?, initialOptions?, onApply})`. `fontService` provides `listFonts()` and `readFont(id)`. To edit a particular text asset in a mixed rig, pass `initialOptions.assetIndex`; other assets, segments and instance identities are retained. Only `onApply(definition)` mutates the editor. Text-only creation and embedded-asset editing remain reusable pure functions in `text-authoring.mjs` and `native-text-authoring.mjs`.

## Verification

Run from the application directory with the codec server at `http://127.0.0.1:47831`, or set `STYK_URL` for browser checks.

| Command / evidence | Coverage |
| --- | --- |
| `node --test tests/text.test.mjs tests/native-text-authoring.test.mjs` | Real font styles, native metadata recovery, exact no-op preservation, H/V paths, reflow, scaling, missing glyphs, mixed assets and decomposed Unicode |
| `node tests/text-dialog.browser.mjs` · [report](../artifacts/text-dialog/report.json) | Actual worker, vector preview, font file/service selection, invalid input, cancellation and compact layout |
| `node tests/native-text-roundtrip.browser.mjs` · [report](../artifacts/native-text-authoring/report.json) | Eleven Arial, Comic Sans, Webdings and Segoe Print variants; actual PIV and STK writer/decoder round trips; identical reopened pixels with font loading blocked |
| `node tests/text-app.browser.mjs` · [report](../artifacts/text-app/report.json) | Actual app file import, contextual Edit text, one-command undo/redo, Save/reopen STYK, PIV/STK export buttons, and a fresh app reopening PIV with identical pixels and fonts blocked |

These checks cover the supplied fixtures and supported outline fonts. They do not establish unrestricted Unicode shaping or parity with every installed font format.
