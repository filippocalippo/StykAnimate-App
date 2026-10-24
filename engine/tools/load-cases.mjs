// The synthetic documents of the load-normalization fixtures (load-fixtures.mjs): one document per branch of
// the editor's load (src/editor-load.mjs) and one invalid document per refusal it can raise. Each starts from
// a document the repository already holds and changes it where the branch is; the editor, run on the result
// by load-fixtures.mjs, says what the engine must answer.
import {readFileSync} from 'node:fs';
import path from 'node:path';

export async function syntheticDocuments({repo}) {
  const cases = [];
  const read = name => JSON.parse(readFileSync(path.join(repo, 'engine/tests/edit', `${name}.document.json`), 'utf8'));
  /** A copy of the base document `base`, changed by `edit` (which mutates it or returns another document). */
  const variant = (base, name, edit) => {
    const document = structuredClone(typeof base === 'string' ? read(base) : base);
    cases.push({name, input: edit(document) ?? document});
  };

  variant('startup', 'valid-startup', () => {});
  variant('startup', 'empty-animation', document => { document.keyframes = []; });
  return cases;
}
