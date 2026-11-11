#!/usr/bin/env node
// StykAnimate video MCP server (stdio). Builds animations from a scene spec,
// previews frames and exports video through a headless copy of the real app.
import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {AppSession} from './session.mjs';
import {buildAnimation} from './build.mjs';
import {EASINGS} from './spec.mjs';
import {JOINTS, POSES} from './rig.mjs';
import {GUIDE} from './guide.mjs';

const session = new AppSession();
const server = new McpServer({name: 'stykanimate', version: '0.1.0'});

// One editor page: tool calls run one at a time.
let queue = Promise.resolve();
const serial = work => { const run = queue.then(work, work); queue = run.catch(() => {}); return run; };
const outputPath = file => path.resolve(process.env.STYK_OUTPUT_DIR ?? process.cwd(), file);
const text = value => ({content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)}]});
const failure = error => ({isError: true, content: [{type: 'text', text: `${error.message}${session.pageErrors.length ? `\nApp errors: ${session.pageErrors.slice(-3).join(' | ')}` : ''}`}]});
const tool = (name, config, handler) => server.registerTool(name, config, args => serial(async () => {
  try { return await handler(args); } catch (error) { return failure(error); }
}));

const color = z.string().describe('Hex colour, e.g. "#222222" or "#f80"');
const placement = z.object({
  x: z.number().optional().describe('Horizontal position in canvas pixels (stickman: hip; circle and text: centre; line: start)'),
  y: z.number().optional().describe('Vertical position in canvas pixels (y grows downward)'),
  ground: z.number().optional().describe('Stickman only: stand on this y, placing the lowest point of the pose there (use instead of y)'),
  pose: z.enum(Object.keys(POSES)).optional().describe('Stickman only: a library pose; omit to keep the previous pose'),
  joints: z.partialRecord(z.enum(JOINTS), z.number()).optional().describe('Stickman only: absolute joint angles in degrees (0 right, 90 down, -90 up, 180 left), applied over the pose'),
  lean: z.number().optional().describe('Stickman only: lean the upper body forward by this many degrees (negative leans back)'),
  flip: z.boolean().optional().describe('Face left (library poses face right)'),
  scale: z.number().positive().optional(),
  rotate: z.number().optional().describe('Non-stickman figures: rotation in degrees, clockwise'),
  opacity: z.number().min(0).max(1).optional(),
  hide: z.boolean().optional().describe('Remove the figure from this keyframe on'),
}).describe('Changes to one cast member. Fields left out carry over from the previous keyframe.');

const spec = z.object({
  title: z.string().optional(),
  width: z.number().int().min(16).max(4096).optional().describe('Canvas width; default 540 (vertical 9:16 with height 960)'),
  height: z.number().int().min(16).max(4096).optional().describe('Canvas height; default 960'),
  fps: z.number().int().min(1).max(60).optional().describe('Frames per second; default 24'),
  background: color.optional().describe('Starting background colour; default white'),
  ease: z.enum(Object.keys(EASINGS)).optional().describe('Default motion between keyframes; default auto (smooth)'),
  cast: z.array(z.object({
    id: z.string().min(1).describe('Unique name used in keyframes'),
    kind: z.enum(['stickman', 'line', 'circle', 'text', 'file']),
    color: color.optional(),
    thickness: z.number().positive().optional().describe('stickman: line weight multiplier (default 1); line/circle outline: pixels'),
    headColor: color.optional(), headFilled: z.boolean().optional(),
    length: z.number().positive().optional().describe('line: length in pixels'),
    radius: z.number().positive().optional().describe('circle: radius in pixels'),
    filled: z.boolean().optional().describe('circle: filled (default) or outline'),
    text: z.string().optional().describe('text: the words; use \\n for line breaks. One cast member per caption'),
    fontSize: z.number().positive().optional(), bold: z.boolean().optional(), italic: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    outline: z.number().min(0).optional().describe('text: outline width in pixels'), outlineColor: color.optional(),
    path: z.string().optional().describe('file: path to a Pivot .stk figure'),
  })).min(1).describe('Every figure in the animation; later members draw on top'),
  keyframes: z.array(z.object({
    hold: z.number().int().min(1).max(65535).optional().describe('Frames from this keyframe to the next (default 12 = 0.5 s at 24 fps)'),
    ease: z.enum(Object.keys(EASINGS)).optional().describe('Motion from this keyframe to the next; constant = no tween (a cut)'),
    background: color.optional(),
    camera: z.object({x: z.number().optional(), y: z.number().optional(), zoom: z.number().positive().optional(), rotate: z.number().optional()})
      .optional().describe('Point the camera at canvas x/y with a zoom (1 = whole canvas); carries over until changed'),
    figures: z.record(z.string(), placement).optional().describe('Cast id → changes. A figure appears from the first keyframe that names it'),
  })).min(1),
  audio: z.array(z.object({path: z.string(), start: z.number().min(0).optional().describe('Seconds'), volume: z.number().min(0).max(1).optional()}))
    .optional().describe('Voiceover or music files (wav, mp3, ogg, m4a...) placed on the timeline'),
  extendToAudio: z.boolean().optional().describe('Lengthen the last keyframe to the end of the audio (default true)'),
});

