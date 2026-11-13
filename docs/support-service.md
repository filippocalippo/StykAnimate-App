# Reports and feedback

The public `/feedback/` page and the app's Help, Settings and Privacy feedback actions
use the same `SupportCenter` UI. The owner works in `/admin/` → Reports.
Support is independent of statistics ([STATISTICS.md](STATISTICS.md)). Sending a report never changes them
or uploads a project automatically.

## User experience

- The website page is a compact heading followed directly by the shared form, so the new
  report step is the first thing a visitor sees. Inbox access actions stay in the form's own
  menu; the page adds no copy, cards or controls of its own.
- Bug/performance reports ask for a title, description, reproduction steps and expected
  behavior. Ideas have a shorter form. Version, system, frequency and display name
  are optional on the website; the app supplies its trusted version/platform.
- Reports are private conversations. Replies, status, selected files and prior messages
  remain together. Resolved/waiting reports return to review when the creator replies.
  Closed/spam reports are read-only for the creator; the administrator can reopen them.
- Website text drafts are bounded and saved locally. The app saves its inbox, text
  drafts and last-open conversation automatically across restarts in native preferences,
  with up to twelve drafts per inbox and two inboxes retained. Files stay in memory until explicitly
  submitted. Failed requests preserve drafts. Stable request IDs make retries idempotent.
- The latest 30 visible messages open first. Earlier messages and lists use cursors.
  A visible conversation receives change hints through a hibernating WebSocket.
  Idle chats perform no polling, heartbeats or database reads. Reconnecting fetches
  missed replies; hidden/closed views disconnect. Five bounded reconnect attempts
  precede manual refresh. Sent messages appear immediately with a sending state,
  then the server receipt. Lists refresh manually.
- A private access link restores an inbox in another browser or the app. Anyone with
  that link can access all conversations in that inbox. Save it before clearing browser
  data. There is no email identity or password-reset service. Users can export a
  conversation and delete a report or attachment themselves.

## Moderation

The admin workspace uses the site's Inter typeface, charcoal surfaces and blue accents.
Reports is a three-pane inbox: a rail with the unread, new, in-progress, assigned,
follow-up-due and resolved queues plus type/status/priority filters and the storage
widget; a conversation list with title/ID search; and the open report with its
timeline and composer beside a Properties column. Properties hold status, priority,
assignment to the owner, a follow-up date, five comma-separated tags and duplicate
references; changes are version-checked and saved explicitly. Replies and private notes
share one composer with a note switch and Ctrl+Enter to send. Server-generated
moderation history appears as compact events in the timeline. The sidebar shows the
count of reports awaiting a reply from one bounded list request per visit, never polling.
A List/Board switch in the rail (remembered in the browser) turns the same filtered list
into a Kanban board with one column per status. The board loads at most four ordinary
list pages, so it shows the latest 120 matching reports and says so when more exist.
Cards move between columns by drag and drop or through their status control; each move is
the same version-checked PATCH the Properties column uses, followed by one list reload.
Every card shows its priority; hover or keyboard focus previews the full original description,
with scrolling for long reports and Escape to dismiss. Admin list pages include the original
message through an indexed lookup, so previews require no extra requests or read receipts.
Clicking a card returns to the list layout with that conversation open.
Internal messages and organizational metadata never appear in creator responses.

Older clients still send to `/api/v1/feedback`; those existing messages stay available
under “Reports from older app versions”. They have no conversation access token and
cannot retroactively receive in-app replies. Existing analytics/export/privacy behavior
remains available in the other workspace sections.

## Boundaries and identity

- Browser access uses 32 random bytes, stored only in that browser and sent as a Bearer
  credential. Recovery links use a URL fragment, immediately removed by the page before
  requests. The fragment never reaches the server or referrers. Browser drafts are
  namespaced by inbox. The server stores only `SHA256('support:' + key)` on each report.
- The Electron main process owns `desktop/support.cjs`, a narrow, fixed-origin support
  transport. It persists a **separate** support key through atomic `WorkspacePreferences`
  in `support-access.json`. No other credential, arbitrary URL, filesystem path or
  IPC channel crosses the preload boundary. Report downloads use the native Save dialog
  and atomic replacement. Support keys are only copied on explicit user action.
- Administrator authentication remains the existing signed HttpOnly, SameSite=Strict
  cookie. All admin mutations require the exact Origin. Creator requests reject a
  foreign Origin; native main-process requests omit Origin. No wildcard CORS exists.
- Text renders through DOM text nodes. Files require authentication on every download,
  use no-store, attachment disposition, nosniff and a sandbox policy. R2 has no public
  hostname, public URL or browser S3 credentials. Images and videos are previewed automatically in the selected conversation, with
  at most six authenticated file fetches per opening. Prepared attachments have local
  thumbnails or video controls. Blob URLs are released on replacement or navigation.
