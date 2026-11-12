# Home

Home is the page the app opens on: the person's projects, a way to start a new animation, and the tutorials.
It is a page over the editor, not another document. The open projects stay open behind it, and it steps aside
as soon as a project comes to the front or a command works on the animation. The design is the "Home as a place of its own in the band" concept, with the project organization added.

## Where it lives

- `#home` is the last child of `.workspace` in `index.html`. It covers the workspace grid (`position: absolute;
  inset: 0`), so showing and leaving Home lays nothing out again and the renderer, the timeline and the docks
  keep their sizes. While it shows, `.workspace[data-home]` hides the editor's parts (`visibility`, which also
  takes them out of the tab order) and `.shell[data-home]` hides the band's Undo, Redo, Save, Export and session
  buttons, without changing the band's width (it is not measured again).
- The band's Home button (`.band-home`, `data-action="home"`) sits between the mark and the project tabs. It is
  pressed while Home shows, and no workspace is.
- `src/home/home.mjs` owns Home: when it shows, its project list, and what its page asks for.
  `src/home/home-view.mjs` draws the page from the state it is given and reports what the person asks for.
  `src/home/home-model.mjs` is pure: search, order, scopes, relative times, sizes and tutorial progress.
  `src/styles/features/home.css` styles it, and the tutorials' strip, mark and pointer.
- `app.mjs` creates Home before the action wrapper loop and tells it which command is about to run
  (`home.before(name)`), asks it whether a key press is the editor's (`home.blocksKey(command)`), and calls
  `home.start()` once the settings are read.

## Showing and leaving

- At startup Home shows unless the launch says otherwise or the person turned it off (Settings › Interface ›
  Show Home when the app starts, `showHomeOnStartup`). The desktop decides `startupView` in the main process:
  `'editor'` when the window opens with a file (Home would only flash before it), or what `STYK_STARTUP_VIEW`
  says. In a browser `window.stykStartupView` does the same. Tests and scripts start in the editor
  (`tests/support/playwright.mjs` sets both); a test of Home asks for it.
- Home leaves for the editor when: the person presses Back to {project}, Escape, the Home button again, a
  workspace button or a project tab; a document comes to the front by any way (a tab, a file from the system,
  a recovered copy, Start); or a command that works on the animation runs. `HOME_COMMANDS` lists the commands
  that leave Home in place because they open something of their own (dialogs, menus, file pickers) or act on the
  window.
- While Home shows, only Home's shortcuts and the ones that bring a project to the front work (New, Open, Save,
  the palette, Settings, Help, the project switch); every other key belongs to the page.
- Messages show in Home's box while it shows (the stage header is under it). Startup prompts (What's new,
  the privacy question) still open over Home.
- Showing Home pauses playback and ends a running tutorial.

## Start

Landscape (960 × 540), Vertical (540 × 960) and Square (720 × 720) run New and then load the startup animation
on that canvas (`createStartupDocument({canvas})`, `STARTUP_CANVASES`): Blue stays where it stands relative to
the canvas, its hand and foot controls with it. Open a file is File › Open.

## Projects (desktop)

The list is the main process's (`desktop/project-library.cjs`), stored in `userData/project-library/`:
`projects.json` and one PNG per project in `previews/`.

- A project is an animation that was opened or saved (`.styk`, `.piv`, `.json`, `.stknds`): `rememberRecent`
  in `main.cjs` records it. Figures and movieclips are assets, not projects.
- The renderer sees opaque ids, never paths it did not choose. Opening a listed project goes through
  `readImportFile`, as File › Open does. A listed project that is already open (its file is a document of this
  window, `projectFiles.documents`) carries that document's token, and Home brings its tab to the front instead.
- Open-tab matching and preview updates resolve linked folders and file aliases to the same path used when
  remembering a project, so opening through a link still returns to the existing tab and stores its picture.
- Pins and folders are the person's arrangement. A folder is a label: nothing moves, renames or deletes a file.
  Removing a project from the list leaves its file alone. At most 200 projects (pinned ones never leave; the
  oldest unpinned ones do, with their pictures) and 48 folders.
- A project whose file moved or was deleted stays listed as missing, so the person can remove it.
- Each project keeps a small picture and its counts (frames, fps, canvas size). After a save or an open,
  Home stores the picture the project's tab already has (the stage as last seen, `projectTabsView.picture`)
  once nothing is moving, as a PNG of at most 320 px wide, with the counts; nothing is rendered for it. The main
  process accepts it only for the document's own file (`documentToken`).
- The page reads the list each time it shows, and a card's picture only when the card scrolls into view
  (`IntersectionObserver`); read pictures are kept for the session (at most 96).
- Search matches every word in the name or folder, ignoring case and accents. Order: last opened, name or last
  changed (`homeSort`); pinned projects lead. Grid or list (`homeLayout`). The list shows folder, length,
  last change and size.

IPC (preload): `listProjects`, `openProject(id)`, `updateProject(id, {pinned, folder})`, `removeProject(id)`,
`revealProject(id)`, `getProjectPreview(id)`, `setProjectPreview({documentToken, thumbnail, stats})`,
`changeProjectFolder({action: 'create' | 'rename' | 'delete', name, to})`.

The browser build keeps no list: projects are the files the person opens and saves. Home says so and offers
Open a file.

## Learn and Help

Learn shows the tutorials (`docs/TUTORIALS.md`) with what is done (`tutorialsDone`) and the next one to take.
Help links Keyboard shortcuts, Search commands and, on the desktop, What's new and Send feedback.

## Checks

- `tests/home-model.test.mjs`: the model, Home's settings and Start's canvases.
- `scripts/project-library.test.mjs`: the list in the main process.
- `tests/home.browser.mjs`: Home in the browser (startup, keys, Start, messages, Learn, language, setting,
  small windows).
- `scripts/smoke-home.mjs`: Home in the desktop app with the real list (saving, opening, pins, folders,
  search, layout, a moved file, the startup setting across launches, a file opened at launch).
