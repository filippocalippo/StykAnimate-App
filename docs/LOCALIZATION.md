# Interface localization

English is the default. Settings → Interface → Language persists through the
existing editor preference service. The browser, touch interface and Electron
menus use the same catalog and fallback rules. Existing accurate translations are preserved. All 26 non-English packs have complete catalog and plural coverage. Translation and independent context review use exclusive language batches; per-language results are recorded in [LOCALIZATION-REVIEW.md](LOCALIZATION-REVIEW.md).

## Ownership and lookup

`src/localization.mjs` owns `Localization`, the shared `interfaceLocalization`,
`t(key, params)`, and the component-kit adapter `messageText(optionalTranslator,
key, params)`. `src/locales/en-catalog.mjs` composes English common and feature namespaces;
`src/locales/en-features/` separates feature copy and diagnostics. The page loads
English as one generated module, `src/locales/en.mjs`, which `npm run locales:build`
writes from the catalog (`locales:check` rejects a stale one). Keys describe
semantic intent and remain stable when English wording changes. Duplicate English
ownership fails validation. No UI imports a particular language or matches English
captions to infer behavior.

Each `src/locales/packs/<ID>.json` independently owns locale metadata and translated
messages. `scripts/build-locales.mjs` generates the language index (`src/locales/locale-index.mjs`), one
messages module per non-English language (`src/locales/messages/<ID>.mjs`), the source context and
sandboxed preload diagnostics. A session loads the messages of the language it shows and no other:
`loadLocale` (src/localization.mjs) brings a language in before it is chosen, the app awaits it for the saved language at
startup and the Settings picker before it commits, and the desktop main process requires its language's module
(`useLocale`, desktop/localization.cjs). `Localization` refuses a language that is not loaded. The shared support asset generator includes its
localization import dependencies for standalone support builds. No dependency, new preference store, translation
observer, remote service or runtime language installer is required. The original
INI importer remains provenance. See [TRANSLATING.md](TRANSLATING.md) for the pack
workflow and integration ownership.

Lookup selects the requested key and, for plurals, the locale's CLDR category.
Absent messages or categories use English and English plural rules; unknown keys
remain visible as keys. Deliberate English fallback is reported in validation and
explained in Settings when the selected pack has missing messages or plural forms.
Complete packs do not show the partial-language notice. Exact BCP-47 IDs and explicit aliases take precedence.
Generic language packs can serve regions, script packs serve only that script,
and regional packs require deliberate aliases. `zh-Hant`, `pt-PT` and `nn` do not
silently become Simplified Chinese, Brazilian Portuguese or Bokmål.

Messages are plain text with named `{placeholders}`. Plurals contain `other` and
the language's categories. Parameters can be scalars, bounded nested
`{messageKey, messageParams}` references, or `{format: 'number'|'date', value,
options}` display descriptors. Display lists can use `{format: 'list', value, options}`
with at most 256 strings or nested message references; the same eight-level nesting
limit and bounded formatter cache apply. Use full sentences rather than translated fragment
concatenation. `Intl` formats displayed numbers and dates, with a bounded cache;
input parsing, document units and encoder values retain their existing contracts.

## Connected interface and errors

`src/localization-bindings.mjs` attaches explicit text and attribute bindings at
the owning feature. A parent that adopts an explicitly bound child caption retains
that child as its caption slot, so registration and language changes update the
same node without duplicating text or replacing icons and shortcut badges.
It supports captions, tooltips, accessibility descriptions,
placeholders, custom numeric validation messages and per-binding parameters. Factories carry presentation metadata;
tuple metadata lives outside arrays so saved IDs and command values remain intact.
Owners explicitly connect mounted subtrees. Locale changes update connected nodes
in place, preserving icons, hotkeys, focus, drafts, selection and scroll. Detached
bindings are pruned. Dynamic parameters use weak storage and compare before writing
so playback does not gain per-frame localization attribute changes.

Coverage includes application chrome, workspace and docking controls, Settings,
commands and menus, both timelines, inspector, drawing and rig controls, camera,
VFX and built-in preset and effect-channel captions, libraries, touch controls, dialogs, recovery,
exports, updates, support, notifications and owned validation/diagnostic messages.
User names, filenames, command/history identifiers, shortcuts, extensions, HTTP
headers, codec IDs, authored figure names and animation text remain data.

