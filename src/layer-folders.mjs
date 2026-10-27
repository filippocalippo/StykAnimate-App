import {messageError} from './localized-error.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateLayerFolders(state) {
  const folders = state.folders;
  if (folders !== undefined) {
    if (!record(folders) || !record(folders.byId) || !Number.isSafeInteger(folders.nextId) || folders.nextId < 1 || Object.keys(folders.byId).length > 10000)
      throw messageError(new Error(''), 'errors.layerFolders.invalidFolders');
    let largest = 0;
    for (const [id, folder] of Object.entries(folders.byId)) {
      if (!/^folder-[1-9]\d*$/.test(id) || !record(folder) || typeof folder.name !== 'string' || !folder.name.trim() || folder.name.length > 160)
        throw messageError(new Error(''), 'errors.layerFolders.invalidFolders');
      largest = Math.max(largest, Number(id.slice(7)));
    }
    if (folders.nextId <= largest) throw messageError(new Error(''), 'errors.layerFolders.invalidFolders');
  }
  for (const layer of Object.values(state.byId)) if (layer.folderId !== undefined && !Object.hasOwn(folders?.byId ?? {}, layer.folderId))
    throw messageError(new Error(''), 'errors.layerFolders.missingFolder');
  const seen = new Set(); let previous;
  for (const id of state.order) {
    const folderId = state.byId[id].folderId;
    if (folderId && folderId !== previous) {
      if (seen.has(folderId)) throw messageError(new Error(''), 'errors.layerFolders.invalidFolders');
      seen.add(folderId);
    }
    previous = folderId;
  }
}

/** Folders have no pose tracks. Collapse is local UI state, never visibility. */
export function layerFolderRows(layers, state, collapsed = new Set()) {
  const groups = new Map(), rows = [], seen = new Set();
  for (const layer of layers) if (layer.folderId) { if (!groups.has(layer.folderId)) groups.set(layer.folderId, []); groups.get(layer.folderId).push(layer); }
  const add = id => {
    const folder = state.folders?.byId[id]; if (!folder) return;
    const children = groups.get(id) ?? [];
    rows.push({id, kind: 'folder', name: folder.name, layerIds: children.map(layer => layer.id), collapsed: collapsed.has(id)});
    if (!collapsed.has(id)) rows.push(...children);
    seen.add(id);
  };
  for (const id of Object.keys(state.folders?.byId ?? {})) if (!groups.has(id)) add(id);
  for (const layer of layers) { if (layer.folderId) { if (!seen.has(layer.folderId)) add(layer.folderId); } else rows.push(layer); }
  return rows;
}
