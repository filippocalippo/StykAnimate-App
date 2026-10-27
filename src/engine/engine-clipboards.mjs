/**
 * The clipboards of an engine-owned editor (docs/engine/editing.md, "Clipboards").
 *
 * The session runs the editor's copy and paste commands and keeps what was copied. The interface reads the same clipboards
 * (the Paste buttons, the shared clipboard that writes them to the system's) and hands it others (restored from another
 * window or the system's clipboard, copied in another project tab), so the editor's clipboard fields are a mirror this
 * module keeps: a copy's answer carries the clipboard in the shape the editor held it, and whatever the interface writes
 * to a field reaches the session (`@setClipboard`) before the next call that pastes it. A clipboard moves between the
 * sessions of the editor's projects the same way, as one copied in another document (`foreign`).
 *
 * The drawing pixels the Draw tool copies are not here: they are the interface's alone (the session never sees pixels). An
 * audio clip's recording can be megabytes, so the editor shows only that a clip was copied; the recording stays in the session
 * that copied it and moves to the one that pastes it, read from the first (`lazy`). A session that is about to be freed
 * (its project closes, its movieclip is left) hands the recording over first (`surrender`): no clipboard names a session
 * once it is gone.
 */

/** What the editor shows of a copied audio clip, which the session holds: the interface asks only whether there is one. */
const AUDIO_COPIED = Object.freeze({inSession: true});

/** The calls that paste a clipboard, and the kinds each reads. */
const READS = Object.freeze({
  sheetPasteFrames: ['sheet'], pasteSelection: ['figures'], pasteFiguresInFrames: ['figures'], pasteCameraMotion: ['cameraMotion'],
  pasteCamera: ['camera'], pasteSegmentValues: ['segmentValues'], pasteVfxClip: ['vfxClip'], pasteAudioClip: ['audio'],
});

/**
 * The mirrored kinds. `fields`: the editor fields that show it (an effect clip's is the clip and the effects at the playhead
 * as it was copied: two fields of one value). `read`: the session's wire shape as the editor holds it, `write` the way back
 * (the value's own document stays with the interface), `source`: the document the value was copied in (one copied in another
 * pastes everything as new), `empty`: whether the value holds nothing, `lazy`: the editor shows a marker and the data is read from
 * the session that holds it when another pastes.
 */
const KINDS = {
  sheet: {
    fields: ['_sheetClipboard'],
    read: (data, token) => ({...data, document: token}),
    // `layerNames` belongs to the packets of the shared clipboard.
    write: ({document, layerNames, ...data}) => data,
    source: value => value.document,
  },
  figures: {
    fields: ['_selectionClipboard'],
    read: (data, token) => ({...data, layers: new Map(data.layers), ...(data.freshTypes?.length ? {freshTypes: new Set(data.freshTypes)} : {}), documentToken: token}),
    write: ({documentToken, ...data}) => ({...data, layers: [...data.layers], freshTypes: [...(data.freshTypes ?? [])]}),
    source: value => value.documentToken,
  },
  cameraMotion: {fields: ['_cameraMotionClipboard']},
  camera: {fields: ['_cameraClipboard']},
  segmentValues: {fields: ['_segmentValuesClipboard']},
  vfxClip: {
    fields: ['_vfxClipClipboard', '_vfxClipClipboardValues'], parts: ['clip', 'values'],
    read: ({clip, values}) => ({clip, values}),
    write: ({clip, values}) => ({clip, values: values ?? null}),
    empty: value => !value?.clip,
  },
};

KINDS.audio = {fields: ['_audioClipboard'], read: () => AUDIO_COPIED, lazy: true};

const isEmpty = (kind, value) => KINDS[kind].empty ? KINDS[kind].empty(value) : value == null;

/**
 * @param {object} editor the app's Editor
 * @param {object} layer the owner's layer between the editor and its class, which gets the fields as accessors
 * @param {() => unknown} token the document the editor shows
 */
export function createClipboards(editor, layer, token) {
  /** kind -> {value, holder: the session whose clipboard it is, pending: the interface wrote it since the session had it,
   * taken: what a lazy kind's session handed over when it ended, until another session has it}. */
  const mirror = new Map(Object.keys(KINDS).map(kind => [kind, {value: undefined, holder: null, pending: false, taken: undefined}]));

  for (const [kind, {fields, parts}] of Object.entries(KINDS)) {
    const entry = mirror.get(kind);
    fields.forEach((field, index) => {
      const part = parts?.[index];
      // A clipboard the editor holds before it is owned stays.
      if (Object.hasOwn(editor, field)) {
        const held = editor[field];
        if (part) entry.value = {...entry.value, [part]: held}; else entry.value = held;
        entry.pending = true;
        delete editor[field];
      }
      Object.defineProperty(layer, field, {
        configurable: true, enumerable: false,
        get: () => part ? entry.value?.[part] : entry.value,
        set(value) {
          entry.value = part ? {...entry.value, [part]: value} : value;
          entry.pending = true; entry.taken = undefined;
        },
      });
    });
  }

  return {
    /** A copy's answer: the session holds the clipboard, the editor shows it. */
    adopt({kind, data}, session) {
      const entry = mirror.get(kind), {read} = KINDS[kind];
      entry.value = read ? read(data, token()) : data;
      entry.holder = session; entry.pending = false; entry.taken = undefined;
      // Copying figures leaves no single figure copied (`copySelection`).
      if (kind === 'figures') editor._figureClipboard = null;
    },
    /** A paste's answer: how many times the figures were pasted, which sets where the next paste lands. */
    pasted(pastes) {
      const entry = mirror.get('figures');
      if (entry.value && Number.isFinite(pastes?.after)) entry.value.pastes = pastes.after;
    },
    /** Before a call: the clipboards it pastes are the session's. `send(kind, data, foreign)` hands one over; `fetch(holder, kind)`
     * reads one the editor only shows a marker of from the session that holds it. */
    handOver(name, session, send, fetch) {
      for (const kind of READS[name] ?? []) {
        const entry = mirror.get(kind), {write, source, lazy} = KINDS[kind];
        const held = !isEmpty(kind, entry.value);
        if (!entry.pending && (!held || entry.holder === session)) continue;
        if (lazy && !entry.pending) {
          // The session that copied it, or what it handed over when it ended. Nobody has it (the owner was released): nothing to hand over.
          const data = entry.holder ? fetch(entry.holder, kind) : entry.taken;
          if (data === undefined) continue;
          send(kind, data, true);
        } else send(kind, held ? (write ? write(entry.value) : entry.value) : null, held && Boolean(source) && source(entry.value) !== token());
        entry.holder = session; entry.pending = false; entry.taken = undefined;
      }
    },
    /** `session` is about to be freed: what it holds of a lazy clipboard (a copied audio clip's recording) is read from it
     * now and kept, and none names it afterwards. `fetch(session, kind)` is the read `handOver` takes. */
    surrender(session, fetch) {
      for (const [kind, entry] of mirror) {
        if (entry.holder !== session) continue;
        entry.holder = null;
        // What the interface wrote since is the whole value already; a clipboard the session does not hold is the editor's alone.
        if (KINDS[kind].lazy && !entry.pending && !isEmpty(kind, entry.value)) entry.taken = fetch(session, kind);
      }
    },
    /** The sessions are gone. */
    release() { for (const entry of mirror.values()) { entry.holder = null; entry.taken = undefined; } },
  };
}
