import {importWarningMessage} from './import-notes-localization.mjs';
import {presentError} from './error-presentation.mjs';
import {replaceLocalized, messageTuple, tupleMessages, translatedElement, appendLocalized, localizedText, localizedMarkup, localizedAttribute} from './localization-bindings.mjs';
import {interfaceLocalization, t as interfaceText} from './localization.mjs';

import {messageError} from './localized-error.mjs';

/**
 * The app's own prompts (architecture.md §3.8): Save changes? before a
 * document is replaced, the project's name, Recent files, Performance, the
 * import notes, the Stick Nodes pack picker and Discard frame changes?. Each
 * is its own dialog from the kit (src/ui/ui-dialog.mjs): a form, so Enter
 * runs the primary action and Escape or × cancels; focus starts on the
 * primary (or the first choice) and returns to where it was; a prompt can
 * open over another dialog without replacing it. The test hooks are today's
 * ids (#keep-editing, #discard-changes, #save-changes, #keep-frame-draft,
 * #discard-frame-draft, #rename-input, #clear-recent, [data-recent-id],
 * .recent-files).
 *
 * The `rename`, `open-recent` and `performance` commands register
 * themselves in the app's `actions` map, before app.mjs wraps every action.
 *
 * DOM-free at import. ctx (from app.mjs): {editor, state, actions, desktop,
 * overlays, playbackMetrics, guarded, pause, finishCurrentEdit, promptText,
 * saveNative, acceptNativeFile, updateTitle, localization()}.
 */
import { icon } from "./icons.mjs";
import { createDialog } from "./ui/ui-dialog.mjs";
import { installRovingFocus } from "./ui/roving-focus.mjs";
import { kitText } from "./ui/ui-strings.mjs";

