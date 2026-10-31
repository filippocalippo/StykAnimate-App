'use strict';
const fs = require('node:fs/promises');

// On Windows a virus scanner or an indexer can hold a file that was just written for a moment, and the rename onto its name fails with
// one of these. The failure passes, so it is tried again for about a second; a real refusal (a read-only target) is reported then.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const DELAYS_MS = [20, 40, 80, 160, 320, 400];

/** `fs.rename(from, to)`, tried again after a transient failure; the last failure is thrown as it was. */
async function renameWithRetry(from, to, delays = DELAYS_MS) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); }
    catch (error) {
      if (!TRANSIENT.has(error?.code) || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

module.exports = { renameWithRetry };
