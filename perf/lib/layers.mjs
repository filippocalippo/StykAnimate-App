/**
 * The app's layers, and which layer a function belongs to (docs/PERFORMANCE.md "Layers").
 *
 * A processor profile names functions; a person deciding what to optimise needs to know which part of the app the time
 * belongs to. This is the one table that maps a profile's call frame (a JavaScript module's URL, a WebAssembly
 * function's Rust path, one of V8's own markers) to a layer. Rows are tried in order: the first match wins.
 *
 * Groups: `interface` (JavaScript of the app), `engine` (the Rust engine in WebAssembly), `browser` (the browser's own
 * work on the thread), `tools` (the measurement itself) and `idle`.
 */

/** JavaScript modules by path, first match wins. Paths are matched after the origin (`/src/...`). */
const MODULES = [
  ['tools', /\/src\/devtools\/|\/src\/trace\.mjs/],
  ['binding', /\/src\/engine\/pkg\//],
  ['engine-interface', /\/src\/engine\//],
  ['shell', /\/src\/(shell|ui|touch|home|tutorials)\/|\/src\/(hotkey|localization|theme|icons|settings|studio-shell|application-menu|ui-scale)/],
  ['timeline', /\/src\/(timeline-|layer-timeline|layer-sheet|sheet-filmstrip|audio-timeline|camera-motion-timeline|onion-timeline|vfx-clip-timeline|vfx-clip-views|keyframe-easing|timeline-rows)/],
  ['canvas', /\/src\/(canvas-|renderer-geometry|camera-overlay|camera-monitor|motion-path|spatial-gizmo|spatial-projection|ik-view|ik\.mjs|polygon-|onion-|vfx-gizmos|builder-)/],
  ['inspector', /\/src\/(inspector-|property-|color-|rig-|vfx-inspector|vfx-clip-inspector|vfx-clip-controls|spatial-controls|tweener-controls|segment-values|text-dialog|background-dialog)/],
  ['drawing', /\/src\/(drawing-|pen-input|paint\.mjs)/],
  ['export', /\/src\/(export-|image-export|image-codecs|gif-|native-video|vfw-|mp4-muxer|audio-encode|document-export|document-save|document-lift)/],
  ['files', /\/src\/(import-|codec-|native-file|library-|user-library|asset-library|community-library|sticknodes\/|project-tabs|browser-recovery|document-transport|document-normalize|clipboard-wire|shared-clipboard)/],
  ['telemetry', /\/src\/(telemetry-|playback-metrics|playback-cadence)/],
  ['editor', /\/src\/(editor|layers\.mjs|layer-|frame-ids|figure-|animation-|movieclip|lazy-|pivot\/|vfx|audio-|camera-motion|preview-|thumbnail-|playback-)/],
  ['app', /\/src\/app(\.mjs|-dialogs)/],
  ['interface-other', /\/src\//],
];

/** Rust crates (the first crate named in a WebAssembly function's path) to layers. */
const CRATES = new Map(Object.entries({
  styk_edit: 'engine-edit', styk_eval: 'engine-eval', styk_draw: 'engine-eval', styk_render: 'engine-render', styk_raster: 'engine-raster',
  styk_doc: 'engine-document', styk_formats: 'engine-formats', styk_piv: 'engine-formats', styk_export: 'engine-export', styk_drawing: 'engine-drawing',
  styk_engine: 'engine-scheduler', styk_wasm: 'engine-binding', styk_math: 'engine-math', libm: 'engine-math', styk_alloc: 'engine-memory', styk_codec_wasm: 'engine-formats', styk_drawing_wasm: 'engine-drawing',
  wgpu: 'engine-render', wgpu_core: 'engine-render', wgpu_hal: 'engine-render', wgpu_types: 'engine-render', naga: 'engine-render', glow: 'engine-render',
  dlmalloc: 'engine-memory', compiler_builtins: 'engine-memory',
  serde_json: 'engine-json', serde: 'engine-json', ryu: 'engine-json', itoa: 'engine-json',
  png: 'engine-codecs', miniz_oxide: 'engine-codecs', flate2: 'engine-codecs', zune_jpeg: 'engine-codecs', zune_core: 'engine-codecs', image: 'engine-codecs', fdeflate: 'engine-codecs', gif: 'engine-codecs',
  core: 'engine-std', alloc: 'engine-std', std: 'engine-std', hashbrown: 'engine-std', wasm_bindgen: 'engine-binding', js_sys: 'engine-binding', web_sys: 'engine-binding',
}));
const CRATE = /(?:^|[^\w:])(?:<|&|dyn |mut )*([a-z][a-z0-9_]*)::/;
const MEMORY = /^(memcpy|memmove|memset|memcmp|__rust_(alloc|dealloc|realloc)|__rdl_|malloc|free|realloc)/;
/**
 * The platform's `sin`, `cos`, `atan2`… on WebAssembly are the compiler's builtins (`compiler_builtins::math`, a copy of the `libm`
 * crate): the arithmetic of geometry and evaluation, not the memory functions the rest of that crate holds.
 */
const MATH = /^compiler_builtins::math::/;
const WAITING = /::(condvar|futex)::|memory_atomic_wait|std::thread::(sleep|park)/;

export const LAYERS = Object.freeze({
  'app': {title: 'App wiring (app.mjs)', group: 'interface'},
  'timeline': {title: 'Timeline', group: 'interface'},
  'canvas': {title: 'Canvas overlay and gestures', group: 'interface'},
  'inspector': {title: 'Inspector and panels', group: 'interface'},
  'shell': {title: 'Shell, docking and UI kit', group: 'interface'},
  'editor': {title: 'Editor read view', group: 'interface'},
  'engine-interface': {title: 'Engine interface (src/engine)', group: 'interface'},
  'binding': {title: 'Engine binding glue', group: 'interface'},
  'drawing': {title: 'Drawing (interface)', group: 'interface'},
  'export': {title: 'Export and save (interface)', group: 'interface'},
  'files': {title: 'Import, files and library', group: 'interface'},
  'telemetry': {title: 'Telemetry', group: 'interface'},
  'interface-other': {title: 'Other interface code', group: 'interface'},
  'engine-edit': {title: 'Engine: editing commands', group: 'engine'},
  'engine-eval': {title: 'Engine: evaluation and draw lists', group: 'engine'},
  'engine-math': {title: 'Engine: math (sin, cos, atan2, …)', group: 'engine'},
  'engine-render': {title: 'Engine: GPU renderer', group: 'engine'},
  'engine-raster': {title: 'Engine: CPU rasterizer', group: 'engine'},
  'engine-document': {title: 'Engine: document store', group: 'engine'},
  'engine-formats': {title: 'Engine: file formats', group: 'engine'},
  'engine-export': {title: 'Engine: export frames', group: 'engine'},
  'engine-drawing': {title: 'Engine: drawing layers', group: 'engine'},
  'engine-scheduler': {title: 'Engine: scheduler and jobs', group: 'engine'},
  'engine-binding': {title: 'Engine: boundary (wasm-bindgen)', group: 'engine'},
  'engine-json': {title: 'Engine: JSON', group: 'engine'},
  'engine-codecs': {title: 'Engine: image and stream codecs', group: 'engine'},
  'engine-memory': {title: 'Engine: allocation and copying', group: 'engine'},
  'engine-std': {title: 'Engine: Rust standard library', group: 'engine'},
  'engine-other': {title: 'Engine: other', group: 'engine'},
  'browser-gc': {title: 'Garbage collection', group: 'browser'},
  'browser-native': {title: 'Browser (DOM, style, layout, graphics calls)', group: 'browser'},
  'browser-builtin': {title: 'JavaScript built-ins', group: 'browser'},
  'tools': {title: 'Developer tools (measurement)', group: 'tools'},
  'idle': {title: 'Idle', group: 'idle'},
});

/** The layer of a profile's call frame ({functionName, url}). */
export function layerOf({functionName = '', url = ''}) {
  if (functionName === '(idle)') return 'idle';
  if (functionName === '(garbage collector)') return 'browser-gc';
  if (functionName === '(program)' || functionName === '(root)') return 'browser-native';
  if (/^wasm:|\.wasm(\?|$)|wasm-function/.test(url) || /^wasm-function\[/.test(functionName)) return wasmLayer(functionName, url);
  if (!url) return 'browser-builtin';
  const pathname = url.replace(/^[a-z-]+:\/\/[^/]*/i, '');
  for (const [layer, pattern] of MODULES) if (pattern.test(pathname)) return layer;
  return 'interface-other';
}

/** A Rust path as the compiler mangles it names each crate with a hash (`styk_eval[30fd614d899501a1]::geometry`): the path without them. */
const plain = name => name.replace(/\[[0-9a-f]{16}\]/g, '');

function wasmLayer(mangled, url) {
  const name = plain(mangled);
  // A thread parked until there is work is not working: the standard library's waits count as idle.
  if (WAITING.test(name)) return 'idle';
  if (MEMORY.test(name)) return 'engine-memory';
  if (MATH.test(name)) return 'engine-math';
  // V8's own trampolines between JavaScript and WebAssembly: the cost of crossing the boundary.
  if (/^(wasm-to-js|js-to-wasm)/.test(name)) return 'engine-binding';
  // A generic or trait method names several paths: the engine's own crate decides over the standard library's.
  const own = /styk_[a-z_]+/.exec(name);
  if (own && CRATES.has(own[0])) return CRATES.get(own[0]);
  const first = CRATE.exec(name)?.[1];
  if (first && CRATES.has(first)) return CRATES.get(first);
  if (/styk_codec/.test(url)) return 'engine-formats';
  if (/styk_drawing/.test(url)) return 'engine-drawing';
  return 'engine-other';
}

/** A function's name for a table: a Rust path without its hash and generic noise, a JavaScript function as it is. */
export function displayName(functionName) {
  if (!functionName) return '(anonymous)';
  return plain(functionName).replace(/::h[0-9a-f]{16}$/, '').replace(/\$LT\$/g, '<').replace(/\$GT\$/g, '>').replace(/\$u20\$/g, ' ').replace(/\.\./g, '::');
}

/** A Rust function's module (`styk_eval::geometry`), the level a table of engine time groups by; null for other frames. */
export function rustModule(functionName) {
  const path = /(styk_[a-z_]+(?:::[a-z_][a-z0-9_]*){0,2})::/.exec(plain(functionName ?? ''));
  return path ? path[1] : null;
}
