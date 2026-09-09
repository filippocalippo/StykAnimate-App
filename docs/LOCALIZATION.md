# Interface localization and coverage

Updated 2026-09-08. English is the default. Settings → Interface → Language is
implemented and persists through the existing application preference service.
The root editor shares one locale service with Settings and translates explicit
chrome/menu bindings without replacing controls or changing document state.
This is partial interface translation, not a fully translated application.

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

## Implementation

- `src/localization.mjs`: validated locale IDs, English default, plain-text lookup,
  cached Intl numbers/dates/plurals and synchronous language-change subscriptions.
  `normalizeLocale` falls back for invalid preferences; explicit `setLocale`
  rejects unsupported choices. No OS-locale inference changes the initial language.
- `src/locales/en.mjs` and `it.mjs`: 153 English and 152 Italian app-specific
  common-control keys. Missing localized keys fall back to English, then the key.
  Existing deliberate Italian captions take precedence over old native captions.
- `scripts/build-native-locales.mjs`: deterministic generation from the supplied
  490,811 INI bytes into a 49,660-character catalog module. It verifies the exact
  inventory and maps caption keys explicitly, never by English-string matching.
  The other 25 catalogs contain 36–65 mapped app captions each. Original English
  values are omitted so the app's current English fallback remains authoritative.
- `src/locales/pivot-language.mjs`: data-only bounded INI parser, 512 KiB input,
  2,048 keys and 4,096 characters per value. BOM decoding is authoritative;
  legacy Windows code pages are explicit. Invalid control text, oversized input
  and prototype keys cannot become captions. Parsed values are never executed.
- `src/localization-bindings.mjs`: stable semantic DOM bindings, explicit new
  subtree/menu application, and current playback-action labels. Locale changes
  update retained connected elements. There is no MutationObserver, timer,
  whole-document rescan after mutations, per-frame translation or geometry work.
- `src/settings.mjs`: shared service, validated persistent locale preference,
  27 native-name options, partial-coverage note, translated Interface controls,
  and focus/tab/scroll/draft preservation during a language redraw.

The supplied Portuguese-BR CancelBitCap incorrectly contains a long confirmation
question. It is explicitly excluded so Cancel uses English. Chinese Builder
Open/Save mean figure materials; project captions use MFOpen/MFSave instead.
These source exceptions are recorded and tested. Native translation quality is
inherited only where reviewed semantic keys match; key counts are not a quality
or complete-app translation percentage.

All returned values are plain text. Consumers use textContent or existing HTML
escaping. Placeholder substitution accepts own scalar properties only; it does
not evaluate expressions or mutate numeric editor parsing/model units. Intl
formatter caches have a 16-entry bound and clear on an actual locale change.

Arabic/Hebrew carry RTL language metadata and Unicode captions. The application
sets document lang but does not mirror the shell, canvas coordinates, animation
time, hotkeys or user-authored text. Complete RTL layout remains separate
acceptance work. Language files are build inputs today: a user-installed custom
INI loader is not wired to the app, despite the parser being reusable for one.

## Verified behavior

- `node --test tests/localization.test.mjs tests/native-locales.test.mjs`: **16
  passing checks**, including all 27 IDs, regional/script normalization, real
  source bytes/hashes, Unicode/ANSI decoding, bounded parser, safe fallback,
  source exceptions, placeholders, plurals, formatter cache and subscriptions.
- [Settings/browser report](../artifacts/localization-settings/report.json): **18
  passing checks** after the 27-choice extension. Actual controls, focused
  selector, persisted preference reload, same icons/input, bounded menu bindings,
  playback action, narrow-window fit and no localization observer use.
- [Actual root-app report](../artifacts/localization-app/report.json): **12 passing
  checks** on its English/Italian UI snapshot. A visible numeric edit remains
  byte-for-byte unchanged by language selection; undo count, revision, dirty state,
  selection and tick are stable. Undo/Redo, menus/hotkeys, same Save/SVG nodes,
  current preview action and browser reload are verified.

- [Actual 27-language root report](../artifacts/localization-native-app/report.json):
  **37 passing checks** activate every supplied choice, retain focus and exact
  document/history/control identity, verify Arabic/Hebrew/Chinese captions and
  Arabic reload persistence, and preserve LTR canvas/time semantics. Arabic and
  compact Chinese screenshots were visually inspected; controls remain reachable.

Browser preference reload is proved; locale-specific native two-process restart
and the final rebuilt package are not yet verified.

## Remaining text ownership and acceptance

| Owner/module | Remaining text and preservation requirement |
| --- | --- |
| Root app and index | Remaining toolbar/status/toasts, errors, recovery/export/dirty-close/shortcut dialogs; keep action IDs, hotkeys and user filenames stable. |
| Panels | Layer/property labels and dynamic actions; preserve scrubs, focus and user-created names. Canvas/Animation/Shortcuts settings sections remain largely English. |
| Timeline | Simple/Advanced controls, context menus and counters; never rebuild all rows, change scroll/ranges or reverse time for a locale event. |
| Inspector/camera/dialog owners | Semantic property and action keys, validation/messages; preserve modal drafts, worker requests, selection and undo grouping. |
| Model/history | Prefer stable presentation message codes and parameters. Do not rename serialized history or match commands by translated text. |
| Desktop | App-owned dialog/error text can use validated locale/message codes. OS file-picker text follows OS behavior. An optional custom language installer would need a bounded persistent user-data contract; it is not an inferred native requirement. |

The [module source inventory](../artifacts/localization-source-inventory.json)
is a navigation aid, not exhaustive coverage. Finish remaining actual captions,
validate terminology with native speakers, and inspect narrow/floating/high-DPI
layouts before claiming any full app translation. English fallback is deliberate
and visible in Settings. Native desktop locale restart remains unverified. Full RTL layout and a custom locale installer are optional modern extensions unless direct native baseline evidence establishes those capabilities; neither is an inferred completion blocker.
