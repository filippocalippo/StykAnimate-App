import {messageError} from './localized-error.mjs';
/** Colour palettes shared by every colour picker and Draw's colour rail.
 *
 * Three sources:
 * - Project colours belong to the document (`_styk.palette`). They change
 *   only through editor commands, so they undo and save with the project.
 * - Recent colours belong to this app: the last colours painted or chosen.
 * - Personal palettes belong to the person: named palettes kept on this
 *   computer, like brush presets, and offered in every project.
 *
 * Recent colours, personal palettes and the chosen view are kept in local
 * storage and shared, so the picker and the rail always show the same
 * palette. Until someone chooses, the view follows the project: its colours
 * once it has any, recent before. */

export const PROJECT_PALETTE_LIMIT = 64;
export const PERSONAL_PALETTE_LIMIT = 64;
const PERSONAL_PALETTES_LIMIT = 32;
const RECENT_LIMIT = 12;
const NAME_LIMIT = 60;
const STORE_KEY = 'stykanimate.colors.v1';
// Draw kept its recent colours with the brushes before palettes were shared.
const LEGACY_BRUSH_KEY = 'stykanimate.drawing-brushes.v1';
const HEX = /^#[0-9a-f]{6}$/;

/** Lower-case #rrggbb, or null for anything else. */
const paletteHex = value => typeof value === 'string' && HEX.test(value.toLowerCase()) ? value.toLowerCase() : null;
const cleanList = (list, limit) => {
  const out = [];
  if (Array.isArray(list)) for (const value of list) { const hex = paletteHex(value); if (hex && !out.includes(hex)) out.push(hex); if (out.length >= limit) break; }
  return out;
};
const cleanName = name => typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT) : '';
const cleanPalettes = list => {
  const out = [];
  if (Array.isArray(list)) for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id.slice(0, 40) : '', name = cleanName(entry?.name);
    if (id && name && !out.some(palette => palette.id === id)) out.push({id, name, colors: cleanList(entry.colors, PERSONAL_PALETTE_LIMIT)});
    if (out.length >= PERSONAL_PALETTES_LIMIT) break;
  }
  return out;
};

/** The project's colours in their saved order; tolerant of damaged files. */
export const projectColors = report => cleanList(report?._styk?.palette?.colors, PROJECT_PALETTE_LIMIT);

