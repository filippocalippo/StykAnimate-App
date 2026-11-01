'use strict';

/**
 * What the main process sends to the page on its own (the file the app was launched with, a `stykanimate://` link's menu action, the
 * menu's own actions) goes to listeners the page registers while it starts. A message sent before they exist is dropped, and the page's
 * load event does not wait for them: a module that waits (src/app.mjs waits for the engine) has run no further when the page has loaded.
 * So the page says when its listeners are on (`styk:page-listening`), and everything sent until then is kept, in order. A page that loads
 * again has no listeners until it says so once more.
 */
class PagePushes {
  #held = [];
  #listening = false;
  #deliver;

  /** `deliver(channel, args)` sends to the page. */
  constructor(deliver) { this.#deliver = deliver; }

  get listening() { return this.#listening; }
  get held() { return this.#held.length; }

  send(channel, ...args) {
    if (this.#listening) this.#deliver(channel, args);
    else this.#held.push([channel, args]);
  }

  /** The page's listeners are on: what was kept goes out first, in order. */
  listen() {
    this.#listening = true;
    for (const [channel, args] of this.#held.splice(0)) this.#deliver(channel, args);
  }

  /** The page is loading again (or is gone): it has no listeners until it says so. */
  reset() { this.#listening = false; }
}

module.exports = { PagePushes };