`src/localized-error.mjs` adds a stable message key and scalar parameters (or display
references with an explicit `diagnosticValue`) to the original error without
changing its class, name, code or English diagnostic.
Human parameter labels resolve from their display message key; their original scalar
value still appears in the diagnostic and survives worker/IPC transport.
Import notices use their stable codes and structured recovery records; stored
warning strings remain unchanged. Support status codes and option values also
remain separate from their captions.
Workers forward this metadata through their existing reply shapes; presentation
uses `src/error-presentation.mjs`. Raw OS, driver and external-service details stay
as reported. Electron's `desktop/localization.cjs` uses the same DOM-free service
and English catalog, restores the saved locale before creating menus, and updates
native menus through the existing settings IPC. App-owned native titles, filters,
buttons and errors are localized; operating-system dialog chrome follows the OS.
The sandboxed preload bundles the same pure diagnostic constructor and its tiny
English subset; context isolation and IPC APIs are unchanged.

## Direction and layout

The locale sets root `lang` and `dir`. Logical interface alignment, wrapping,
menu placement and horizontal menu keys support RTL and expanded captions.
Canvas/world coordinates, timeline chronological order, filmstrips, graphs,
numeric inputs, units and shortcut badges remain LTR. This changes interface
presentation only; it does not redesign authored text inside animations.

The font stack includes Arabic, Hebrew and CJK fallbacks. Browser checks exercise
Arabic, Hebrew, Chinese, Cyrillic and accented Latin glyphs on this Linux system;
font availability still needs shipping-platform review. Development-only
`setPseudo('long')` and `setPseudo('rtl')` expand messages without adding production
translations or persisting a pseudo language.

## Validation and verification

- `npm run locales:validate -- --locale fr` validates one pack without generating
  shared files; `--strict` requires complete messages and plural categories.
- `npm run locales:build` regenerates shared outputs; `npm run locales:check`, also
  part of `npm run check`, rejects stale generation, unknown static bindings,
  duplicate JSON keys, malformed messages, invalid metadata/aliases, placeholder
  mismatches and invalid plural categories. Missing translations and valid missing
  plural forms are reported and intentionally allowed without `--strict`.
- `npm test` covers catalog/fallback/variants/formatting, message ownership,
  transport/error identity, command tuples, sandboxed preload and existing editor
  behavior. Static scanning validates literal bindings; computed keys also need
  focused owner tests and rendered inspection.
- `npm run test:localization:browser` checks Settings, actual app switching through
  every supplied language, menu/dialog retention, exact document/history state,
  narrow layouts, long labels, RTL directions, notifications and font samples.
  Export, touch and app-dialog browser suites exercise their own workflows.
- Desktop preference smoke verifies Italian menus before and after process restart;
  boot smoke verifies the bridge, context isolation and codec startup. The complete
  private-sample desktop smoke requires the local sample files documented by it.

The pre-existing inspector-header browser check expects an obsolete set of joint
quick actions and fails identically on the unchanged committed baseline. The
changed generated heading and retained-caption behavior have separate focused
coverage. The pre-existing playback-quiet browser check also fails on the unchanged baseline:
onion markers write their attributes/styles during playback. Localization's earlier
parameter writes were removed; comparison showed only the baseline marker writers
remaining. Catalog coverage is a completeness report, not a translation-quality
score. Native-speaker terminology review and Windows/macOS packaged rendering remain
unverified; catalog completion and AI context review do not certify those results.

## Native baseline and supplied languages

Pivot 5.2 selects a language in Options and retains preferences across restarts.
Its extension mechanism uses translated INI values in the installation languages
directory; Unicode files use UTF-16LE BOM. Its manual asks translators to inspect
every window for caption fit. [Language files](https://pivotanimator.net/help5-2/language_files.htm),
[Options](https://pivotanimator.net/help5-2/options.htm).

The supplied Pivot 5.2.11 contains 27 language files, including English. All 27
are registered as selectable locales. The [source inventory](../artifacts/localization-native-inventory.json)
records exact bytes, SHA-256, BOM/codepage decoding, key counts, mapped app keys
and the explicit semantic mapping used by the generator.

| Language | Locale | Language | Locale | Language | Locale |
| --- | --- | --- | --- | --- | --- |
| English | en | Arabic | ar | Simplified Chinese | zh-Hans |
| Croatian | hr | Czech | cs | Danish | da |
| Dutch | nl | Finnish | fi | French | fr |
| German | de | Greek | el | Hebrew | he |
| Hungarian | hu | Indonesian | id | Italian | it |
| Kazakh | kk | Norwegian Bokmål | nb | Polish | pl |
| Brazilian Portuguese | pt-BR | Romanian | ro | Russian | ru |
| Slovenian | sl | Spanish | es | Latin American Spanish | es-419 |
| Turkish | tr | Ukrainian | uk | Vietnamese | vi |

The native Norwegian vocabulary uses Bokmål; Slovenian is identified from its
vocabulary rather than treating its filename as Slovak. Chinese captions use the
simplified script. Traditional Chinese, Nynorsk and European Portuguese do not
silently select a different supplied script/variant. Latin American regional
Spanish maps to es-419; native es and es-419 remain distinct preferences.
