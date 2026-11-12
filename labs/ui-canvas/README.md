# UI Canvas

An infinite canvas for exploring StykAnimate's UI and UX. Describe a screen or a flow and Claude designs several real directions side by side, rendered with the app's own tokens, fonts, icons and a working stand-in editor. It runs locally through your logged-in `claude` CLI, and nothing here ships in the app.

```
npm run canvas
```

This opens `http://127.0.0.1:47900`. `--port <n>` picks another port and `--no-open` skips the browser. The board is saved in `artifacts/ui-canvas/board/` (git-ignored); every version of every screen is kept as its own file.

## Using it

With nothing selected, the composer creates. Just say what you want and how many: "5 Homes, 5 timelines and 10 export dialogs in different styles". The agent plans the jobs itself, including flows and leaving the design system where you ask for styles. With no number it picks what suits the request. With a screen selected, the same composer acts on it:

| Action | What happens | Sends |
| --- | --- | --- |
| Refine | A patch to this screen, as a new version | The screen |
| Variants | New directions beside it | The screen |
| Next screen | The following screen, added to this flow | The screen |
| Restyle | A new look from a token override; layout untouched. Works on several screens at once | Titles only |
| Critique | Up to five findings in a panel; **Apply fix** refines from one | The screen |
| Combine | With two or more selected: one screen from the best of each | Each screen |
| Element | Press `E`, click any part, and change only that | That element |

Tag screens with `T` or the number keys (`1` Keep, `2` Maybe, `3` Reject), or add your own. Tags at the top filter the board, and double-clicking one selects its screens. The ideas you tag Keep and Reject go into later requests, so the agent learns your taste.

| Key | Action |
| --- | --- |
| `/` or `Enter` | Write in the composer |
| Double-click or `P`, `Esc` | Open full window, and close it |
| `←` `→` | Previous or next screen of a flow, when open |
| `E` | Pick an element |
| `T`, `1`–`9` | Tag |
| `[` `]` | Older or newer version |
| `F`, `Shift+1` | Fit the selection, fit everything |
| Space-drag, wheel, Ctrl+wheel | Pan, pan, zoom |
| `Ctrl+Z`, `Ctrl+Shift+Z`, `Del`, `Ctrl+A` | Undo, redo, delete, select all |

A flow is one stacked card on the canvas, however many screens it has. Open it to click through it like a prototype or jump between screens from the strip at the top. When you close it, the card stays on the screen you were viewing, so the composer acts on that one. Moving or deleting the card moves or deletes the whole flow.

Drag a selected screen's corner to test how it responds to a different size.

## How it stays fast and small

- **Opus at high effort only.** Every call uses `--model opus --effort high` (`lib/claude-cli.mjs`). There is deliberately no other tier; the owner chose quality over speed.
- **A lean CLI call.** Replacing the default system prompt and turning off tools, MCP, skills and settings takes the baseline from about 27,000 input tokens to about 700. Calls also run from an empty folder and cannot touch the disk.
- **Macros.** `<x-editor>` is the whole working app, and a child with `slot="timeline"` replaces just that region, so experiments stay small and always look real. `frame/runtime.js` expands them on the mockup kit in `kit/`, a copy of the one the Home concepts were designed with.
- **Pace in the brief.** Most of a generation is thinking, which `MAX_THINKING_TOKENS` barely limited. The Pace section of `brief/design-brief.md` is what brought screens under two minutes.
- **One short planning call.** It turns the request into jobs (24 at most), then six run at a time and the rest wait as Queued.

Measured through this app on 2026-11-06, Opus at high effort. Timings vary with load and the idea.

| Call | Time | Tokens (input + output) |
| --- | --- | --- |
| New screen, three in parallel | 69–105 s each; 105 s for all three | 10–14k each |
| Critique | 36 s | 9k |
| Refine | 19 s | 8k |
| Element | 7 s | 4k |
| Restyle | 55 s | 9k |

## The agent's brief

`brief/design-brief.md` is the whole system prompt: the UX priorities, the creative stance, the pace, the visual rules from `docs/design/visual-system.md`, and the kit. Edit it when the design system moves or when you want to steer every result. Tokens, fonts, icons and kit classes are served live from the repository, so mockups follow them automatically; only the names listed in the brief need updating, and `tests/ui-canvas.test.mjs` fails if it promises one that does not exist.

## Structure

| Path | What it owns |
| --- | --- |
| `server.mjs` | Loopback HTTP, events, static files, request checks |
| `lib/runner.mjs` | Turns a request into model calls and board changes |
| `lib/claude-cli.mjs` | The CLI call, its flags and the concurrency limit (6) |
| `lib/prompts.mjs` | The planning call and each request's user turn |
| `lib/screen-stream.mjs` | Reads screens, edits and findings from streamed text |
| `lib/board-store.mjs` | Atomic saves; one file per screen version |
| `shared/board-model.mjs` | The board and its operations, used by server and page |
| `app/` | The canvas page |
| `frame/` | The sandboxed page each screen runs in, and the macros |
| `test/fake-claude.mjs` | A stand-in CLI, so tests spend no tokens |

## Safety

The server listens on loopback and refuses any other Host or Origin, so a web page cannot read the board or spend tokens. Screens run in `sandbox="allow-scripts"` iframes with an opaque origin and a strict Content Security Policy: generated markup cannot reach the page, the API or the network.

## Tests

```
node --test tests/ui-canvas.test.mjs
npm run test:canvas:ui
```

Both use the fake CLI. The browser test needs Playwright and Chrome.

## Limits

- One board, kept in one folder. Back up `artifacts/ui-canvas/board/` if a board matters.
- Mockups use the stand-in editor, not the real renderer or document. Its joints, Play and Add frame work; the rest is drawn.
- Screens stay static: no scripts, so a different state is a different screen.
- Up to 30 iframes are live at once. When zoomed far out on a very large board, others show as empty until you move closer.
- A refinement whose edits do not match the screen changes nothing and says so.
