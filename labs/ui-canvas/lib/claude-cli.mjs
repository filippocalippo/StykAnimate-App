// One model call through the local `claude` CLI. The flags strip the CLI's default system
// prompt, tools, MCP servers, skills and settings: measured on 2026-11-06 that takes the
// baseline from about 27,000 input tokens to about 700, and a call can touch nothing on
// disk. The model and effort are fixed by the owner; there is deliberately no other tier.
import { spawn } from 'node:child_process';

export const MODEL = 'opus';
export const EFFORT = 'high';
export const CONCURRENCY = 6;
export const TIMEOUT_MS = 6 * 60_000;

export function cliArguments(systemPromptFile) {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence',
    '--model', MODEL, '--effort', EFFORT, '--tools', '', '--system-prompt-file', systemPromptFile,
    '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', ''];
}

// This server may be started from inside a Claude Code session; a child must not inherit it.
export function childEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key === 'CLAUDECODE' || /^CLAUDE_(CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|EXECPATH|MESSAGING_\w+)|PID|EFFORT|AGENT_SDK_VERSION)$/.test(key)) delete clean[key];
  }
  return clean;
}

export function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try { return await task(); }
    finally { active--; waiting.shift()?.(); }
  };
}

const summarize = (usage = {}) => ({
  input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
  output: usage.output_tokens ?? 0,
});

export function runClaude({ command, cwd, systemPromptFile, prompt, onText, signal }) {
  return new Promise((resolve) => {
    const [file, ...prefix] = command;
    const child = spawn(file, [...prefix, ...cliArguments(systemPromptFile)], { cwd, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let text = '', stderr = '', result = null, pending = '', settled = false;
    const kill = () => { if (child.exitCode === null) child.kill(); };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => { kill(); finish({ ok: false, cancelled: true, text, usage: summarize() }); };
    const timer = setTimeout(() => { kill(); finish({ ok: false, error: 'The model took too long and was stopped.', text, usage: summarize() }); }, TIMEOUT_MS);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });

    const line = (raw) => {
      if (!raw.trim()) return;
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      const delta = event.type === 'stream_event' ? event.event?.delta : null;
      if (delta?.type === 'text_delta') { text += delta.text; onText?.(delta.text); }
      if (event.type === 'result') result = event;
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      lines.forEach(line);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish({ ok: false, error: error.code === 'ENOENT' ? 'The claude command was not found on PATH.' : error.message, text, usage: summarize() }));
    child.on('close', () => {
      line(pending);
      if (!result) { finish({ ok: false, error: stderr.trim().slice(0, 400) || 'The CLI stopped without a result.', text, usage: summarize() }); return; }
      finish({
        ok: !result.is_error,
        error: result.is_error ? String(result.result ?? 'The model returned an error.').slice(0, 400) : null,
        text: result.is_error ? text : (result.result ?? text),
        usage: summarize(result.usage),
        ms: result.duration_ms,
      });
    });
    child.stdin.end(prompt);
  });
}
