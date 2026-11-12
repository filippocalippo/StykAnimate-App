import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Pivot corpora live beside the repository (the codec's WORKSPACE), private
 * sample projects under the home folder (tests/support/corpus.mjs), and built
 * encoders/generated inventories are not committed. Tests that read them skip,
 * naming the missing path, in a clean checkout such as CI. Set
 * STYK_REQUIRE_FIXTURES=1 to run them anyway so a missing corpus fails loudly.
 * Paths are relative to the repository root, or absolute.
 * @returns {string|false} The reason to skip, or false when every path exists. */
export function missingFixture(...paths) {
  if (process.env.STYK_REQUIRE_FIXTURES === '1') return false;
  const missing = paths.filter(file => !existsSync(path.resolve(repositoryRoot, file)));
  return missing.length ? `requires local fixture: ${missing.join(', ')}` : false;
}

/** The same check for a standalone script (tests/*.browser.mjs): when a path is
 * missing it prints `SKIP <reason>` and exits with 0, which
 * scripts/run-browser-tests.mjs reports as skipped. Call it before launching a browser. */
export function skipWithoutFixtures(...paths) {
  const reason = missingFixture(...paths);
  if (!reason) return;
  console.log(`SKIP ${reason}`);
  process.exit(0);
}
