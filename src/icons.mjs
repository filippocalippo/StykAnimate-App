/**
 * Offline SVG icons from Lucide, https://github.com/lucide-icons/lucide
 * Pinned source revision: a537cb6eb323b885f4c60baf3cec1a995982d167
 * Adaptations: optical stroke width, solid transport controls, line endpoints.
 * All other shapes retain the original SVG nodes, including circles and rectangles.
 *
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * ---
 *
 * The following Lucide icons are derived from the Feather project:
 *
 * airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
 *
 * The MIT License (MIT) (for the icons listed above)
 *
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const shapes = Object.freeze({
  "bring-to-front": '<rect x="8" y="8" width="8" height="8" rx="2" /><path d="M4 10a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2" /><path d="M14 20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2" />',
  "send-to-back": '<rect x="14" y="14" width="8" height="8" rx="2" /><rect x="2" y="2" width="8" height="8" rx="2" /><path d="M7 14v1a2 2 0 0 0 2 2h1" /><path d="M14 7h1a2 2 0 0 1 2 2v1" />',
  text: '<path d="M12 4v16" /> <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /> <path d="M9 20h6" />',
  polygon:
    '<path d="M10.83 2.38a2 2 0 0 1 2.34 0l8 5.74a2 2 0 0 1 .73 2.25l-3.04 9.26a2 2 0 0 1-1.9 1.37H7.04a2 2 0 0 1-1.9-1.37L2.1 10.37a2 2 0 0 1 .73-2.25z" />',
  cursor:
    '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />',
  nodes:
    '<path d="m10.586 5.414-5.172 5.172" /> <path d="m18.586 13.414-5.172 5.172" /> <path d="M6 12h12" /> <circle cx="12" cy="20" r="2" /> <circle cx="12" cy="4" r="2" /> <circle cx="20" cy="12" r="2" /> <circle cx="4" cy="12" r="2" />',
  folder:
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /> <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /> <path d="M7 3v4a1 1 0 0 0 1 1h7" />',
  export:
    '<path d="M12 3v12" /> <path d="m17 8-5-5-5 5" /> <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />',
  import:
    '<path d="M12 15V3" /> <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /> <path d="m7 10 5 5 5-5" />',
  plus: '<path d="M5 12h14" /> <path d="M12 5v14" />',
  minus: '<path d="M5 12h14" />',
  search: '<path d="m21 21-4.34-4.34" /> <circle cx="11" cy="11" r="8" />',
  frame:
    '<line x1="22" x2="2" y1="6" y2="6" /> <line x1="22" x2="2" y1="18" y2="18" /> <line x1="6" x2="6" y1="2" y2="22" /> <line x1="18" x2="18" y1="2" y2="22" />',
  settings:
    '<path d="M10 5H3" /> <path d="M12 19H3" /> <path d="M14 3v4" /> <path d="M16 17v4" /> <path d="M21 12h-9" /> <path d="M21 19h-5" /> <path d="M21 5h-7" /> <path d="M8 10v4" /> <path d="M8 12H3" />',
  help: '<circle cx="12" cy="12" r="10" /> <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /> <path d="M12 17h.01" />',
  onion: '<circle cx="15" cy="9" r="7" /> <circle cx="9" cy="15" r="7" />',
  line: '<path d="m7 17 10-10" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" />',
  circle: '<circle cx="12" cy="12" r="10" />',
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" /> <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" /> <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" /> <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />',
  person:
    '<circle cx="12" cy="5" r="1" /> <path d="m9 20 3-6 3 6" /> <path d="m6 8 6 2 6-2" /> <path d="M12 10v4" />',
  first:
    '<path fill="currentColor" stroke="none" d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" /> <path d="M3 20V4" />',
  previous:
    '<path fill="currentColor" stroke="none" d="M13.971 4.285A2 2 0 0 1 17 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" /> <path d="M21 20V4" />',
  next: '<path fill="currentColor" stroke="none" d="M10.029 4.285A2 2 0 0 0 7 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" /> <path d="M3 4v16" />',
  last: '<path d="M21 4v16" /> <path fill="currentColor" stroke="none" d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" />',
  play: '<path fill="currentColor" stroke="none" d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />',
  pause:
    '<rect fill="currentColor" stroke="none" x="14" y="3" width="5" height="18" rx="1" /> <rect fill="currentColor" stroke="none" x="5" y="3" width="5" height="18" rx="1" />',
  stop: '<rect width="18" height="18" x="3" y="3" rx="2" />',
  loop: '<path d="m2 9 3-3 3 3" /> <path d="M13 18H7a2 2 0 0 1-2-2V6" /> <path d="m22 15-3 3-3-3" /> <path d="M11 6h6a2 2 0 0 1 2 2v10" />',
  trash:
    '<path d="M10 11v6" /> <path d="M14 11v6" /> <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /> <path d="M3 6h18" /> <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />',
  zoom: '<circle cx="11" cy="11" r="8" /> <line x1="21" x2="16.65" y1="21" y2="16.65" /> <line x1="8" x2="14" y1="11" y2="11" />',
  sliders:
    '<path d="M10 5H3" /> <path d="M12 19H3" /> <path d="M14 3v4" /> <path d="M16 17v4" /> <path d="M21 12h-9" /> <path d="M21 19h-5" /> <path d="M21 5h-7" /> <path d="M8 10v4" /> <path d="M8 12H3" />',
  activity:
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /> <circle cx="12" cy="12" r="3" />',
  "eye-off":
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" /> <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /> <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" /> <path d="m2 2 20 20" />',
  lock: '<circle cx="12" cy="16" r="1" /> <rect x="3" y="10" width="18" height="12" rx="2" /> <path d="M7 10V7a5 5 0 0 1 10 0v3" />',
  unlock:
    '<circle cx="12" cy="16" r="1" /> <rect width="18" height="12" x="3" y="10" rx="2" /> <path d="M7 10V7a5 5 0 0 1 9.33-2.5" />',
  diamond:
    '<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z" />',
  duplicate:
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
  flip: '<path d="m3 7 5 5-5 5V7" /> <path d="m21 7-5 5 5 5V7" /> <path d="M12 20v2" /> <path d="M12 14v2" /> <path d="M12 8v2" /> <path d="M12 2v2" />',
  rotate:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /> <path d="M3 3v5h5" />',
  center:
    '<circle cx="12" cy="12" r="10" /> <line x1="22" x2="18" y1="12" y2="12" /> <line x1="6" x2="2" y1="12" y2="12" /> <line x1="12" x2="12" y1="6" y2="2" /> <line x1="12" x2="12" y1="22" y2="18" />',
  up: '<path d="m18 15-6-6-6 6" />',
  down: '<path d="m6 9 6 6 6-6" />',
  undo: '<path d="M9 14 4 9l5-5" /> <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />',
  redo: '<path d="m15 14 5-5-5-5" /> <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />',
  check: '<path d="M20 6 9 17l-5-5" />',
  close: '<path d="M18 6 6 18" /> <path d="m6 6 12 12" />',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2" /> <path d="M15 7h2a5 5 0 1 1 0 10h-2" /> <line x1="8" x2="16" y1="12" y2="12" />',
  detach: '<path d="M15 7h2a5 5 0 0 1 0 10h-2m-6 0H7A5 5 0 0 1 7 7h2" />',
  grid: '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M3 9h18" /> <path d="M3 15h18" /> <path d="M9 3v18" /> <path d="M15 3v18" />',
  file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /> <path d="M14 2v5a1 1 0 0 0 1 1h5" />',
  scale:
    '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /> <path d="M14 15H9v-5" /> <path d="M16 3h5v5" /> <path d="M21 3 9 15" />',
  dock: '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M15 3v18" /> <path d="m8 9 3 3-3 3" />',
  undock:
    '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M15 3v18" /> <path d="m10 15-3-3 3-3" />',
  "chevron-left": '<path d="m15 18-6-6 6-6" />',
  "chevron-right": '<path d="m9 18 6-6-6-6" />',
  "chevron-up": '<path d="m18 15-6-6-6 6" />',
  "chevron-down": '<path d="m6 9 6 6 6-6" />',
  "align-left":
    '<rect width="9" height="6" x="6" y="14" rx="2" /> <rect width="16" height="6" x="6" y="4" rx="2" /> <path d="M2 2v20" />',
  "align-right":
    '<rect width="16" height="6" x="2" y="4" rx="2" /> <rect width="9" height="6" x="9" y="14" rx="2" /> <path d="M22 22V2" />',
  "align-top":
    '<rect width="6" height="16" x="4" y="6" rx="2" /> <rect width="6" height="9" x="14" y="6" rx="2" /> <path d="M22 2H2" />',
  "align-bottom":
    '<rect width="6" height="16" x="4" y="2" rx="2" /> <rect width="6" height="9" x="14" y="9" rx="2" /> <path d="M22 22H2" />',
  "align-horizontal-center":
    '<path d="M12 2v20" /> <path d="M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4" /> <path d="M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4" /> <path d="M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1" /> <path d="M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1" />',
  "align-vertical-center":
    '<path d="M2 12h20" /> <path d="M10 16v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4" /> <path d="M10 8V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4" /> <path d="M20 16v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1" /> <path d="M14 8V7c0-1.1.9-2 2-2h2a2 2 0 0 1 2 2v1" />',
  "distribute-horizontal":
    '<rect width="6" height="14" x="4" y="5" rx="2" /> <rect width="6" height="10" x="14" y="7" rx="2" /> <path d="M17 22v-5" /> <path d="M17 7V2" /> <path d="M7 22v-3" /> <path d="M7 5V2" />',
  "distribute-vertical":
    '<path d="M22 17h-3" /> <path d="M22 7h-5" /> <path d="M5 17H2" /> <path d="M7 7H2" /> <rect x="5" y="14" width="14" height="6" rx="2" /> <rect x="7" y="4" width="10" height="6" rx="2" />',
  maximize:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3" /> <path d="M21 8V5a2 2 0 0 0-2-2h-3" /> <path d="M3 16v3a2 2 0 0 0 2 2h3" /> <path d="M16 21h3a2 2 0 0 0 2-2v-3" />',
  minimize:
    '<path d="M8 3v3a2 2 0 0 1-2 2H3" /> <path d="M21 8h-3a2 2 0 0 1-2-2V3" /> <path d="M3 16h3a2 2 0 0 1 2 2v3" /> <path d="M16 21v-3a2 2 0 0 1 2-2h3" />',
  grip: '<circle cx="9" cy="12" r="1" /> <circle cx="9" cy="5" r="1" /> <circle cx="9" cy="19" r="1" /> <circle cx="15" cy="12" r="1" /> <circle cx="15" cy="5" r="1" /> <circle cx="15" cy="19" r="1" />',
  more: '<circle cx="12" cy="12" r="1" /> <circle cx="19" cy="12" r="1" /> <circle cx="5" cy="12" r="1" />',
  "more-vertical":
    '<circle cx="12" cy="12" r="1" /> <circle cx="12" cy="5" r="1" /> <circle cx="12" cy="19" r="1" />',
  layers:
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /> <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /> <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2" /> <circle cx="9" cy="9" r="2" /> <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />',
  camera:
    '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" /> <rect x="2" y="6" width="14" height="12" rx="2" />',
  clock: '<circle cx="12" cy="12" r="10" /> <path d="M12 6v6h4" />',
  cut: '<circle cx="6" cy="6" r="3" /> <path d="M8.12 8.12 12 12" /> <path d="M20 4 8.12 15.88" /> <circle cx="6" cy="18" r="3" /> <path d="M14.8 14.8 20 20" />',
  clipboard:
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /> <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />',
  split:
    '<path d="M16 3h5v5" /> <path d="M8 3H3v5" /> <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" /> <path d="m15 9 6-6" />',
  origin:
    '<line x1="2" x2="5" y1="12" y2="12" /> <line x1="19" x2="22" y1="12" y2="12" /> <line x1="12" x2="12" y1="2" y2="5" /> <line x1="12" x2="12" y1="19" y2="22" /> <circle cx="12" cy="12" r="7" /> <circle cx="12" cy="12" r="3" />',
  combine:
    '<path d="M3 7V5c0-1.1.9-2 2-2h2" /> <path d="M17 3h2c1.1 0 2 .9 2 2v2" /> <path d="M21 17v2c0 1.1-.9 2-2 2h-2" /> <path d="M7 21H5c-1.1 0-2-.9-2-2v-2" /> <rect width="7" height="5" x="7" y="7" rx="1" /> <rect width="7" height="5" x="10" y="12" rx="1" />',
  reset:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /> <path d="M3 3v5h5" />',
  "panel-left":
    '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M9 3v18" />',
  "panel-right":
    '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M15 3v18" />',
  "panel-bottom":
    '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M3 15h18" />',
  "arrow-left": '<path d="m12 19-7-7 7-7" /> <path d="M19 12H5" />',
  "arrow-right": '<path d="M5 12h14" /> <path d="m12 5 7 7-7 7" />',
  "arrow-up": '<path d="m5 12 7-7 7 7" /> <path d="M12 19V5" />',
  "arrow-down": '<path d="M12 5v14" /> <path d="m19 12-7 7-7-7" />',
  "zoom-in":
    '<circle cx="11" cy="11" r="8" /> <line x1="21" x2="16.65" y1="21" y2="16.65" /> <line x1="11" x2="11" y1="8" y2="14" /> <line x1="8" x2="14" y1="11" y2="11" />',
  "zoom-out":
    '<circle cx="11" cy="11" r="8" /> <line x1="21" x2="16.65" y1="21" y2="16.65" /> <line x1="8" x2="14" y1="11" y2="11" />',
  fit: '<path d="M3 7V5a2 2 0 0 1 2-2h2" /> <path d="M17 3h2a2 2 0 0 1 2 2v2" /> <path d="M21 17v2a2 2 0 0 1-2 2h-2" /> <path d="M7 21H5a2 2 0 0 1-2-2v-2" />',
  "flip-vertical":
    '<path d="m17 3-5 5-5-5h10" /> <path d="m17 21-5-5-5 5h10" /> <path d="M4 12H2" /> <path d="M10 12H8" /> <path d="M16 12h-2" /> <path d="M22 12h-2" />',
  "new-file":
    '<path d="M11.35 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5.35" /> <path d="M14 2v5a1 1 0 0 0 1 1h5" /> <path d="M14 19h6" /> <path d="M17 16v6" />',
  expand:
    '<path d="m15 15 6 6" /> <path d="m15 9 6-6" /> <path d="M21 16v5h-5" /> <path d="M21 8V3h-5" /> <path d="M3 16v5h5" /> <path d="m3 21 6-6" /> <path d="M3 8V3h5" /> <path d="M9 9 3 3" />',
  collapse:
    '<path d="m15 15 6 6m-6-6v4.8m0-4.8h4.8" /> <path d="M9 19.8V15m0 0H4.2M9 15l-6 6" /> <path d="M15 4.2V9m0 0h4.8M15 9l6-6" /> <path d="M9 4.2V9m0 0H4.2M9 9 3 3" />',
});
const aliases = Object.freeze({
  x: "close",
  square: "stop",
  "window-maximize": "stop",
  "window-restore": "duplicate",
  "window-minimize": "minus",
  upload: "export",
  download: "import",
  alignLeft: "align-left",
  alignRight: "align-right",
  alignTop: "align-top",
  alignBottom: "align-bottom",
  alignHorizontalCenter: "align-horizontal-center",
  alignVerticalCenter: "align-vertical-center",
  horizontalCenter: "align-horizontal-center",
  verticalCenter: "align-vertical-center",
  chevronLeft: "chevron-left",
  chevronRight: "chevron-right",
  chevronUp: "chevron-up",
  chevronDown: "chevron-down",
  alignleft: "align-left",
  alignright: "align-right",
  aligntop: "align-top",
  alignbottom: "align-bottom",
  horizontalcenter: "align-horizontal-center",
  verticalcenter: "align-vertical-center",
  rig: "nodes",
  build: "line",
  move: "cursor",
  restore: "minimize",
  menu: "more",
  unjoin: "detach",
});
export const iconNames = Object.freeze(Object.keys(shapes));
const escapeAttribute = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

/** Inline, inheritable SVG; no font, runtime dependency or network request. */
export function icon(name, cls = "") {
  const shape = shapes[aliases[name] || name] || shapes.file;
  return `<svg class="icon${cls ? " " + escapeAttribute(cls) : ""}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shape}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((element) => {
    const name = element.dataset.icon;
    element.removeAttribute("data-icon");
    element.insertAdjacentHTML("afterbegin", icon(name));
  });
}
