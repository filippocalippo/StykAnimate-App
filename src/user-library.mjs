import {presentError} from './error-presentation.mjs';
import {connectTranslations, replaceLocalized, tupleMessages, messageTuple, localizedMarkup, messageHTML, appendLocalized, messageAttributes, localizedAttribute, localizedText} from './localization-bindings.mjs';

import {interfaceLocalization, t as interfaceText} from './localization.mjs';

import {messageError} from './localized-error.mjs';

import {drawingBarrier} from './drawing-resources.mjs';
import {icon} from './icons.mjs';
import {HotkeyManager} from './hotkeys.mjs';
import {librarySnapshot, libraryPreview, pngThumbnail, saveLibraryFile, readLibraryFile} from './library-files.mjs';
import {LibraryHoverPreview} from './library-hover-preview.mjs';
import {libraryPreviewMatte, LIBRARY_MATTES} from './library-matte.mjs';
import {canMoveLibraryItem} from './library-drag.mjs';
import {openMenu} from './ui/ui-menu.mjs';
import {setAttr, setFlag, setProp, setText} from './ui/dom-write.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const folderIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const KIND_KEYS = {folder:"userLibrary.folder", movieclip:"userLibrary.movieclip", set:"userLibrary.figureSet", figure:"userLibrary.figure"};
const label = item => interfaceText(KIND_KEYS[item.kind] ?? "userLibrary.figure");
const parentOf = path => path.split('/').slice(0, -1).join('/');
// Electron prefixes what the main process throws; the person only needs the sentence.
const plain = error => String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
const PUBLIC_PAGE = 'https://stykanimate.com/library/';
const SKELETONS = 6;

export class UserLibrary {
  /**
   * The Library panel's content. Its root, #user-library, is a static host in
   * index.html; the shell's dock host places it and shows it (a tab, a sheet
   * or a floating island) and calls panelVisible(). `activate(id)` asks the
   * shell to show a panel ('library' or 'properties'); this module never hides
   * another panel.
   *
   * Two sources share one grid: My library (the desktop library's folders,
   * desktop/library-store.cjs) and Community library (what people share on
   * stykanimate.com, desktop/public-library.cjs). Cards insert on double-click,
   * Enter or a drag to the stage; everything else is in a card's ⋯ menu.
   */
  constructor({editor, desktop, exporter, importer, pause, finishEdit, setTool, vfxInspector, activate, hotkeys = new HotkeyManager()}) {
    this.hotkeys = hotkeys;
    Object.assign(this, {editor, desktop, exporter, importer, pause, finishEdit, setTool, vfxInspector, activate});
    this.source = 'mine'; this.folder = ''; this.entries = []; this.selected = null; this.generation = 0; this.busy = false; this.thumbnails = new Map();
    this.publicCatalog = null; this.publicState = 'idle'; this.publicError = ''; this.publicSelected = null; this.publicGeneration = 0;
    this.filterValue = 'all'; this.background = 'auto'; this.menu = null;
    this.cards = []; this.cardsByKey = new Map(); this.selectedCard = null; this.tabStopCard = null;
    this.hoverPreview = new LibraryHoverPreview(desktop);
    this.container = document.getElementById('user-library');
    if (!this.container) { this.container = document.createElement('section'); this.container.id = 'user-library'; this.container.hidden = true; }
    // The kit's parts (features/library.css): the source switch, a search with the kind and the library menu, where
    // you are, the cards as one listbox, then a pinned foot with the status line and Add selection.
    this.container.dataset.source = 'mine'; this.container.dataset.background = 'auto';
    localizedMarkup(this.container, `<div class="library-head">
      <div class="library-source ui-segmented" data-size="sm" data-fill role="group" aria-label="Library source" data-i18n-aria-label="userLibrary.librarySource"><button type="button" class="ui-segmented-item" data-library-source="mine" aria-pressed="true" data-i18n="userLibrary.myLibrary">${messageHTML("userLibrary.myLibrary", {})}</button><button type="button" class="ui-segmented-item" data-library-source="public" aria-pressed="false">${icon('globe')}${messageHTML("userLibrary.communityLibrary", {})}</button></div>
      <div class="library-tools"><label class="library-search ui-field" data-size="sm">${icon('search')}<input class="ui-field-input" type="search" aria-label="Search library" placeholder="Search" spellcheck="false" autocomplete="off" data-i18n-aria-label="userLibrary.searchLibrary" data-i18n-placeholder="common.search"></label><span class="ui-select library-kind-filter" data-size="sm"><select aria-label="Show" data-i18n-aria-label="userLibrary.show"><option value="all" data-i18n="userLibrary.all">${messageHTML("userLibrary.all", {})}</option><option value="figure" data-i18n="userLibrary.figures">${messageHTML("userLibrary.figures", {})}</option><option value="movieclip" data-i18n="userLibrary.movieclips">${messageHTML("userLibrary.movieclips", {})}</option></select>${icon('chevron-down')}</span><button type="button" class="ui-icon-button" data-size="sm" data-library-menu aria-haspopup="menu" aria-label="Library options" title="Library options" data-i18n-aria-label="userLibrary.libraryOptions" data-i18n-title="userLibrary.libraryOptions">${icon('more')}</button></div>
      <div class="library-location"><nav class="library-breadcrumbs ui-crumb" aria-label="Library folders" data-i18n-aria-label="userLibrary.libraryFolders"></nav><span class="library-origin">${icon('globe')}<span data-i18n="userLibrary.stykanimateCom">stykanimate.com</span></span><span class="library-count"></span><button type="button" class="ui-icon-button library-new-folder" data-size="sm" data-library-action="folder" aria-label="New library folder" title="New folder" data-i18n-aria-label="userLibrary.newLibraryFolder" data-i18n-title="userLibrary.newFolder">${icon('folder-plus')}</button></div>
    </div>
    <div class="library-content"><div class="library-grid" role="listbox" aria-label="My library" data-i18n-aria-label="userLibrary.myLibrary"></div><div class="library-empty ui-empty" hidden></div></div>
    <div class="library-foot"><p class="library-message" role="status" aria-live="polite"></p><button type="button" class="ui-button library-add" data-variant="outline" data-library-action="save">${icon('plus')}<span class="ui-label" data-i18n="userLibrary.addSelection">${messageHTML("userLibrary.addSelection", {})}</span></button><button type="button" class="ui-button library-website" data-variant="ghost" data-size="sm" data-library-action="website">${icon('link')}<span class="ui-label" data-i18n="userLibrary.browseStykanimateComLibrary">${messageHTML("userLibrary.browseStykanimateComLibrary", {})}</span></button></div>`);
    // Properties' footer: Add to library, shown with the Properties panel.
    this.propertySave = document.createElement('div'); this.propertySave.className = 'properties-library-save';
    localizedMarkup(this.propertySave, `<button type="button" class="button" data-library-action="save">${icon('plus')} ${messageHTML("userLibrary.addToLibrary", {})}</button>`);
    (document.getElementById('properties-panel') ?? this.container.parentElement)?.append(this.propertySave);
    connectTranslations(this.propertySave);
    this.roots = [this.container, this.propertySave];
    this.dialog = document.createElement('dialog'); this.dialog.className = 'library-dialog'; appendLocalized(document.body, this.dialog);
    this.grid = this.container.querySelector('.library-grid'); this.message = this.container.querySelector('.library-message');
    this.content = this.container.querySelector('.library-content'); this.empty = this.container.querySelector('.library-empty');
    this.input = this.container.querySelector('input'); this.kindSelect = this.container.querySelector('.library-kind-filter select');

    this.container.querySelector('.library-source').onclick = event => { const button = event.target.closest('[data-library-source]'); if (button) this.run(() => this.setSource(button.dataset.librarySource)); };
    this.kindSelect.onchange = () => this.setFilter(this.kindSelect.value);
    const options = this.container.querySelector('[data-library-menu]');
    options.onclick = () => this.showMenu(null, {anchor: options, options: true});
    window.addEventListener('blur', () => { this.closeMenu(); this.hoverPreview.stop(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.closeMenu(); this.hoverPreview.stop(); } });
    this.content.addEventListener('scroll', () => { this.closeMenu(); this.hoverPreview.stop(); }, {passive: true});
    this.content.addEventListener('contextmenu', event => {
      if (event.target.closest('input, select')) return;
      event.preventDefault(); event.stopPropagation(); this.showMenu(this.cardFrom(event.target), {point: {x: event.clientX, y: event.clientY}});
    });
    this.grid.addEventListener('pointerover', event => {
      const card = event.target.closest('.library-card');
      if (!card || card.contains(event.relatedTarget) || event.buttons || this.busy || this.menu || this.dialog.open || card.querySelector('input')) return;
      const item = this.source === 'mine' ? this.itemFor(card.dataset.libraryPath) : null;
      if (item?.kind === 'movieclip') this.hoverPreview.start(card, item);
    });
    this.grid.addEventListener('pointerout', event => {
      const card = event.target.closest('.library-card'); if (card && !card.contains(event.relatedTarget)) this.hoverPreview.stop();
    });
    this.grid.addEventListener('focusin', event => { const card = this.cardFrom(event.target); if (card) this.select(this.keyOf(card)); });
    for (const root of this.roots) root.addEventListener('click', event => {
      const action = event.target.closest('[data-library-action]')?.dataset.libraryAction; if (!action) return;
      event.stopPropagation(); this.run(() => this.action(action));
    });
    this.input.oninput = () => this.render();
    this.empty.onclick = event => {
      if (event.target.closest('[data-library-clear]')) { this.input.value = ''; this.setFilter('all'); this.input.focus(); }
      const source = event.target.closest('[data-library-source-link]')?.dataset.librarySourceLink;
      if (source) this.run(() => this.setSource(source));
      if (event.target.closest('[data-library-retry]')) this.run(() => this.loadPublic({refresh: true}));
    };
    this.grid.onclick = event => {
      const card = this.cardFrom(event.target); if (!card || event.target.matches('input')) return;
      this.select(this.keyOf(card));
      if (event.target.closest('.library-more')) this.showMenu(card, {anchor: event.target.closest('.library-more')});
    };
    this.grid.ondblclick = event => { const card = this.cardFrom(event.target); if (card && !event.target.closest('input, button')) this.run(() => this.open(this.keyOf(card))); };
    this.grid.onkeydown = event => this.onKey(event);
    this.container.addEventListener('keydown', event => event.stopPropagation());
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    this.observer = new IntersectionObserver(items => {
      for (const item of items) if (item.isIntersecting) { this.observer.unobserve(item.target); this.loadThumbnail(item.target, this.generation); }
    }, {root: this.content, rootMargin: '150px'});
    window.addEventListener('focus', () => { if (this.visible && this.source === 'mine' && !this.busy && !this.grid.querySelector('input')) this.run(() => this.refresh()); });
    editor.addEventListener('change', () => this.syncSelection()); this.syncSelection();
    // stykanimate://library/<id> from the website: the main process keeps the link until it is taken.
    if (desktop?.takePublicLibraryLink) {
      const take = () => this.run(async () => { const id = await desktop.takePublicLibraryLink(); if (id !== null && id !== undefined) await this.openPublic(id); });
      desktop.onPublicLibraryLink?.(take); take();
    }
  }

