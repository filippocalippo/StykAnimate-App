// The application menus live in the mark's menu (the band keeps its room for the open projects):
// File, Edit, View, Joint, Animation and Help follow Search commands…, each opening its menu as a submenu.
const LABELS = Object.freeze({file: 'File', edit: 'Edit', view: 'View', editor: 'Joint', animation: 'Animation', help: 'Help'});

/**
 * Opens one application menu (a [data-app-menu] name) and resolves its locator once its rows are shown.
 * Its rows are found inside it (`menu.locator('[data-action="save"]')`), not inside the #menu host, which holds
 * the mark's own menu.
 */
export async function openAppMenu(page, name) {
  const label = LABELS[name];
  if (!label) throw new Error(`Unknown application menu: ${name}`);
  const row = page.locator('#menu').getByRole('menuitem', {name: label, exact: true});
  if (!await row.isVisible().catch(() => false)) await page.locator('.titlebar .brand').click();
  await row.click();
  const menu = page.locator(`.ui-menu[aria-label="${label}"]`).first();
  await menu.waitFor();
  return menu;
}

/** Closes every open menu, the mark's and the application menu inside it. */
export async function closeAppMenus(page) {
  for (let count = 0; count < 4 && await page.locator('.ui-menu').count(); count++) await page.keyboard.press('Escape');
}
