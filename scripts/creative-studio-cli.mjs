#!/usr/bin/env node

/**
 * Creative Agent Studio CLI
 * Unified workflow and CLI suite for automated generative design:
 * creating vector SVGs, app icons, brand mascots, and StykAnimate 2D animations
 * using Antigravity, Claude, Codex, and OpenCode AI CLI tools.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultFigure, emptyDocument, createFrame, createObject } from '../src/demo.mjs';
import { Editor } from '../src/editor.mjs';

const VERSION = '1.0.0';

/**
 * Check if a command/binary is executable on PATH.
 */
export function probeBinary(binName) {
  try {
    const isWin = process.platform === 'win32';
    const checker = isWin ? 'where' : 'which';
    const result = spawnSync(checker, [binName], { stdio: 'ignore', windowsHide: true });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Dispatch prompt to external AI CLI engine if available.
 */
export function invokeEngine(engine, type, prompt) {
  let bin, args;
  const commandPrompt = `Generate a scalable ${type} asset: ${prompt}`;
  if (engine === 'claude') {
    bin = 'claude';
    args = ['-p', commandPrompt];
  } else if (engine === 'codex') {
    bin = 'codex';
    args = ['exec', commandPrompt];
  } else if (engine === 'opencode') {
    bin = 'opencode';
    args = ['run', commandPrompt];
  } else {
    return null;
  }

  if (!probeBinary(bin)) {
    console.error(`[creative-studio-cli] Engine binary "${bin}" not found on PATH. Falling back to built-in procedural asset generator.`);
    return null;
  }

  try {
    const proc = spawnSync(bin, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (proc.status === 0 && proc.stdout && proc.stdout.trim().length > 0) {
      return proc.stdout.trim();
    }
    console.error(`[creative-studio-cli] Engine "${bin}" execution did not produce usable output (exit: ${proc.status}${proc.error ? ', ' + proc.error.message : ''}). Falling back to built-in procedural generator.`);
  } catch (err) {
    console.error(`[creative-studio-cli] Failed to invoke engine "${bin}": ${err.message}. Falling back.`);
  }
  return null;
}

/**
 * Generate a deterministic numeric hash from a prompt string.
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Procedural Vector SVG Generator.
 */
export function generateSvgAsset(prompt) {
  const p = prompt.toLowerCase();
  const seed = hashString(prompt);

  if (p.includes('star') || p.includes('celestial') || p.includes('astro')) {
    // High-precision geometric star with faceted rays and concentric circles
    const points = 8;
    const outerRadius = 190;
    const innerRadius = 75;
    const cx = 256;
    const cy = 256;

    let starPath = '';
    const facetPolygons = [];
    for (let i = 0; i < points; i++) {
      const outerAngle = (i * 2 * Math.PI) / points - Math.PI / 2;
      const innerAngle = outerAngle + Math.PI / points;
      const nextOuterAngle = ((i + 1) * 2 * Math.PI) / points - Math.PI / 2;

      const ox = (cx + Math.cos(outerAngle) * outerRadius).toFixed(2);
      const oy = (cy + Math.sin(outerAngle) * outerRadius).toFixed(2);
      const ix = (cx + Math.cos(innerAngle) * innerRadius).toFixed(2);
      const iy = (cy + Math.sin(innerAngle) * innerRadius).toFixed(2);
      const nox = (cx + Math.cos(nextOuterAngle) * outerRadius).toFixed(2);
      const noy = (cy + Math.sin(nextOuterAngle) * outerRadius).toFixed(2);

      if (i === 0) starPath += `M ${ox},${oy} L ${ix},${iy} `;
      else starPath += `L ${ox},${oy} L ${ix},${iy} `;

      facetPolygons.push(`<polygon points="${cx},${cy} ${ox},${oy} ${ix},${iy}" fill="url(#facetLight)" opacity="0.95"/>`);
      facetPolygons.push(`<polygon points="${cx},${cy} ${ix},${iy} ${nox},${noy}" fill="url(#facetDark)" opacity="0.9"/>`);
    }
    starPath += 'Z';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <radialGradient id="spaceBg" cx="50%" cy="50%" r="70%">
      <stop offset="0%" stop-color="#141829"/>
      <stop offset="70%" stop-color="#0a0d18"/>
      <stop offset="100%" stop-color="#04060a"/>
    </radialGradient>
    <linearGradient id="facetLight" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff2a3"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#d97706"/>
    </linearGradient>
    <linearGradient id="facetDark" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#f59e0b"/>
      <stop offset="70%" stop-color="#b45309"/>
      <stop offset="100%" stop-color="#78350f"/>
    </linearGradient>
    <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0.2"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <g id="background">
    <rect width="512" height="512" rx="32" fill="url(#spaceBg)"/>
  </g>

  <g id="guideline-grid" stroke="url(#ringGrad)" fill="none" opacity="0.6">
    <circle cx="256" cy="256" r="230" stroke-width="1.5" stroke-dasharray="4 6"/>
    <circle cx="256" cy="256" r="190" stroke-width="1"/>
    <circle cx="256" cy="256" r="75" stroke-width="1.5" stroke-dasharray="2 4"/>
    <line x1="256" y1="20" x2="256" y2="492" stroke-width="0.8" stroke-dasharray="2 8"/>
    <line x1="20" y1="256" x2="492" y2="256" stroke-width="0.8" stroke-dasharray="2 8"/>
  </g>

  <g id="radiant-star" filter="url(#glow)">
    ${facetPolygons.join('\n    ')}
    <path d="${starPath}" fill="none" stroke="#fde68a" stroke-width="2" stroke-linejoin="round"/>
  </g>

  <g id="core-emblem">
    <circle cx="256" cy="256" r="28" fill="#ffffff" filter="url(#glow)"/>
    <circle cx="256" cy="256" r="16" fill="#f59e0b"/>
    <circle cx="256" cy="256" r="6" fill="#ffffff"/>
  </g>

  <g id="accent-sparks" fill="#38bdf8">
    <polygon points="256,18 260,26 256,34 252,26"/>
    <polygon points="256,478 260,486 256,494 252,486"/>
    <polygon points="18,256 26,260 34,256 26,252"/>
    <polygon points="478,256 486,260 494,256 486,252"/>
  </g>
</svg>
`;
  }

  if (p.includes('shield') || p.includes('defense') || p.includes('armor')) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <linearGradient id="shieldBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e1b4b"/>
    </linearGradient>
    <linearGradient id="metalGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="50%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <g id="background"><rect width="512" height="512" rx="32" fill="url(#shieldBg)"/></g>
  <g id="shield-body">
    <path d="M 256,70 L 410,130 C 410,290 340,390 256,442 C 172,390 102,290 102,130 Z" fill="url(#metalGrad)" stroke="#60a5fa" stroke-width="4"/>
    <path d="M 256,100 L 380,148 C 380,275 325,355 256,400 C 187,355 132,275 132,148 Z" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
    <polygon points="256,160 320,250 256,340 192,250" fill="url(#metalGrad)" stroke="#93c5fd" stroke-width="2"/>
  </g>
</svg>`;
  }

  // Generic geometric vector composition
  const primaryHue = seed % 360;
  const secondaryHue = (primaryHue + 40) % 360;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="hsl(${primaryHue}, 85%, 60%)"/>
      <stop offset="100%" stop-color="hsl(${secondaryHue}, 85%, 45%)"/>
    </linearGradient>
  </defs>
  <g id="background"><rect width="512" height="512" rx="32" fill="#0f172a"/></g>
  <g id="geometric-framework" stroke="hsl(${primaryHue}, 70%, 50%)" fill="none" opacity="0.5">
    <circle cx="256" cy="256" r="180" stroke-width="2"/>
    <polygon points="256,76 436,256 256,436 76,256" stroke-width="2"/>
  </g>
  <g id="primary-symbol">
    <circle cx="256" cy="256" r="120" fill="url(#grad1)"/>
    <polygon points="256,160 339,208 339,304 256,352 173,304 173,208" fill="#ffffff" opacity="0.9"/>
  </g>
</svg>`;
}

/**
 * Procedural App Icon SVG Generator.
 */
export function generateIconAsset(prompt) {
  const p = prompt.toLowerCase();
  const seed = hashString(prompt);

  // Determine glyph based on prompt
  let glyphContent = '';
  let badgeIcon = '';

  if (p.includes('robot') || p.includes('bot') || p.includes('ai') || p.includes('android')) {
    glyphContent = `
    <!-- Robot Antenna -->
    <line x1="256" y1="174" x2="256" y2="128" stroke="#38bdf8" stroke-width="8" stroke-linecap="round"/>
    <circle cx="256" cy="118" r="18" fill="#38bdf8" filter="url(#glyphGlow)"/>
    <circle cx="256" cy="118" r="8" fill="#ffffff"/>

    <!-- Robot Ears -->
    <rect x="144" y="214" width="22" height="66" rx="8" fill="#475569"/>
    <rect x="346" y="214" width="22" height="66" rx="8" fill="#475569"/>

    <!-- Robot Head Frame -->
    <rect x="166" y="174" width="180" height="154" rx="36" fill="url(#metalGrad)" stroke="#67e8f9" stroke-width="4"/>
    <rect x="180" y="188" width="152" height="126" rx="24" fill="#0f172a" opacity="0.5"/>

    <!-- Digital Visor -->
    <rect x="194" y="206" width="124" height="46" rx="14" fill="#020617" stroke="#06b6d4" stroke-width="2"/>
    <ellipse cx="228" cy="229" rx="14" ry="12" fill="#00f2fe" filter="url(#glyphGlow)"/>
    <ellipse cx="284" cy="229" rx="14" ry="12" fill="#00f2fe" filter="url(#glyphGlow)"/>
    <circle cx="230" cy="227" r="4" fill="#ffffff"/>
    <circle cx="286" cy="227" r="4" fill="#ffffff"/>

    <!-- Audio Grille / Mouth -->
    <line x1="220" y1="284" x2="240" y2="284" stroke="#00f2fe" stroke-width="4" stroke-linecap="round"/>
    <line x1="248" y1="280" x2="248" y2="288" stroke="#00f2fe" stroke-width="4" stroke-linecap="round"/>
    <line x1="256" y1="276" x2="256" y2="292" stroke="#00f2fe" stroke-width="4" stroke-linecap="round"/>
    <line x1="264" y1="280" x2="264" y2="288" stroke="#00f2fe" stroke-width="4" stroke-linecap="round"/>
    <line x1="272" y1="284" x2="292" y2="284" stroke="#00f2fe" stroke-width="4" stroke-linecap="round"/>

    <!-- Collar Plate -->
    <path d="M 216,336 L 296,336 L 316,366 L 196,366 Z" fill="#334155" stroke="#67e8f9" stroke-width="2"/>
    `;
    badgeIcon = `<polygon points="0,-16 4,-4 16,0 4,4 0,16 -4,4 -16,0 -4,-4" fill="#ffffff"/>`;
  } else if (p.includes('timeline') || p.includes('animation') || p.includes('tool')) {
    glyphContent = `
    <rect x="146" y="160" width="220" height="150" rx="20" fill="#0f172a" stroke="#818cf8" stroke-width="4"/>
    <line x1="146" y1="210" x2="366" y2="210" stroke="#334155" stroke-width="2"/>
    <line x1="146" y1="260" x2="366" y2="260" stroke="#334155" stroke-width="2"/>
    <polygon points="200,210 208,202 216,210 208,218" fill="#38bdf8"/>
    <polygon points="270,210 278,202 286,210 278,218" fill="#f43f5e"/>
    <polygon points="320,260 328,252 336,260 328,268" fill="#10b981"/>
    <polygon points="230,330 300,365 230,400" fill="url(#metalGrad)"/>
    `;
    badgeIcon = `<polygon points="0,-12 9,10 -11,-3 11,-3 -9,10" fill="#ffffff"/>`;
  } else {
    glyphContent = `
    <circle cx="256" cy="256" r="100" fill="url(#metalGrad)" stroke="#ffffff" stroke-width="4"/>
    <polygon points="256,180 320,280 192,280" fill="#ffffff"/>
    `;
    badgeIcon = `<circle cx="0" cy="0" r="8" fill="#ffffff"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <linearGradient id="iconBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e1b4b"/>
      <stop offset="50%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="metalGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="badgeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e"/>
      <stop offset="100%" stop-color="#be123c"/>
    </linearGradient>
    <filter id="iconShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.6"/>
    </filter>
    <filter id="glyphGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- App Icon Squircle Background -->
  <g id="icon-background" filter="url(#iconShadow)">
    <rect x="32" y="32" width="448" height="448" rx="100" ry="100" fill="url(#iconBg)"/>
    <rect x="34" y="34" width="444" height="444" rx="98" ry="98" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3"/>
  </g>

  <!-- Gloss Curve Overlay -->
  <g id="icon-gloss" opacity="0.1">
    <path d="M 32,132 C 32,77 77,32 132,32 L 380,32 C 435,32 480,77 480,132 L 480,210 C 340,240 180,180 32,220 Z" fill="#ffffff"/>
  </g>

  <!-- Centered App Glyph -->
  <g id="centered-glyph">
    ${glyphContent}
  </g>

  <!-- Top-Right Corner Badge -->
  <g id="icon-badge" transform="translate(396, 92)" filter="url(#iconShadow)">
    <circle cx="0" cy="0" r="34" fill="url(#badgeGrad)"/>
    <circle cx="0" cy="0" r="32" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2.5"/>
    ${badgeIcon}
  </g>
</svg>
`;
}

/**
 * Procedural Mascot Character SVG Generator.
 */
export function generateMascotAsset(prompt) {
  const p = prompt.toLowerCase();
  const isClaude = p.includes('claude') || p.includes('terracotta') || p.includes('anthropic');

  if (isClaude) {
    const terracotta = '#D97757';
    const darkShade = '#2B2625';
    const creamWhite = '#FFF8F0';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <linearGradient id="claudeGradient" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#E07A5F"/>
      <stop offset="100%" stop-color="#D97757"/>
    </linearGradient>
    <filter id="mascotShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity="0.3"/>
    </filter>
  </defs>

  <g id="background">
    <rect width="512" height="512" rx="32" fill="#1C1917"/>
  </g>

  <!-- Ground Contact Shadow -->
  <g id="shadow" opacity="0.4">
    <ellipse cx="256" cy="455" rx="140" ry="20" fill="#000000"/>
  </g>

  <!-- Claude 4 Legs (Terminal Limb Chains with 2-Bone IK Mapping) -->
  <g id="limbs-legs" stroke="${terracotta}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">
    <!-- Leg 1 (Front Left) -->
    <path d="M 220,310 L 205,375 L 195,438" id="leg-chain-1"/>
    <!-- Leg 2 (Inner Left) -->
    <path d="M 242,310 L 235,370 L 230,432" id="leg-chain-2"/>
    <!-- Leg 3 (Inner Right) -->
    <path d="M 270,310 L 277,370 L 282,432" id="leg-chain-3"/>
    <!-- Leg 4 (Front Right) -->
    <path d="M 292,310 L 307,375 L 317,438" id="leg-chain-4"/>
  </g>

  <!-- Claude Torso Block -->
  <g id="torso" filter="url(#mascotShadow)">
    <rect x="206" y="200" width="100" height="110" rx="18" fill="url(#claudeGradient)"/>
  </g>

  <!-- Claude Dual Arms -->
  <g id="limbs-arms" stroke="${terracotta}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">
    <!-- Left Arm Chain -->
    <path d="M 206,215 L 155,255 L 125,305" id="arm-chain-left"/>
    <!-- Right Arm Chain -->
    <path d="M 306,215 L 357,255 L 387,305" id="arm-chain-right"/>
  </g>

  <!-- Claude Block Head & Expression -->
  <g id="head" filter="url(#mascotShadow)">
    <rect x="186" y="80" width="140" height="110" rx="24" fill="url(#claudeGradient)"/>
    <!-- Expressive Eyes -->
    <ellipse cx="226" cy="130" rx="9" ry="13" fill="${darkShade}"/>
    <circle cx="224" cy="126" r="3.5" fill="${creamWhite}"/>
    <ellipse cx="286" cy="130" rx="9" ry="13" fill="${darkShade}"/>
    <circle cx="284" cy="126" r="3.5" fill="${creamWhite}"/>
    <!-- Friendly Smile -->
    <path d="M 242,156 Q 256,168 270,156" fill="none" stroke="${darkShade}" stroke-width="4.5" stroke-linecap="round"/>
  </g>

  <!-- Physical Joint Anchor Points for StykAnimate Skeletal Mapping -->
  <g id="skeletal-anchors" fill="#B35639" stroke="#FFFFFF" stroke-width="2.5">
    <circle id="anchor-head" cx="256" cy="135" r="5" data-joint="head"/>
    <circle id="anchor-neck" cx="256" cy="195" r="5" data-joint="neck"/>
    <circle id="anchor-shoulder-l" cx="206" cy="215" r="5" data-joint="shoulder-left"/>
    <circle id="anchor-elbow-l" cx="155" cy="255" r="5" data-joint="elbow-left"/>
    <circle id="anchor-wrist-l" cx="125" cy="305" r="5" data-joint="wrist-left"/>
    <circle id="anchor-shoulder-r" cx="306" cy="215" r="5" data-joint="shoulder-right"/>
    <circle id="anchor-elbow-r" cx="357" cy="255" r="5" data-joint="elbow-right"/>
    <circle id="anchor-wrist-r" cx="387" cy="305" r="5" data-joint="wrist-right"/>
    <circle id="anchor-pelvis" cx="256" cy="310" r="5" data-joint="pelvis"/>
    <circle id="anchor-knee-1" cx="205" cy="375" r="5" data-joint="knee-1"/>
    <circle id="anchor-foot-1" cx="195" cy="438" r="5" data-joint="foot-1"/>
    <circle id="anchor-knee-2" cx="235" cy="370" r="5" data-joint="knee-2"/>
    <circle id="anchor-foot-2" cx="230" cy="432" r="5" data-joint="foot-2"/>
    <circle id="anchor-knee-3" cx="277" cy="370" r="5" data-joint="knee-3"/>
    <circle id="anchor-foot-3" cx="282" cy="432" r="5" data-joint="foot-3"/>
    <circle id="anchor-knee-4" cx="307" cy="375" r="5" data-joint="knee-4"/>
    <circle id="anchor-foot-4" cx="317" cy="438" r="5" data-joint="foot-4"/>
  </g>
</svg>
`;
  }

  // Generic Mascot Character
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <g id="background"><rect width="512" height="512" rx="32" fill="#0f172a"/></g>
  <g id="mascot-body" stroke="#38bdf8" stroke-width="12" stroke-linecap="round">
    <circle cx="256" cy="140" r="45" fill="#38bdf8"/>
    <line x1="256" y1="185" x2="256" y2="300"/>
    <line x1="256" y1="210" x2="180" y2="250"/>
    <line x1="256" y1="210" x2="332" y2="250"/>
    <line x1="256" y1="300" x2="190" y2="420"/>
    <line x1="256" y1="300" x2="322" y2="420"/>
  </g>
</svg>`;
}

/**
 * Procedural StykAnimate Animation / Keyframe Structure Generator.
 * Creates an animation document adhering to `startup-blue-data.mjs` and `build-startup-blue.mjs`
 * with 2-bone IK controllers on terminal limbs, compatible with `Editor.importFigure`.
 */
export function generateAnimationAsset(prompt) {
  const p = prompt.toLowerCase();
  const figure = defaultFigure(1);
  const isClaude = p.includes('claude');
  figure.name = isClaude ? 'Claude Mascot' : (p.includes('waving') ? 'Waving Figure' : 'Animated Figure');

  const names = [
    'Torso', 'Head', 'Left upper arm', 'Left forearm', 'Right upper arm', 'Right forearm',
    'Left thigh', 'Left lower leg', 'Right thigh', 'Right lower leg'
  ];
  const thickness = [16, 0, 12, 12, 12, 12, 14, 14, 14, 14];
  const colorRgb = isClaude ? [217, 119, 87] : [13, 153, 255];

  for (const [i, segment] of figure.segments.entries()) {
    Object.assign(segment, { name: names[i], thickness: thickness[i], color_rgb: colorRgb });
  }
  Object.assign(figure.segments[1], { primitive_code: 3, flags: 3, segment_kind: 'circleFill' });

  // Standard symmetrical limb starting angles
  for (const [left, right] of [[2, 4], [3, 5], [6, 8], [7, 9]]) {
    figure.segments[right].angle_rad = Math.PI - figure.segments[left].angle_rad;
  }

  const report = emptyDocument();
  report.figure_types = [figure];
  report.keyframes = [createFrame([createObject(figure, 1, 480, 280)])];

  const editor = new Editor({ demo: false });
  editor.load(report);

  // Configure 2-bone IK controllers on terminal limbs via Editor
  for (const name of ['Left forearm', 'Right forearm', 'Left lower leg', 'Right lower leg']) {
    const idx = figure.segments.findIndex(s => s.name === name);
    if (idx !== -1) {
      editor.select(1, idx);
      editor.setNodeIK({ enabled: true, pinned: false, chainLength: 2, bendDirection: 0 });
    }
  }

  // Generate sequence of animated keyframes based on prompt semantics
  const frameCount = 8;
  const isWaving = p.includes('wave') || p.includes('waving') || p.includes('hand');
  const isWalking = p.includes('walk') || p.includes('walking');

  for (let f = 1; f < frameCount; f++) {
    editor.addFrame();
    const phase = (f / frameCount) * Math.PI * 2;
    const angles = editor.object.angles.slice();

    if (isWaving) {
      // Right arm raised and waving side-to-side
      const wavePhase = phase * 2; // 2 oscillations
      angles[4] = -Math.PI / 2 - 0.35 + Math.sin(wavePhase) * 0.15; // Right upper arm
      angles[5] = -Math.PI / 2 + Math.sin(wavePhase) * 0.65;          // Right forearm
      // Left arm and torso subtle breath
      angles[2] = 1.05 + Math.sin(phase) * 0.05;
      angles[3] = 1.32 + Math.sin(phase) * 0.05;
      editor.object.angles = angles;
    } else if (isWalking) {
      // Bilateral walk cycle with hip bob
      const swing = Math.sin(phase);
      angles[2] = Math.PI / 2 - swing * 0.55;
      angles[3] = Math.PI / 2 - swing * 0.35;
      angles[4] = Math.PI / 2 + swing * 0.55;
      angles[5] = Math.PI / 2 + swing * 0.35;
      angles[6] = Math.PI / 2 + swing * 0.6;
      angles[7] = Math.PI / 2 + Math.max(0, -swing) * 0.7;
      angles[8] = Math.PI / 2 - swing * 0.6;
      angles[9] = Math.PI / 2 + Math.max(0, swing) * 0.7;
      editor.object.angles = angles;
      editor.object.root_y = 280 - Math.abs(Math.sin(phase * 2)) * 8;
    } else {
      // Natural expressive idle loop
      const breath = Math.sin(phase) * 0.1;
      angles[2] = 1.05 + breath;
      angles[4] = Math.PI - (1.05 + breath);
      editor.object.angles = angles;
    }
  }

  const serialized = editor.serialize();
  // Provide dual structure for maximum compatibility with both Editor.importFigure and document loaders
  serialized.figure = figure;
  serialized.object = serialized.keyframes[0].objects[0];
  serialized._styk = {
    ...serialized._styk,
    format: 'StykAnimate',
    format_version: 1,
    name: figure.name,
    prompt
  };

  return JSON.stringify(serialized, null, 2);
}

/**
 * Main generator dispatcher.
 */
export async function generateAsset({ type, prompt, engine = 'antigravity', out = null }) {
  if (!type || !['svg', 'icon', 'mascot', 'animation'].includes(type)) {
    throw new Error(`Invalid asset type "${type}". Supported types: svg, icon, mascot, animation.`);
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('A non-empty --prompt is required.');
  }

  let content = null;

  // Attempt external engine dispatch if not antigravity
  if (engine && engine !== 'antigravity') {
    content = invokeEngine(engine, type, prompt);
  }

  // Fallback to built-in procedural engine if no external output
  if (!content) {
    switch (type) {
      case 'svg':
        content = generateSvgAsset(prompt);
        break;
      case 'icon':
        content = generateIconAsset(prompt);
        break;
      case 'mascot':
        content = generateMascotAsset(prompt);
        break;
      case 'animation':
        content = generateAnimationAsset(prompt);
        break;
    }
  }

  if (out) {
    const resolvedPath = path.resolve(process.cwd(), out);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, content, 'utf8');
    console.log(`[creative-studio-cli] Generated ${type} written to ${out}`);
  } else {
    process.stdout.write(content + '\n');
  }

  return content;
}

/**
 * Parse command line arguments.
 */
export function parseArgs(argv) {
  const options = {
    command: null,
    type: null,
    prompt: null,
    engine: 'antigravity',
    out: null,
    help: false,
    version: false
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === 'generate') {
      options.command = 'generate';
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--type' || arg === '-t') {
      options.type = argv[++i];
    } else if (arg.startsWith('--type=')) {
      options.type = arg.slice(7);
    } else if (arg === '--prompt' || arg === '-p') {
      options.prompt = argv[++i];
    } else if (arg.startsWith('--prompt=')) {
      options.prompt = arg.slice(9);
    } else if (arg === '--engine' || arg === '-e') {
      options.engine = argv[++i];
    } else if (arg.startsWith('--engine=')) {
      options.engine = arg.slice(9);
    } else if (arg === '--out' || arg === '-o') {
      options.out = argv[++i];
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice(6);
    }
    i++;
  }

  return options;
}

/**
 * Display help screen.
 */
function showHelp() {
  console.log(`Creative Agent Studio CLI (v${VERSION})

Usage:
  node scripts/creative-studio-cli.mjs generate --type <svg|icon|mascot|animation> --prompt "<description>" [--engine <antigravity|claude|codex|opencode>] [--out <output_path>]

Commands:
  generate                   Generate an AI asset

Options:
  -t, --type <type>          Asset type: svg, icon, mascot, animation
  -p, --prompt <prompt>      Description or prompt specifying asset aesthetics
  -e, --engine <engine>      AI engine: antigravity (default), claude, codex, opencode
  -o, --out <path>           Output file path (prints to stdout if omitted)
  -h, --help                 Display this help screen
  -v, --version              Display version number

Examples:
  node scripts/creative-studio-cli.mjs generate --type svg --prompt "geometric star" --out assets/star.svg
  node scripts/creative-studio-cli.mjs generate --type icon --prompt "robot app icon" --out assets/robot.svg
  node scripts/creative-studio-cli.mjs generate --type mascot --prompt "claude mascot" --out assets/claude.svg
  node scripts/creative-studio-cli.mjs generate --type animation --prompt "waving hand" --out assets/waving.json
`);
}

// Execute CLI when run directly
const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  process.argv[1].endsWith('creative-studio-cli.mjs')
);

if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(`creative-studio-cli ${VERSION}`);
    process.exit(0);
  }

  if (args.help || (!args.command && !args.type)) {
    showHelp();
    process.exit(args.help ? 0 : 1);
  }

  try {
    await generateAsset(args);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
