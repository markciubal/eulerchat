import test from 'node:test';
import assert from 'node:assert/strict';
import { blend, coherence, hue, regionFill, stroke } from '../lib/palette.js';
import { knowledge } from '../lib/knowledge.js';

/**
 * What a subject's colour has to be, and what it has to stay.
 *
 * Nothing asserted anything about colour before this, which is how a palette
 * that was unreadable at half its hues on one theme and invisible at a third
 * of them on the other went unnoticed. All three claims below are properties
 * of every subject, not of the handful anybody happened to look at.
 */

/** Every name in the bundled hierarchy, which is the real catalogue. */
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

const channel = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/, `${hex} is not a plain hex colour`);
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const PANEL_LIGHT = '#ffffff';
const PANEL_DARK = '#1f2023';

test('a subject keeps its colour, and its hue is the one it always had', () => {
  // Determinism is the whole reason the map is a place rather than a picture.
  // Anything that made colour depend on what else is on screen would break
  // this, which is why it is a test and not a comment.
  for (const subject of catalogue.slice(0, 40)) {
    assert.equal(stroke(subject), stroke(subject));
  }

  // Pinned outright, so that a change to the hash is a decision somebody makes
  // on purpose rather than something that happens.
  assert.equal(hue('art'), 306);
  assert.equal(hue('philosophy'), 122);
  assert.equal(hue('music'), 340);
  assert.equal(stroke('art'), '#855bad');
});

test('every subject in the catalogue is visible on both themes', () => {
  // A single fixed HSL lightness cannot manage this: it is not a fixed
  // brightness, and it swung by a factor of seven around the hue wheel.
  const failures = [];
  for (const subject of catalogue) {
    const colour = stroke(subject);
    const light = contrast(colour, PANEL_LIGHT);
    const dark = contrast(colour, PANEL_DARK);
    if (light < 3 || dark < 3) {
      failures.push(`${subject} ${colour}: ${light.toFixed(2)}:1 light, ${dark.toFixed(2)}:1 dark`);
    }
  }
  assert.deepEqual(failures, [], `${failures.length} of ${catalogue.length} subjects are hard to see`);
});

test('a room of opposite subjects is neutral rather than a third colour', () => {
  // The circular mean of two opposite hues is whatever the rounding left
  // behind: art and philosophy sit nearly opposite, and their "average" used
  // to be an orange that neither of them is - and that a genuinely orange
  // third subject in the same view would also have worn.
  assert.ok(coherence(['art', 'philosophy']) < 0.1, 'these two should disagree');
  const muddle = regionFill(['art', 'philosophy']);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(muddle.slice(i, i + 2), 16));
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 24, `${muddle} is too colourful to be honest`);

  // Where they do agree, the room is coloured, and it sits between them.
  assert.ok(coherence(['art', 'music']) > 0.9, 'these two should agree');
  const together = regionFill(['art', 'music']);
  const spread = [1, 3, 5].map((i) => parseInt(together.slice(i, i + 2), 16));
  assert.ok(Math.max(...spread) - Math.min(...spread) > 24, `${together} should carry their colour`);
  const between = blend(['art', 'music']);
  assert.ok(between > 306 && between < 340, `${between} should lie between the two hues`);
});

test('a deeper room is a darker room', () => {
  // A more specific place should read as one, whatever its hue.
  const one = luminance(regionFill(['art']));
  const two = luminance(regionFill(['art', 'music']));
  const three = luminance(regionFill(['art', 'music', 'philosophy']));
  assert.ok(one > two, 'two subjects should be darker than one');
  assert.ok(two > three, 'three should be darker than two');
});
