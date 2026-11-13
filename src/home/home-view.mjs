/**
 * Home's page (docs/HOME.md): what the hub shows, as DOM. The view draws the
 * state its owner (home.mjs) gives it and reports what the person asks for
 * through `on[name](detail, event)`; it holds no project data of its own and
 * runs no command.
 *
 *   notice    the first-start line about statistics (desktop, until it is answered)
 *   head      a greeting and the way back to the open animation
 *   start     a new animation in one of three canvas shapes, or a file to open
 *   projects  the project list (desktop): search, order, grid or list, pins
 *             and folders
 *   learn     the tutorials, with what is done and what comes next
 *   help      shortcuts, what's new, feedback
 *
 * Sections are drawn again only when what they show changes (render(state,
 * what)). A project's picture loads when its card comes into view.
 */
import {localizedText, localizedAttribute, replaceLocalized, connectTranslations} from '../localization-bindings.mjs';
import {interfaceLocalization, t as interfaceText} from '../localization.mjs';
import {icon} from '../icons.mjs';
import {STARTUP_CANVASES} from '../startup-document.mjs';
import {sameScope, projectOrigin, projectScopes, visibleProjects, relativeTime, playSeconds, fileSize, HOME_LAYOUTS} from './home-model.mjs';

const ORIGIN_KEYS = Object.freeze({pivot: 'home.origin.pivot', sticknodes: 'home.origin.sticknodes'});
const SORT_KEYS = Object.freeze({recent: 'home.sort.recent', name: 'home.sort.name', modified: 'home.sort.modified'});
const SHAPES = Object.freeze([
  ['landscape', 'home.start.landscape'],
  ['portrait', 'home.start.portrait'],
  ['square', 'home.start.square'],
]);