  // ---- The model ----
  /** Removing words: the desktop moves to the Recycle Bin; the browser's library has none, so removing deletes. */
  get bin() {
    return this.desktop?.inBrowser
      ? {menu: interfaceText("common.delete"), menuKey:"common.delete", dialog: interfaceText("userLibrary.willBeDeletedFromThisBrowserSLibrary"), dialogKey:"userLibrary.willBeDeletedFromThisBrowserSLibrary", button: interfaceText("common.delete"), buttonKey:"common.delete", done: interfaceText("userLibrary.deleted"), doneKey:"userLibrary.deleted"}
      : {menu: interfaceText("userLibrary.moveToRecycleBin"), menuKey:"userLibrary.moveToRecycleBin", dialog: interfaceText("userLibrary.willMoveToTheRecycleBin"), dialogKey:"userLibrary.willMoveToTheRecycleBin", button: interfaceText("userLibrary.moveToRecycleBin"), buttonKey:"userLibrary.moveToRecycleBin", done: interfaceText("userLibrary.movedToRecycleBin"), doneKey:"userLibrary.movedToRecycleBin"};
  }
  /** Listings are snapshots. Keep derived records and searches until the owning API replaces them. */
  itemView(source = this.source) {
    if (source === 'public') {
      if (!this.publicView || this.publicView.catalog !== this.publicCatalog) {
        const names = new Map((this.publicCatalog?.categories ?? []).map(category => [category.id, category.name]));
        const items = (this.publicCatalog?.items ?? []).map(item => ({...item, source: 'public', categoryName: names.get(item.category) ?? ''}));
        this.publicView = {catalog: this.publicCatalog, items, byKey: new Map(items.map(item => [item.id, item]))};
      }
      return this.publicView;
    }
    if (!this.localView || this.localView.items !== this.entries) this.localView = {items: this.entries, byKey: new Map(this.entries.map(item => [item.path, item]))};
    return this.localView;
  }
  get publicItems() { return this.itemView('public').items; }
  cardFrom(target) { const card = target?.closest?.('.library-card'); return card && this.grid.contains(card) && !card.classList.contains('is-skeleton') ? card : null; }
  keyOf(card) { return card?.dataset.libraryPath ?? card?.dataset.publicId ?? null; }
  cardFor(key) { return this.cardsByKey.get(key) ?? null; }
  itemFor(key) { return key == null ? null : this.itemView().byKey.get(key) ?? null; }
  get selectedKey() { return this.source === 'public' ? this.publicSelected : this.selected; }
  /** The asset a card drags (library-drag.mjs): an asset or, in My library, a folder. */
  assetFor(card) { return this.busy ? null : this.itemFor(this.keyOf(card)); }
  dragStarted(asset) { this.hoverPreview.stop(); this.closeMenu(); this.select(asset.path ?? asset.id); }
  visibleItems() {
    const locale = interfaceLocalization.locale, query = this.input.value.trim().toLocaleLowerCase(locale), filter = this.filterValue;
    const kind = item => filter === 'all' || item.kind === filter || filter === 'figure' && item.kind === 'set';
    const view = this.itemView(), pub = this.source === 'public';
    if (query && view.searchLocale !== locale) {
      view.searchText = new Map(view.items.map(item => [item, (pub ? `${item.name} ${item.categoryName} ${item.author} ${item.tags.join(' ')} ${item.description}` : item.name).toLocaleLowerCase(locale)]));
      view.searchLocale = locale;
    }
    return view.items.filter(item => (!pub && item.kind === 'folder' || kind(item)) && (!query || view.searchText.get(item).includes(query)));
  }

