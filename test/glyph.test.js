import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, glyphOf, patternId, signature, tile } from '../lib/glyph.js';
import { hue } from '../lib/palette.js';
import { knowledge } from '../lib/knowledge.js';

/**
 * The second channel, and whether it is really a second one.
 *
 * A pattern that came from the same hash as the colour would tell you nothing
 * a colour collision had not already failed to tell you, and a parameter that
 * does not change what a family looks like — turning a ring — counts toward a
 * total while doing no work. Both are easy to write and hard to notice, so
 * both are measured here rather than asserted in a comment.
 */

const catalogue = (() => {
  const names = [];
  const walk = (node) => {
    for (const [key, value] of Object.entries(node)) {
      names.push(key);
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(knowledge);
  return [...new Set(names)];
})();

test('a subject keeps its pattern, the way it keeps its colour', () => {
  for (const subject of catalogue.slice(0, 40)) {
    assert.deepEqual(glyphOf(subject), glyphOf(subject));
    assert.equal(signature(subject), signature(subject));
  }
  // Pinned, so that changing the hash is a decision rather than a surprise.
  assert.equal(signature('art'), 'rings/0/l/1.00');
  assert.equal(signature('music'), 'grid/0/d/1.00');
});

test('the pattern is a genuinely separate channel from the colour', () => {
  // The point of the whole file. If these two came from one hash, subjects
  // that collided on hue would collide on texture too and the second channel
  // would be decoration.
  let close = 0;
  let same = 0;
  for (let i = 0; i < catalogue.length; i++) {
    for (let j = i + 1; j < catalogue.length; j++) {
      const apart = Math.abs(hue(catalogue[i]) - hue(catalogue[j]));
      if (Math.min(apart, 360 - apart) >= 20) continue;
      close++;
      if (signature(catalogue[i]) === signature(catalogue[j])) same++;
    }
  }
  assert.ok(close > 500, `expected plenty of near-hues to test, got ${close}`);
  const both = same / close;
  assert.ok(both < 0.06, `${(both * 100).toFixed(1)}% of colour collisions collide on pattern too`);
});

test('the parameters are ones that change what is drawn', () => {
  // Turning a ring produces a ring. A first cut of this gave every family
  // four angles and counted sixty-three patterns where far fewer were
  // distinguishable, so the count is taken over what is actually drawn.
  const drawn = new Set(catalogue.map(signature));
  assert.ok(drawn.size > 30, `only ${drawn.size} distinct patterns across ${catalogue.length} subjects`);

  // Every family gets used on a catalogue this size, including `plain`.
  const families = new Set(catalogue.map((s) => glyphOf(s).family));
  assert.deepEqual([...families].sort(), [...FAMILIES].sort());

  // And two subjects drawn the same really are the same drawing.
  const bySignature = new Map();
  for (const subject of catalogue) {
    const key = signature(subject);
    if (bySignature.has(key)) {
      assert.deepEqual(
        tile(subject, 20),
        tile(bySignature.get(key), 20),
        `${subject} and ${bySignature.get(key)} share a signature but not a tile`,
      );
    } else bySignature.set(key, subject);
  }
});

test('every subject produces geometry, and only geometry', () => {
  // A pattern is not a picture of anything. What a tile may contain is shapes.
  const allowed = new Set(['line', 'circle', 'rect', 'path']);
  for (const subject of catalogue) {
    const shapes = tile(subject, 24);
    assert.ok(Array.isArray(shapes), `${subject} produced no tile`);
    if (glyphOf(subject).family === 'plain') {
      assert.equal(shapes.length, 0, 'plain is plain');
      continue;
    }
    assert.ok(shapes.length > 0 && shapes.length < 200, `${subject}: ${shapes.length} shapes`);
    for (const shape of shapes) {
      assert.ok(allowed.has(shape.shape), `${subject} drew a ${shape.shape}`);
      for (const [name, value] of Object.entries(shape)) {
        if (name === 'shape' || name === 'hollow') continue;
        if (name === 'd') {
          // A path is numbers and the two commands that join them.
          assert.match(value, /^[ML0-9 .-]+$/, `${subject} path: ${value}`);
          continue;
        }
        assert.ok(Number.isFinite(value), `${subject}.${name} is ${value}`);
      }
    }
  }
});

test('a pattern id survives being put in a selector', () => {
  // Subject names are near enough arbitrary: they carry spaces, and a cluster
  // carries a slash. Either would break `querySelector('#...')`.
  for (const subject of ['film noir', 'kite-fox-9/art', 'art', 'a b c']) {
    assert.match(patternId(subject), /^[a-zA-Z][\w-]*$/, `${subject} -> ${patternId(subject)}`);
  }
  assert.notEqual(patternId('art'), patternId('music'));
  assert.equal(patternId('art'), patternId('art'));
});
