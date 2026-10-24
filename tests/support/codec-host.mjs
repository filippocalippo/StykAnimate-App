/** A stand-in for the page's codec host (src/codec-web-host.mjs) for unit tests: it records
 * what jobs do (register, link, release, cancel) and answers every request sent over a
 * linked port with `answer(request)`, as the codec worker would. `answer` returns
 * {status, headers, body} (body: string, ArrayBuffer or nothing) or nothing to stay silent.
 * Call close() after the test: open ports keep Node alive. */
const encoder = new TextEncoder(), decoder = new TextDecoder();

export class FakeCodecHost {
  constructor(answer = () => ({status: 204})) {
    this.answer = answer;
    this.events = [];
    this.requests = [];
    this.jobs = new Set();
    this.channels = [];
    this.cancellations = [];
  }

  register(jobId) { this.jobs.add(jobId); this.events.push(['register', jobId]); }

  link(jobId) {
    // After close() nothing may open a port again (cleanup that runs late would keep Node alive).
    if (!this.jobs.has(jobId) || this.closed) throw new DOMException('The codec job was cancelled.', 'AbortError');
    const channel = new MessageChannel();
    this.channels.push(channel);
    channel.port2.onmessage = async ({data}) => {
      const body = data.body instanceof ArrayBuffer || ArrayBuffer.isView(data.body) ? data.body : new Uint8Array(0);
      const request = {...data, jobId, text: decoder.decode(body)};
      this.requests.push(request);
      const reply = await this.answer(request);
      if (!reply) return;
      const bytes = reply.body == null ? new ArrayBuffer(0) : typeof reply.body === 'string' ? encoder.encode(reply.body).buffer : reply.body;
      try { channel.port2.postMessage({id: data.id, status: reply.status ?? 200, headers: reply.headers ?? {}, body: bytes}, [bytes]); }
      catch { /* The test closed the port. */ }
    };
    this.events.push(['link', jobId]);
    return {fields: {codecPort: channel.port1}, transfer: [channel.port1]};
  }

  release(jobId) { if (this.jobs.delete(jobId)) this.events.push(['release', jobId]); }

  cancel(jobId) { if (this.jobs.delete(jobId)) { this.events.push(['cancel', jobId]); this.cancellations.push(jobId); } }

  /** Job ids in the order they were cancelled (`cancellations` is the same list, kept live). */
  get cancelled() { return [...this.cancellations]; }

  /** Requests to `path` (without its query), in arrival order. */
  sent(path) { return this.requests.filter(request => request.path.split('?')[0] === path); }

  close() { this.closed = true; for (const channel of this.channels.splice(0)) { channel.port1.close(); channel.port2.close(); } }
}