  // ---- Showing ----
  async run(operation) { try { await operation(); } catch (error) { this.say(error, true); } }
  say(text, error = false) {
    clearTimeout(this.messageTimer);
    if (text?.messageKey) presentError(this.message, text); else setText(this.message, text && typeof text === 'object' ? plain(text) : text);
    this.message.dataset.error = String(error);
    // Success fades after a while; an error stays until the next action.
    if (text && !error) this.messageTimer = setTimeout(() => { this.messageTimer = null; setText(this.message, ''); }, 6000);
  }
  show(visible = true) { this.showView(visible ? 'library' : 'properties'); }
  /** Asks the shell to show a panel: 'library', 'properties' or 'vfx'. */
  showView(view) { this.finishEdit?.(); this.activate?.(view); }
  /** The shell showed or hid the Library panel (panel registry onVisibility). */
  panelVisible(visible) {
    this.closeMenu(); this.hoverPreview.stop();
    this.visible = visible;
    if (visible) this.run(() => this.source === 'public' ? this.loadPublic() : this.refresh());
  }
  async setSource(source) {
    source = source === 'public' ? 'public' : 'mine';
    if (this.source !== source) {
      this.source = source; this.container.dataset.source = source; this.input.value = ''; this.say('');
      for (const button of this.container.querySelectorAll('[data-library-source]')) button.setAttribute('aria-pressed', String(button.dataset.librarySource === source));
      this.syncSelection();
    }
    return source === 'public' ? this.loadPublic() : this.refresh();
  }
  setFilter(value) { this.filterValue = value; this.kindSelect.value = value; this.render(); }
  setBackground(value) { this.background = value; this.container.dataset.background = value; }
  syncSelection() {
    const count = this.editor.selectedObjects.length, available = Boolean(this.desktop?.listLibrary);
    const saves = this.roots.flatMap(root => [...root.querySelectorAll('[data-library-action="save"]')]);
    // Runs on every editor change (each frame while playing): write only what changed.
    for (const button of saves) setProp(button, 'disabled', this.busy || !count || !available);
    // Properties' foot shows only when there is something to save (a figure or movieclip, in the desktop app).
    setProp(this.propertySave, 'hidden', !count || !available);
    localizedText(this.container.querySelector('.library-add .ui-label'), (count > 1 ? 'userLibrary.addFigures' : "userLibrary.addSelection"), (count > 1 ? {count} : {}));
    for (const button of saves) setAttr(button, 'title', count ? interfaceText('userLibrary.saveTheSelectionInValue', {value: this.folder ? this.folder.split('/').at(-1) : {messageKey: "userLibrary.myLibrary"}}) : interfaceText("userLibrary.selectFiguresOrAMovieclipToAddThem"));
  }
  /** Empty grid: explain the library and offer the next action for this situation. */
  renderEmpty(filtered) {
    const selection = this.editor.selectedObjects.length, pub = this.source === 'public';
    // The kit's empty state: a title, one quiet line where it helps, then the next step.
    const card = (title, text, actions = '', _messages = {}) => `<h3 class="ui-empty-title" ${_messages.title ? messageAttributes(_messages.title.key, _messages.title.params) : ''}>${title}</h3>${text ? `<p class="ui-empty-text" ${_messages.text ? messageAttributes(_messages.text.key, _messages.text.params) : ''}>${text}</p>` : ''}${actions ? `<div class="ui-empty-actions">${actions}</div>` : ''}`;
    const examples = `<button type="button" class="ui-button" data-variant="outline" data-size="sm" data-action="rig-examples" data-i18n="userLibrary.rigExamples">${messageHTML("userLibrary.rigExamples", {})}</button>`;
    const browse = `<button type="button" class="ui-button" data-variant="outline" data-size="sm" data-library-source-link="public" data-i18n="userLibrary.browseTheCommunityLibrary">${messageHTML("userLibrary.browseTheCommunityLibrary", {})}</button>`;
    if (filtered) localizedMarkup(this.empty, card(interfaceText("userLibrary.noMatches"), '', `<button type="button" class="ui-button" data-size="sm" data-library-clear data-i18n="userLibrary.clearSearch">${messageHTML("userLibrary.clearSearch", {})}</button>`, {title: {key: "userLibrary.noMatches", params: {}}}));
    else if (pub && !this.desktop?.listPublicLibrary) localizedMarkup(this.empty, card(interfaceText("userLibrary.communityLibrary"), interfaceText("userLibrary.freeFiguresAndMovieclipsSharedByTheCommunity"), `<a class="ui-button" data-variant="outline" data-size="sm" href="${PUBLIC_PAGE}" target="_blank" rel="noopener noreferrer">${messageHTML("userLibrary.openStykanimateComLibrary", {})}</a>`, {title: {key: "userLibrary.communityLibrary", params: {}}, text: {key: "userLibrary.freeFiguresAndMovieclipsSharedByTheCommunity", params: {}}}));
    else if (pub && this.publicState === 'error') localizedMarkup(this.empty, card(interfaceText("userLibrary.communityLibraryIsUnavailable"), esc(this.publicError), `<button type="button" class="ui-button" data-size="sm" data-library-retry data-i18n="userLibrary.tryAgain">${messageHTML("userLibrary.tryAgain", {})}</button>`, {title: {key: "userLibrary.communityLibraryIsUnavailable", params: {}}}));
    else if (pub) localizedMarkup(this.empty, card(interfaceText("userLibrary.nothingHereYet"), interfaceText("userLibrary.figuresAndMovieclipsSharedByTheCommunityAppear"), undefined, {title: {key: "userLibrary.nothingHereYet", params: {}}, text: {key: "userLibrary.figuresAndMovieclipsSharedByTheCommunityAppear", params: {}}}));
    else if (!this.desktop?.listLibrary) localizedMarkup(this.empty, card(interfaceText("userLibrary.libraryIsAvailableInTheDesktopApp"), interfaceText("userLibrary.saveFiguresAndMovieclipsThereToReuseThem"), examples, {title: {key: "userLibrary.libraryIsAvailableInTheDesktopApp", params: {}}, text: {key: "userLibrary.saveFiguresAndMovieclipsThereToReuseThem", params: {}}}));
    else if (this.folder) localizedMarkup(this.empty, card(interfaceText("userLibrary.emptyFolder"), interfaceText("userLibrary.dragAssetsOntoThisFolderSNameAbove"), selection ? '' : examples, {title: {key: "userLibrary.emptyFolder", params: {}}, text: {key: "userLibrary.dragAssetsOntoThisFolderSNameAbove", params: {}}}));
    else localizedMarkup(this.empty, card(interfaceText("userLibrary.noSavedAssetsYet"), selection ? interfaceText("userLibrary.addTheSelectionBelowToReuseItIn") : interfaceText("userLibrary.selectFiguresOrAMovieclipAndChooseAdd"), `${selection ? '' : browse}${examples}`, {title: {key: "userLibrary.noSavedAssetsYet", params: {}}, text: {key: selection ? "userLibrary.addTheSelectionBelowToReuseItIn" : "userLibrary.selectFiguresOrAMovieclipAndChooseAdd", params: {}}}));
  }
  renderLocation(count) {
    const pub = this.source === 'public';
    localizedText(this.container.querySelector('.library-count'), pub ? 'counts.assets' : 'counts.items', {count});
  }

