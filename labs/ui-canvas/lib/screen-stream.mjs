// Reads <screen ...>...</screen> blocks out of model text as it arrives, however the
// chunks fall. Text outside a block (a stray fence or sentence) is ignored.

const OPEN = /<screen\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i;
const CLOSE = '</screen>';

export function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([a-zA-Z_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[match[1].toLowerCase()] = match[2] ?? match[3];
  return attributes;
}

export function createScreenParser({ onOpen, onDelta, onClose }) {
  let buffer = '', inside = false;
  const pump = () => {
    for (;;) {
      if (!inside) {
        const match = OPEN.exec(buffer);
        if (!match) {
          const start = buffer.lastIndexOf('<');
          buffer = start >= 0 ? buffer.slice(start) : '';
          return;
        }
        buffer = buffer.slice(match.index + match[0].length);
        inside = true;
        onOpen(parseAttributes(match[1]));
        continue;
      }
      const end = buffer.indexOf(CLOSE);
      if (end >= 0) {
        if (end) onDelta(buffer.slice(0, end));
        buffer = buffer.slice(end + CLOSE.length);
        inside = false;
        onClose();
        continue;
      }
      // Hold back only what could still become the closing tag.
      const last = buffer.lastIndexOf('<');
      const safe = last >= 0 && last >= buffer.length - CLOSE.length && CLOSE.startsWith(buffer.slice(last)) ? last : buffer.length;
      if (safe) { onDelta(buffer.slice(0, safe)); buffer = buffer.slice(safe); }
      return;
    }
  };
  return {
    feed(text) { buffer += text; pump(); },
    // A stream cut short still yields what arrived, so the person keeps a partial screen.
    end() {
      if (!inside) return false;
      if (buffer) onDelta(buffer);
      buffer = '';
      inside = false;
      onClose();
      return true;
    },
  };
}

// <edit><find>..</find><replace>..</replace></edit> hunks. All apply, or none do.
export function applyEdits(html, response) {
  const hunks = [...response.matchAll(/<edit>\s*<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>\s*<\/edit>/g)];
  if (!hunks.length) return { html: null, failed: 'no edits in the response' };
  let next = html;
  for (const [, find, replace] of hunks) {
    const at = next.indexOf(find);
    if (at < 0) return { html: null, failed: find.slice(0, 80) };
    next = next.slice(0, at) + replace + next.slice(at + find.length);
  }
  return { html: next, count: hunks.length };
}

export const tagBody = (text, tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? null;
export const goTargets = (html) => [...new Set([...html.matchAll(/data-go\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]))];

export function parseJobs(text, limit) {
  return [...text.matchAll(/<job\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g)]
    .map((match) => parseAttributes(match[1]))
    .filter((job) => job.brief)
    .slice(0, limit)
    .map((job) => ({ title: job.title || 'Direction', brief: job.brief, flow: job.flow === 'true', free: job.free === 'true' }));
}

export function parseFindings(text) {
  return [...text.matchAll(/<finding\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g)]
    .map((match) => parseAttributes(match[1]))
    .filter((finding) => finding.title)
    .map(({ sev, title, why, fix }) => ({ sev: sev ?? 'med', title, why: why ?? '', fix: fix ?? title }));
}
