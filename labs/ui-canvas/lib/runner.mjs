// Turns one request from the composer into model calls and board changes. Every call is
// stateless and carries only what it needs. Refinements send a patch back rather than a
// whole screen, and a restyle sends no markup at all.
import { randomBytes } from 'node:crypto';
import { applyOp, liveFrames } from '../shared/board-model.mjs';
import { CONCURRENCY, createLimiter, runClaude } from './claude-cli.mjs';
import * as prompts from './prompts.mjs';
import { applyEdits, createScreenParser, goTargets, parseFindings, parseJobs, tagBody } from './screen-stream.mjs';

const id = () => randomBytes(5).toString('hex');
const GAP = 120, ROW_GAP = 180, STREAM_MS = 180, COLUMNS = 5;
const RESTYLE = /<style data-restyle>[\s\S]*?<\/style>\s*/;

export function createRunner({ store, broadcast, command, cwd, systemPromptFile }) {
  const limit = createLimiter(CONCURRENCY);
  const { board } = store;
  const active = new Map();

  const commit = (op) => {
    applyOp(board, op);
    store.touch();
    broadcast({ type: 'op', op, origin: 'server' });
  };
  const call = (prompt, signal, onText, onBegin) => limit(() => {
    if (signal.aborted) return { ok: false, cancelled: true, text: '', usage: { input: 0, output: 0 } };
    onBegin?.();
    return runClaude({ command, cwd, systemPromptFile, prompt, onText, signal });
  });
  const htmlOf = async (frame) => (await store.readScreen(frame.id, frame.version)) ?? '';

  function placeBelow(width) {
    const frames = liveFrames(board);
    const bottom = frames.length ? Math.max(...frames.map((frame) => frame.y + frame.h)) + ROW_GAP : 0;
    const left = frames.length ? Math.min(...frames.map((frame) => frame.x)) : -width / 2;
    return { x: left, y: bottom };
  }
  function placeRightOf(source, width, height) {
    let x = source.x + source.w + GAP;
    const frames = liveFrames(board);
    while (frames.some((frame) => x < frame.x + frame.w && x + width > frame.x && source.y < frame.y + frame.h && source.y + height > frame.y)) x += GAP;
    return { x, y: source.y };
  }

  // The agent reads the request and decides what to make; a plan that names nothing means one job.
  async function plan(job, signal, run, source) {
    commit({ op: 'upsertRun', run: { id: run.id, phase: 'planning' } });
    const result = await call(prompts.planPrompt({ prompt: job.prompt, source, tasteFrames: liveFrames(board) }), signal);
    commit({ op: 'upsertRun', run: { id: run.id, phase: null } });
    if (!result.ok) return { result, jobs: [] };
    const jobs = parseJobs(result.text, prompts.MAX_JOBS);
    return { result, jobs: jobs.length ? jobs : [{ title: 'New screen', brief: job.prompt, flow: false, free: false }] };
  }

  function placeholder({ run, group, title, x, y, w, h, prompt, theme }) {
    const frame = { id: id(), run, group, title, idea: '', x, y, w, h, theme: theme ?? 'light', tags: [], version: 0, versions: [], links: [], status: 'queued', startedAt: Date.now(), prompt };
    commit({ op: 'addFrame', frame });
    return frame;
  }

  async function saveVersion(frame, html, { prompt, usage, patch }) {
    const n = (frame.versions.at(-1)?.n ?? 0) + 1;
    await store.writeScreen(frame.id, n, html);
    commit({ op: 'addVersion', id: frame.id, meta: { n, prompt, at: Date.now(), ms: Date.now() - (frame.startedAt ?? Date.now()), tokens: usage ? usage.input + usage.output : 0 }, patch });
  }

  function linkGroup(group) {
    const frames = liveFrames(board).filter((frame) => frame.group === group);
    for (const frame of frames) {
      const links = (frame.targets ?? []).map((target) => frames.find((other) => other.screenId === target)?.id).filter(Boolean);
      if (links.length) commit({ op: 'patchRunnerFrame', id: frame.id, patch: { links } });
    }
  }

  // One streaming call: the first <screen> fills `frame`; any others become new frames in its group.
  async function streamScreens({ frame, prompt, label, signal, placeNext }) {
    let current = null, html = '', last = 0, count = 0, frameForScreen = frame;
    const pending = [];
    const parser = createScreenParser({
      onOpen(attributes) {
        current = frameForScreen = count++ === 0 ? frame : placeholder({ ...placeNext(count - 1), run: frame.run, group: frame.group, title: attributes.title ?? 'Screen', w: frame.w, h: frame.h, prompt: label });
        html = '';
        commit({ op: 'patchRunnerFrame', id: current.id, patch: { status: 'streaming', title: attributes.title ?? current.title, idea: attributes.idea ?? '', screenId: attributes.id ?? null, theme: attributes.theme === 'dark' ? 'dark' : current.theme } });
      },
      onDelta(text) {
        html += text;
        const now = Date.now();
        if (now - last >= STREAM_MS) { last = now; broadcast({ type: 'stream', id: current.id, html }); }
      },
      onClose() {
        const done = current, body = html.trim();
        commit({ op: 'patchRunnerFrame', id: done.id, patch: { targets: goTargets(body) } });
        pending.push({ frame: done, html: body });
        current = null;
      },
    });
    const result = await call(prompt, signal, (text) => parser.feed(text), () => commit({ op: 'patchRunnerFrame', id: frame.id, patch: { status: 'thinking', startedAt: Date.now() } }));
    const cut = parser.end();
    for (const screen of pending) await saveVersion(screen.frame, screen.html, { prompt: label, usage: pending.length === 1 ? result.usage : null });
    if (!pending.length && !result.cancelled) {
      const error = result.error ?? 'The model replied without a screen.';
      commit({ op: 'patchRunnerFrame', id: frame.id, patch: { status: 'error', error } });
    } else if (!pending.length) {
      commit({ op: 'deleteFrames', ids: [frame.id] });
    } else if (cut && !result.cancelled) {
      commit({ op: 'patchRunnerFrame', id: pending.at(-1).frame.id, patch: { error: 'This screen was cut short.' } });
    }
    return result;
  }

  async function patchCall({ frames, prompt, signal, apply }) {
    for (const frame of frames) commit({ op: 'patchRunnerFrame', id: frame.id, patch: { status: 'thinking', startedAt: Date.now(), error: null } });
    const result = await call(prompt, signal);
    let failure = result.cancelled ? null : result.error;
    if (result.ok) {
      try { await apply(result); } catch (error) { failure = error.message; }
    }
    for (const frame of frames) {
      if (frame.status === 'thinking') commit({ op: 'patchRunnerFrame', id: frame.id, patch: { status: frame.versions.length ? 'ready' : 'error', error: failure } });
    }
    return result;
  }

  const tasks = {
    async create(job, signal, run) {
      const { prompt, size, theme } = job;
      const { result, jobs } = await plan(job, signal, run);
      if (!jobs.length) return [result];
      const start = placeBelow(size.w);
      const planned = jobs.map((item, index) => ({
        item,
        group: id(),
        x: start.x + (index % COLUMNS) * (size.w + GAP),
        y: start.y + Math.floor(index / COLUMNS) * (size.h + ROW_GAP),
      })).map((slot) => ({ ...slot, frame: placeholder({ run: run.id, group: slot.group, title: slot.item.title, x: slot.x, y: slot.y, w: size.w, h: size.h, prompt, theme }) }));
      const results = planned.map(({ item, group, x, frame }) => {
        const text = prompts.createPrompt({ prompt, job: item, size, tasteFrames: liveFrames(board) });
        return streamScreens({ frame, prompt: text, label: prompt, signal, placeNext: () => ({ x, y: frame.y }) }).then((screens) => { linkGroup(group); return screens; });
      });
      return [result, ...await Promise.all(results)];
    },
    async variants(job, signal, run) {
      const [source] = job.sources;
      const html = await htmlOf(source);
      const { result, jobs } = await plan(job, signal, run, source);
      if (!jobs.length) return [result];
      const planned = jobs.map((item) => {
        const frame = placeholder({ run: run.id, group: id(), title: item.title, ...placeRightOf(source, source.w, source.h), w: source.w, h: source.h, prompt: job.prompt, theme: source.theme });
        return { item, frame };
      });
      const results = planned.map(({ item, frame }) => {
        const text = prompts.variantPrompt({ prompt: job.prompt, source, html, job: item, tasteFrames: liveFrames(board) });
        return streamScreens({ frame, prompt: text, label: job.prompt || item.title, signal, placeNext: () => ({ x: frame.x, y: frame.y }) });
      });
      return [result, ...await Promise.all(results)];
    },
    async next(job, signal, run) {
      const [source] = job.sources;
      const html = await htmlOf(source);
      const frame = placeholder({ run: run.id, group: source.group, title: 'Next screen', x: source.x, y: source.y, w: source.w, h: source.h, prompt: job.prompt, theme: source.theme });
      const result = await streamScreens({ frame, prompt: prompts.nextPrompt({ prompt: job.prompt, source, html }), label: job.prompt, signal, placeNext: () => ({ x: frame.x, y: frame.y }) });
      commit({ op: 'patchRunnerFrame', id: source.id, patch: { targets: [...new Set([...(source.targets ?? []), frame.screenId].filter(Boolean))] } });
      linkGroup(source.group);
      return [result];
    },
    async combine(job, signal, run) {
      const sources = await Promise.all(job.sources.map(async (frame) => ({ frame, html: await htmlOf(frame) })));
      const [first] = job.sources;
      const place = placeRightOf(job.sources.at(-1), first.w, first.h);
      const frame = placeholder({ run: run.id, group: id(), title: 'Combined', ...place, w: first.w, h: first.h, prompt: job.prompt, theme: first.theme });
      return [await streamScreens({ frame, prompt: prompts.combinePrompt({ prompt: job.prompt, sources }), label: job.prompt, signal, placeNext: () => ({ x: frame.x, y: frame.y }) })];
    },
    async refine(job, signal) {
      const [source] = job.sources;
      const html = await htmlOf(source);
      return [await patchCall({
        frames: [source], signal, prompt: prompts.refinePrompt({ prompt: job.prompt, source, html }),
        apply: async (result) => {
          const edited = applyEdits(html, result.text);
          if (!edited.html) throw new Error('The change did not match the screen. Try wording it again.');
          await saveVersion(source, edited.html, { prompt: job.prompt, usage: result.usage, patch: { targets: goTargets(edited.html) } });
        },
      })];
    },
    async element(job, signal) {
      const [source] = job.sources;
      const { before, after, html: element } = job.element;
      return [await patchCall({
        frames: [source], signal, prompt: prompts.elementPrompt({ prompt: job.prompt, source, element }),
        apply: async (result) => {
          const fragment = tagBody(result.text, 'fragment');
          if (fragment === null) throw new Error('The model replied without a replacement.');
          await saveVersion(source, `${before}${fragment.trim()}${after}`, { prompt: job.prompt, usage: result.usage });
        },
      })];
    },
    async restyle(job, signal) {
      const sources = job.sources.map((frame) => ({ frame }));
      return [await patchCall({
        frames: job.sources, signal, prompt: prompts.restylePrompt({ prompt: job.prompt, sources }),
        apply: async (result) => {
          const tokens = tagBody(result.text, 'tokens');
          if (!tokens) throw new Error('The model replied without a style.');
          for (const frame of job.sources) {
            const html = (await htmlOf(frame)).replace(RESTYLE, '');
            await saveVersion(frame, `<style data-restyle>${tokens.trim()}</style>\n${html}`, { prompt: job.prompt, usage: frame === job.sources[0] ? result.usage : null });
          }
        },
      })];
    },
    async critique(job, signal) {
      const [source] = job.sources;
      const html = await htmlOf(source);
      return [await patchCall({
        frames: [source], signal, prompt: prompts.critiquePrompt({ prompt: job.prompt, source, html }),
        apply: async (result) => {
          const findings = parseFindings(result.text);
          if (!findings.length) throw new Error('The model replied without findings.');
          commit({ op: 'setCritique', id: source.id, critique: findings });
        },
      })];
    },
  };

  return {
    start(job) {
      const run = { id: id(), intent: job.intent, prompt: job.prompt, state: 'running', startedAt: Date.now(), tokens: 0, output: 0 };
      const controller = new AbortController();
      active.set(run.id, controller);
      commit({ op: 'upsertRun', run });
      tasks[job.intent](job, controller.signal, run)
        .then((results) => {
          const usage = results.reduce((sum, result) => ({ input: sum.input + result.usage.input, output: sum.output + result.usage.output }), { input: 0, output: 0 });
          const failed = results.find((result) => !result.ok && !result.cancelled);
          commit({ op: 'upsertRun', run: { id: run.id, state: controller.signal.aborted ? 'cancelled' : failed ? 'failed' : 'done', error: failed?.error ?? null, tokens: usage.input + usage.output, output: usage.output, ms: Date.now() - run.startedAt } });
        })
        .catch((error) => { console.error(error); commit({ op: 'upsertRun', run: { id: run.id, state: 'failed', error: error.message, ms: Date.now() - run.startedAt } }); })
        .finally(() => active.delete(run.id));
      return run.id;
    },
    cancel(runId) { active.get(runId)?.abort(); return active.has(runId); },
    cancelAll() { for (const controller of active.values()) controller.abort(); },
  };
}