  // ---- My library ----
  async refresh(folder = this.folder) {
    if (this.source !== 'mine') return;
    if (!this.desktop?.listLibrary) { this.container.dataset.unavailable = 'true'; return this.render(); }
    delete this.container.dataset.unavailable;
    const generation = ++this.generation;
    this.closeMenu(); this.hoverPreview.stop();
    let result;
    try { result = await this.desktop.listLibrary(folder); }
    catch (error) { if (folder && /ENOENT/.test(error.message)) result = await this.desktop.listLibrary(''); else throw error; }
    if (generation !== this.generation || this.source !== 'mine') return;
    if (this.folder !== result.path) { this.selected = null; this.input.value = ''; }
    this.folder = result.path; this.entries = result.entries; this.localView = null; this.root = result.root;
    const nav = this.container.querySelector('nav'); replaceLocalized(nav);
    let current = ''; const parts = messageTuple([interfaceText("userLibrary.library2"), ...this.folder.split('/').filter(Boolean)], {0: {key: "userLibrary.library2", params: {}}});
    for (const [i, part] of parts.entries()) {
      if (i) current += `${current ? '/' : ''}${part}`;
      if (i) { const sep = document.createElement('span'); sep.className = 'ui-crumb-sep'; sep.setAttribute('aria-hidden', 'true'); sep.textContent = '›'; appendLocalized(nav, sep); }
      const path = current, button = document.createElement('button'); button.type = 'button'; button.className = 'ui-crumb-item'; button.textContent = part;
      button.title = i ? part : this.root; button.dataset.libraryFolder = path;
      if (i === parts.length - 1) button.setAttribute('aria-current', 'location');
      button.onclick = () => this.run(() => this.refresh(path));
      appendLocalized(nav, button);
    }
    this.syncSelection();
    this.render();
  }

  // ---- Public library ----
  async loadPublic({refresh = false} = {}) {
    if (this.source !== 'public') return;
    if (!this.desktop?.listPublicLibrary) { this.publicState = 'unavailable'; return this.render(); }
    const generation = ++this.publicGeneration;
    if (!this.publicCatalog || refresh) { this.publicState = 'loading'; this.render(); }
    try {
      const catalog = await this.desktop.listPublicLibrary(refresh);
      if (generation !== this.publicGeneration) return;
      this.publicCatalog = catalog; this.publicView = null; this.publicState = 'ready'; this.publicError = '';
    } catch (error) {
      if (generation !== this.publicGeneration) return;
      this.publicError = plain(error);
      // A catalogue already shown stays usable; the failure is only reported.
      if (this.publicCatalog) { this.publicState = 'ready'; this.say(error, true); } else this.publicState = 'error';
    }
    if (this.source === 'public') this.render();
  }
  /** A stykanimate://library link: the Library opens on the public asset, selected and ready to insert. */
  async openPublic(id) {
    this.showView('library');
    await this.setSource('public');
    if (!id) return;
    let item = this.itemFor(id);
    if (!item && this.publicState === 'ready') { await this.loadPublic({refresh: true}); item = this.itemFor(id); }
    if (!item) { if (this.publicState === 'ready') this.say({messageKey:"userLibrary.notice.thatAssetIsNoLongerInTheCommunity",messageParams:{}}, true); return; }
    if (!this.visibleItems().includes(item)) { this.input.value = ''; this.setFilter('all'); }
    this.publicSelected = id; this.render();
    const card = this.cardFor(id);
    card?.scrollIntoView({block: 'center'}); card?.focus({preventScroll: true});
    card?.classList.add('library-card-linked');
    this.say({messageKey:"userLibrary.notice.isReadyDragItOntoTheCanvasOr",messageParams:{name: item.name}});
  }

