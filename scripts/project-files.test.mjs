import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const { ProjectFiles } = createRequire(import.meta.url)('../desktop/project-files.cjs');
const nativePath = name => path.join(os.tmpdir(), 'StykAnimate project files', name);
const describeCurrent = (files, token) => files.describe(files.requireCurrent(token));

test('a fresh session has no document or save target until a document is activated', () => {
  const files = new ProjectFiles();
  assert.throws(() => files.requireCurrent(undefined), /different document/);
  assert.throws(() => files.commit('invented-token', nativePath('scene.styk')), /different document/);
  const document = files.activate();
  assert.equal(typeof document.documentToken, 'string');
  assert.ok(document.documentToken.length > 0);
  assert.deepEqual(document, { documentToken: document.documentToken, filename: null, hasSaveTarget: false });
  assert.equal(files.requireCurrent(document.documentToken).filename, null);
});

test('native STYK activation consumes its open token and exposes only the basename', () => {
  const files = new ProjectFiles();
  const filename = nativePath('Scène 日本語.STYK');
  const openToken = files.rememberOpen(filename);
  assert.equal(typeof openToken, 'string');
  const document = files.activate({ openToken });
  assert.notEqual(document.documentToken, openToken);
  assert.deepEqual(document, { documentToken: document.documentToken, filename: 'Scène 日本語.STYK', hasSaveTarget: true });
  assert.equal(files.requireCurrent(document.documentToken).filename, filename);
  assert.throws(() => files.activate({ openToken }), /no longer active/);
  assert.deepEqual(describeCurrent(files, document.documentToken), document);
});

test('PIV, STK, and JSON native opens activate documents without a save target', () => {
  const files = new ProjectFiles();
  for (const filename of ['animation.piv', 'figure.stk', 'native.stkz', 'NATIVE.STKZ', 'decoded.json', 'ANIMATION.PIV', 'FIGURE.STK']) {
    const previous = files.activate({ openToken: files.rememberOpen(nativePath('previous.styk')) });
    const openToken = files.rememberOpen(nativePath(filename));
    assert.equal(openToken, null);
    const imported = files.activate({ openToken });
    assert.equal(imported.filename, null);
    assert.equal(imported.hasSaveTarget, false);
    assert.throws(() => files.requireCurrent(previous.documentToken), /different document/);
  }
});

test('preparing or abandoning a save destination does not replace the active target', () => {
  const files = new ProjectFiles();
  const document = files.activate({ openToken: files.rememberOpen(nativePath('original.styk')) });
  const candidate = nativePath('save-as.styk');
  assert.equal(files.validateDestination(candidate), candidate);
  // The native writer calls commit only after the write succeeds. A cancelled or
  // failed writer therefore leaves this prepared destination uncommitted.
  assert.deepEqual(describeCurrent(files, document.documentToken), document);
  assert.equal(files.requireCurrent(document.documentToken).filename, nativePath('original.styk'));
  const saved = files.commit(document.documentToken, candidate);
  assert.deepEqual(saved, { documentToken: document.documentToken, filename: 'save-as.styk', hasSaveTarget: true });
  assert.equal(files.requireCurrent(document.documentToken).filename, candidate);
});

test('a first save acquires its target only when committed', () => {
  const files = new ProjectFiles();
  const document = files.activate();
  const candidate = files.validateDestination(nativePath('first.styk'));
  assert.deepEqual(describeCurrent(files, document.documentToken), document);
  const saved = files.commit(document.documentToken, candidate);
  assert.equal(saved.documentToken, document.documentToken);
  assert.equal(saved.filename, 'first.styk');
  assert.equal(saved.hasSaveTarget, true);
});

test('invalid destinations reject without modifying a complete active target', () => {
  const files = new ProjectFiles();
  const document = files.activate({ openToken: files.rememberOpen(nativePath('original.styk')) });
  for (const filename of [
    'relative.styk', '', null, undefined, 42,
    nativePath('source.piv'), nativePath('figure.stk'), nativePath('export.json'), nativePath('scene.styk.backup'),
  ]) {
    assert.throws(() => files.commit(document.documentToken, filename), /Choose a \.styk/);
    assert.deepEqual(describeCurrent(files, document.documentToken), document);
    assert.equal(files.requireCurrent(document.documentToken).filename, nativePath('original.styk'));
  }
});

test('switching documents prevents a delayed save from changing the new document target', () => {
  const files = new ProjectFiles();
  const previous = files.activate({ openToken: files.rememberOpen(nativePath('previous.styk')) });
  const current = files.activate({ openToken: files.rememberOpen(nativePath('current.styk')) });
  assert.notEqual(previous.documentToken, current.documentToken);
  assert.throws(() => files.requireCurrent(previous.documentToken), /different document/);
  assert.throws(() => files.commit(previous.documentToken, nativePath('delayed-save.styk')), /different document/);
  assert.deepEqual(describeCurrent(files, current.documentToken), current);
  assert.equal(files.requireCurrent(current.documentToken).filename, nativePath('current.styk'));
});

test('renderer-supplied paths and forged tokens cannot select a native target', () => {
  const files = new ProjectFiles();
  const filename = nativePath('unapproved.styk');
  const document = files.activate({ filename, path: filename, nativePath: filename, documentToken: 'forged' });
  assert.equal(document.filename, null);
  assert.equal(document.hasSaveTarget, false);
  assert.notEqual(document.documentToken, 'forged');
  for (const openToken of ['forged', filename, 123, {}, []]) {
    assert.throws(() => files.activate({ openToken, filename }), /no longer active/);
    assert.deepEqual(describeCurrent(files, document.documentToken), document);
  }
  for (const token of ['forged', filename, null, undefined, 123, {}]) {
    assert.throws(() => files.commit(token, filename), /different document/);
    assert.deepEqual(describeCurrent(files, document.documentToken), document);
  }
});

test('expired native open tokens cannot replace the current document', t => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const files = new ProjectFiles({ openTokenTtlMs: 100 });
  const document = files.activate();
  const expired = files.rememberOpen(nativePath('expired.styk'));
  now = 1_100;
  assert.throws(() => files.activate({ openToken: expired }), /no longer active/);
  assert.deepEqual(describeCurrent(files, document.documentToken), document);
  const valid = files.rememberOpen(nativePath('valid.styk'));
  assert.throws(() => files.activate({ openToken: expired }), /no longer active/);
  now = 1_199;
  assert.equal(files.activate({ openToken: valid }).filename, 'valid.styk');
});

test('pending native opens are bounded by evicting the oldest unconsumed token', () => {
  const files = new ProjectFiles({ maxOpenTokens: 3 });
  const document = files.activate();
  const tokens = ['one', 'two', 'three', 'four'].map(name => files.rememberOpen(nativePath(`${name}.styk`)));
  assert.throws(() => files.activate({ openToken: tokens[0] }), /no longer active/);
  assert.deepEqual(describeCurrent(files, document.documentToken), document);
  for (let index = 1; index < tokens.length; index++) {
    const activated = files.activate({ openToken: tokens[index] });
    assert.equal(activated.filename, ['one', 'two', 'three', 'four'][index] + '.styk');
    assert.throws(() => files.activate({ openToken: tokens[index] }), /no longer active/);
  }
});
