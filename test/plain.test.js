import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPictographs, plain, saidAbout } from '../lib/plain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

test('ordinary words are left exactly as they were', () => {
  const said = 'practising the same four bars until they stop being four bars.';
  const result = plain(said);

  assert.equal(result.text, said);
  assert.equal(result.changed, false);
  assert.equal(saidAbout(result), null, 'and nothing to report');
});

test('emoji come out, in every shape they arrive in', () => {
  const cases = [
    ['plain pictograph', 'well done \u{1F600}'],
    ['with a variation selector', 'a warning ⚠️ here'],
    ['a joined sequence', 'family \u{1F468}‍\u{1F469}‍\u{1F467}'],
    ['a flag from regional indicators', 'from \u{1F1EC}\u{1F1E7} today'],
    ['a keycap', 'number 1️⃣ please'],
    ['a symbol with emoji presentation', 'look ❤️'],
  ];

  for (const [what, text] of cases) {
    const result = plain(text);
    assert.equal(hasPictographs(result.text), false, `${what}: "${result.text}"`);
    assert.ok(result.emoji > 0, `${what} should be counted`);
    assert.ok(result.text.length > 0, `${what} should leave the words behind`);
  }
});

test('the words around a removed emoji survive intact', () => {
  const result = plain('the chanterelles \u{1F344} are up behind the quarry');
  assert.equal(result.text, 'the chanterelles are up behind the quarry');
  assert.equal(result.emoji, 1);
  assert.match(saidAbout(result), /1 emoji removed/);
});

test('images are removed however they are dressed up', () => {
  const cases = [
    '![a picture](http://example.com/cat.png)',
    '<img src="cat.png" alt="cat">',
    '<svg><circle r="4"/></svg>',
    'data:image/png;base64,iVBORw0KGgo=',
    'http://example.com/photo.jpeg',
  ];

  for (const text of cases) {
    const result = plain(`before ${text} after`);
    assert.ok(result.images > 0, `not counted: ${text}`);
    assert.equal(result.text, 'before after', `not removed cleanly: "${result.text}"`);
  }
});

test('a message that was only a picture has nothing left of it', () => {
  const result = plain('\u{1F600}\u{1F601}');
  assert.equal(result.empty, true);
  assert.match(saidAbout(result), /only pictures/);
});

test('nothing at all is not an error', () => {
  for (const nothing of [null, undefined, '', '   ']) {
    const result = plain(nothing);
    assert.equal(result.text, '');
    assert.equal(result.emoji, 0);
  }
});

test('ordinary punctuation and accents are words, not pictures', () => {
  // The rule is no pictographs. It is not "no characters an English keyboard
  // lacks", and a check that cannot tell the difference would quietly make
  // this place unusable for most of the people in the world.
  const said = 'Il a dit « non » — ça ne marchera pas. Ψυχή, 数学, naïve café 50% ≤ 3';
  const result = plain(said);
  assert.equal(result.text, said);
  assert.equal(result.emoji, 0);
});

test('no pictograph is written into the product itself', () => {
  // The rule covers the interface too, not only what people type. This is the
  // check rather than a promise to remember: one crept into a label the first
  // time round and was only found by looking.
  const skip = new Set(['node_modules', '.git', 'coverage']);
  const offenders = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|html|css|md|ts)$/.test(entry.name)) {
        // This file necessarily contains the examples it tests with.
        if (full.endsWith('plain.test.js')) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (hasPictographs(text)) offenders.push(path.relative(root, full));
      }
    }
  })(root);

  assert.deepEqual(offenders, [], `pictographs in: ${offenders.join(', ')}`);
});