export function createAppDialogs(ctx) {
  const {
    editor, state, actions, desktop, overlays, playbackMetrics, guarded, pause, finishCurrentEdit,
    promptText, saveNative, acceptNativeFile, updateTitle,
  } = ctx;
  const t = (key, params) => ctx.localization()?.t(key, params);
  const glyph = (name) => icon(name);
  /** A kit dialog with the app's overlay stack, glyphs and words. */
  const dialogOf = (options) => createDialog({ overlays, icon: glyph, t, ...options });
  const paragraph = (text, className = "ui-dialog-desc") => {
    const node = document.createElement("p");
    node.className = className;
    node.textContent = text;
    return node;
  };
  /**
   * Choices as one tab stop: the arrow keys move between them, Enter or Space
   * picks one (each is a submit button, so the dialog closes with it) and the
   * first one available starts focused. entries: [{label, detail, icon,
   * disabled, data}] (data: dataset entries, the test hooks).
   */
  function choiceList(label, entries, className = "") {
    const list = document.createElement("div");
    list.className = ["ui-dialog-choices", className].filter(Boolean).join(" ");
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", label);
    for (const entry of entries) {
      const button = document.createElement("button"), text = document.createElement("span"), name = document.createElement("b");
      button.type = "submit";
      button.className = "ui-dialog-choice";
      button.disabled = Boolean(entry.disabled);
      Object.assign(button.dataset, entry.data ?? {});
      if (entry.icon) button.insertAdjacentHTML("beforeend", glyph(entry.icon));
      text.className = "ui-dialog-choice-text";
      name.textContent = entry.label;
      appendLocalized(text, name);
      if (entry.detail) {
        const detail = document.createElement("small");
        detail.textContent = entry.detail;
        appendLocalized(text, detail);
      }
      appendLocalized(button, text);
      appendLocalized(list, button);
    }
    const first = list.querySelector(".ui-dialog-choice:not(:disabled)");
    if (first) first.autofocus = true;
    installRovingFocus(list, { items: ".ui-dialog-choice", orientation: "vertical", loop: false });
    return list;
  }

  /**
   * Asks before the open document is replaced while it has unsaved changes:
   * Save (the primary: the dialog stays open while saving and closes once the
   * project is saved), Don't save, or Cancel (Escape and × too). Resolves
   * true when the document may be replaced.
   */
  async function confirmReplace({discardOnly = false} = {}) {
    finishCurrentEdit();
    if (!editor.dirty) return true;
    const projectName = editor.name || {messageKey: "app.untitled"};
    const dialog = dialogOf({
      size: "sm",
      title: interfaceText(discardOnly ? "appDialogs.reloadFromDisk" : "appDialogs.saveChangesTo", {value: projectName}), titleKey: discardOnly ? "appDialogs.reloadFromDisk" : "appDialogs.saveChangesTo", titleParams: {value: projectName},
      body: interfaceText("appDialogs.yourChangesWillBeLostIfYouDon"), bodyKey: "appDialogs.yourChangesWillBeLostIfYouDon",
      actions: [
        { label: interfaceText("appDialogs.donTSave"), labelKey: "appDialogs.donTSave", value: "discard", id: "discard-changes", variant: "ghost", tone: "danger" },
        { label: kitText(t, "common.cancel"), labelKey: "common.cancel", labelParams: {}, cancel: true, id: "keep-editing", variant: "ghost", autofocus: discardOnly },
        ...(!discardOnly ? [{ label: interfaceText("common.save"), labelKey: "common.save", value: "save", id: "save-changes", variant: "primary", autofocus: true }] : []),
      ],
      onSubmit: (value) => {
        if (value !== "save") return undefined;
        void save();
        return false;
      },
    });
    const save = guarded(async () => {
      dialog.setBusy(true);
      try {
        if (await saveNative()) dialog.close("save");
      } finally {
        if (dialog.open) {
          dialog.setBusy(false);
          dialog.element.querySelector("#save-changes")?.focus({ preventScroll: true });
        }
      }
    });
    const choice = await dialog.showModal();
    return choice === "save" || choice === "discard";
  }
  /** The source features a Pivot or Stick Nodes import may show differently. */
  function showImportNotes(warnings, { pivot = false, report } = {}) {
    const list = document.createElement("ul");
    list.className = "import-notes";
    for (const warning of warnings) {
      const item = document.createElement("li");
      presentError(item, importWarningMessage(warning,report));
      appendLocalized(list, item);
    }
    const dialog = dialogOf({
      size: "sm",
      className: "import-notes-dialog",
      title: pivot ? interfaceText("appDialogs.pivotImportNotes") : interfaceText("appDialogs.stickNodesImportNotes"), titleKey: (pivot ? "appDialogs.pivotImportNotes" : "appDialogs.stickNodesImportNotes"), titleParams: (pivot ? {} : {}),
      description: interfaceText("appDialogs.theAssetIsReadyToEditTheseSource"), descriptionKey: "appDialogs.theAssetIsReadyToEditTheseSource",
      body: list,
      actions: [{ label: kitText(t, "overlays.ok"), labelKey: "overlays.ok", labelParams: {}, value: true, variant: "primary" }],
    });
    void dialog.showModal();
  }
  /** Which asset of a Stick Nodes pack to import: its index, or null when the dialog closes. */
  async function chooseSticknodesEntry(entries) {
    const dialog = dialogOf({
      size: "sm",
      title: interfaceText("appDialogs.chooseAStickNodesAsset"), titleKey: "appDialogs.chooseAStickNodesAsset",
      description: interfaceText("appDialogs.thisPackContains", {count: entries.length}), descriptionKey: "appDialogs.thisPackContains", descriptionParams: {count: entries.length},
      body: translatedElement(choiceList(interfaceText("appDialogs.assets"), entries.map((entry) => ({ label: entry.name, icon: "person", data: { sticknodesEntry: String(entry.index) } }))), "appDialogs.assets", {}, 'aria-label'),
      actions: [{ label: kitText(t, "common.cancel"), labelKey: "common.cancel", labelParams: {}, cancel: true, variant: "ghost" }],
      onSubmit: (value, form, submitter) => (submitter?.dataset.sticknodesEntry === undefined ? false : { value: Number(submitter.dataset.sticknodesEntry) }),
    });
    return dialog.showModal();
  }
  /** Asks before Simple mode restores a frame's saved pose; Discard is the default, as before. */
  async function confirmDiscardFrame() {
    const dialog = dialogOf({
      size: "sm",
      title: interfaceText("appDialogs.discardFrameChanges"), titleKey: "appDialogs.discardFrameChanges",
      body: interfaceText("appDialogs.restoreTheFrameToItsSavedPoseYou"), bodyKey: "appDialogs.restoreTheFrameToItsSavedPoseYou",
      actions: [
        { label: interfaceText("appDialogs.keepChanges"), labelKey: "appDialogs.keepChanges", cancel: true, id: "keep-frame-draft", variant: "ghost" },
        { label: interfaceText("appDialogs.discard"), labelKey: "appDialogs.discard", value: true, id: "discard-frame-draft", variant: "primary" },
      ],
    });
    return (await dialog.showModal()) === true;
  }
  function showPerformance() {
    const presentation = playbackMetrics.snapshot(performance.now());
    const sorted = [...state.renderSamples].sort((a, b) => a - b),
      p = (n) =>
        sorted[
          Math.min(sorted.length - 1, Math.floor(sorted.length * n))
        ]?.toFixed(2) || "—";
    const bufferingParams = {milliseconds:{format:'number', value:presentation.bufferingMs, options:{minimumFractionDigits:1, maximumFractionDigits:1}}, count:presentation.bufferingEvents};
    const rows = [
      messageTuple([interfaceText("appDialogs.renderer"), state.renderer?.stats?.backend || interfaceText("appDialogs.initializing")], {0: {key: "appDialogs.renderer", params: {}}, ...(!state.renderer?.stats?.backend ? {1:{key:"appDialogs.initializing", params:{}}} : {})}),
      messageTuple([interfaceText("appDialogs.playbackFpsTarget"), presentation.fps === null ? "—"
        : `${presentation.fps.toFixed(1)} / ${presentation.targetFps.toFixed(1)}`], {0: {key: "appDialogs.playbackFpsTarget", params: {}}}),
      messageTuple([interfaceText("appDialogs.playbackStartup"), presentation.startupMs === null ? "—" : `${presentation.startupMs.toFixed(1)} ms`], {0: {key: "appDialogs.playbackStartup", params: {}}}),
      messageTuple([interfaceText("appDialogs.playbackBuffering"), interfaceText("appDialogs.bufferingSummary", bufferingParams)], {0: {key: "appDialogs.playbackBuffering", params: {}}, 1:{key:"appDialogs.bufferingSummary", params:bufferingParams}}),
      messageTuple([interfaceText("appDialogs.recentCpuFrameP50"), `${p(0.5)} ms`], {0: {key: "appDialogs.recentCpuFrameP50", params: {}}}),
      messageTuple([interfaceText("appDialogs.recentCpuFrameP95"), `${p(0.95)} ms`], {0: {key: "appDialogs.recentCpuFrameP95", params: {}}}),
      messageTuple([interfaceText("appDialogs.recentCpuFrameP99"), `${p(0.99)} ms`], {0: {key: "appDialogs.recentCpuFrameP99", params: {}}}),
      messageTuple([interfaceText("appDialogs.measuredFrames"), sorted.length], {0: {key: "appDialogs.measuredFrames", params: {}}}),
      messageTuple([interfaceText("appDialogs.currentSceneFigures"), interfaceLocalization.formatNumber(editor.frame.objects.length)], {0: {key: "appDialogs.currentSceneFigures", params: {}}}),
      messageTuple([
        interfaceText("appDialogs.currentSceneSegments"),
        interfaceLocalization.formatNumber(editor.frame.objects
          .reduce(
            (n, o) =>
              n +
              (editor.report.figure_types.find(
                (f) => f.figure_type_id === o.figure_type_id,
              )?.segments.length || 0),
            0,
          )),
      ], {0: {key: "appDialogs.currentSceneSegments", params: {}}}),
      messageTuple([
        interfaceText("appDialogs.importDecode"),
        state.lastImport?.decode_ms !== undefined
          ? `${state.lastImport.decode_ms.toFixed(1)} ms`
          : "—",
      ], {0: {key: "appDialogs.importDecode", params: {}}}),
    ];
    const body = document.createDocumentFragment(), table = document.createElement("table");
    table.className = "metric-table";
    for (const values of rows) {
      const row = table.insertRow();
      const messages = tupleMessages(values);
      values.forEach((value, index) => {
        const cell = row.insertCell(), message = messages[index];
        if (message) localizedText(cell, message.key, message.params);
        else cell.textContent = String(value);
      });
    }
    appendLocalized(body, table, translatedElement(paragraph(interfaceText("appDialogs.cpuSubmissionTimingsIncludeGeometryEvaluationAndSelection"), interfaceText('appDialogs.uiDialogDescPerformanceNote')), "appDialogs.cpuSubmissionTimingsIncludeGeometryEvaluationAndSelection", {}));
    // The editor's recent activity (there is no status bar): newest first, a problem marked.
    const activity = ctx.activity?.() ?? [];
    const clock = (time) => interfaceLocalization.formatDate(time, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (activity.length) {
      const heading = document.createElement("h3"), list = document.createElement("ol");
      heading.className = "ui-dialog-section-title";
      localizedText(heading, "appDialogs.activity", {});
      list.className = "performance-activity";
      for (const entry of activity.slice(0, 12)) {
        const item = document.createElement("li"), time = document.createElement("time");
        time.textContent = clock(entry.time);
        appendLocalized(item, time, ` ${entry.text}`);
        if (entry.error) item.dataset.tone = "error";
        appendLocalized(list, item);
      }
      appendLocalized(body, heading, list);
    }
    const report = () => [...Array.from(table.rows, row => `${row.cells[0].textContent}: ${row.cells[1].textContent}`), "", ...activity.map((entry) => `${clock(entry.time)} ${entry.error ? "! " : ""}${entry.text}`)].join("\n");
    const dialog = dialogOf({
      size: "md",
      id: "performance-dialog",
      title: interfaceText("appDialogs.performance"), titleKey: "appDialogs.performance",
      body,
      actions: [
        { label: interfaceText("appDialogs.copyReport"), labelKey: "appDialogs.copyReport", id: "copy-performance-report", value: "copy", variant: "ghost" },
        { label: kitText(t, "common.close"), labelKey: "common.close", labelParams: {}, cancel: true, variant: "secondary" },
      ],
      // Copy report keeps the dialog open: the numbers and the activity, for a bug report.
      onSubmit: (value) => {
        if (value !== "copy") return undefined;
        navigator.clipboard?.writeText(report()).then(() => dialog.setMeta({messageKey:"appDialogs.copied"}), () => dialog.setMeta({messageKey:"appDialogs.couldNotCopy"}));
        return false;
      },
    });
    void dialog.showModal();
  }
  /** Recent files (desktop): pick one to open it (after the list closes); Clear history empties the list in place. */
  async function showRecentFiles() {
    pause();
    const entries = await desktop.listRecentFiles();
    const empty = () => translatedElement(paragraph(interfaceText("appDialogs.noRecentFiles")), "appDialogs.noRecentFiles", {});
    const list = entries.length
      ? translatedElement(choiceList(interfaceText("appDialogs.recentFiles"), entries.map((entry) => ({
        label: entry.name, detail: `${entry.directory}${entry.missing ? interfaceText("appDialogs.unavailable") : ""}`, icon: "file",
        disabled: entry.missing, data: { recentId: entry.id },
      })), "recent-files"), "appDialogs.recentFiles", {}, 'aria-label')
      : Object.assign(document.createElement("div"), { className: "recent-files" });
    if (!entries.length) appendLocalized(list, empty());
    const dialog = dialogOf({
      size: "sm",
      title: interfaceText("appDialogs.recentFiles"), titleKey: "appDialogs.recentFiles",
      body: list,
      actions: [
        ...(entries.length ? [{ label: interfaceText("appDialogs.clearHistory"), labelKey: "appDialogs.clearHistory", value: "clear", id: "clear-recent", variant: "ghost" }] : []),
        { label: kitText(t, "common.close"), labelKey: "common.close", labelParams: {}, cancel: true, variant: "ghost" },
      ],
      onSubmit: (value, form, submitter) => {
        if (submitter?.dataset.recentId) return { value: { recent: submitter.dataset.recentId } };
        if (value === "clear") void clear();
        return false;
      },
    });
    const clear = guarded(async () => {
      dialog.setBusy(true);
      try {
        await desktop.clearRecentFiles();
        if (!dialog.open) return;
        replaceLocalized(list, empty());
        list.removeAttribute("role");
        const button = dialog.element.querySelector("#clear-recent");
        if (button) button.hidden = true;
        dialog.element.querySelector(".ui-dialog-foot button:not([hidden])")?.focus({ preventScroll: true });
      } finally {
        dialog.setBusy(false);
      }
    });
    // The command finishes once the list shows, as before; the file opens after the dialog closes.
    void dialog.showModal().then((choice) => {
      if (choice?.recent) guarded(async () => acceptNativeFile(await desktop.openRecentFile(choice.recent)))();
    });
  }
  Object.assign(actions, {
    rename: async () => {
      const name = await promptText({
        title: interfaceText("appDialogs.nameYourProject"), titleKey: "appDialogs.nameYourProject",
        value: editor.name,
        confirmLabel: interfaceText("appDialogs.saveName"), confirmLabelKey: "appDialogs.saveName", confirmLabelParams: {},
        maxLength: 120,
        inputId: "rename-input",
        overlays,
        icon: glyph,
        t,
      });
      if (name === null) return;
      editor.name = name.trim() || "Untitled";
      editor.dirty = true;
      updateTitle();
    },
    "open-recent": showRecentFiles,
    performance: showPerformance,
  });
  async function chooseRecovery(records, discard) {
    const body=document.createDocumentFragment(), label=document.createElement('label'), select=document.createElement('select'), wrap=document.createElement('span');
    label.className='ui-form-row';localizedText(label, "appDialogs.recoveryCopy", {});wrap.className='ui-select';localizedMarkup(wrap, icon('chevron-down'));
    localizedAttribute(select, 'aria-label', "appDialogs.recoveryCopy", {});
    for(const record of records){
      const option=document.createElement('option'),name=document.createTextNode(record.name || ''),time=document.createTextNode('');option.value=record.id;
      if(!record.name)localizedText(name,'app.untitled');
      localizedText(time,'supportMessages.date',{date:{format:'date',value:record.savedAt,options:{dateStyle:'short',timeStyle:'short'}}});
      appendLocalized(option,name,' · ',time);appendLocalized(select,option);
    }
    wrap.prepend(select);appendLocalized(label, wrap);appendLocalized(body, label, translatedElement(paragraph(interfaceText("appDialogs.restoreOpensThisCopyAsAnEditedProject")), "appDialogs.restoreOpensThisCopyAsAnEditedProject", {}));
    const dialog=dialogOf({title:interfaceText("appDialogs.restoreUnsavedWork"), titleKey: "appDialogs.restoreUnsavedWork",size:'sm',body,
      actions:[{label:interfaceText("common.cancel"), labelKey: "common.cancel",cancel:true},{label:interfaceText("appDialogs.discardCopy"), labelKey: "appDialogs.discardCopy",value:'discard',tone:'danger'},{label:interfaceText("appDialogs.restore"), labelKey: "appDialogs.restore",value:'restore',variant:'primary'}],
      onSubmit:value=>{
        const record=records.find(copy=>copy.id===select.value);
        if(value==='restore')return {value:record};
        if(value==='discard'){
          dialog.setBusy(true);
          void discard(record).then(deleted=>{
            if(!deleted)throw messageError(new Error(''), "errors.appDialogs.theRecoveryCopyChangedOrIsOpenIn", {});
            records.splice(records.indexOf(record),1);
            select.selectedOptions[0].remove();if(!select.options.length)dialog.close();
          }).catch(error=>dialog.setError(error)).finally(()=>dialog.setBusy(false));
          return false;
        }
        return false;
      },
    });
    return dialog.showModal();
  }
  return { confirmReplace, showImportNotes, chooseSticknodesEntry, confirmDiscardFrame, showPerformance, chooseRecovery };
}
