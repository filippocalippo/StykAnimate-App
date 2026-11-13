/**
 * One connection to a browser's inspector protocol (the Chrome DevTools Protocol), over the port a developer launch
 * opens (docs/PERFORMANCE.md "How a run reaches the app").
 *
 * The runner needs what a page-level client does not give: every thread of the app (the page, each engine worker, the
 * export and codec workers) as a target of its own, so each can be profiled, and the browser-level domains (tracing,
 * the processes' CPU time). One WebSocket carries them all; a target is a session id.
 */
import WebSocket from 'ws';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Inspector {
  /** Connects to the browser listening on `port`, waiting up to `timeoutMs` for it to open. */
  static async connect(port, {timeoutMs = 30000, alive = () => true} = {}) {
    const deadline = Date.now() + timeoutMs;
    let version = null;
    while (!version) {
      if (!alive()) throw new Error('The app exited before its inspector port opened.');
      try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(2000)})).json(); }
      catch { if (Date.now() > deadline) throw new Error(`No inspector answered on port ${port} within ${Math.round(timeoutMs / 1000)} s.`); await sleep(100); }
    }
    const socket = new WebSocket(version.webSocketDebuggerUrl, {perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024});
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const inspector = new Inspector(socket, version);
    await inspector.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
    return inspector;
  }

  constructor(socket, version) {
    this.socket = socket;
    this.browser = version.Browser ?? '';
    /** Every attached target by session id: {sessionId, type ('page', 'worker', …), title, url, parent (session id or null)}. */
    this.targets = new Map();
    this.nextId = 1;
    this.waiting = new Map();
    this.listeners = new Map();
    this.targetListeners = new Set();
    this.closed = false;
    socket.on('message', raw => this.#receive(JSON.parse(raw)));
    socket.on('close', () => {
      this.closed = true;
      for (const pending of this.waiting.values()) pending.reject(new Error('The app closed the inspector connection.'));
      this.waiting.clear();
    });
    socket.on('error', () => {});
  }

  #receive(message) {
    if (message.id !== undefined) {
      const pending = this.waiting.get(message.id);
      if (!pending) return;
      this.waiting.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      const {sessionId, targetInfo} = message.params;
      const target = {sessionId, type: targetInfo.type, title: targetInfo.title, url: targetInfo.url, parent: message.sessionId ?? null};
      this.targets.set(sessionId, target);
      // A page's workers are its own children: ask each new target for them too.
      this.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true}, sessionId).catch(() => {});
      for (const listener of this.targetListeners) listener(target, true);
    } else if (message.method === 'Target.detachedFromTarget') {
      const target = this.targets.get(message.params.sessionId);
      this.targets.delete(message.params.sessionId);
      if (target) for (const listener of this.targetListeners) listener(target, false);
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params, message.sessionId ?? null);
  }

  /** Sends one command to the browser, or to the target `sessionId`; resolves with its result. */
  send(method, params = {}, sessionId = null) {
    if (this.closed) return Promise.reject(new Error(`${method}: the inspector connection is closed.`));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.waiting.set(id, {resolve, reject, method});
      this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }

  /** Calls `listener(params, sessionId)` for every `method` event; returns the function that stops it. */
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }

  /** Calls `listener(target, attached)` when a target attaches or detaches; returns the function that stops it. */
  onTarget(listener) { this.targetListeners.add(listener); return () => this.targetListeners.delete(listener); }

  /** The workers of the page `sessionId` (its engine threads, its export and codec workers). */
  workersOf(sessionId) { return [...this.targets.values()].filter(target => target.type === 'worker' && target.parent === sessionId); }

  close() { if (!this.closed) this.socket.close(); }
}
