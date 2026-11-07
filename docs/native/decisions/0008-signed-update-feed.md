# N8. The native updater verifies a signed feed

**Date:** 2026-11-07. **Status:** accepted.

**Context.** Today's app updates through electron-updater: it reads `latest.yml` from the selected GitHub release over
HTTPS and verifies the installer against the feed's `sha512` and size. Windows builds are not code-signed
(`docs/UPDATES.md`), so nothing proves that the feed itself came from the project: whoever can change the release's files
can change the installer and its hash together. The native shell (spike S6, `docs/native/shell.md`) ports the updater.

**Decision.** The native updater keeps today's feed format, release resolution and `sha512` and size check, and adds one
step: `latest.yml.sig`, an Ed25519 signature over the exact feed bytes, verified with a public key compiled into the app
(`UPDATE_PUBLIC_KEY`). A build without a key has no updater (it says so, as today's development copies do). Downgrades and
prereleases are refused, as today.

**What the owner does before the first native release** (listed in the Handoff; nothing is published in this phase):
generate the key pair once (`release_feed keygen`), keep the private key out of the repository and out of CI logs, give the
release workflow the signing step, and build the release with the public key.

**Why.** The signature costs one small file per release and one check, and closes the case where the release files are
replaced; it does not depend on a code-signing certificate the project does not have. The upgrade from today's app is
unaffected: the last Electron release's electron-updater installs the native Setup through today's `latest.yml` and hash
check, and the native updater's requirement starts with the first native release.
