# StykAnimate MCP server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant
build a StykAnimate animation from a scene description, check its frames and export it as video,
for example a 1080 × 1920 YouTube Short. It runs this repository's app headless: the editor's own
document model, renderer and export dialog produce every frame, and a saved `.styk` opens in the
app for hand editing.

Nothing here ships in the desktop app or the browser build; it is a separate package with its own
dependencies.

## Tools

| Tool | What it does |
| --- | --- |
| `stykanimate_guide` | How to write a spec: coordinates, rig, pose library, timing and an example |
| `build_animation` | Spec (cast, keyframes, optional audio) → open animation, optionally saved as `.styk` |
| `open_project` | Open a `.styk`, `.piv`, `.stk` or Stick Nodes file |
| `project_info` | Canvas, frame rate, length, figures and sound clips |
| `preview_frames` | A contact sheet of chosen frames, drawn by the exporter |
| `export_video` | MP4, WebM or GIF; presets `shorts`, `youtube`, `tiktok`, `instagram`, `x`, `gif`, `best` |
| `save_project` | Save as `.styk` |

A spec declares the figures once (stickmen, lines, circles, text and `.stk` figures) and then lists
keyframes that only say what changes. Keyframes tween with the app's easing modes. Each one can also
move the camera or change the background. `stykanimate_guide` returns the full format.

## How it works

| Module | Responsibility |
| --- | --- |
| `src/spec.mjs`, `src/rig.mjs` | Compile a spec into a native document with `src/demo.mjs` factories and validate it with `validateScene` |
| `src/session.mjs` | Start the codec service (`desktop/backend.cjs`) and Chrome (`tests/support/playwright.mjs`), load documents through `window.styk.editor`, and drive the export dialog |
| `src/build.mjs` | Prepare text figures (bundled Noto Sans), `.stk` figures and audio, then compile and load |
| `src/index.mjs` | The MCP tools over stdio |

Export, preview stills and Save As all run through the app's own commands, so the output is what
the app itself exports. The headless browser takes the app's Canvas 2D path when no WebGPU adapter is
available, as the browser tests do on Linux.

The browser's MP4 encoder cannot include sound here (the export dialog asks for a desktop FFmpeg
format). An MP4 with sound is therefore exported as WebM, which carries the app's own audio mix, and
converted to H.264/AAC with the system `ffmpeg`.

## Requirements

- This repository set up as in [Build from source](../README.md#build-from-source) (`npm ci`, Python).
- Google Chrome, or Playwright's Chromium (`npx playwright install chromium`).
- `ffmpeg` with libx264 and AAC, only for MP4 exports with sound. Set `STYK_FFMPEG` to choose it.

## Use

```sh
cd mcp
npm ci
```

Register `node /path/to/StykAnimate-App/mcp/src/index.mjs` as a stdio server in your MCP client, for
example:

```json
{
  "mcpServers": {
    "stykanimate": {
      "command": "node",
      "args": ["/path/to/StykAnimate-App/mcp/src/index.mjs"],
      "env": {"STYK_OUTPUT_DIR": "/path/to/videos"}
    }
  }
}
```

Relative output paths resolve against `STYK_OUTPUT_DIR` (by default, the client's working
directory). `STYK_APP_ROOT` points the server at another checkout of the app. `STYK_HEADED=1` shows
the browser window while debugging.

## Checks

```sh
npm test                    # from the repository root: includes tests/mcp-spec.test.mjs
cd mcp
npm run smoke               # build, preview, save and export examples/hello-short.json
npm run test:mcp            # stdio round trip with sound; needs ffmpeg
```

Both end-to-end checks write their output to `artifacts/` for inspection.

## Limits

- The stickman is the app's default figure. Joint angles are absolute screen angles, and the named
  poses are a small starter library. `.stk` figures can be moved, scaled, rotated and flipped, but not
  posed.
- Export drives the export dialog's controls, so changes to its element ids must be reflected in
  `src/session.mjs`.
- One editor page serves all calls, one at a time. A Short of a few seconds takes about 40 seconds from
  build to MP4.