export function createHomeView({root, on = {}, document: doc = root.ownerDocument}) {
  const win = doc.defaultView ?? globalThis;
  const el = (tag, className, parent) => { const node = doc.createElement(tag); if (className) node.className = className; parent?.append(node); return node; };
  const text = (tag, className, parent, key, params = {}) => { const node = el(tag, className, parent); localizedText(node, key, params); return node; };
  const glyph = (parent, name, className = 'home-glyph') => { const node = el('span', className, parent); node.setAttribute('aria-hidden', 'true'); node.innerHTML = icon(name); return node; };
  const action = (node, name, detail = {}) => { node.dataset.home = name; for (const [key, value] of Object.entries(detail)) node.dataset[key] = value; return node; };
  const button = (className, parent, {name, detail, variant, size, iconName, key, params} = {}) => {
    const node = el('button', className, parent);
    node.type = 'button';
    if (variant) node.dataset.variant = variant;
    if (size) node.dataset.size = size;
    if (iconName) node.insertAdjacentHTML('beforeend', icon(iconName));
    if (key) text('span', 'ui-label', node, key, params);
    if (name) action(node, name, detail);
    return node;
  };
  const number = (value, options) => interfaceLocalization.formatNumber(value, options);
  /** "3 hours ago", in the interface's language; the date once it is older than a month. */
  const when = time => {
    if (!Number.isFinite(time)) return '';
    const relative = relativeTime(time);
    if (!relative) return interfaceText('home.time.now');
    if (relative.unit === 'month' || relative.unit === 'year') return interfaceLocalization.formatDate(time, {dateStyle: 'medium'});
    try { return new Intl.RelativeTimeFormat(interfaceLocalization.locale, {numeric: 'auto'}).format(relative.value, relative.unit); }
    catch { return interfaceLocalization.formatDate(time, {dateStyle: 'medium'}); }
  };
  const length = stats => {
    const seconds = playSeconds(stats);
    return seconds === null ? '' : interfaceText('home.project.length', {seconds: number(seconds, {maximumFractionDigits: 1, minimumFractionDigits: 1})});
  };
  const size = bytes => {
    const value = fileSize(bytes);
    if (!value) return '';
    try { return number(value.value, {style: 'unit', unit: value.unit, unitDisplay: 'short', maximumFractionDigits: 1}); } catch { return ''; }
  };

  // ---- Structure ---------------------------------------------------------------------------------------------------
  root.dataset.ui = '';
  // The page scrolls as one; it takes focus when Home shows, so the first Tab lands on its first control.
  const page = el('div', 'home-page', root);
  page.tabIndex = -1;
  const body = el('div', 'home-body', page);
  const main = el('div', 'home-main', body);
  const notice = el('div', 'home-notice', main);
  notice.hidden = true;
  const head = el('header', 'home-head', main);
  const start = el('section', 'home-section home-start', main);
  const projects = el('section', 'home-section home-projects', main);
  const side = el('aside', 'home-side', body);
  const learn = el('section', 'home-card home-learn ui-island', side);
  const help = el('section', 'home-card home-help ui-island', side);
  let previews = null, previewSource = null, projectsBuilt = false, search = null, scopes = null, list = null, tools = null;

  // ---- Head ----------------------------------------------------------------------------------------------------------
  function renderHead(state) {
    const words = el('div', 'home-head-text');
    text('h1', 'home-title', words, state.firstTime ? 'home.welcome' : 'home.welcomeBack');
    text('p', 'home-lede', words, state.firstTime ? 'home.ledeFirst' : 'home.lede');
    // Quiet beside the tutorial's Start: the page has one main action.
    const back = button('ui-button home-continue', null, {name: 'continue', variant: 'outline', size: 'lg', iconName: 'arrow-right'});
    const label = el('span', 'ui-label');
    localizedText(label, 'home.continue', {name: state.documentName});
    back.prepend(label);
    replaceLocalized(head, words, back);
  }

  // ---- The first-start line (src/privacy-settings.mjs): one quiet line, in the page, never over anything --------------
  function renderNotice(state) {
    if (!state.statsNotice) {
      // Answered: focus that was on one of its buttons stays on the page.
      if (notice.contains(doc.activeElement)) page.focus({preventScroll: true});
      notice.hidden = true;
      replaceLocalized(notice);
      return;
    }
    notice.hidden = false;
    if (notice.childElementCount) return;
    const words = text('p', 'home-notice-text', null, 'privacy.notice.text');
    const actions = el('div', 'home-notice-actions');
    button('ui-button', actions, {name: 'stats-details', variant: 'ghost', size: 'sm', key: 'privacy.notice.details'});
    button('ui-button', actions, {name: 'stats-off', variant: 'ghost', size: 'sm', key: 'privacy.notice.turnOff'});
    button('ui-button', actions, {name: 'stats-ok', variant: 'outline', size: 'sm', key: 'privacy.notice.ok'});
    replaceLocalized(notice, words, actions);
  }

  // ---- Start ---------------------------------------------------------------------------------------------------------
  function renderStart() {
    const title = text('h2', 'home-section-title', null, 'home.start.title');
    title.id = 'home-start-title';
    start.setAttribute('aria-labelledby', title.id);
    const grid = el('div', 'home-start-grid');
    for (const [shape, nameKey] of SHAPES) {
      const canvas = STARTUP_CANVASES[shape];
      const tile = button('home-start-tile', grid, {name: 'new', detail: {canvas: shape}});
      const art = el('span', 'home-start-art', tile);
      art.setAttribute('aria-hidden', 'true');
      const sheet = el('i', 'home-start-sheet', art);
      sheet.style.setProperty('--ratio', String(canvas.width / canvas.height));
      const words = el('span', 'home-start-text', tile);
      text('b', '', words, nameKey);
      text('small', '', words, 'home.start.size', {width: canvas.width, height: canvas.height});
    }
    const open = button('home-start-tile', grid, {name: 'open'});
    glyph(el('span', 'home-start-art', open), 'folder', 'home-start-icon');
    const words = el('span', 'home-start-text', open);
    text('b', '', words, 'home.start.open');
    text('small', '', words, 'home.start.openFor');
    replaceLocalized(start, title, grid);
  }

  // ---- Projects ------------------------------------------------------------------------------------------------------
  function buildProjects() {
    const bar = el('div', 'home-projects-head');
    const title = text('h2', 'home-section-title', bar, 'home.projects.title');
    title.id = 'home-projects-title';
    projects.setAttribute('aria-labelledby', title.id);
    tools = el('div', 'home-projects-tools', bar);
    const field = el('label', 'ui-field home-search', tools);
    field.dataset.size = 'sm';
    field.insertAdjacentHTML('beforeend', icon('search'));
    search = el('input', 'ui-field-input', field);
    search.type = 'search';
    search.autocomplete = 'off';
    search.spellcheck = false;
    localizedAttribute(search, 'placeholder', 'home.projects.search');
    localizedAttribute(search, 'aria-label', 'home.projects.search');
    search.addEventListener('input', () => on.search?.(search.value));
    // Escape clears the search before anything else takes the key.
    search.addEventListener('keydown', event => { if (event.key === 'Escape' && search.value) { event.stopPropagation(); search.value = ''; on.search?.(''); } });
    const sort = button('ui-button home-sort', tools, {name: 'sort', variant: 'ghost', size: 'sm', iconName: 'sort'});
    sort.setAttribute('aria-haspopup', 'menu');
    el('span', 'ui-label', sort);
    sort.insertAdjacentHTML('beforeend', icon('chevron-down', 'ui-button-chev'));
    const layout = el('div', 'ui-segmented home-layout', tools);
    layout.dataset.size = 'sm';
    layout.setAttribute('role', 'group');
    localizedAttribute(layout, 'aria-label', 'home.projects.layout');
    for (const kind of HOME_LAYOUTS) {
      const item = button('ui-segmented-item', layout, {name: 'layout', detail: {layout: kind}, iconName: kind === 'grid' ? 'tiles' : 'list'});
      localizedAttribute(item, 'aria-label', kind === 'grid' ? 'home.projects.grid' : 'home.projects.list');
      localizedAttribute(item, 'data-tooltip', kind === 'grid' ? 'home.projects.grid' : 'home.projects.list');
    }
    scopes = el('div', 'home-scopes');
    scopes.setAttribute('role', 'toolbar');
    localizedAttribute(scopes, 'aria-label', 'home.projects.scopes');
    list = el('div', 'home-list');
    replaceLocalized(projects, bar, scopes, list);
    projectsBuilt = true;
  }

  /**
   * A project's card: its picture and words, with one button over the whole card that opens it (named by the
   * project, described by its line) and the card's menu above that.
   */
  function projectCard(project, state) {
    const card = el('article', 'home-project');
    card.dataset.id = project.id;
    if (project.missing) card.dataset.state = 'missing'; else if (project.open) card.dataset.state = 'open';
    if (state.busyId === project.id) card.setAttribute('aria-busy', 'true');
    const origin = projectOrigin(project.extension);
    const art = el('span', 'home-project-art', card);
    art.setAttribute('aria-hidden', 'true');
    art.dataset.origin = origin;
    glyph(art, project.missing ? 'alert' : origin === 'styk' ? 'frame' : 'import', 'home-project-glyph');
    if (project.hasPreview && !project.missing) {
      const image = el('img', 'home-project-image', art);
      image.alt = '';
      image.decoding = 'async';
      image.hidden = true;
      art.dataset.preview = project.id;
    }
    const words = el('span', 'home-project-text', card);
    const name = el('span', 'home-project-name', words);
    name.textContent = project.name;
    const facts = [];
    if (project.missing) facts.push(interfaceText('home.project.missing'));
    else {
      if (project.open) facts.push(interfaceText('home.project.open'));
      if (ORIGIN_KEYS[origin]) facts.push(interfaceText(ORIGIN_KEYS[origin]));
      if (project.folder && state.scope.kind !== 'folder') facts.push(project.folder);
      facts.push(when(state.sort === 'modified' ? project.modifiedAt : project.openedAt));
    }
    const meta = el('span', 'home-project-meta', words);
    meta.textContent = facts.filter(Boolean).join(' · ');
    meta.id = `home-project-${project.id}`;
    // The list layout's columns; the grid shows the one line above.
    el('span', 'home-project-col', words).textContent = project.folder || '—';
    el('span', 'home-project-col', words).textContent = project.missing ? '—' : length(project.stats) || '—';
    el('span', 'home-project-col', words).textContent = project.missing ? interfaceText('home.project.missing') : when(project.modifiedAt);
    el('span', 'home-project-col', words).textContent = project.missing ? '—' : size(project.bytes) || '—';
    const open = button('home-project-open', card, {name: 'open-project', detail: {id: project.id}});
    open.disabled = Boolean(state.busyId) && state.busyId !== project.id;
    open.setAttribute('aria-label', project.name);
    open.setAttribute('aria-describedby', meta.id);
    if (project.pinned) {
      const pin = glyph(card, 'pin', 'home-project-pin');
      localizedAttribute(pin, 'title', 'home.project.pinned');
    }
    const more = button('ui-icon-button home-project-more', card, {name: 'project-menu', detail: {id: project.id}, size: 'sm', iconName: 'more'});
    more.setAttribute('aria-haspopup', 'menu');
    localizedAttribute(more, 'aria-label', 'home.project.more', {name: project.name});
    return card;
  }

  function renderProjects(state) {
    if (!state.supported) {
      // A browser keeps no list of files: projects are opened and saved where the person chooses.
      projectsBuilt = false;
      const title = text('h2', 'home-section-title', null, 'home.projects.title');
      const empty = el('div', 'ui-empty home-empty');
      text('h3', 'ui-empty-title', empty, 'home.projects.webTitle');
      text('p', 'ui-empty-text', empty, 'home.projects.webText');
      button('ui-button', el('div', 'ui-empty-actions', empty), {name: 'open', variant: 'outline', iconName: 'folder', key: 'home.start.open'});
      replaceLocalized(projects, title, empty);
      return;
    }
    if (!projectsBuilt) buildProjects();
    if (search.value !== state.query) search.value = state.query;
    const sort = tools.querySelector('.home-sort');
    localizedText(sort.querySelector('.ui-label'), SORT_KEYS[state.sort] ?? SORT_KEYS.recent, {});
    localizedAttribute(sort, 'aria-label', 'home.projects.sortBy', {order: {messageKey: SORT_KEYS[state.sort] ?? SORT_KEYS.recent}});
    for (const item of tools.querySelectorAll('.home-layout > button')) item.setAttribute('aria-pressed', String(item.dataset.layout === state.layout));
    tools.hidden = !state.projects.length;

    // Scopes: every project, the pinned ones, each folder, then New folder.
    const chips = projectScopes(state.projects, state.folders).map(({scope, count}) => {
      const chip = button('ui-chip home-scope', null, {name: 'scope', detail: {kind: scope.kind, ...(scope.kind === 'folder' ? {folder: scope.name} : {})}, iconName: scope.kind === 'folder' ? 'folder' : scope.kind === 'pinned' ? 'pin' : null});
      const label = el('span', 'ui-label', chip);
      if (scope.kind === 'folder') label.textContent = scope.name; else localizedText(label, scope.kind === 'pinned' ? 'home.scope.pinned' : 'home.scope.all', {});
      el('small', 'home-scope-count', chip).textContent = number(count);
      chip.setAttribute('aria-pressed', String(sameScope(scope, state.scope)));
      return chip;
    });
    chips.push(button('ui-chip home-scope home-scope-new', null, {name: 'new-folder', iconName: 'plus', key: 'home.scope.newFolder'}));
    replaceLocalized(scopes, ...chips);
    scopes.hidden = !state.projects.length;

    previews?.disconnect();
    list.dataset.layout = state.layout;
    if (state.loading && !state.projects.length) {
      const loading = el('div', 'home-loading');
      loading.setAttribute('aria-busy', 'true');
      for (let index = 0; index < 4; index++) el('i', 'home-skeleton', loading);
      replaceLocalized(list, loading);
      return;
    }
    if (!state.projects.length) {
      const empty = el('div', 'ui-empty home-empty');
      glyph(empty, 'folder', 'ui-empty-glyph');
      text('h3', 'ui-empty-title', empty, 'home.projects.emptyTitle');
      text('p', 'ui-empty-text', empty, 'home.projects.emptyText');
      replaceLocalized(list, empty);
      return;
    }
    const shown = visibleProjects(state.projects, {scope: state.scope, query: state.query, sort: state.sort,
      compare: (a, b) => a.localeCompare(b, interfaceLocalization.locale, {numeric: true, sensitivity: 'base'})});
    if (!shown.length) {
      const empty = el('div', 'ui-empty home-empty');
      if (state.query) { text('h3', 'ui-empty-title', empty, 'home.projects.noMatch', {query: state.query}); text('p', 'ui-empty-text', empty, 'home.projects.noMatchText'); }
      else { text('h3', 'ui-empty-title', empty, 'home.projects.emptyFolder'); text('p', 'ui-empty-text', empty, 'home.projects.emptyFolderText'); }
      replaceLocalized(list, empty);
      return;
    }
    const nodes = [];
    if (state.layout === 'list') {
      const header = el('div', 'home-list-head');
      header.setAttribute('aria-hidden', 'true');
      for (const key of ['home.column.name', 'home.column.folder', 'home.column.length', 'home.column.modified', 'home.column.size']) text('span', '', header, key);
      nodes.push(header);
    }
    for (const project of shown) nodes.push(projectCard(project, state));
    replaceLocalized(list, ...nodes);
    watchPreviews();
  }

  /** A card's picture loads when the card comes into view; one request per card. */
  function watchPreviews() {
    if (!previewSource || !win.IntersectionObserver) return;
    previews ??= new win.IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const art = entry.target, id = art.dataset.preview;
        previews.unobserve(art);
        Promise.resolve(previewSource(id)).then(url => {
          const image = art.querySelector('.home-project-image');
          if (!url || !image || !art.isConnected) return;
          image.addEventListener('load', () => { image.hidden = false; art.dataset.loaded = ''; }, {once: true});
          image.src = url;
        }, () => {});
      }
    }, {root: page, rootMargin: '200px'});
    for (const art of list.querySelectorAll('[data-preview]')) previews.observe(art);
  }

  // ---- Learn ---------------------------------------------------------------------------------------------------------
  function renderLearn(state) {
    const {items, done, total, next} = state.tutorials;
    const top = el('div', 'home-card-head');
    const title = text('h2', 'home-section-title', top, 'home.learn.title');
    title.id = 'home-learn-title';
    learn.setAttribute('aria-labelledby', title.id);
    text('span', 'home-card-note', top, 'home.learn.progress', {done, count: total});
    const bar = el('div', 'ui-progress home-learn-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(total)); bar.setAttribute('aria-valuenow', String(done));
    localizedAttribute(bar, 'aria-label', 'home.learn.progress', {done, count: total});
    bar.style.setProperty('--_p', `${total ? Math.round(done / total * 100) : 0}%`);
    const nodes = [top, bar];
    const lead = next ?? null;
    if (lead) {
      const hero = el('div', 'home-lesson');
      hero.dataset.tint = lead.tint;
      glyph(hero, lead.icon, 'home-lesson-icon');
      const words = el('div', 'home-lesson-text', hero);
      text('span', 'home-lesson-eyebrow', words, done ? 'home.learn.next' : 'home.learn.startHere');
      text('b', 'home-lesson-title', words, lead.titleKey);
      text('p', 'home-lesson-line', words, lead.lineKey);
      const go = button('ui-button home-lesson-start', hero, {name: 'tutorial', detail: {id: lead.id}, variant: 'primary', iconName: 'play'});
      text('span', 'ui-label', go, 'home.learn.start', {minutes: lead.minutes});
      nodes.push(hero);
    } else {
      const all = el('div', 'home-lesson home-lesson-done');
      glyph(all, 'check-circle', 'home-lesson-icon');
      const words = el('div', 'home-lesson-text', all);
      text('b', 'home-lesson-title', words, 'home.learn.allDone');
      text('p', 'home-lesson-line', words, 'home.learn.allDoneText');
      nodes.push(all);
    }
    const rows = el('div', 'home-lessons');
    items.forEach((item, index) => {
      if (item === lead) return;
      const row = button('home-lesson-row', rows, {name: 'tutorial', detail: {id: item.id}});
      const mark = el('span', 'home-lesson-mark', row);
      mark.dataset.state = item.done ? 'done' : 'todo';
      mark.setAttribute('aria-hidden', 'true');
      if (item.done) mark.innerHTML = icon('check'); else mark.textContent = String(index + 1);
      const words = el('span', 'home-lesson-row-text', row);
      text('b', '', words, item.titleKey);
      text('small', '', words, item.done ? 'home.learn.doneAgain' : 'home.learn.minutes', {minutes: item.minutes});
    });
    nodes.push(rows);
    replaceLocalized(learn, ...nodes);
  }

  // ---- Help ----------------------------------------------------------------------------------------------------------
  function renderHelp(state) {
    const title = text('h2', 'home-section-title', null, 'home.help.title');
    title.id = 'home-help-title';
    help.setAttribute('aria-labelledby', title.id);
    const rows = el('div', 'home-help-rows');
    const row = (command, glyphName, nameKey, lineKey) => {
      const node = el('button', 'home-help-row', rows);
      node.type = 'button';
      // A command of the app: the app's own click delegation runs it.
      node.dataset.action = command;
      glyph(node, glyphName, 'home-help-icon');
      const words = el('span', 'home-help-text', node);
      text('b', '', words, nameKey);
      text('small', '', words, lineKey);
    };
    row('help', 'keyboard', 'home.help.shortcuts', 'home.help.shortcutsLine');
    row('command-palette', 'search', 'home.help.commands', 'home.help.commandsLine');
    if (state.news) row('release-notes', 'lightbulb', 'home.help.news', 'home.help.newsLine');
    if (state.feedback) row('feedback', 'message', 'home.help.feedback', 'home.help.feedbackLine');
    replaceLocalized(help, title, rows);
  }

  root.addEventListener('click', event => {
    const target = event.target.closest('[data-home]');
    if (!target || !root.contains(target) || target.disabled) return;
    on[target.dataset.home]?.({...target.dataset}, event, target);
  });
  root.addEventListener('contextmenu', event => {
    const card = event.target.closest('.home-project'), chip = event.target.closest('.home-scope[data-folder]');
    if (card) { event.preventDefault(); on['project-menu']?.({id: card.dataset.id}, event, null); }
    else if (chip) { event.preventDefault(); on['folder-menu']?.({folder: chip.dataset.folder}, event, null); }
  });

  const RENDER = {notice: renderNotice, head: renderHead, start: renderStart, projects: renderProjects, learn: renderLearn, help: renderHelp};
  return {
    root, page,
    /** Draws the named sections (all of them by default) from `state`. */
    render(state, what = Object.keys(RENDER)) {
      for (const name of what) RENDER[name]?.(state);
      connectTranslations(root);
    },
    /** `source(id)` resolves a project's picture as a URL, or null. */
    setPreviewSource(source) { previewSource = source; },
    focusSearch() { search?.focus(); },
    /** Brings a section to the top of the page and moves focus into it. */
    reveal(section) {
      const node = {learn, projects, help, start}[section];
      if (!node) return;
      node.scrollIntoView({block: 'start'});
      node.querySelector('button:not(:disabled)')?.focus({preventScroll: true});
    },
    destroy() { previews?.disconnect(); },
  };
}

