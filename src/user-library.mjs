import {icon} from './icons.mjs';
import {librarySnapshot, libraryPreview, saveLibraryFile, readLibraryFile} from './library-files.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const folderIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const label = item => item.kind === 'folder' ? 'Folder' : item.kind === 'movieclip' ? 'Movieclip' : item.kind === 'set' ? 'Figure set' : 'Figure';

export class UserLibrary {
  constructor({editor, desktop, exporter, importer, pause, finishEdit, setTool}) {
    Object.assign(this, {editor, desktop, exporter, importer, pause, finishEdit, setTool});
    this.folder = ''; this.entries = []; this.selected = null; this.generation = 0; this.busy = false; this.thumbnails = new Map();
    this.panel = document.querySelector('.right-panel');
    const tabs = document.createElement('div'); tabs.className = 'inspector-switch'; tabs.setAttribute('role','tablist'); tabs.setAttribute('aria-label','Properties and asset library');
    tabs.innerHTML = '<button type="button" role="tab" id="properties-tab" aria-controls="inspector" aria-selected="true">Properties</button><button type="button" role="tab" id="library-tab" aria-controls="user-library" aria-selected="false">Library</button>';
    this.panel.prepend(tabs);
    this.container = document.createElement('section'); this.container.id = 'user-library'; this.container.hidden = true; this.container.setAttribute('role','tabpanel'); this.container.setAttribute('aria-labelledby','library-tab');
    this.container.innerHTML = `<div class="library-tools"><label class="library-search">${icon('search')}<input type="search" aria-label="Search library" placeholder="Search" spellcheck="false"></label><button type="button" class="icon-button" data-library-action="refresh" aria-label="Refresh library" title="Refresh">${icon('rotate')}</button><button type="button" class="icon-button" data-library-action="folder" aria-label="New library folder" title="New folder">${icon('plus')}</button><button type="button" class="icon-button" data-library-action="reveal" aria-label="Open library folder" title="Open folder in Explorer">${folderIcon}</button></div>
      <nav class="library-breadcrumbs" aria-label="Library folders"></nav><div class="library-filter"><select aria-label="Filter library assets"><option value="all">All assets</option><option value="figure">Figures & sets</option><option value="movieclip">Movieclips</option></select><span class="library-count"></span></div>
      <div class="library-content"><div class="library-grid" role="list" aria-label="Saved assets"></div><div class="library-empty">No assets in this folder</div></div>
      <div class="library-item-actions" hidden><button type="button" data-library-action="insert">Insert</button><button type="button" data-library-action="rename">Rename</button><button type="button" data-library-action="move">Move to…</button><button type="button" class="library-trash" data-library-action="trash" aria-label="Remove library item" title="Move to Recycle Bin">${icon('trash')}</button></div>
      <div class="library-message" role="status" aria-live="polite"></div><div class="library-save"><button type="button" class="button primary" data-library-action="save">${icon('plus')}<span>Add to library</span></button></div>`;
    this.panel.append(this.container);
    this.propertySave = document.createElement('div'); this.propertySave.className = 'properties-library-save';
    this.propertySave.innerHTML = `<button type="button" class="button" data-library-action="save">${icon('plus')} Add to library</button>`; this.panel.append(this.propertySave);
    this.dialog = document.createElement('dialog'); this.dialog.className = 'library-dialog'; document.body.append(this.dialog);
    this.grid = this.container.querySelector('.library-grid'); this.message = this.container.querySelector('.library-message');
    this.input = this.container.querySelector('input'); this.filter = this.container.querySelector('select');
    tabs.onclick = event => { if (event.target.closest('[role="tab"]')) this.show(event.target.id === 'library-tab'); };
    tabs.onkeydown = event => { if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); this.show(event.key === 'ArrowRight'); tabs.querySelector('[aria-selected="true"]').focus(); } };
    this.panel.addEventListener('click', event => {
      const action = event.target.closest('[data-library-action]')?.dataset.libraryAction; if (!action) return;
      event.stopPropagation(); this.run(() => this.action(action));
    });
    this.input.oninput = () => this.render(); this.filter.onchange = () => this.render();
    this.grid.onclick = event => { const card = event.target.closest('[data-library-path]'); if (card && !event.target.matches('input')) this.select(card.dataset.libraryPath); };
    this.grid.ondblclick = event => { const card = event.target.closest('[data-library-path]'); if (card && !event.target.matches('input')) this.run(() => this.open(card.dataset.libraryPath)); };
    this.grid.onkeydown = event => {
      if (event.target.matches('input')) return;
      if (event.key === 'Enter') { event.preventDefault(); this.run(() => this.open(this.selected)); }
      else if (event.key === 'F2') { event.preventDefault(); this.rename(); }
      else if (event.key.startsWith('Arrow')) {
        event.preventDefault(); const cards = [...this.grid.querySelectorAll('[data-library-path]')], index = cards.indexOf(event.target.closest('[data-library-path]'));
        const step = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-2,ArrowDown:2}[event.key]; const card = cards[Math.max(0, Math.min(cards.length-1,index+step))];
        if (card) { this.select(card.dataset.libraryPath); card.focus(); }
      }
    };
    this.container.addEventListener('keydown', event => event.stopPropagation());
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    this.observer = new IntersectionObserver(items => {
      for (const item of items) if (item.isIntersecting) { this.observer.unobserve(item.target); this.loadThumbnail(item.target, this.generation); }
    }, {root:this.container.querySelector('.library-content'), rootMargin:'150px'});
    window.addEventListener('focus', () => { if (this.visible && !this.busy && !this.grid.querySelector('input')) this.run(() => this.refresh()); });
    editor.addEventListener('change', () => this.syncSelection()); this.syncSelection();
  }
  async run(operation) { try { await operation(); } catch (error) { this.message.textContent = error.message; this.message.dataset.error = 'true'; } }
  show(visible = true) {
    this.visible = visible; this.container.hidden = !visible; this.propertySave.hidden = visible;
    this.panel.querySelector('.inspector-header').hidden = visible; document.getElementById('inspector').hidden = visible;
    document.getElementById('properties-tab').setAttribute('aria-selected', String(!visible)); document.getElementById('library-tab').setAttribute('aria-selected', String(visible));
    if (visible) this.run(() => this.refresh());
  }
  syncSelection() {
    const count = this.editor.selectedObjects.length, available = Boolean(this.desktop?.listLibrary);
    for (const button of this.panel.querySelectorAll('[data-library-action="save"]')) button.disabled = this.busy || !count || !available;
    this.container.querySelector('[data-library-action="save"] span').textContent = count > 1 ? `Add ${count} figures to library` : 'Add to library';
    for (const button of this.panel.querySelectorAll('[data-library-action="save"]')) button.title = count ? `Save selection in ${this.folder || 'Library'}` : 'Select figures or a movieclip';
  }
  async refresh(folder = this.folder) {
    if (!this.desktop?.listLibrary) { this.message.textContent = 'Open the desktop app to use your Documents library.'; return; }
    const generation = ++this.generation;
    let result;
    try { result = await this.desktop.listLibrary(folder); }
    catch (error) { if (folder && /ENOENT/.test(error.message)) result = await this.desktop.listLibrary(''); else throw error; }
    if (generation !== this.generation) return;
    if (this.folder !== result.path) { this.selected = null; this.input.value = ''; }
    this.folder = result.path; this.entries = result.entries; this.root = result.root;
    const nav = this.container.querySelector('nav'); nav.replaceChildren();
    let current = ''; for (const [i, part] of ['Library', ...this.folder.split('/').filter(Boolean)].entries()) {
      if (i) current += `${current ? '/' : ''}${part}`;
      const path = current, button = document.createElement('button'); button.type = 'button'; button.textContent = part; button.title = i ? part : this.root;
      button.onclick = () => this.run(() => this.refresh(path)); nav.append(button);
    }
    this.render();
  }
  render() {
    this.observer.disconnect(); this.grid.replaceChildren();
    const query = this.input.value.trim().toLocaleLowerCase(), items = this.entries.filter(item => item.name.toLocaleLowerCase().includes(query) && (this.filter.value === 'all' || item.kind === 'folder' || item.kind === this.filter.value || this.filter.value === 'figure' && item.kind === 'set'));
    this.container.querySelector('.library-count').textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
    const empty = this.container.querySelector('.library-empty'); empty.hidden = items.length > 0;
    empty.textContent = query || this.filter.value !== 'all' ? 'No matching assets' : 'No assets in this folder';
    for (const item of items) {
      const card = document.createElement('div'); card.className = `library-card ${item.kind}`; card.dataset.libraryPath = item.path; card.tabIndex = 0; card.setAttribute('role','listitem'); card.setAttribute('aria-label',`${item.name}, ${label(item)}`); card.title = `Double-click to ${item.kind === 'folder' ? 'open' : 'insert'} ${item.name}`;
      card.innerHTML = `<div class="library-thumbnail">${item.kind === 'folder' ? folderIcon : '<span class="library-preview-loading"></span>'}${['movieclip','set'].includes(item.kind) ? `<span class="library-clip-badge" title="${label(item)}">${icon(item.kind === 'movieclip' ? 'play' : 'duplicate')}</span>` : ''}</div><div class="library-card-info"><span class="library-name">${esc(item.name)}</span></div>`;
      this.grid.append(card); if (item.kind !== 'folder') this.observer.observe(card);
    }
    this.select(this.entries.some(item => item.path === this.selected) ? this.selected : null);
  }
  async loadThumbnail(card, generation) {
    const path = card.dataset.libraryPath, item = this.entries.find(item => item.path === path); if (!item) return;
    const key = `${path}:${item.modified}`;
    try {
      let url = this.thumbnails.get(key) ?? await this.desktop.getLibraryThumbnail(path);
      if (!url) {
        // Missing previews (for files copied in Explorer) are repaired one at a time.
        const generate = async () => {
          if (generation !== this.generation || !card.isConnected) return null;
          const file = await readLibraryFile(this.desktop,path), result = await this.importer.importFile(file), report = result.document ?? result.report ?? result;
          const thumbnail = await libraryPreview(report), kind = report.keyframes[0].objects.length > 1 ? 'set' : item.kind;
          await this.desktop.cacheLibraryThumbnail({path, thumbnail, modified:item.modified, kind});
          if (generation === this.generation && card.isConnected) { item.kind = kind; card.setAttribute('aria-label',`${item.name}, ${label(item)}`); }
          return thumbnail;
        };
        const pending = (this.previewChain ?? Promise.resolve()).then(generate); this.previewChain = pending.catch(() => {}); url = await pending;
      }
      if (generation !== this.generation || !card.isConnected) return;
      const target = card.querySelector('.library-thumbnail'); target.querySelector('.library-preview-loading')?.remove();
      if (url) {
        this.thumbnails.delete(key); this.thumbnails.set(key, url); while (this.thumbnails.size > 128) this.thumbnails.delete(this.thumbnails.keys().next().value);
        const image = new Image(); image.alt = item.name; image.src = url; image.draggable = false; target.prepend(image);
      } else { target.insertAdjacentHTML('afterbegin', icon('person')); target.title = 'Preview unavailable for this file'; }
    } catch { if (card.isConnected) card.querySelector('.library-thumbnail').innerHTML = icon('person'); }
  }
  select(path) {
    this.selected = path; for (const card of this.grid.children) card.classList.toggle('selected', card.dataset.libraryPath === path);
    const item = this.entries.find(item => item.path === path); this.container.querySelector('.library-item-actions').hidden = !item;
    this.container.querySelector('[data-library-action="insert"]').textContent = item?.kind === 'folder' ? 'Open' : 'Insert';
  }
  async action(action) {
    if (this.busy) return;
    if (action === 'save') return this.save();
    if (action === 'refresh') return this.refresh();
    if (action === 'reveal') return this.desktop.revealLibrary(this.folder);
    if (action === 'folder') return this.newFolder();
    if (action === 'rename') return this.rename();
    if (action === 'move') return this.move();
    if (action === 'trash') return this.trash();
    if (action === 'insert') return this.open(this.selected);
  }
  async save() {
    if (!this.editor.selectedObjects.length || this.busy) return;
    this.pause(); this.finishEdit(); this.show(); this.busy = true; this.syncSelection();
    this.message.dataset.error = 'false'; this.message.textContent = 'Saving artwork and preview…';
    const folder = this.folder;
    try {
      const report = librarySnapshot(this.editor), format = report._styk.libraryKind === 'movieclip' ? 'stykmov' : 'stkz';
      const [thumbnail, blob] = await Promise.all([libraryPreview(report), this.exporter.export(report, {format, figureUids:report.keyframes[0].objects.map(o => o.unique_id)})]);
      let name = report._styk.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').replace(/^\.+|[. ]+$/g,'').slice(0,110).trim() || 'Untitled asset';
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `Asset ${name}`;
      const result = await saveLibraryFile(this.desktop, blob, {folder, name, kind:report._styk.libraryKind, extension:`.${format}`, thumbnail});
      this.input.value = ''; this.filter.value = 'all'; await this.refresh(folder); this.select(result.path); this.message.textContent = `Saved to ${folder || 'Library'}`;
      [...this.grid.children].find(card => card.dataset.libraryPath === result.path)?.scrollIntoView({block:'nearest'});
    } finally { this.busy = false; this.syncSelection(); }
  }
  async open(path) {
    const item = this.entries.find(item => item.path === path); if (!item || this.busy) return;
    if (item.kind === 'folder') return this.refresh(path);
    this.busy = true; this.syncSelection(); this.message.dataset.error = 'false'; this.message.textContent = `Inserting ${item.name}…`;
    const report = this.editor.report;
    try {
      const file = await readLibraryFile(this.desktop, path), result = await this.importer.importFile(file);
      if (this.editor.report !== report) throw new Error('The document changed. Insert the asset again.');
      const document = result.document ?? result.report ?? result;
      if (document.figure_types?.length === 1) document.figure_types[0].name = item.name;
      this.pause(); this.finishEdit(); this.editor.importFigure(document); this.setTool('select'); this.message.textContent = `${item.name} added to the scene`;
    } finally { this.busy = false; this.syncSelection(); }
  }
  rename() {
    const item = this.entries.find(item => item.path === this.selected); if (!item || this.busy) return;
    const card = [...this.grid.children].find(card => card.dataset.libraryPath === item.path), name = card?.querySelector('.library-name'); if (!name || card.querySelector('input')) return;
    const input = document.createElement('input'); input.className = 'library-rename'; input.value = item.name; input.maxLength = 120; input.setAttribute('aria-label','Asset name'); name.replaceWith(input); input.focus(); input.select();
    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      try { const result = await this.desktop.changeLibraryItem({path:item.path, name:input.value}); this.selected = result.path; await this.refresh(); }
      catch (error) { done = false; this.message.textContent = error.message; this.message.dataset.error = 'true'; input.focus(); }
    };
    input.onkeydown = event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commit(); } else if (event.key === 'Escape') { done = true; this.render(); } };
    input.onblur = commit;
  }
  newFolder() {
    this.dialog.setAttribute('aria-label','New library folder');
    this.dialog.innerHTML = '<form><h2>New folder</h2><label>Folder name<input name="name" aria-label="Folder name" value="New folder" maxlength="120" required></label><div class="library-dialog-error" role="alert"></div><footer><button class="button" type="button" data-cancel>Cancel</button><button class="button primary" type="submit">Create folder</button></footer></form>';
    this.dialog.querySelector('[data-cancel]').onclick = () => this.dialog.close();
    this.dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const submit = event.submitter; submit.disabled = true;
      try { const result = await this.desktop.createLibraryFolder({folder:this.folder, name:this.dialog.querySelector('input').value}); this.dialog.close(); this.selected = result.path; await this.refresh(); }
      catch (error) { this.dialog.querySelector('[role="alert"]').textContent = error.message; } finally { submit.disabled = false; }
    };
    this.dialog.showModal(); this.dialog.querySelector('input').select();
  }
  async move() {
    const item = this.entries.find(item => item.path === this.selected); if (!item) return;
    this.dialog.setAttribute('aria-label','Move library item'); let destination = ''; let sequence = 0;
    this.dialog.innerHTML = `<h2>Move ${esc(item.name)}</h2><div class="library-move-location"></div><div class="library-move-folders"></div><div role="alert" class="library-dialog-error"></div><footer><button type="button" class="button" data-cancel>Cancel</button><button type="button" class="button primary" data-move>Move here</button></footer>`;
    const browse = async folder => {
      const id = ++sequence, result = await this.desktop.listLibrary(folder); if (id !== sequence) return; destination = folder;
      this.dialog.querySelector('.library-move-location').textContent = `Library${folder ? ` / ${folder.replaceAll('/',' / ')}` : ''}`;
      const list = this.dialog.querySelector('.library-move-folders'); list.replaceChildren();
      const add = (text, path) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = () => this.run(() => browse(path)); list.append(button); };
      if (folder) add('← Parent folder', folder.split('/').slice(0,-1).join('/'));
      for (const child of result.entries.filter(child => child.kind === 'folder' && child.path !== item.path)) add(`▱ ${child.name}`, child.path);
    };
    this.dialog.querySelector('[data-cancel]').onclick = () => this.dialog.close();
    this.dialog.querySelector('[data-move]').onclick = async event => {
      event.target.disabled = true;
      try { await this.desktop.changeLibraryItem({path:item.path, folder:destination}); this.dialog.close(); this.selected = null; await this.refresh(); this.message.textContent = `Moved to ${destination || 'Library'}`; }
      catch (error) { this.dialog.querySelector('[role="alert"]').textContent = error.message; } finally { event.target.disabled = false; }
    };
    await browse(''); this.dialog.showModal();
  }
  trash() {
    const item = this.entries.find(item => item.path === this.selected); if (!item) return;
    this.dialog.setAttribute('aria-label','Remove library item');
    this.dialog.innerHTML = `<h2>Remove ${esc(item.name)}?</h2><p>${item.kind === 'folder' ? 'This folder and its contents' : 'This asset and its preview'} will move to the Recycle Bin. Copies already in your scenes stay available.</p><div class="library-dialog-error" role="alert"></div><footer><button type="button" class="button" data-cancel>Cancel</button><button type="button" class="button primary" data-remove>Move to Recycle Bin</button></footer>`;
    this.dialog.querySelector('[data-cancel]').onclick = () => this.dialog.close();
    this.dialog.querySelector('[data-remove]').onclick = async event => {
      event.target.disabled = true;
      try { await this.desktop.trashLibraryItem(item.path); this.dialog.close(); this.selected = null; await this.refresh(); this.message.textContent = 'Moved to Recycle Bin'; }
      catch (error) { this.dialog.querySelector('[role="alert"]').textContent = error.message; } finally { event.target.disabled = false; }
    };
    this.dialog.showModal(); this.dialog.querySelector('[data-cancel]').focus();
  }
}
