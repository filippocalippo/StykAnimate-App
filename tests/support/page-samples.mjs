/** In a page whose test called exposeWorkspaceSamples (workspace-samples.mjs): the ImportClient
 * `readSample` the desktop bridge provides in the desktop app. */
export function sampleReader() {
  return async relative => {
    const answer = await window.stykTestReadSample(relative);
    return answer.ok ? {ok: true, name: answer.name, bytes: Uint8Array.fromBase64(answer.base64)} : answer;
  };
}