  // ---- Cards ----
  render() {
    this.closeMenu(); this.hoverPreview.stop();
    this.observer.disconnect();
    this.cards = []; this.cardsByKey = new Map(); this.selectedCard = null; this.tabStopCard = null;
    const pub = this.source === 'public', items = this.visibleItems();
    localizedAttribute(this.grid, 'aria-label', (pub ? "userLibrary.communityLibrary" : "userLibrary.myLibrary"), (pub ? {} : {}));
    this.grid.removeAttribute('aria-busy');
    if (pub && this.publicState === 'loading') {
      replaceLocalized(this.grid);
      this.grid.setAttribute('aria-busy', 'true'); this.empty.hidden = true; this.renderLocation(0);
      for (let i = 0; i < SKELETONS; i++) this.grid.insertAdjacentHTML('beforeend', '<div class="library-card is-skeleton" aria-hidden="true"><div class="library-thumbnail"></div><div class="library-card-info"><span class="library-name"></span><span class="library-kind"></span></div></div>');
      return;
    }
    this.renderLocation(items.length);
    this.empty.hidden = items.length > 0;
    const filtered = Boolean(this.input.value.trim() || this.filterValue !== 'all') && (pub ? this.publicItems.length : this.entries.length) > 0;
    if (!this.empty.hidden) this.renderEmpty(filtered);
    // Build off-document, then register the completed subtree once. Registering
    // each connected card repeatedly prunes all prior translation bindings.
    const fragment = document.createDocumentFragment();
    const addCard = (parent, item) => {
      const card = this.card(item); this.cards.push(card); this.cardsByKey.set(this.keyOf(card), card); parent.append(card);
    };
    if (pub) {
      // Grouped by the website's categories, in its order.
      const groups = new Map();
      for (const item of items) { const members = groups.get(item.category) ?? []; members.push(item); groups.set(item.category, members); }
      for (const category of this.publicCatalog?.categories ?? []) {
        const members = groups.get(category.id); if (!members?.length) continue;
        const group = document.createElement('div'); group.className = 'library-group'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', category.name);
        localizedMarkup(group, `<div class="library-group-label"><span>${esc(category.name)}</span><span class="library-group-count">${members.length}</span></div>`);
        for (const item of members) addCard(group, item);
        fragment.append(group);
      }
    } else for (const item of items) addCard(fragment, item);
    replaceLocalized(this.grid, fragment);
    for (const card of this.cards) if (!card.classList.contains('folder')) this.observer.observe(card);
    const key = this.selectedKey;
    this.select(this.cardsByKey.has(key) ? key : null);
  }
  card(item) {
    const card = document.createElement('div'), pub = item.source === 'public';
    card.className = `library-card ${item.kind}`; card.tabIndex = -1;
    if (pub) card.dataset.publicId = item.id; else card.dataset.libraryPath = item.path;
    if (item.kind === 'folder') card.dataset.libraryFolder = item.path;
    card.setAttribute('role', 'option'); card.setAttribute('aria-selected', 'false'); localizedAttribute(card, 'aria-label', 'userLibrary.assetLabel', {name:item.name, kind:{messageKey:KIND_KEYS[item.kind]??'userLibrary.figure'}});
    let titleKey, titleParams;
    if (item.kind === 'folder') {
      titleKey = 'userLibrary.nameDoubleClickToOpenOrDropAssetsHere'; titleParams = {name:item.name};
    } else if (pub && item.author) {
      titleKey = 'userLibrary.publicAssetByAuthor';
      titleParams = {name:item.name, author:item.author, description:item.description ? `: ${item.description}` : ''};
    } else if (pub) {
      titleKey = 'userLibrary.nameValue1Value2DoubleClickToInsertOrDrag';
      titleParams = {name:item.name, value1:'', value2:item.description ? `: ${item.description}` : ''};
    } else {
      titleKey = 'userLibrary.nameDoubleClickToInsertOrDragOntoThe';
      titleParams = {name:item.name, value1:item.kind === 'movieclip' ? {messageKey:'userLibrary.hoverToPlay2'} : ''};
    }
    localizedAttribute(card, 'title', titleKey, titleParams);
    const badge = ['movieclip', 'set'].includes(item.kind) ? `<span class="library-clip-badge" title="${label(item)}" ${messageAttributes(KIND_KEYS[item.kind]??"userLibrary.figure",{},"title")}>${icon(item.kind === 'movieclip' ? 'play' : 'duplicate')}</span>` : '';
    const clip = item.kind === 'movieclip' && !pub ? `<span class="library-preview-hint" data-i18n="userLibrary.hoverToPlay">${messageHTML("userLibrary.hoverToPlay", {})}</span><span class="library-preview-progress"></span>` : '';
    localizedMarkup(card, `<div class="library-thumbnail">${item.kind === 'folder' ? folderIcon : '<span class="library-preview-loading"></span>'}${badge}${clip}</div><div class="library-card-info"><span class="library-name">${esc(item.name)}</span><span class="library-kind">${messageHTML(KIND_KEYS[item.kind]??"userLibrary.figure")}</span></div><button type="button" class="library-more" tabindex="-1" aria-label="Actions for ${esc(item.name)}" aria-haspopup="menu" ${messageAttributes("userLibrary.actionsFor", {name: item.name}, "aria-label")}>${icon('more')}</button>`);
    return card;
  }
  async loadThumbnail(card, generation) {
    if (card.dataset.publicId) return this.loadPublicPreview(card, generation);
    const path = card.dataset.libraryPath, item = this.itemView('mine').byKey.get(path); if (!item) return;
    const key = `${path}:${item.modified}`;
    try {
      let url = this.thumbnails.get(key) ?? await this.desktop.getLibraryThumbnail(path);
      if (!url) {
        // Missing previews (for files copied in Explorer) are repaired one at a time.
        const generate = async () => {
          if (generation !== this.generation || !card.isConnected) return null;
          const file = await readLibraryFile(this.desktop,path), result = await this.importer.importFile(file), report = result.document ?? result.report ?? result;
          const thumbnail = await libraryPreview(file), kind = report.keyframes[0].objects.length > 1 ? 'set' : item.kind;
          await this.desktop.cacheLibraryThumbnail({path, thumbnail, modified:item.modified, kind});
          if (generation === this.generation && card.isConnected) { item.kind = kind; localizedAttribute(card, 'aria-label', 'userLibrary.assetLabel', {name:item.name, kind:{messageKey:KIND_KEYS[item.kind]??'userLibrary.figure'}}); localizedText(card.querySelector('.library-kind'), KIND_KEYS[item.kind]??'userLibrary.figure'); }
          return thumbnail;
        };
        const pending = (this.previewChain ?? Promise.resolve()).then(generate); this.previewChain = pending.catch(() => {}); url = await pending;
      }
      if (generation !== this.generation || !card.isConnected) return;
      this.showThumbnail(card, key, url, item.name);
    } catch { if (card.isConnected) this.showThumbnail(card, key, null, item.name); }
  }
  async loadPublicPreview(card, generation) {
    const id = card.dataset.publicId, item = this.itemView('public').byKey.get(id); if (!item) return;
    const key = `public:${id}:${item.sha256}`, current = () => this.source === 'public' && card.isConnected && generation === this.generation;
    try {
      const url = this.thumbnails.get(key) ?? await this.desktop.getPublicLibraryPreview(id);
      if (current()) this.showThumbnail(card, key, url, item.name);
    } catch { if (current()) this.showThumbnail(card, key, null, item.name); }
  }
  showThumbnail(card, key, url, name) {
    const target = card.querySelector('.library-thumbnail'); target.querySelector('.library-preview-loading')?.remove();
    if (!url) { target.insertAdjacentHTML('afterbegin', icon('person')); localizedAttribute(target, "title", "userLibrary.previewUnavailableForThisFile", {}); return; }
    this.thumbnails.delete(key); this.thumbnails.set(key, url); while (this.thumbnails.size > 160) this.thumbnails.delete(this.thumbnails.keys().next().value);
    const image = new Image(); image.alt = name; image.draggable = false; image.decoding = 'async';
    image.onload = () => {
      if (!card.isConnected) return;
      // The matte follows the artwork's own colours, so white and dark assets both read.
      const sample = document.createElement('canvas'); sample.width = sample.height = 40;
      const context = sample.getContext('2d', {willReadFrequently: true}); context.drawImage(image, 0, 0, 40, 40);
      const matte = LIBRARY_MATTES[libraryPreviewMatte(context.getImageData(0, 0, 40, 40).data)];
      card.dataset.matte = matte; if (!card.classList.contains('library-preview-playing')) card.style.setProperty('--library-matte', matte);
      card.classList.add('is-loaded');
    };
    image.src = url; target.prepend(image);
  }
  select(key) {
    if (this.source === 'public') this.publicSelected = key; else this.selected = key;
    const selected = this.cardFor(key);
    if (selected !== this.selectedCard) {
      setFlag(this.selectedCard, 'selected', false); setAttr(this.selectedCard, 'aria-selected', 'false');
      setFlag(selected, 'selected', true); setAttr(selected, 'aria-selected', 'true');
      this.selectedCard = selected;
    }
    // One tab stop for the whole grid: the selected card, else the first.
    const focusable = selected ?? this.cards[0] ?? null;
    if (focusable !== this.tabStopCard) {
      setProp(this.tabStopCard, 'tabIndex', -1); setProp(focusable, 'tabIndex', 0); this.tabStopCard = focusable;
    }
  }
  /** Arrow keys move by what is on screen: across a row, or to the nearest card in the row above or below. */
  neighbour(card, key) {
    const cards = this.cards, index = cards.indexOf(card);
    if (key === 'Home') return cards[0]; if (key === 'End') return cards.at(-1);
    if (key === 'ArrowLeft') return cards[Math.max(0, index - 1)]; if (key === 'ArrowRight') return cards[Math.min(cards.length - 1, index + 1)];
    const from = card.getBoundingClientRect(), down = key === 'ArrowDown', x = from.left + from.width / 2;
    let best = null, bestRow = Infinity, bestX = Infinity;
    for (const other of cards) {
      const rect = other.getBoundingClientRect(), row = down ? rect.top - from.top : from.top - rect.top;
      if (row < 4) continue;
      const dx = Math.abs(rect.left + rect.width / 2 - x);
      if (row < bestRow - 4 || Math.abs(row - bestRow) <= 4 && dx < bestX) { best = other; bestRow = row; bestX = dx; }
    }
    return best ?? card;
  }
  onKey(event) {
    if (event.target.matches('input')) return;
    if (event.target.closest('button') && ["Enter", ' '].includes(event.key)) return;
    const card = this.cardFrom(event.target);
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
      event.preventDefault(); if (card) { const rect = card.getBoundingClientRect(); this.showMenu(card, {point: {x: rect.left, y: rect.bottom}}); } return;
    }
    if (event.key === 'Delete') { event.preventDefault(); if (!event.repeat && this.source === 'mine') this.run(() => this.action('trash')); return; }
    const command = this.hotkeys.resolve(event, ['library']);
    if (command?.scope === 'library') {
      event.preventDefault();
      if (!event.repeat) this.run(() => command.id === 'library-open' ? this.open(this.selectedKey) : this.rename());
    }
    else if (card && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const next = this.neighbour(card, event.key);
      this.select(this.keyOf(next)); next.focus(); next.scrollIntoView({block: 'nearest'});
    }
  }

  // ---- Menus ----
  closeMenu() { const menu = this.menu; this.menu = null; menu?.close('api', {restore: false}); }
  /** A card's menu, or the library's own (the ⋯ button, a right-click on empty space). */
  showMenu(card, {anchor = null, point = null, options = false} = {}) {
    this.hoverPreview.stop(); this.closeMenu();
    if (card) this.select(this.keyOf(card));
    const item = card ? this.itemFor(this.keyOf(card)) : null, pub = this.source === 'public', mine = !pub && Boolean(this.desktop?.listLibrary);
    const run = operation => () => this.run(operation);
    let items;
    if (item && pub) items = [
      {label: interfaceText('userLibrary.insert'), labelKey: "userLibrary.insert", icon: 'plus', shortcut: 'Enter', disabled: this.busy, run: run(() => this.insert(item))},
      {label: interfaceText("userLibrary.saveToMyLibrary"), labelKey: "userLibrary.saveToMyLibrary", icon: 'library', disabled: this.busy || !this.desktop?.savePublicLibraryAsset, run: run(() => this.savePublic(item))},
      null,
      {label: interfaceText("userLibrary.viewOnStykanimateCom"), labelKey: "userLibrary.viewOnStykanimateCom", icon: 'link', run: run(() => this.desktop.openPublicLibraryPage(item.id))},
    ];
    else if (item) items = [
      {label: item.kind === 'folder' ? interfaceText("userLibrary.open") : interfaceText('userLibrary.insert'), labelKey: (item.kind === 'folder' ? "userLibrary.open" : "userLibrary.insert"), labelParams: (item.kind === 'folder' ? {} : {}), icon: item.kind === 'folder' ? 'folder' : 'plus', shortcut: 'Enter', disabled: this.busy, run: run(() => this.open(item.path))},
      {label: interfaceText("common.rename"), labelKey: "common.rename", icon: 'text', shortcut: 'F2', disabled: this.busy, run: run(() => this.rename())},
      {label: interfaceText("userLibrary.moveTo"), labelKey: "userLibrary.moveTo", icon: 'arrow-right', disabled: this.busy, run: run(() => this.move())},
      ...(this.desktop.revealLibrary ? [{label: interfaceText("userLibrary.showInFolder"), labelKey: "userLibrary.showInFolder", icon: 'folder', run: run(() => this.desktop.revealLibrary(item.kind === 'folder' ? item.path : parentOf(item.path)))}] : []),
      null,
      {label: this.bin.menu, labelKey:this.bin.menuKey, icon: 'trash', shortcut: 'Del', danger: true, disabled: this.busy, run: run(() => this.trash())},
    ];
    else {
      items = pub ? [
        {label: interfaceText("userLibrary.refresh"), labelKey: "userLibrary.refresh", icon: 'rotate', disabled: !this.desktop?.listPublicLibrary, run: run(() => this.loadPublic({refresh: true}))},
        {label: interfaceText("userLibrary.openStykanimateComLibrary"), labelKey: "userLibrary.openStykanimateComLibrary", icon: 'link', run: run(() => this.action('website'))},
      ] : [
        {label: interfaceText("userLibrary.newFolder"), labelKey: "userLibrary.newFolder", icon: 'folder-plus', disabled: !mine || this.busy, run: run(() => this.newFolder())},
        {label: interfaceText("userLibrary.addSelection"), labelKey: "userLibrary.addSelection", icon: 'plus', disabled: !mine || this.busy || !this.editor.selectedObjects.length, run: run(() => this.save())},
        null,
        {label: interfaceText("userLibrary.refresh"), labelKey: "userLibrary.refresh", icon: 'rotate', disabled: !mine, run: run(() => this.refresh())},
        ...(this.desktop?.revealLibrary ? [{label: interfaceText("userLibrary.showInFolder"), labelKey: "userLibrary.showInFolder", icon: 'folder', disabled: !mine, run: run(() => this.desktop.revealLibrary(this.folder))}] : []),
      ];
      if (options) items.push(null,
        {label: interfaceText("userLibrary.previewBackground"), labelKey: "userLibrary.previewBackground", icon: 'image', submenu: [messageTuple(['auto', interfaceText("userLibrary.automatic")], {1: {key: "userLibrary.automatic", params: {}}}), messageTuple(['light', interfaceText("userLibrary.light")], {1: {key: "userLibrary.light", params: {}}}), messageTuple(['dark', interfaceText("userLibrary.dark")], {1: {key: "userLibrary.dark", params: {}}})].map((_tuple) => {const [value, text] = _tuple; const _messages = tupleMessages(_tuple); return {label: text, ...(_messages[1] ? {labelKey: _messages[1].key, labelParams: _messages[1].params} : {}), radio: true, checked: this.background === value, run: () => this.setBackground(value)};})},
        {label: interfaceText("userLibrary.rigExamples2"), labelKey: "userLibrary.rigExamples2", icon: 'person', command: 'rig-examples'});
    }
    const invoker = card ?? (anchor || this.grid.querySelector('.library-card[tabindex="0"]') || this.input);
    const menu = this.menu = openMenu({items, ...(anchor ? {anchor} : {point}), icon: name => icon(name), label: options ? interfaceText("userLibrary.libraryOptions") : interfaceText("userLibrary.libraryActions"), labelKey: (options ? "userLibrary.libraryOptions" : "userLibrary.libraryActions"), labelParams: (options ? {} : {}), invoker,
      onClose: () => { if (this.menu === menu) this.menu = null; }});
  }

  // ---- Actions ----
  /** The panel's [data-library-action] buttons (Add selection, New folder, the website) and Delete. */
  async action(action) {
    if (action === 'website') return this.desktop?.openPublicLibraryPage ? this.desktop.openPublicLibraryPage('') : window.open(PUBLIC_PAGE, '_blank', 'noopener');
    if (this.busy) return;
    if (action === 'save') return this.save();
    if (action === 'folder') return this.newFolder();
    if (action === 'trash') return this.trash();
  }
  dragDestination(hit, item) {
    const target = hit?.closest('[data-library-folder]');
    if (!target || item?.source === 'public' || this.source !== 'mine' || !this.container.contains(target) || this.busy || !canMoveLibraryItem(item, target.dataset.libraryFolder)) return null;
    return {element: target, folder: target.dataset.libraryFolder, name: target.dataset.libraryFolder.split('/').at(-1) || interfaceText("userLibrary.library2")};
  }
  async moveItem(item, folder) {
    if (this.busy || !canMoveLibraryItem(item, folder)) return;
    this.busy = true; this.syncSelection(); this.hoverPreview.stop();
    try {
      await this.desktop.changeLibraryItem({path: item.path, folder}); this.selected = null;
      await this.refresh(); this.say({messageKey:"userLibrary.notice.movedTo",messageParams:{name: item.name, value1: folder || {messageKey:"userLibrary.library2"}}});
    } finally { this.busy = false; this.syncSelection(); }
  }
  async save() {
    if (!this.editor.selectedObjects.length || this.busy) return;
    this.pause(); this.finishEdit();
    // Saving lands in My library's open folder: show it there.
    if (this.source !== 'mine') await this.setSource('mine');
    this.show(); this.busy = true; this.syncSelection();
    this.say({messageKey:"userLibrary.notice.savingArtworkAndPreview",messageParams:{}});
    const folder = this.folder;
    try {
      const revision=this.editor.revision;await drawingBarrier(this.editor.report);if(revision!==this.editor.revision)throw messageError(new Error(''), "errors.userLibrary.theSelectionChangedBeforeSavingToTheLibrary", {});
      const report = librarySnapshot(this.editor), format = report._styk.libraryKind === 'movieclip' ? 'stykmov' : 'stkz';
      // The preview is drawn by the engine from the saved bytes (src/library-files.mjs).
      const exported = this.exporter.export(this.editor.report, {format, figureUids:report.keyframes[0].objects.map(o => o.unique_id), tick:this.editor.tick, revision});
      const [thumbnail, blob] = await Promise.all([libraryPreview(exported, format), exported]);
      let name = report._styk.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').replace(/^\.+|[. ]+$/g,'').slice(0,110).trim() || interfaceText("userLibrary.untitledAsset");
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `Asset ${name}`;
      const result = await saveLibraryFile(this.desktop, blob, {folder, name, kind:report._styk.libraryKind, extension:`.${format}`, thumbnail});
      this.input.value = ''; this.filterValue = 'all'; this.kindSelect.value = 'all'; await this.refresh(folder); this.select(result.path); this.say({messageKey:"userLibrary.notice.savedTo",messageParams:{value0: folder || {messageKey:"userLibrary.myLibrary"}}});
      this.cardFor(result.path)?.scrollIntoView({block:'nearest'});
    } finally { this.busy = false; this.syncSelection(); }
  }
  async savePublic(item) {
    if (this.busy) return;
    this.busy = true; this.syncSelection(); this.say({messageKey:"userLibrary.notice.savingToMyLibrary",messageParams:{name: item.name}});
    try {
      // The library keeps PNG previews; the website's posters are WebP, so the poster is converted here.
      const thumbnail = await pngThumbnail(this.thumbnails.get(`public:${item.id}:${item.sha256}`) ?? await this.desktop.getPublicLibraryPreview(item.id));
      const result = await this.desktop.savePublicLibraryAsset({id: item.id, folder: this.folder, thumbnail});
      this.say({messageKey:"userLibrary.notice.savedTo2",messageParams:{name: item.name, value1: this.folder ? {messageKey:'userLibrary.folderLocation',messageParams:{folder:this.folder.split('/').join(' › ')}} : {messageKey:'userLibrary.myLibrary'}}});
      return result;
    } finally { this.busy = false; this.syncSelection(); }
  }
  async open(key) {
    const item = this.itemFor(key); if (!item || this.busy) return;
    if (item.kind === 'folder') return this.refresh(item.path);
    return this.insert(item);
  }
  async readAsset(item) {
    if (item.source !== 'public') return readLibraryFile(this.desktop, item.path);
    const {name, bytes} = await this.desktop.readPublicLibraryAsset(item.id);
    return new File([bytes], name);
  }
  async insert(item, position) {
    if (this.busy) return;
    this.hoverPreview.stop();
    this.busy = true; this.syncSelection(); this.say({messageKey:"userLibrary.notice.inserting",messageParams:{name: item.name}});
    try {
      this.pause(); this.finishEdit();
      const report = this.editor.report, tick = this.editor.tick, layer = this.editor.activeLayerId;
      const file = await this.readAsset(item), result = await this.importer.importFile(file);
      if (this.editor.report !== report || this.editor.tick !== tick || this.editor.activeLayerId !== layer) throw messageError(new Error(''), "errors.userLibrary.theDocumentOrInsertionFrameChangedInsertThe", {});
      const document = result.document ?? result.report ?? result;
      if (document.figure_types?.length === 1) document.figure_types[0].name = item.name;
      if (this.editor.getLayer(layer)?.locked) throw messageError(new Error(''), "errors.userLibrary.unlockTheDestinationLayerBeforeInsertingAnAsset", {});
      this.editor.importFigure(document, {position}); this.setTool('select'); this.say({messageKey:"userLibrary.notice.addedToTheScene",messageParams:{name: item.name}});
    } finally { this.busy = false; this.syncSelection(); }
  }
  rename() {
    this.hoverPreview.stop();
    const item = this.source === 'mine' ? this.itemFor(this.selected) : null; if (!item || this.busy) return;
    const card = this.cardFor(item.path), name = card?.querySelector('.library-name'); if (!name || card.querySelector('input')) return;
    const input = document.createElement('input'); input.className = 'library-rename'; input.value = item.name; input.maxLength = 120; localizedAttribute(input, 'aria-label', "userLibrary.assetName", {}); name.replaceWith(input); input.focus(); input.select();
    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      try { const result = await this.desktop.changeLibraryItem({path:item.path, name:input.value}); this.selected = result.path; await this.refresh(); this.cardFor(result.path)?.focus({preventScroll: true}); }
      catch (error) { done = false; this.say(error, true); input.focus(); }
    };
    input.onkeydown = event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commit(); } else if (event.key === 'Escape') { done = true; this.render(); this.cardFor(item.path)?.focus({preventScroll: true}); } };
    input.onblur = commit;
  }
  newFolder() {
    localizedAttribute(this.dialog, 'aria-label', "userLibrary.newLibraryFolder", {});
    localizedMarkup(this.dialog, `<form><h2 data-i18n="userLibrary.newFolder">${messageHTML("userLibrary.newFolder", {})}</h2><p ${messageAttributes("userLibrary.in", {value: this.folder ? this.folder.split('/').join(' › ') : {messageKey: "userLibrary.myLibrary"}})}>In ${esc(this.folder ? this.folder.split('/').join(' › ') : interfaceText("userLibrary.myLibrary"))}</p><label>${messageHTML("userLibrary.folderName", {})}<input name="name" aria-label="Folder name" value="${esc(interfaceText("userLibrary.newFolder"))}" maxlength="120" required data-i18n-aria-label="userLibrary.folderName"></label><div class="library-dialog-error" role="alert"></div><footer><button class="ui-button" data-variant="ghost" type="button" data-cancel data-i18n="common.cancel">${messageHTML("userLibrary.cancel", {})}</button><button class="ui-button" data-variant="primary" type="submit" data-i18n="userLibrary.createFolder">${messageHTML("userLibrary.createFolder", {})}</button></footer></form>`);
    this.dialog.querySelector('[data-cancel]').onclick = () => this.dialog.close();
    this.dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const submit = event.submitter; submit.disabled = true;
      try { const result = await this.desktop.createLibraryFolder({folder:this.folder, name:this.dialog.querySelector('input').value}); this.dialog.close(); this.selected = result.path; await this.refresh(); }
      catch (error) { presentError(this.dialog.querySelector('[role="alert"]'), error); } finally { submit.disabled = false; }
    };
    this.dialog.showModal(); this.dialog.querySelector('input').select();
  }
  async move() {
    const item = this.itemView('mine').byKey.get(this.selected); if (!item) return;
    localizedAttribute(this.dialog, 'aria-label', "userLibrary.moveLibraryItem", {}); let destination = ''; let sequence = 0;
    localizedMarkup(this.dialog, `<h2 ${messageAttributes("userLibrary.move", {name: item.name})}>Move ${esc(item.name)}</h2><div class="library-move-location"></div><div class="library-move-folders"></div><div role="alert" class="library-dialog-error"></div><footer><button type="button" class="ui-button" data-variant="ghost" data-cancel data-i18n="common.cancel">${messageHTML("userLibrary.cancel", {})}</button><button type="button" class="ui-button" data-variant="primary" data-move data-i18n="userLibrary.moveHere">${messageHTML("userLibrary.moveHere", {})}</button></footer>`);
    const browse = async folder => {
      const id = ++sequence, result = await this.desktop.listLibrary(folder); if (id !== sequence) return; destination = folder;
      localizedText(this.dialog.querySelector('.library-move-location'), "userLibrary.library", {value: folder ? ` › ${folder.replaceAll('/',' › ')}` : ''});
      const list = this.dialog.querySelector('.library-move-folders'); replaceLocalized(list);
      // A row per place: the parent first (a back chevron), then each folder with its glyph.
      const add = (text, path, glyph) => { const button = document.createElement('button'); button.type = 'button'; localizedMarkup(button, icon(glyph)); const words = document.createElement('span'); words.textContent = text; appendLocalized(button, words); button.onclick = () => this.run(() => browse(path)); appendLocalized(list, button); return button; };
      if (folder) {
        const path=parentOf(folder),parent=add(path.split('/').at(-1),path,'chevron-left');parent.dataset.parent='';
        if(path)localizedAttribute(parent,'aria-label','userLibrary.folderLocation',{folder:path.replaceAll('/',' › ')});
        else {localizedText(parent.querySelector('span'),'userLibrary.myLibrary');localizedAttribute(parent,'aria-label','userLibrary.myLibrary');}
      }
      for (const child of result.entries.filter(child => child.kind === 'folder' && child.path !== item.path)) add(child.name, child.path, 'folder');
      if (!list.children.length) { const none = document.createElement('p'); none.className = 'library-move-none'; localizedText(none, "userLibrary.noFoldersHere", {}); appendLocalized(list, none); }
    };
    this.dialog.querySelector('[data-cancel]').onclick = () => this.dialog.close();
    this.dialog.querySelector('[data-move]').onclick = async event => {
      event.target.disabled = true;
      try { await this.desktop.changeLibraryItem({path:item.path, folder:destination}); this.dialog.close(); this.selected = null; await this.refresh(); this.say({messageKey:"userLibrary.notice.movedTo2",messageParams:{value0: destination || {messageKey:"userLibrary.library2"}}}); }
      catch (error) { presentError(this.dialog.querySelector('[role="alert"]'), error); } finally { event.target.disabled = false; }
    };
    await browse(''); this.dialog.showModal();
  }
  trash() {
    const item = this.source === 'mine' ? this.itemFor(this.selected) : null; if (!item) return;
    localizedAttribute(this.dialog, 'aria-label', "userLibrary.removeLibraryItem", {});
    localizedMarkup(this.dialog, `<h2 ${messageAttributes("userLibrary.remove", {name: item.name})}>Remove ${esc(item.name)}?</h2><p ${messageAttributes("userLibrary.copiesAlreadyInYourScenesStayAvailable", {value: item.kind === 'folder' ? {messageKey: "userLibrary.thisFolderAndItsContents"} : {messageKey: "userLibrary.thisAssetAndItsPreview"}, dialog: {messageKey:this.bin.dialogKey}})}>${item.kind === 'folder' ? interfaceText("userLibrary.thisFolderAndItsContents") : interfaceText("userLibrary.thisAssetAndItsPreview")} ${this.bin.dialog}. Copies already in your scenes stay available.</p><div class="library-dialog-error" role="alert"></div><footer><button type="button" class="ui-button" data-variant="ghost" data-cancel data-i18n="common.cancel">${messageHTML("userLibrary.cancel", {})}</button><button type="button" class="ui-button" data-variant="danger" data-remove>${messageHTML(this.bin.buttonKey)}</button></footer>`);
    this.dialog.querySelector('[data-cancel]').onclick = () => this.dialog.close();
    this.dialog.querySelector('[data-remove]').onclick = async event => {
      event.target.disabled = true;
      try { await this.desktop.trashLibraryItem(item.path); this.dialog.close(); this.selected = null; await this.refresh(); this.say({messageKey:this.bin.doneKey}); }
      catch (error) { presentError(this.dialog.querySelector('[role="alert"]'), error); } finally { event.target.disabled = false; }
    };
    this.dialog.showModal(); this.dialog.querySelector('[data-cancel]').focus();
  }
}