- Uploaded images must have valid type/dimension headers: PNG/JPEG/WebP, at most 16
  megapixels and 8,192 pixels per side. `.styk` requires the real native STYK signature
  and supported header version. Files remain opaque; this is not an antivirus scan,
  and the Worker never decompresses, interprets or executes projects. MP4 box structure
  and WebM EBML/DocType headers are checked before storage; files are not transcoded
  on the server. These checks do not certify every media frame or codec.

## Local media preparation

Attachments are visible on both report steps. Images up to 32 MiB are resized to a
2,048-pixel longest side and encoded as WebP at 0.86 quality; compact originals are
kept when encoding would enlarge them. Videos accept MP4/WebM sources up to 100 MiB.
Clips above 2 MiB and up to 60 seconds are encoded locally to WebM, at up to 1,280 pixels
on the longest side, 30 fps, 650 kbps video and 64 kbps audio. Encoding runs in real time
with progress and cancellation; it stops at the 8 MiB output limit or a 75-second timeout.
Already compact videos are retained. Unsupported encoders or longer clips can pass
through only below the enforced 8 MiB upload ceiling. No oversized original is uploaded
as a fallback. Projects remain byte-for-byte unchanged. Preparation is sequential.

## Capacity and free-plan controls

These are **service admission ceilings, not an account billing meter**. The existing
Workers Free plan remains the outer limit. Cloudflare counts a request before the
Worker can reject it; no application can promise that arbitrary traffic, other account
services, or denial probes never consume that quota. On Free, exhausted Worker/D1
allowances reject traffic. Do not upgrade the plan to make support requests succeed.

| Resource | Ceiling |
| --- | --- |
| Private R2 reservations | 512 MiB, including interrupted uploads |
| Retained R2 file records | 6,000, including held records |
| One image / video or project | 4 MiB / 8 MiB |
| One conversation's files | 6 files / 24 MiB |
| Threads / messages | 2,000 / 20,000; 150 messages per thread including internal history |
| Estimated stored support text and record overhead | 24 MiB |
| Daily admitted support requests | 3,000 |
| Daily reserved reads / writes | 750,000 / 16,000 |
| Daily live connections / automatic requests | 500 / 1,000 globally; 40 / 200 per inbox |
| Daily R2 upload / download attempts | 100 / 600 |
| Per creator per day | 180 requests / 5 report attempts |
| Per daily salted IP per day | 600 requests / 15 report attempts |
| Edge throttles | 40 support requests/minute per inbox; existing 120/minute IP edge limit |
| Retention | Conversations: 90 days from creation; attachments: 30 days or earlier thread expiry |

Signed-in moderation (`/api/v1/admin/support/`) is never charged to or blocked by the
daily ledger or the per-actor buckets: anonymous traffic cannot lock the administrator
out, and moderation browsing does not consume the public allowance. Admin requests
remain bounded by the edge throttles, the shared global live budget, and the same
per-query result bounds.

`SUPPORT_STORAGE_BYTES`, `SUPPORT_DAILY_REQUESTS` and `SUPPORT_DAILY_WRITES` may lower
their ceilings, including to zero; values above the source ceilings cannot raise them.
`SUPPORT_ENABLED=false` or the persisted admin pause control stops **new** reports,
while existing conversations remain readable and can receive replies within quotas.

Every ordinary support request reserves conservative read/write work in one conditional SQL
statement before querying report data. Reservations are never refunded after failure.
The read reservation covers the largest bounded query for that route; write reservations
include indexes, triggers and actor ledgers. The ledger itself and rejected probes still
consume D1 operations. Nightly cleanup is separately bounded; the app does not represent
the ledger as exact billed usage. Existing analytics has its own limits. Check account-wide headroom before enabling
the new service alongside any other Workers, D1 databases or R2 buckets.

Live updates use a separate D1 admission ledger (`0004_support_live.sql`), so reaching
its limit pauses automatic refresh without consuming the message/upload allowance.
Automatic detail reads and seen acknowledgements both count toward that limit.
The additional admitted work is bounded separately; it still counts toward the
account's Cloudflare quotas. Initial connections and actual changes consume requests.

`SupportLive` uses the SQLite Durable Object migration and WebSocket Hibernation API,
available on Workers Free. It stores no message bodies, database rows or alarms.
Only `changed`/`deleted` hints are sent; clients fetch content through normal authorization.
Connections require signed, conversation-scoped, 60-second tickets and are capped at
four per role/eight per conversation. Private notes notify administrators only.
The connection lease expires after 24 hours and is checked on the next change.
Idle eligible objects incur no duration charges: see [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
This is free-plan compatible, not unlimited traffic or a guarantee against account-wide exhaustion.

At September 15, 2026, Cloudflare documents Workers Free at 100,000 requests/day and
10 ms CPU/request, D1 Free at 5 million rows read and 100,000 rows written/day, and R2
Standard's included tier at 10 GB-month, one million Class A and ten million Class B
operations/month. Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/). R2 included usage is
account-wide and is not itself a hard spending cap.

