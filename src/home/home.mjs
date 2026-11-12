/**
 * Home (docs/HOME.md): the page the app opens on. It lists the person's
 * projects with the pins and folders they arranged, starts a new animation and
 * leads into the tutorials. Home is a page over the editor, not another
 * document: the open projects stay open behind it, and it steps aside as soon
 * as a project comes to the front or a command works on the animation.
 *
 *   - The project list is the desktop's (desktop/project-library.cjs, through
 *     the preload's listProjects…); the browser build keeps no list and says so.
 *     The renderer only sees opaque ids: opening goes through the same import
 *     the File menu uses.
 *   - A project's picture is the one its tab already has (the stage as it was
 *     last seen); Home stores it with the project's counts after a save or an
 *     open, never on an interactive path.
 *   - Nothing is built until Home first shows, and its list is read again each
 *     time it shows: files move and change outside the app.
 *
 * ctx (from app.mjs): {root, editor, state, actions, desktop, overlays, guarded,
 * toast(text, key, params), menu(items, anchor, options), prompt(options),
 * acceptNativeFile(result), activateDocument(token), picture(), fit(), pause(),
 * focusStage(), settings(), tutorials(), studio(), startupView}; getters for
 * what the app creates later.
 */
import {t as interfaceText, interfaceLocalization} from '../localization.mjs';
import {createStartupDocument, STARTUP_CANVASES} from '../startup-document.mjs';
import {createHomeView} from './home-view.mjs';
import {ALL_PROJECTS, PINNED_PROJECTS, HOME_LAYOUTS, HOME_SORTS, folderScope, validScope, tutorialProgress} from './home-model.mjs';

/**
 * The commands that run with Home staying where it is: they open something of
 * their own (a dialog, a menu, a file picker) or act on the window. Every
 * other command works on the animation, so Home steps aside before it runs.
 */
export const HOME_COMMANDS = Object.freeze(new Set([
  'home', 'tutorials', 'menu', 'command-palette', 'settings', 'privacy', 'feedback', 'check-updates', 'release-notes', 'donate',
  'website', 'help', 'about', 'performance', 'minimize', 'maximize', 'close', 'new-window', 'open', 'open-recent',
  'save', 'save-as', 'save-all', 'save-and-close', 'save-and-update', 'restart-update',
]));
/** The shortcuts that work on Home: its own commands and the ones that bring a project to the front. */
const HOME_KEYS = new Set([...HOME_COMMANDS, 'new', 'next-project', 'previous-project', 'recent-project']);
const SORT_KEYS = Object.freeze({recent: 'home.sort.recent', name: 'home.sort.name', modified: 'home.sort.modified'});
const MAX_PICTURES = 96;
const PICTURE_WIDTH = 320;
/** After a save or an open, once the project's tab has its picture (app.mjs takes it 700 ms after either). */
const PICTURE_DELAY_MS = 1800;

