// Private sample projects used by profiling and audit scripts (for example the
// dense "Akane" scene). They are not in the repository. Scripts used to default
// to one developer's Windows path; this resolves the same file from the home
// directory, which is the identical path on that machine and works anywhere the
// files are kept in the same place, or in the folder STYK_CORPUS_DIR names.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a sample project is looked for, whether or not it is there. A test that can do
 * without it passes this to `skipWithoutFixtures` (tests/helpers/local-fixtures.mjs).
 * @param {string} relative Path under the home directory, for example "Downloads/scene.piv".
 * @param {{env?: object, home?: string}} [options]
 * @returns {string}
 */
export function corpusFile(relative, { env = process.env, home = os.homedir() } = {}) {
  return env.STYK_CORPUS_DIR ? path.join(env.STYK_CORPUS_DIR, path.basename(relative)) : path.join(home, ...relative.split('/'));
}

/**
 * @param {string} relative Path under the home directory, for example "Downloads/scene.piv".
 * @param {{env?: object, home?: string, exists?: (file: string) => boolean}} [options]
 * @returns {string} The file to read. Throws, saying what to do, when it is missing.
 */
export function corpusPath(relative, { env = process.env, home = os.homedir(), exists = existsSync } = {}) {
  const file = corpusFile(relative, { env, home });
  if (!exists(file)) {
    const name = path.basename(relative);
    throw new Error(`Sample project not found: ${file}\nPass its path as the first argument, or set STYK_CORPUS_DIR to the folder that contains "${name}".`);
  }
  return file;
}