### Attachment accounting and failure handling

Uploads validate/bound the body first, then atomically insert a D1 reservation before
the single conditional R2 PUT. Only the request whose INSERT succeeds owns that write.
Retries of a completed upload never PUT again. File/byte counters use SQL triggers;
parallel uploads cannot both spend the last available capacity. The request body is
capped and has a 30-second receive timeout. R2 responses stream without copying the file.

Successful files release space only **after** R2 confirms deletion. Deleting a report
immediately revokes access and deletes its message text. Up to six completed files
are removed immediately; failed deletions retain their reservations for scheduled cleanup. An in-flight writer checks that its parent still exists before making
the file readable, and deletes the object if the report was removed meanwhile.

An interrupted or ambiguous PUT stays charged. After a day, maintenance deletes its
object and marks the slot `held`; it deliberately does not refund that reservation,
because a writer could still finish late. Held records contain no filename or message
text after cleanup. Their total is visible in admin capacity. Do not manually reset the
counters: releasing held space requires stopping upload traffic and verifying those
object keys can no longer be written. This conservative failure mode can pause future
uploads before storage fills; messages remain available.

Maintenance runs with the existing 03:17 UTC trigger. One run removes at most 100 ready
objects, revisits 100 interrupted objects, and purges 20 expired threads. Text expiry
runs even if R2 fails. Expired data is denied on reads even when physical cleanup is
backlogged. Never enable public access or another writer on the dedicated R2 bucket.

## Source and API

The service itself (the Worker that owns authorization, admission, validation and
workflows, its D1 migrations and the admin UI) lives in the StykAnimate website
repository. `src/support-contract.mjs`, `src/support-center.mjs` and
`src/support-center.css` in this repository are canonical; the website copies them into
its public assets. Do not edit those copies by hand.

Creator routes live under `/api/v1/support`; matching admin routes use
`/api/v1/admin/support`. All JSON and binary responses are private/no-store.

| Route | Method | Purpose |
| --- | --- | --- |
| `/config` | GET | Effective ceilings, intake state and attachment availability |
| `/threads` | GET / POST | Cursor list / structured new report (creator only) |
| `/threads/:id` | GET / DELETE | Latest messages, details / privacy deletion |
| `/threads/:id` | PATCH, admin | Version-checked status and organizational changes |
| `/threads/:id/messages` | POST | Idempotent reply or administrator internal note |
| `/threads/:id/live` | POST | Short-lived, receive-only WebSocket ticket |
| `/threads/:id/seen` | POST | Acknowledge only the visible sequence already read |
| `/threads/:id/files?message=ID&upload=UUID` | POST | Bounded raw body, encoded `X-File-Name` |
| `/threads/:id/files/:fileId` | GET / DELETE | Authorized streaming download / deletion |
| `/capacity` | GET / PATCH, admin | Counters / persisted intake pause |

`GET /threads/:id?before=SEQ` pages backward; `?after=SEQ` pages forward (exports/new
replies). Message bodies cap at 4,000 characters; report titles cap at 120. New reports
and replies carry a stable `requestId` UUID. Blob uploads have a separate stable UUID.

## Enablement and verification

Implementation does not publish a website or desktop release. Before an authorized
deployment:

1. Inspect the existing Free account's available D1, request and R2 allowances.
2. Create dedicated **private Standard** R2 bucket `stykanimate-support`. Keep `r2.dev`,
   custom public domains and public CORS disabled. Do not enable paid Workers or
   Infrequent Access. If R2 enrollment requires billing approval, obtain that explicitly.
   A 31-day R2 lifecycle expiry for `support/` is recommended as a second cleanup layer;
   it does not replace D1 accounting and cannot make a held reservation refundable.
3. Apply migrations through `0004_support_live.sql` to `stykanimate-analytics`, including
   prior migrations. Existing feedback and analytics rows are preserved.
4. Generate and validate the public assets. Deploy the Worker **and** assets, R2 binding,
   support limiter, `SUPPORT_LIVE` binding, SQLite Durable Object migration and variables together. Existing administrator secrets are retained.
5. Verify public page, creator isolation, admin session, binding readiness, CSP, and
   scheduled cleanup on the actual deployment. Do not put synthetic reports in production
   without an explicit test scope. Observe actual CPU/billed operations before widening use.
6. Ship the desktop integration through the documented desktop release process when
   authorized. Updating the website alone cannot change an already installed app.

App-side checks (Node 24.11.0, pinned dependencies):

```text
npm run check
npm test
```

The service's own tests (real SQL, workerd with local D1 and R2, browser checks) live
with it in the website repository.
Evidence is written to ignored `artifacts/support/`. These checks do not establish live
Cloudflare CPU, billing, physical-device behavior, or a packaged desktop release.
