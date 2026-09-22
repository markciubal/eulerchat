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

/** How far apart a colour's channels are: roughly, how colourful it is. */
const spread = (hex) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(...v) - Math.min(...v);
};

test('a room whose subjects disagree does not state a confident colour', () => {
  // The circular mean of two opposite hues is whatever the rounding left
  // behind: art and philosophy sit nearly opposite, and their "average" is an
  // orange that neither of them is — one a genuinely orange third subject in
  // the same view would also have worn. The rooms are vivid by design, so the
  // guard is not that this one comes out grey but that it comes out visibly
  // less sure of itself than a room whose subjects agree.
  assert.ok(coherence(['art', 'philosophy']) < 0.1, 'these two should disagree');
  assert.ok(coherence(['art', 'music']) > 0.9, 'these two should agree');

  const unsure = spread(regionFill(['art', 'philosophy']));
  const sure = spread(regionFill(['art', 'music']));
  assert.ok(
    unsure < sure * 0.6,
    `a room of opposite subjects (${unsure}) should be far less colourful than one of neighbours (${sure})`,
  );

  // And where they do agree, the room sits between them on the wheel.
  const between = blend(['art', 'music']);
  assert.ok(between > 306 && between < 340, `${between} should lie between the two hues`);
});

test('rooms are vivid, and every one of them at the same strength', () => {
  // High saturation is the point of the fills; equal brightness is what keeps
  // a yellow room from washing out on the light theme and a blue one from
  // disappearing on the dark one.
  for (const room of [['art'], ['music'], ['philosophy'], ['art', 'music']]) {
    assert.ok(spread(regionFill(room)) > 120, `${room.join('+')} should be vivid`);
  }

  // At one depth, because depth is the other thing lightness carries: a
  // deeper room is meant to sit darker, and the test below says so.
  const lit = [['art'], ['music'], ['philosophy']].map((r) => luminance(regionFill(r)));
  const drift = Math.max(...lit) - Math.min(...lit);
  assert.ok(drift < 0.02, `three hues at one depth should match, spread ${drift.toFixed(3)}`);
});

test('a deeper room is a darker room', () => {
  // A more specific place should read as one, whatever its hue.
  const one = luminance(regionFill(['art']));
  const two = luminance(regionFill(['art', 'music']));
  const three = luminance(regionFill(['art', 'music', 'philosophy']));
  assert.ok(one > two, 'two subjects should be darker than one');
  assert.ok(two > three, 'three should be darker than two');
});
