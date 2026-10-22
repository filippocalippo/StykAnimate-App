'use strict';

// The application menu. Editor shortcuts belong to the renderer's customizable, focus-aware
// dispatcher, so on Windows and Linux the menu carries no accelerators: native accelerators would
// intercept disabled or reassigned keys and text editing.
//
// macOS is different in two ways. Chromium leaves Command+Z/X/C/V/A in text fields to the menu (the
// Edit menu's key equivalents), and Command+W and Command+H are system conventions. The page still
// receives every key first and the editor claims the keys it handles, so a key equivalent fires only
// for a key the editor declined: in a text field, under a dialog, or after the person reassigned it.
// Those clicks arrive with `fromKeyboard`, and the renderer applies them to a focused text field or
// ignores them, so one key never runs two actions.

/** Text editing commands the renderer may ask the focused page to perform natively. */
const TEXT_EDIT_COMMANDS = Object.freeze({ undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', 'select-all': 'selectAll', delete: 'delete' });

function nativeMenuTemplate({ platform = process.platform, packaged = true, t, send }) {
  const mac = platform === 'darwin';
  const item = (label, action, accelerator) => ({
    label,
    ...(mac && accelerator ? { accelerator } : {}),
    click: (_item, _window, event) => send(action, { fromKeyboard: Boolean(event?.triggeredByAccelerator) }),
  });
  return [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: t('desktop.main.file'), submenu: [
      item(t('menu.newAnimation'), 'new'),
      item(t('desktop.main.newWindow'), 'new-window'),
      item(t('menu.openProject'), 'open'),
      { type: 'separator' },
      item(t('common.save'), 'save'),
      item(t('common.saveAs'), 'save-as'),
      item(t('desktop.main.saveFigure'), 'export-stkz'),
      item(t('common.export'), 'export'),
      { type: 'separator' },
      // Command+W closes the project in front, as it closes a tab elsewhere on macOS; Shift+Command+W the window.
      ...(mac ? [item(t('commands.closeProject'), 'close-project', 'CmdOrCtrl+W'),
        { role: 'close', label: t('desktop.main.closeWindow'), accelerator: 'Shift+CmdOrCtrl+W' }] : [{ role: 'quit' }]),
    ] },
    { label: t('desktop.main.edit'), submenu: [
      item(t('common.undo'), 'undo', 'CmdOrCtrl+Z'), item(t('common.redo'), 'redo', 'Shift+CmdOrCtrl+Z'),
      { type: 'separator' },
      item(t('common.cut'), 'cut', 'CmdOrCtrl+X'), item(t('common.copy'), 'copy', 'CmdOrCtrl+C'), item(t('common.paste'), 'paste', 'CmdOrCtrl+V'),
      item(t('common.duplicate'), 'duplicate'), item(t('common.delete'), 'delete'),
      { type: 'separator' }, item(t('desktop.main.selectAll'), 'select-all', 'CmdOrCtrl+A'),
    ] },
    { label: t('desktop.main.animation'), submenu: [
      item(t('desktop.main.playPause'), 'play'), item(t('timeline.addFrame'), 'add-frame'),
      item(t('desktop.main.previousFrame'), 'previous-frame'), item(t('desktop.main.nextFrame'), 'next-frame'),
      { type: 'separator' }, item(t('timeline.onion'), 'toggle-onion'),
    ] },
    { label: t('desktop.main.view'), submenu: [
      item(t('desktop.main.zoomIn'), 'zoom-in'), item(t('desktop.main.zoomOut'), 'zoom-out'),
      item(t('desktop.main.fitCanvas'), 'zoom-reset'), { type: 'separator' }, { role: 'togglefullscreen', accelerator: '' },
      ...(!packaged ? [{ role: 'toggleDevTools', accelerator: '' }] : []),
    ] },
    // Minimize (Command+M), Zoom and the window list.
    ...(mac ? [{ role: 'windowMenu' }] : []),
    { label: t('desktop.main.help'), submenu: [item(t('menu.shortcuts'), 'help'), item(t('desktop.main.checkForUpdates'), 'check-updates'), item(t('desktop.main.whatSNew'), 'release-notes'), item(t('desktop.main.supportDevelopment'), 'donate'), item(t('desktop.main.aboutStykAnimate'), 'about')] },
  ];
}

module.exports = { nativeMenuTemplate, TEXT_EDIT_COMMANDS };
