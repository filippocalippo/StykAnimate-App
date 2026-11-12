// Lint for mistakes, not for style: every rule here reports code that is wrong or cannot do what it says
// (a name that does not exist, a key written twice, a comparison that is always false). `npm run lint` runs it and
// the Tests workflow requires it. Formatting and taste are left to the author and to review.
import globals from 'globals';

const mistakes = {
  'constructor-super': 'error',
  'for-direction': 'error',
  'getter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-class-assign': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-const-assign': 'error',
  'no-constant-binary-expression': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-ex-assign': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-invalid-regexp': 'error',
  'no-loss-of-precision': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-obj-calls': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-setter-return': 'error',
  'no-this-before-super': 'error',
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-unused-private-class-members': 'error',
  'no-useless-backreference': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

export default [
  // Generated, vendored or not this application's code.
  {ignores: ['src/engine/pkg/**', 'vendor/**', 'build/**', 'release/**', 'artifacts/**', 'engine/**', 'experiments/**', 'web/node_modules/**', 'tmp/**']},
  {
    files: ['**/*.{mjs,cjs,js}'],
    linterOptions: {reportUnusedDisableDirectives: 'error'},
    languageOptions: {ecmaVersion: 'latest', sourceType: 'module'},
    rules: mistakes,
  },
  // The interface: pages and their workers.
  {files: ['src/**', 'web/*.js'], languageOptions: {globals: {...globals.browser, ...globals.worker, ...globals.serviceworker}}},
  // The desktop shell.
  {files: ['desktop/**/*.cjs'], languageOptions: {sourceType: 'commonjs', globals: globals.node}},
  // Tools and tests run in Node; a browser test also holds functions that run in the page, where `styk` is the app's handle.
  {files: ['scripts/**', 'tests/**', 'backend/**/*.mjs', 'engine/tools/**', '*.mjs'], languageOptions: {globals: {...globals.node, ...globals.browser, styk: 'readonly'}}},
  {files: ['**/*.cjs'], languageOptions: {sourceType: 'commonjs'}},
  // The Stick Nodes reader also runs in Node (its tests, the tools): it asks whether `process` and `Buffer` exist before using them.
  {files: ['src/sticknodes/**'], languageOptions: {globals: {process: 'readonly', Buffer: 'readonly'}}},
  // Scripts that drive the app hold functions that run in its page, where the page's own names exist: an undefined
  // name cannot be told from one of those here. Their mistakes show when the script runs.
  {
    files: ['tests/**/*.browser.mjs', 'tests/**/*.desktop.mjs', 'tests/document-export-browser.mjs', 'tests/import-client-only.mjs', 'tests/join-interaction-profile.mjs',
      'scripts/smoke-*.mjs', 'scripts/benchmark-*.{mjs,cjs}', 'scripts/dense-drag-benchmark.mjs', 'scripts/corpus-gestures.mjs'],
    rules: {'no-undef': 'off'},
  },
];
