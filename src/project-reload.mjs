/** Serialize disk reloads and refuse stale reads without replacing the live document. */
export function createProjectReloader({busy, settle, confirm, capture, isCurrent, read, decode, apply, release = () => {}}) {
  let active = false;
  return {
    get active() { return active; },
    async run() {
      if (active || busy()) return false;
      active = true;
      let decoded;
      try {
        if (!await settle() || !await confirm()) return false;
        const checkpoint = capture();
        const file = await read(checkpoint);
        if (!file || !isCurrent(checkpoint)) return false;
        decoded = await decode(file);
        if (!decoded || !isCurrent(checkpoint)) return false;
        return await apply(decoded, file);
      } finally {
        try { if (decoded) await release(decoded); }
        finally { active = false; }
      }
    },
  };
}
