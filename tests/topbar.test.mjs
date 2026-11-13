/**
 * The band's measurement (src/shell/topbar.mjs): the widths the layout
 * solver reads as `bandMin`, after each fold step that frees room, with the
 * menubar docked and folded into the mark.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {MENUBAR_FOLD, collectBandWidths, rangeCoversText} from '../src/shell/topbar.mjs';
import {BAND_FOLDS, resolveTiers} from '../src/shell/layout-solver.mjs';

// A band whose steps free these widths; the menubar is 300px.
const SAVES = {state: 60, tight: 30, name: 40, name8: 20, savelabel: 30, save: 40, winctl: 6, dot: 60, primary: 50};
const bandWidth = (tokens, base = 900) => tokens.reduce((width, token) => width - (token === MENUBAR_FOLD ? 300 : SAVES[token] ?? 0), base);

test('the band is measured after each step that frees room, in the fold order, docked and folded', () => {
  const widths = collectBandWidths(tokens => bandWidth(tokens));
  assert.equal(widths.none, 900);
  // Steps the band has no rule for (or that free nothing) are left out.
  assert.deepEqual(Object.keys(widths).filter(key => key !== 'none' && key !== 'minimal'),
    BAND_FOLDS.filter(step => SAVES[step]));
  assert.equal(widths.state, 840);
  assert.equal(widths.tight, 810);
  assert.equal(widths.primary, 900 - Object.values(SAVES).reduce((sum, value) => sum + value, 0));
  assert.equal(widths.minimal.none, 600);
  assert.equal(widths.minimal.primary, widths.primary - 300);
});

test('the docked and folded passes can run on their own', () => {
  const calls = [];
  const docked = collectBandWidths(tokens => { calls.push(tokens.join(' ')); return bandWidth(tokens); }, undefined, {folded: false});
  assert.equal(docked.minimal, undefined);
  assert.ok(!calls.some(call => call.includes(MENUBAR_FOLD)), 'no folded pass');
  const folded = collectBandWidths(tokens => bandWidth(tokens), undefined, {docked: false});
  assert.deepEqual(Object.keys(folded), ['minimal']);
  assert.deepEqual(folded.minimal, collectBandWidths(tokens => bandWidth(tokens)).minimal);
});

test('a step that frees nothing is neither measured nor applied', () => {
  const calls = [];
  const widths = collectBandWidths(tokens => { calls.push(tokens.join(' ')); return bandWidth(tokens.filter(token => token !== 'winctl')); });
  assert.equal(widths.winctl, undefined);
  // Later steps are measured without it.
  assert.ok(calls.includes('state tight name name8 savelabel save dot'));
  assert.ok(!calls.some(call => call.includes('winctl dot')));
});

test('the solver folds the fewest measured steps, and the menubar only where none is enough', () => {
  const widths = collectBandWidths(tokens => bandWidth(tokens, 1200));
  assert.deepEqual(resolveTiers(1440, 900, {bandMin: widths}).band, []);
  assert.deepEqual(resolveTiers(1200, 900, {bandMin: widths}).band, ['state']);
  assert.deepEqual(resolveTiers(1140, 900, {bandMin: widths}).band, ['state', 'tight']);
  const narrowest = resolveTiers(widths.primary + 24, 900, {bandMin: widths});
  assert.equal(narrowest.tier, 'narrow');
  assert.equal(narrowest.band.at(-1), 'primary');
  const folded = resolveTiers(widths.primary + 23, 900, {bandMin: widths});
  assert.equal(folded.tier, 'minimal');
  assert.equal(folded.bandStep, true);
  // With the menubar folded the band needs far fewer steps.
  assert.deepEqual(folded.band, ['state']);
});

test('a font subset refits the band only when it covers a character the band shows', () => {
  const latin = 'U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+20AC';
  const cyrillic = 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116';
  assert.equal(rangeCoversText(latin, 'Animate · Untitled'), true);
  assert.equal(rangeCoversText(cyrillic, 'Animate · Untitled'), false, 'another script loaded for text elsewhere');
  assert.equal(rangeCoversText(cyrillic, 'Анимация'), true);
  assert.equal(rangeCoversText('U+4E??', '\u4e00'), true, 'a wildcard range');
  assert.equal(rangeCoversText('U+4E??', 'A'), false);
  assert.equal(rangeCoversText('', 'A'), true, 'no range: every character');
  assert.equal(rangeCoversText('not a range', 'A'), true, 'a range it cannot read refits as before');
});
