// The owner's suites again with tables of two records and verify mode not holding them: every record is given back almost at once and fetched again
// from the session, so a patch that assumed the view held a record, an identity that changed with a fetch, or a record that lost what was written
// in place shows. The suites chosen write nothing to the read view themselves (others do, and a small cache gives that back).
import {limitRecords} from '../src/lazy-table.mjs';

limitRecords(2);
for (const suite of [
  'engine-owner', 'engine-owner-gestures', 'engine-owner-commands', 'engine-owner-movieclip-scope', 'engine-owner-tabs', 'engine-owner-topology',
  'engine-owner-clipboards', 'engine-owner-reads', 'engine-owner-misc', 'engine-owner-undefined', 'engine-owner-origins', 'engine-owner-ik-joined',
  'engine-owner-drawing', 'engine-owner-bake', 'engine-patch', 'lazy-payload',
]) await import(`./${suite}.test.mjs`);
