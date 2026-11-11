import {localizedAttribute, appendLocalized, localizedText} from './localization-bindings.mjs';
import {readLibraryFile} from './library-files.mjs';
import {engineLibraryAnimation} from './engine/engine-previews.mjs';

/**
 * One hover animation at a time and one frame in flight; no decoded-document cache. The engine draws it
 * (src/engine/engine-previews.mjs: the page's preview worker, kept between hovers); a file it cannot draw
 * shows no animation.
 */
export class LibraryHoverPreview {
  constructor(desktop) { this.desktop = desktop; }
  start(card, item) {
    if (this.current?.card === card) return;
    this.stop();
    const session = {card, controller: new AbortController()}; this.current = session;
    session.delay = setTimeout(() => this.load(session, item), 180);
  }
  async load(session, item) {
    const active = () => this.current === session && session.card.isConnected;
    try {
      const file = await readLibraryFile(this.desktop, item.path, {signal: session.controller.signal});
      if (!active()) return;
      const animation = await engineLibraryAnimation(file, {signal: session.controller.signal});
      if (!active()) { animation?.close(); return; }
      if (animation) this.play(session, animation);
      else this.fail(session);
    } catch (error) {
      if (active()) { this.stop(); if (error.name !== 'AbortError') localizedAttribute(session.card, "title", "libraryHoverPreview.animationPreviewUnavailableDoubleClickToInsertThis", {}); }
    }
  }
  fail(session) {
    if (this.current !== session || !session.card.isConnected) return;
    this.stop();
    localizedAttribute(session.card, "title", "libraryHoverPreview.animationPreviewUnavailableDoubleClickToInsertThis", {});
  }
  /** Puts a frame on the card's canvas (created with the first frame). */
  show(session, bitmap, {tick, duration, matte}) {
    if (!session.canvas) {
      session.canvas = document.createElement('canvas'); session.canvas.className = 'library-animation';
      session.canvas.width = session.canvas.height = 320; session.canvas.setAttribute('aria-hidden', 'true');
      appendLocalized(session.card.querySelector('.library-thumbnail'), session.canvas);
      session.card.classList.add('library-preview-playing');
      localizedText(session.card.querySelector('.library-preview-hint'), "libraryHoverPreview.playing", {});
      session.started = performance.now();
    }
    const context = session.canvas.getContext('2d');
    context.clearRect(0, 0, 320, 320); context.drawImage(bitmap, 0, 0); bitmap.close();
    session.canvas.dataset.tick = String(tick);
    session.card.style.setProperty('--library-progress', String((tick + 1) / duration));
    // Contrast stays stable for the whole hover, including color-changing clips.
    if (matte) session.card.style.setProperty('--library-matte', matte);
  }
  /** The engine's animation: frames asked for one at a time, at most 24 a second. */
  play(session, animation) {
    const active = () => this.current === session && session.card.isConnected;
    session.animation = animation;
    let first = true;
    const next = async () => {
      session.timeout = setTimeout(() => this.fail(session), first ? 60000 : 15000);
      let frame;
      try { frame = await animation.frame(session.started === undefined ? 0 : (performance.now() - session.started) / 1000); }
      catch (error) { clearTimeout(session.timeout); if (error.name !== 'AbortError') this.fail(session); return; }
      clearTimeout(session.timeout);
      if (!active()) { frame?.bitmap.close(); return; }
      // A frame the engine does not draw: the animation ends.
      if (!frame) { animation.close(); session.animation = null; this.fail(session); return; }
      this.show(session, frame.bitmap, {tick: frame.tick, duration: animation.duration, matte: first ? animation.matte : undefined});
      first = false;
      session.delay = setTimeout(() => { if (active()) void next(); }, 1000 / Math.min(24, animation.fps));
    };
    void next();
  }
  stop() {
    const session = this.current; this.current = null;
    if (!session) return;
    clearTimeout(session.delay); clearTimeout(session.timeout); session.controller.abort(); session.animation?.close();
    session.canvas?.remove(); session.card.classList.remove('library-preview-playing');
    const hint = session.card.querySelector('.library-preview-hint'); if (hint) localizedText(hint, "libraryHoverPreview.hoverToPlay", {});
    if (session.card.dataset.matte) session.card.style.setProperty('--library-matte', session.card.dataset.matte);
  }
}
