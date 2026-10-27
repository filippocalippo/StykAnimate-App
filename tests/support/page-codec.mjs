/** In a page of the app (the development server serves /tests): one request to the Pivot codec,
 * made as an import or export job makes it, through the page's codec worker. Answers like the
 * HTTP codec service did, with a standard Response, and like `fetch` it leaves the caller's
 * body usable (a job transfers its buffer to the codec; this sends a copy).
 *
 *   const {codecFetch} = await import('/tests/support/page-codec.mjs');
 *   const response = await codecFetch('/api/export', {method: 'POST', body: JSON.stringify({document, format: 'piv'})});
 */
import {codecJob} from '/src/codec-job.mjs';
import {codecRequest} from '/src/codec-request.mjs';

export async function codecFetch(path, init = {}) {
  const body = init.body instanceof ArrayBuffer ? init.body.slice(0) : ArrayBuffer.isView(init.body) ? init.body.slice() : init.body;
  const job = codecJob();
  try { return await codecRequest(job.link().fields, String(path), {...init, body}); }
  finally { job.finish(); }
}