tool('stykanimate_guide', {
  description: 'How to write an animation spec for build_animation: coordinates, the stickman rig, the pose library, timing and a worked example. Read this before the first build.',
}, async () => text(GUIDE));

tool('build_animation', {
  description: 'Build a StykAnimate animation from a spec (cast + keyframes) and open it in the headless editor, replacing the open one. Follow with preview_frames to check it, then export_video and save_project. See stykanimate_guide.',
  inputSchema: {spec, saveProject: z.string().optional().describe('Also save the project to this .styk path')},
}, async ({spec, saveProject}) => {
  const result = await buildAnimation(session, spec);
  if (saveProject) result.saved = await session.save(outputPath(saveProject));
  return text(result);
});

tool('open_project', {
  description: 'Open an existing .styk, .piv, .stk or Stick Nodes file in the headless editor, for preview or export.',
  inputSchema: {path: z.string()},
}, async ({path: file}) => text(await session.open(path.resolve(file))));

tool('project_info', {
  description: 'The open animation: canvas, fps, length, keyframes, figures and audio clips.',
}, async () => text(await session.info()));

tool('preview_frames', {
  description: 'Render frames of the open animation as one contact-sheet image, exactly as export draws them. Frames are 0-based ticks.',
  inputSchema: {
    frames: z.array(z.number().int().min(0)).max(16).optional().describe('Frames to show; default: evenly spaced'),
    count: z.number().int().min(1).max(16).optional().describe('How many evenly spaced frames when frames is omitted (default 8)'),
    width: z.number().int().min(80).max(540).optional().describe('Width of each still in the sheet (default 270)'),
  },
}, async ({frames, count = 8, width}) => {
  const {ticks} = await session.info();
  const chosen = frames?.length ? frames.map(frame => Math.min(frame, ticks - 1))
    : [...new Set(Array.from({length: Math.min(count, ticks)}, (_, i) => Math.round(i * (ticks - 1) / Math.max(1, Math.min(count, ticks) - 1))))];
  const image = await session.preview({frames: chosen, width});
  return {content: [{type: 'image', data: image, mimeType: 'image/png'}, {type: 'text', text: `Frames ${chosen.join(', ')} of ${ticks}`}]};
});

tool('export_video', {
  description: 'Export the open animation with the app\'s exporter. preset "shorts" gives a 1080×1920 MP4 for YouTube Shorts (needs a vertical canvas); "youtube" a 1080p landscape MP4. Without a preset, format picks mp4/webm/gif at the canvas size. Audio is included when the animation has sound.',
  inputSchema: {
    out: z.string().describe('Output file path, e.g. out/my-short.mp4'),
    preset: z.enum(['shorts', 'youtube', 'tiktok', 'instagram', 'x', 'gif', 'best']).optional(),
    format: z.enum(['mp4', 'webm', 'gif']).optional(),
    sound: z.boolean().optional().describe('Include audio (default true)'),
  },
}, async ({out, preset, format, sound}) => text(await session.exportVideo({out: outputPath(out), preset, format, sound})));

tool('save_project', {
  description: 'Save the open animation as a StykAnimate .styk project, which opens in the app for hand editing.',
  inputSchema: {out: z.string().describe('Output path ending in .styk')},
}, async ({out}) => text(await session.save(outputPath(out))));

const shutdown = async () => { await session.close(); process.exit(0); };
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