let store;
const listeners = new Set();
function load() {
  if (store) return store;
  let saved = {};
  try { saved = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) || '{}') ?? {}; } catch { /* Palette storage is optional. */ }
  let recent = cleanList(saved.recent, RECENT_LIMIT);
  if (!Array.isArray(saved.recent)) try { recent = cleanList(JSON.parse(globalThis.localStorage?.getItem(LEGACY_BRUSH_KEY) || '{}')?.recent, RECENT_LIMIT); } catch { /* Nothing to migrate. */ }
  const palettes = cleanPalettes(saved.palettes), mine = palettes.some(palette => palette.id === saved.mine) ? saved.mine : palettes[0]?.id ?? null;
  store = {recent, view: ['project', 'recent', 'mine'].includes(saved.view) ? saved.view : null, mine, palettes};
  return store;
}
function save() {
  try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* Palette storage is optional. */ }
  for (const listener of listeners) listener();
}
/** Called when recent colours, personal palettes or the view change. Returns the unsubscribe. */
export function subscribePalette(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export const recentColors = () => load().recent;
/** Replaces the recent colours (tests, and Draw's library property). */
export function setRecentColors(colors) { load().recent = cleanList(colors, RECENT_LIMIT); save(); }
/** Moves a colour to the front of the recent colours. */
export function rememberColor(value) {
  const hex = paletteHex(value), state = load(); if (!hex || state.recent[0] === hex) return;
  state.recent = [hex, ...state.recent.filter(color => color !== hex)].slice(0, RECENT_LIMIT); save();
}

// ---- Personal palettes ----
export const personalPalettes = () => load().palettes;
/** The personal palette the Mine view shows, or null when there is none. */
export const currentPersonalPalette = () => { const state = load(); return state.palettes.find(palette => palette.id === state.mine) ?? null; };
const personal = id => { const palette = load().palettes.find(entry => entry.id === id); if (!palette) throw messageError(new Error(''), "errors.colorPalette.thatPaletteNoLongerExists", {}); return palette; };
/** A name for a new palette: "My palette", "My palette 2", … */
export function suggestPaletteName(base = 'My palette') {
  const names = new Set(load().palettes.map(palette => palette.name.toLowerCase()));
  for (let n = 1; ; n++) { const name = n === 1 ? base : `${base} ${n}`; if (!names.has(name.toLowerCase())) return name; }
}
/** Creates a personal palette, shows it and returns its id. */
export function createPersonalPalette(name, colors = []) {
  const state = load(), clean = cleanName(name);
  if (!clean) throw messageError(new Error(''), "errors.colorPalette.nameThePalette", {});
  if (state.palettes.length >= PERSONAL_PALETTES_LIMIT) throw messageError(new Error(''), "errors.colorPalette.youCanKeepUpToPalettesDeleteOne", {PERSONAL_PALETTES_LIMIT: PERSONAL_PALETTES_LIMIT});
  const id = `palette-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  state.palettes = [...state.palettes, {id, name: clean, colors: cleanList(colors, PERSONAL_PALETTE_LIMIT)}];
  state.view = 'mine'; state.mine = id; save();
  return id;
}
export function renamePersonalPalette(id, name) {
  const clean = cleanName(name); if (!clean) throw messageError(new Error(''), "errors.colorPalette.nameThePalette", {});
  const palette = personal(id); if (palette.name === clean) return false;
  load().palettes = store.palettes.map(entry => entry === palette ? {...entry, name: clean} : entry); save(); return true;
}
export function deletePersonalPalette(id) {
  personal(id); const state = load();
  state.palettes = state.palettes.filter(entry => entry.id !== id);
  if (state.mine === id) { state.mine = state.palettes[0]?.id ?? null; if (!state.mine && state.view === 'mine') state.view = null; }
  save(); return true;
}
function setPersonalColors(id, colors) {
  const palette = personal(id);
  if (colors.length === palette.colors.length && colors.every((color, i) => color === palette.colors[i])) return false;
  load().palettes = store.palettes.map(entry => entry === palette ? {...entry, colors} : entry); save(); return true;
}
export function addPersonalColor(id, value) {
  const hex = paletteHex(value), palette = personal(id);
  if (!hex) throw messageError(new Error(''), "errors.colorPalette.useAValidHexColor", {});
  if (palette.colors.includes(hex)) return false;
  if (palette.colors.length >= PERSONAL_PALETTE_LIMIT) throw messageError(new Error(''), "errors.colorPalette.isFullRemoveAColorToAdd", {name: palette.name, value: hex.toUpperCase()});
  return setPersonalColors(id, [...palette.colors, hex]);
}
export function removePersonalColor(id, value) { const hex = paletteHex(value), palette = personal(id); return setPersonalColors(id, palette.colors.filter(color => color !== hex)); }
export function movePersonalColor(id, value, index) {
  const hex = paletteHex(value), palette = personal(id); if (!palette.colors.includes(hex)) return false;
  const next = palette.colors.filter(color => color !== hex); next.splice(Math.max(0, Math.min(next.length, Math.trunc(index) || 0)), 0, hex);
  return setPersonalColors(id, next);
}

// ---- The view ----
/** 'project', 'recent' or 'mine': the palette the picker and the rail show. */
export function paletteView(project) {
  const state = load(), fallback = project.length ? 'project' : 'recent';
  if (state.view === 'mine') return currentPersonalPalette() ? 'mine' : fallback;
  return state.view ?? fallback;
}
export function setPaletteView(view) {
  if (!['project', 'recent'].includes(view)) throw messageError(new Error(''), "errors.colorPalette.chooseTheProjectOrRecentColors", {});
  if (load().view !== view) { store.view = view; save(); }
}
/** Shows a personal palette. */
export function selectPersonalPalette(id) { personal(id); const state = load(); if (state.view !== 'mine' || state.mine !== id) { state.view = 'mine'; state.mine = id; save(); } }
/** Where + saves a colour: 'project', 'mine' or null. The project is offered
 * in its view and, until a view is chosen, while it has no colours, so the
 * first colour saved switches to it. */
export function saveTarget(project) {
  const view = paletteView(project);
  return view === 'recent' ? (!load().view && !project.length ? 'project' : null) : view;
}

/** What a palette surface shows: the view, its name, its colours, where +
 * saves (`target`) and the colours already there (`saved`). */
export function paletteFor(project, recent = recentColors()) {
  const view = paletteView(project), mine = view === 'mine' ? currentPersonalPalette() : null, target = saveTarget(project);
  return {view, project, name: mine?.name ?? (view === 'project' ? 'Project' : 'Recent'),
    colors: view === 'project' ? project : mine ? mine.colors : recent,
    target, saved: target === 'mine' ? mine.colors : target === 'project' ? project : [],
    limit: target === 'mine' ? PERSONAL_PALETTE_LIMIT : PROJECT_PALETTE_LIMIT};
}
export const paletteColors = report => paletteFor(projectColors(report));

/** Project colours, the editor's own document and commands:
 * {colors(), add(hex), addMany(hexes), remove(hex), move(hex, index), subscribe(listener)}.
 * The picker is installed before the editor exists, so app.mjs binds them here. */
let projectSource = null;
export function bindProjectPalette(source) { projectSource = source; }
export const projectPalette = () => projectSource;

/** Saves a colour where + saves it now; false when it is already there. */
export function saveColor(value) {
  const target = saveTarget(projectSource?.colors() ?? []);
  if (target === 'mine') return addPersonalColor(load().mine, value);
  if (target === 'project' && projectSource) return projectSource.add(value);
  return false;
}
/** Removes or moves a colour in the palette shown now (project or personal). */
export function removeShownColor(value) {
  const view = paletteView(projectSource?.colors() ?? []);
  if (view === 'mine') return removePersonalColor(load().mine, value);
  return view === 'project' && projectSource ? projectSource.remove(value) : false;
}
export function moveShownColor(value, index) {
  const view = paletteView(projectSource?.colors() ?? []);
  if (view === 'mine') return movePersonalColor(load().mine, value, index);
  return view === 'project' && projectSource ? projectSource.move(value, index) : false;
}
