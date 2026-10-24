// One headless StykAnimate editor: the app's local codec service, Chrome and
// the editor page. Rendering, export and saving all go through the app itself,
// the same way its browser tests drive it.
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile, mkdir, mkdtemp, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {APP_ROOT, appModule} from './app-root.mjs';

const {chromium} = await appModule('tests/support/playwright.mjs');
const {default: backend} = await appModule('desktop/backend.cjs');

const EXPORT_TIMEOUT = 15 * 60 * 1000;

/** Re-encodes a WebM export as an H.264/AAC MP4 that YouTube and phones play directly. */
function toMp4(input, output) {
  const args = ['-v', 'error', '-y', '-i', input, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output];
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.STYK_FFMPEG || 'ffmpeg', args, {stdio: ['ignore', 'ignore', 'pipe']});
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.on('error', error => reject(new Error(`ffmpeg is needed to put sound in an MP4 (${error.message}). Install ffmpeg, set STYK_FFMPEG, or export format "webm".`)));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${errors.trim()}`)));
  });
}

export class AppSession {
  #service = null;
  #browser = null;
  #page = null;
  #starting = null;
  #files = new Map();
  pageErrors = [];

  /** Starts the app once; later calls reuse it. */
  page() {
    this.#starting ??= this.#start().catch(error => { this.#starting = null; throw error; });
    return this.#starting;
  }

  async #start() {
    this.#service = await backend.startBackend({appRoot: APP_ROOT, log: () => {}});
    this.#browser = await chromium.launch({channel: process.env.STYK_BROWSER_CHANNEL ? undefined : 'chrome', headless: process.env.STYK_HEADED !== '1'});
    const page = await this.#browser.newPage({viewport: {width: 1280, height: 900}, acceptDownloads: true});
    page.on('pageerror', error => { this.pageErrors.push(error.message); this.pageErrors.splice(0, this.pageErrors.length - 20); });
    // Without a save picker the app saves exports and projects as downloads, which this session collects.
    await page.addInitScript(() => { delete window.showSaveFilePicker; });
    // Local files reach the page through this route, never through a path the page chooses.
    await page.route(`${this.#service.origin}/__mcp/file/*`, route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1), file = this.#files.get(id);
      return file ? route.fulfill({status: 200, body: file.bytes, contentType: 'application/octet-stream'}) : route.fulfill({status: 404});
    });
    await page.goto(this.#service.origin);
    await page.waitForFunction(() => window.styk?.ready, null, {timeout: 120000});
    this.#page = page;
    return page;
  }

  /** Serves a local file to the page once and returns its page URL. */
  async #offer(filePath) {
    const absolute = path.resolve(filePath), id = randomUUID();
    this.#files.set(id, {bytes: await readFile(absolute)});
    return {url: `/__mcp/file/${id}`, name: path.basename(absolute), release: () => this.#files.delete(id)};
  }

  /** Builds text figure definitions with the app's bundled font. */
  async textFigures(members) {
    if (!members.length) return new Map();
    const page = await this.page();
    const built = await page.evaluate(async members => {
      const {createTextFigure} = await import('/src/text-authoring.mjs');
      const rgb = hex => { const value = parseInt(hex.length === 3 ? [...hex].map(d => d + d).join('') : hex, 16); return [value >> 16 & 255, value >> 8 & 255, value & 255]; };
      const out = [];
      for (const member of members) {
        const figure = await createTextFigure({
          text: member.text, name: member.id, fontSize: member.fontSize ?? 48, bold: member.bold ?? false, italic: member.italic ?? false,
          alignment: member.align ?? 'center', color: rgb((member.color ?? '#2b2b2b').replace('#', '')),
          outlineWidth: member.outline ?? 0, outlineColor: rgb((member.outlineColor ?? '#ffffff').replace('#', '')),
        });
        // The figure's root is the text's bottom-left corner.
        const {width, height} = figure.text_assets[0].bounds;
        out.push([member.id, {figure, anchor: {x: -width / 2, y: height / 2}}]);
      }
      return out;
    }, members);
    return new Map(built);
  }

  /** Reads a Pivot .stk figure with the app's codec service. */
  async figureFile(filePath) {
    await this.page();
    const bytes = await readFile(path.resolve(filePath));
    const response = await fetch(`${this.#service.origin}/api/import?filename=${encodeURIComponent(path.basename(filePath))}`,
      {method: 'POST', body: bytes});
    const result = await response.json();
    if (!result.ok) throw new Error(`${path.basename(filePath)}: ${result.error}`);
    const figure = result.document.figure_types?.[0];
    if (!figure) throw new Error(`${path.basename(filePath)} contains no figure`);
    return figure;
  }

  /** Decodes audio files with the app's audio engine; returns their durations in seconds. */
  async prepareAudio(clips) {
    const page = await this.page(), offered = [];
    try {
      for (const clip of clips) offered.push({...await this.#offer(clip.path), start: clip.start ?? 0, volume: clip.volume});
      return await page.evaluate(async clips => {
        window.__mcpAudio = [];
        for (const clip of clips) {
          const blob = await (await fetch(clip.url)).blob();
          const asset = await styk.audioEngine.import(new File([blob], clip.name, {type: blob.type}));
          window.__mcpAudio.push({asset, start: clip.start, volume: clip.volume});
        }
        return window.__mcpAudio.map(entry => ({name: entry.asset.name, duration: entry.asset.duration, start: entry.start}));
      }, offered.map(({release, ...clip}) => clip));
    } finally { for (const file of offered) file.release(); }
  }

  /** Opens a compiled document in the editor, with any prepared audio. */
  async load(document, name) {
    const page = await this.page();
    return page.evaluate(({document, name}) => {
      styk.editor.load(document, name);
      for (const {asset, start, volume} of window.__mcpAudio ?? []) {
        const id = styk.editor.importAudio(asset, {start});
        if (volume !== undefined && id) styk.editor.setAudioClip(id, {volume});
      }
      window.__mcpAudio = [];
      styk.editor.markSaved();
      return describe();
      function describe() { const report = styk.editor.report; return {name: styk.editor.name, width: report.canvas_width, height: report.canvas_height, fps: report.fps, ticks: styk.editor.totalTicks, seconds: styk.editor.totalTicks / report.fps, keyframes: report.keyframes.length}; }
    }, {document, name});
  }

  /** Opens a project or Pivot file the way File › Open does. */
  async open(filePath) {
    const page = await this.page(), file = await this.#offer(filePath);
    try {
      return await page.evaluate(async ({url, name}) => {
        const blob = await (await fetch(url)).blob();
        const result = await styk.importFiles([new File([blob], name)]);
        if (result === false) throw new Error('The file was not opened');
        const report = styk.editor.report;
        return {name: styk.editor.name, width: report.canvas_width, height: report.canvas_height, fps: report.fps, ticks: styk.editor.totalTicks, seconds: styk.editor.totalTicks / report.fps};
      }, {url: file.url, name: file.name});
    } finally { file.release(); }
  }

  async info() {
    const page = await this.page();
    return page.evaluate(() => {
      const report = styk.editor.report;
      return {name: styk.editor.name, width: report.canvas_width, height: report.canvas_height, fps: report.fps,
        ticks: styk.editor.totalTicks, seconds: styk.editor.totalTicks / report.fps, keyframes: report.keyframes.length,
        figures: report.figure_types.map(figure => figure.name), audioClips: (report._styk.audio?.tracks ?? []).flatMap(track => track.clips ?? []).length};
    });
  }

  async #openExport(page) {
    await page.locator('[data-action="export"]').first().click();
    await page.locator('#export-dialog').waitFor({state: 'visible'});
  }

  async #chooseType(page, action) {
    const {EXPORT_FORMATS} = await appModule('src/export-request.mjs');
    const format = EXPORT_FORMATS.find(entry => entry.action === action);
    await page.locator(`#export-dialog [data-category="${format.category}"]`).click();
    await page.waitForFunction(action => {
      const option = document.querySelector(`#output-format option[value="${action}"]`);
      return option && !option.disabled;
    }, action, {timeout: 30000});
    await page.locator('#output-format').selectOption(action);
  }

  async #submit(page, outPath) {
    const submit = page.locator('#export-submit');
    await page.waitForFunction(() => !document.querySelector('#export-submit')?.disabled, null, {timeout: 30000}).catch(async () => {
      throw new Error(`Export is disabled: ${await this.#disabledReason(page) || 'no reason shown'}`);
    });
    const label = await submit.textContent();
    const download = page.waitForEvent('download', {timeout: EXPORT_TIMEOUT});
    await submit.click();
    const file = await download;
    await mkdir(path.dirname(outPath), {recursive: true});
    await file.saveAs(outPath);
    const failure = await file.failure();
    if (failure) throw new Error(`Export failed: ${failure}`);
    return {path: outPath, bytes: (await stat(outPath)).size, type: label?.trim()};
  }

  /** The dialog's explanation for a disabled Export button. */
  async #disabledReason(page) {
    const lines = (await page.locator('#export-dialog').innerText().catch(() => '')).split('\n');
    return lines.filter(line => /choose|cannot|can't|unavailable|turn off|too |exceed|invalid|must/i.test(line)).join(' ');
  }

  /**
   * Exports the open animation. `preset` is one of the dialog's Quick presets (shorts, youtube, tiktok, ...);
   * otherwise `format` picks the type (mp4, webm, gif) at the canvas size.
   *
   * The browser's MP4 encoder cannot carry sound here, so an MP4 with sound is exported as WebM with the
   * app's own audio mix and converted to H.264/AAC MP4 with ffmpeg.
   */
  async exportVideo({preset, format = 'mp4', out, sound = true}) {
    const page = await this.page();
    await this.#openExport(page);
    try {
      if (preset) {
        const tile = page.locator(`#export-presets [data-preset="${preset}"]`);
        if (!await tile.count()) throw new Error(`Unknown preset "${preset}"`);
        await tile.click();
        await page.waitForFunction(preset => document.querySelector(`#export-presets [data-preset="${preset}"]`)?.getAttribute('aria-checked') === 'true', preset, {timeout: 30000});
      } else await this.#chooseType(page, {mp4: 'export-mp4', webm: 'export-video', gif: 'export-gif'}[format] ?? format);
      const audio = page.locator('#export-audio');
      const hasSound = await audio.count() > 0 && await page.locator('#export-audio').evaluate(input => input.closest('[hidden]') === null && input.offsetParent !== null);
      if (hasSound && await audio.isChecked() !== sound) await audio.setChecked(sound, {force: true});
      const note = (await page.locator('#export-preset-note').textContent().catch(() => ''))?.trim();
      const summary = (await page.locator('#export-summary-size').textContent().catch(() => ''))?.trim();
      const outPath = path.resolve(out);
      const mp4 = await page.locator('#output-format').inputValue() === 'export-mp4';
      if (hasSound && sound && mp4 && await page.locator('#export-submit').isDisabled()) {
        await page.locator('#output-format').selectOption('export-video');
        const webm = outPath.replace(/\.mp4$/i, '') + '.with-sound.webm';
        const exported = await this.#submit(page, webm);
        await toMp4(webm, outPath);
        await rm(webm, {force: true});
        return {path: outPath, bytes: (await stat(outPath)).size, type: 'MP4 with sound (exported as WebM, converted with ffmpeg)', size: summary, note, webmBytes: exported.bytes};
      }
      const result = await this.#submit(page, outPath);
      return {...result, size: summary, note, sound: hasSound && sound};
    } catch (error) {
      await page.keyboard.press('Escape').catch(() => {});
      throw error;
    }
  }

  /** PNG stills of the given frames, laid out on one contact sheet. */
  async preview({frames, width = 270}) {
    const page = await this.page();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'styk-preview-'));
    try {
      const stills = [];
      for (const tick of frames) {
        await page.evaluate(tick => styk.editor.seek(tick), tick);
        await this.#openExport(page);
        try { await this.#chooseType(page, 'export-png'); stills.push(await this.#submit(page, path.join(directory, `${tick}.png`))); }
        catch (error) { await page.keyboard.press('Escape').catch(() => {}); throw error; }
      }
      const images = await Promise.all(stills.map(async still => (await readFile(still.path)).toString('base64')));
      const sheet = await page.evaluate(async ({images, frames, width}) => {
        // The app's content policy refuses data: fetches, so the PNGs are decoded from base64 here.
        const bitmaps = await Promise.all(images.map(data => createImageBitmap(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], {type: 'image/png'}))));
        const height = Math.round(width * bitmaps[0].height / bitmaps[0].width), columns = Math.min(4, bitmaps.length), rows = Math.ceil(bitmaps.length / columns), label = 22;
        const canvas = new OffscreenCanvas(columns * width, rows * (height + label)), context = canvas.getContext('2d');
        context.fillStyle = '#888'; context.fillRect(0, 0, canvas.width, canvas.height);
        bitmaps.forEach((bitmap, index) => {
          const x = index % columns * width, y = Math.floor(index / columns) * (height + label);
          context.fillStyle = '#111'; context.fillRect(x, y, width, label);
          context.fillStyle = '#fff'; context.font = '14px sans-serif'; context.fillText(`frame ${frames[index]}`, x + 6, y + 16);
          context.drawImage(bitmap, x, y + label, width, height);
        });
        const blob = await canvas.convertToBlob({type: 'image/png'}), bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      }, {images, frames, width});
      return sheet;
    } finally { await rm(directory, {recursive: true, force: true}); }
  }

  /** Saves the open animation as a StykAnimate project through Save As. */
  async save(out) {
    const page = await this.page(), outPath = path.resolve(out);
    const download = page.waitForEvent('download', {timeout: 120000});
    await page.evaluate(() => { styk.actions['save-as'](); });
    const file = await download;
    await mkdir(path.dirname(outPath), {recursive: true});
    await file.saveAs(outPath);
    return {path: outPath, bytes: (await stat(outPath)).size};
  }

  async close() {
    await this.#browser?.close().catch(() => {});
    this.#service?.stop();
    this.#browser = this.#page = this.#service = this.#starting = null;
  }
}