export function createHome(ctx) {
  const {root, editor, state, actions, desktop, overlays, guarded} = ctx;
  const doc = root.ownerDocument, win = doc.defaultView ?? globalThis;
  const workspace = root.closest('.workspace'), shell = root.closest('.shell'), band = shell?.querySelector('.titlebar') ?? null;
  const supported = Boolean(desktop?.listProjects);
  const model = {
    supported, news: Boolean(desktop?.getUpdateState), feedback: Boolean(desktop?.supportRequest), loading: supported, projects: [], folders: [], scope: ALL_PROJECTS, query: '',
    sort: 'recent', layout: 'grid', busyId: null, tutorials: tutorialProgress([], []), documentName: '', firstTime: false,
  };
  let view = null, shown = false, loads = 0, pictureTimer = 0, storedPicture = null;
  // Pictures already read, newest last: scrolling back to a card shows it at once.
  const pictures = new Map();
  const say = (key, params = {}) => ctx.toast(interfaceText(key, params), key, params);

  function read() {
    const settings = state.settings;
    model.sort = HOME_SORTS.includes(settings.homeSort) ? settings.homeSort : 'recent';
    model.layout = HOME_LAYOUTS.includes(settings.homeLayout) ? settings.homeLayout : 'grid';
    model.tutorials = tutorialProgress(ctx.tutorials()?.list ?? [], settings.tutorialsDone ?? []);
    model.documentName = editor.name || interfaceText('home.untitled');
    model.firstTime = !model.loading && !model.projects.length && !model.tutorials.done;
  }
  function draw(what) {
    if (!view || !shown) return;
    read();
    view.render(model, what);
  }

  // ---- The project list --------------------------------------------------------------------------------------------
  /** Reads the list again. A slower, older answer never replaces a newer one. */
  async function load() {
    if (!supported) return;
    const request = ++loads;
    let listed;
    try { listed = await desktop.listProjects(); }
    finally { if (request === loads) model.loading = false; }
    if (request !== loads) return;
    model.projects = listed?.projects ?? [];
    model.folders = listed?.folders ?? [];
    model.scope = validScope(model.scope, model.projects, model.folders);
    draw(['head', 'projects']);
  }
  const project = id => model.projects.find(item => item.id === id) ?? null;
  /** A change to the list, then the list as the desktop has it. */
  async function change(operation) {
    try { return await operation(); }
    finally { await load(); }
  }

  function picture(id) {
    if (pictures.has(id)) return pictures.get(id);
    const pending = Promise.resolve(desktop.getProjectPreview(id)).catch(() => null);
    pictures.set(id, pending);
    while (pictures.size > MAX_PICTURES) pictures.delete(pictures.keys().next().value);
    return pending;
  }

  /**
   * Stores the picture and counts of the project in front with its entry in the list. The picture is the one its
   * tab shows; the desktop ignores a project that has no file yet.
   */
  async function storePicture() {
    pictureTimer = 0;
    const documentToken = state.documentToken;
    if (!desktop?.setProjectPreview || !documentToken || editor.dirty) return;
    const bitmap = ctx.picture?.() ?? null, report = editor.report;
    let thumbnail;
    if (bitmap && bitmap !== storedPicture && bitmap.width > 0 && bitmap.height > 0) {
      try {
        const canvas = doc.createElement('canvas'), scale = Math.min(1, PICTURE_WIDTH / bitmap.width);
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        thumbnail = canvas.toDataURL('image/png');
      } catch { thumbnail = undefined; /* The tab released this picture meanwhile: the counts are stored without it. */ }
    }
    let result = null;
    try {
      result = await desktop.setProjectPreview({documentToken, thumbnail,
        stats: {frames: editor.totalTicks, fps: Number(report.fps), width: report.canvas_width, height: report.canvas_height}});
    } catch { return; /* Another project came to the front meanwhile: its own save or open stores it. */ }
    if (!result?.stored) return;
    if (thumbnail) { storedPicture = bitmap; pictures.delete(result.id); }
    if (shown) void load().catch(() => {});
  }
  function schedulePicture() {
    if (!desktop?.setProjectPreview) return;
    win.clearTimeout(pictureTimer);
    pictureTimer = win.setTimeout(() => { void storePicture(); }, PICTURE_DELAY_MS);
  }

  // ---- What the page asks for ----------------------------------------------------------------------------------------
  /** A new animation on a canvas of the chosen shape. Resolves false when nothing opened (too many projects are open). */
  async function newAnimation(shape) {
    const before = editor.report;
    await actions.new();
    if (editor.report === before) return false;
    const canvas = STARTUP_CANVASES[shape];
    if (canvas && shape !== 'landscape') {
      // The new project is still the untouched startup animation: the same one on the chosen canvas takes its place.
      editor.load(createStartupDocument({canvas}), editor.name);
      ctx.fit();
    }
    return true;
  }

  async function openProject(id) {
    const item = project(id);
    if (!item || model.busyId) return false;
    if (item.missing) { say('home.project.missingHint', {name: item.name}); return false; }
    // A project that is already open comes to the front as it was left.
    if (item.documentToken && await ctx.activateDocument(item.documentToken)) { hide(); return true; }
    model.busyId = id;
    draw(['projects']);
    try {
      const result = await desktop.openProject(id);
      return Boolean(result) && (await ctx.acceptNativeFile(result)) !== false;
    } finally {
      model.busyId = null;
      if (shown) await load();
    }
  }

  async function newFolder({then = null} = {}) {
    const name = await ctx.prompt({
      title: interfaceText('home.folder.newTitle'), titleKey: 'home.folder.newTitle',
      label: interfaceText('home.folder.name'), labelKey: 'home.folder.name',
      confirmLabel: interfaceText('home.folder.create'), confirmLabelKey: 'home.folder.create', maxLength: 60,
      validate: value => (value.trim() ? null : interfaceText('home.folder.nameNeeded')),
    });
    if (name === null || name === undefined) return null;
    const {folder} = await change(async () => {
      const created = await desktop.changeProjectFolder({action: 'create', name});
      if (then) await then(created.folder);
      return created;
    });
    if (!then) { model.scope = folderScope(folder); draw(['projects']); }
    return folder;
  }
  async function renameFolder(name) {
    const next = await ctx.prompt({
      title: interfaceText('home.folder.renameTitle'), titleKey: 'home.folder.renameTitle',
      label: interfaceText('home.folder.name'), labelKey: 'home.folder.name', value: name,
      confirmLabel: interfaceText('home.folder.rename'), confirmLabelKey: 'home.folder.rename', maxLength: 60,
      validate: value => (value.trim() ? null : interfaceText('home.folder.nameNeeded')),
    });
    if (next === null || next === undefined || next.trim() === name) return;
    const viewing = model.scope.kind === 'folder' && model.scope.name === name;
    const {folder} = await change(() => desktop.changeProjectFolder({action: 'rename', name, to: next}));
    if (viewing) { model.scope = folderScope(folder); draw(['projects']); }
  }
  async function deleteFolder(name) {
    await change(() => desktop.changeProjectFolder({action: 'delete', name}));
    say('home.folder.deleted', {name});
  }
  const moveTo = (id, folder) => change(() => desktop.updateProject(id, {folder}));

  function projectMenu(id, anchor) {
    const item = project(id);
    if (!item) return;
    const folders = model.folders.map(name => ({label: name, icon: 'folder', radio: true, checked: item.folder === name, run: guarded(() => moveTo(id, name))}));
    ctx.menu([
      {label: interfaceText('home.project.openIt'), labelKey: 'home.project.openIt', icon: 'arrow-right', disabled: item.missing, run: guarded(() => openProject(id))},
      null,
      {label: interfaceText(item.pinned ? 'home.project.unpin' : 'home.project.pin'), labelKey: item.pinned ? 'home.project.unpin' : 'home.project.pin', icon: 'pin',
        run: guarded(() => change(() => desktop.updateProject(id, {pinned: !item.pinned})))},
      {label: interfaceText('home.project.moveTo'), labelKey: 'home.project.moveTo', icon: 'folder', submenu: [
        {label: interfaceText('home.folder.none'), labelKey: 'home.folder.none', radio: true, checked: !item.folder, run: guarded(() => moveTo(id, ''))},
        ...folders,
        null,
        {label: interfaceText('home.scope.newFolder'), labelKey: 'home.scope.newFolder', icon: 'folder-plus', run: guarded(() => newFolder({then: folder => desktop.updateProject(id, {folder})}))},
      ]},
      {label: interfaceText('home.project.reveal'), labelKey: 'home.project.reveal', icon: 'folder', disabled: item.missing, run: guarded(() => desktop.revealProject(id))},
      null,
      {label: interfaceText('home.project.remove'), labelKey: 'home.project.remove', icon: 'close', run: guarded(async () => {
        await change(() => desktop.removeProject(id));
        pictures.delete(id);
        say('home.project.removed', {name: item.name});
      })},
    ], anchor, {label: item.name});
  }
  function folderMenu(name, anchor) {
    ctx.menu([
      {label: interfaceText('home.folder.renameIt'), labelKey: 'home.folder.renameIt', icon: 'text', run: guarded(() => renameFolder(name))},
      {label: interfaceText('home.folder.delete'), labelKey: 'home.folder.delete', icon: 'trash', danger: true, run: guarded(() => deleteFolder(name))},
    ], anchor, {label: name});
  }
  function sortMenu(anchor) {
    ctx.menu(HOME_SORTS.map(sort => ({label: interfaceText(SORT_KEYS[sort]), labelKey: SORT_KEYS[sort], radio: true, checked: model.sort === sort,
      run: () => { ctx.settings()?.commit({homeSort: sort}); draw(['projects']); }})), anchor,
    {label: interfaceText('home.projects.sortTitle'), labelKey: 'home.projects.sortTitle'});
  }
  /** Where a menu opens: under the control that asked, or at the pointer (a right click). */
  const at = (event, target) => target ?? {left: event.clientX, bottom: event.clientY, invoker: event.target.closest('button') ?? view.page};

  function build() {
    view = createHomeView({root, document: doc, on: {
      continue: () => hide(),
      new: guarded(detail => newAnimation(detail.canvas)),
      open: () => actions.open(),
      'open-project': guarded(detail => openProject(detail.id)),
      'project-menu': (detail, event, target) => projectMenu(detail.id, at(event, target)),
      'folder-menu': (detail, event, target) => folderMenu(detail.folder, at(event, target)),
      scope: detail => {
        model.scope = detail.kind === 'folder' ? folderScope(detail.folder) : detail.kind === 'pinned' ? PINNED_PROJECTS : ALL_PROJECTS;
        draw(['projects']);
      },
      'new-folder': guarded(() => newFolder()),
      sort: (detail, event, target) => sortMenu(target),
      layout: detail => { if (HOME_LAYOUTS.includes(detail.layout)) { ctx.settings()?.commit({homeLayout: detail.layout}); draw(['projects']); } },
      search: value => { model.query = value; draw(['projects']); },
      tutorial: guarded(detail => ctx.tutorials()?.start(detail.id)),
    }});
    if (supported) view.setPreviewSource(picture);
    // Escape goes back to the animation, wherever focus is; a menu or a dialog over Home keeps the key for itself
    // (the overlay manager's own Escape runs first and marks the key handled).
    doc.addEventListener('keydown', event => {
      if (!shown || event.key !== 'Escape' || event.defaultPrevented || event.isComposing || overlays.blocksHotkeys()) return;
      event.preventDefault();
      hide();
    });
    // Some of the page's words are written as text (dates, sizes): a new language writes them again.
    interfaceLocalization.subscribe(() => draw());
  }

  // ---- Showing and leaving -------------------------------------------------------------------------------------------
  function mark() {
    root.hidden = !shown;
    workspace?.toggleAttribute('data-home', shown);
    shell?.toggleAttribute('data-home', shown);
    for (const button of doc.querySelectorAll('[data-action="home"][aria-pressed]')) button.setAttribute('aria-pressed', String(shown));
    ctx.studio()?.sync();
  }
  /** Shows Home; `section` ('learn', 'projects') brings that part into view. */
  function show({section = null, focus = true} = {}) {
    if (!view) build();
    if (!shown) {
      ctx.pause();
      // A tutorial belongs to the editor: Home ends it.
      ctx.tutorials()?.leave();
      shown = state.home = true;
      mark();
      view.page.scrollTop = 0;
      draw();
      void load().catch(ctx.fail);
    }
    if (section) view.reveal(section);
    else if (focus) view.page.focus({preventScroll: true});
    return true;
  }
  /** Back to the animation. */
  function hide({focus = true} = {}) {
    if (!shown) return false;
    shown = state.home = false;
    mark();
    if (focus) ctx.focusStage?.();
    return true;
  }

  // A project that comes to the front, by any way (a tab, a file from the system, a recovered copy), is what the
  // person asked to see. A save or an open also refreshes the project's entry in the list.
  editor.addEventListener('change', event => {
    const kind = event.detail?.kind;
    if (kind === 'document') { if (shown) hide({focus: false}); if (!event.detail.resumed) schedulePicture(); }
    else if (kind === 'saved') schedulePicture();
  });
  // The workspace switch and a project's tab lead back to the editor, also when they change nothing there
  // (the workspace or the project already in front).
  const leaves = target => Boolean(target.closest?.('.workspace-switch [data-workspace-mode], .project-tab') && !target.closest('.project-tab-close'));
  band?.addEventListener('click', event => { if (shown && leaves(event.target)) hide({focus: false}); }, true);
  band?.addEventListener('keydown', event => { if (shown && (event.key === 'Enter' || event.key === ' ') && leaves(event.target)) hide({focus: false}); }, true);

  Object.assign(actions, {
    /** The band's Home button and File › Home: to Home, or back to the animation. */
    home: () => (shown ? hide() : show()),
  });

  return {
    get shown() { return shown; },
    show, hide,
    /** The app's command wrapper tells Home which command is about to run: one that works on the animation sends Home away. */
    before(command) { if (shown && !HOME_COMMANDS.has(command)) hide({focus: false}); },
    /** True when a key press is not for the editor: Home shows and the key is not one of its shortcuts. */
    blocksKey(command) { return shown && !(command && HOME_KEYS.has(command.id)); },
    /** Home at startup, unless the launch says otherwise (`startupView`: 'home' or 'editor') or the person turned it off. */
    start() {
      const wanted = ctx.startupView === 'home' || ctx.startupView === 'editor' ? ctx.startupView : state.settings.showHomeOnStartup === false ? 'editor' : 'home';
      return wanted === 'home' ? show() : false;
    },
    /** Where a message goes while Home shows: the page's box. */
    area: () => root.getBoundingClientRect(),
    refresh: () => (shown ? load() : Promise.resolve()),
    get view() { return view; },
    get model() { return model; },
    destroy() { win.clearTimeout(pictureTimer); view?.destroy(); },
  };
}
