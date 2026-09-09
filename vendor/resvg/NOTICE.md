# Vendored resvg WebAssembly

Unmodified `@resvg/resvg-wasm` version **2.6.2**, copyright 2021–present yisibl
and contributors. Licensed under the Mozilla Public License 2.0; see [LICENSE](LICENSE).

- Complete corresponding source: https://github.com/thx/resvg-js/tree/v2.6.2
- Source archive: https://github.com/thx/resvg-js/archive/refs/tags/v2.6.2.tar.gz
- Original package: https://registry.npmjs.org/@resvg/resvg-wasm/-/resvg-wasm-2.6.2.tgz
- Registry SHA512 integrity (verified before extraction):
  `FqALmHI8D4o6lk/LRWDnhw95z5eO+eAa6ORjVg09YRR7BkcM6oPHU9uyC0gtQG5vpFLvgpeU4+zEAz2H8APHNw==`

The original generated ESM binding, WebAssembly binary and type declarations
are unchanged. StykAnimate uses this offline dependency only inside the export
worker for aliased, portable outline rendering. It loads no system fonts and
needs no external network or host-native binary at runtime. App integration is
in `src/export-crisp.mjs`. The original npm package metadata is retained here.
