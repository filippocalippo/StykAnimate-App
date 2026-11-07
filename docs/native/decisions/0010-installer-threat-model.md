# N10. What the installer and uninstaller protect against

**Date:** 2026-11-07. **Status:** accepted.

**Context.** Spike S6's installer was reviewed three times for data loss (`perf/native/spikes/reviews/S6-*`). The first two
reviews found real defects: an uninstall record pointed elsewhere made the old uninstaller delete an unrelated folder, and
a file named `StykAnimate.exe` passed for an installation. Those are fixed at the root (a manifest-based native uninstaller
that never deletes a folder recursively, today's uninstaller run only on a validated record, non-empty destinations
refused). The third review asked for removal through verified handles, inventories of every Electron version, and
directory identities, against processes that rename folders, plant junctions or edit the manifest during an uninstall.

**Decision.** The installer protects a person's files against **mistakes and inconsistent state**: stale or damaged
uninstall records, a destination that is not ours, both install scopes present, two Setups at once, an interrupted
upgrade. It does not defend against a process that already has the rights to change the installation folder: for a
per-user install that is the person's own processes, which can delete those files directly; for an all-users install, in
Program Files, only administrators can write there. Within that model:

- The native uninstaller removes only its manifest's entries, never through a reparse point (a junction or symbolic link
  anywhere in an entry's path, the installation folder included), and never a folder with contents.
- The upgrade from today's app runs today's electron-builder uninstaller on a validated installation, as today's own
  updates do; it removes what today's updates remove (the whole installation folder). Files a person put inside the
  installation folder are not kept, as today.
- Case-sensitive directories (WSL per-folder case sensitivity) and 8.3 spellings are refused or treated as today's NSIS
  installers treat them.

**Why.** Each defended case is one a person can reach by accident. Defending against a process with the same rights
costs handle-based removal, version inventories and identity comparisons in NSIS for no protection that process could not
bypass by deleting the files itself.
