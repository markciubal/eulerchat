import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderAtlas, relabel } from '../public/atlasview.js';
import { fitTo } from '../public/minimap.js';
import { atlas } from '../lib/atlas.js';
import { zones } from '../lib/regions.js';
import { anchorsFor, radialLayout } from '../lib/taxonomy.js';
import { knowledge } from '../lib/knowledge.js';

const NS = 'http://www.w3.org/2000/svg';
const people = (n, s) => Array.from({ length: n }, () => new Set(s));

function drawn() {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const svg = document.createElementNS(NS, 'svg');
  svg.getBoundingClientRect = () => ({ width: 600, height: 600, left: 0, top: 0 });
  document.body.append(svg);

  const subjects = ['entomology', 'mycology', 'topology'];
  const view = atlas(
    zones(
      [
        ...people(20, ['entomology']), ...people(16, ['mycology']), ...people(12, ['topology']),
        ...people(8, ['entomology', 'mycology']), ...people(3, ['mycology', 'topology']),
      ],
      subjects,
    ),
    { anchors: anchorsFor(subjects, radialLayout(knowledge)) },
  );
  return { svg, view, ...renderAtlas(svg, { ...view, subscription: [] }) };
}

test('the layout says how much room a label has', () => {
  // The distance transform that decides where a label goes already knows how
  // big the space is; it used to throw the number away.
  const { view } = drawn();
  for (const zone of view.zones) {
    assert.ok(Number.isFinite(zone.room), `${zone.key} has no room`);
    assert.ok(zone.room > 0);
  }
  // A zone holding three people has less room than one holding twenty.
  const small = view.zones.find((z) => z.key === 'mycology+topology');
  const large = view.zones.find((z) => z.key === 'mycology');
  assert.ok(small.room < large.room);
});

test('a label spells itself out once there is room, and not before', () => {
  const { written } = drawn();
  const overlap = written.find((w) => w.short.includes('+'));
  assert.ok(overlap, 'expected an abbreviated overlap label');

  // Squeezed: the short form is all that fits.
  relabel(written, 0.15);
  assert.equal(overlap.text.textContent, overlap.short);

  // Zoomed in far enough and the real name is what should be there — which is
  // the whole reason the short form existed.
  relabel(written, 8);
  assert.equal(overlap.text.textContent, overlap.long);
  assert.match(overlap.long, / \+ /);
});

test('text holds its size on screen as the map grows under it', () => {
  // Without this the label scales with the map and never fits any better, so
  // zooming in would never reveal anything.
  const { written } = drawn();
  const sizeAt = (scale) => {
    relabel(written, scale);
    return Number(written[0].text.getAttribute('font-size'));
  };

  const close = sizeAt(8);
  const far = sizeAt(0.5);
  assert.ok(close < far, `${close} should be smaller in map units than ${far}`);
  // Within the two decimal places the attribute is written to: at a scale of
  // eight, a rounding of 0.005 in map units is 0.04 on screen.
  assert.ok(Math.abs(close * 8 - far * 0.5) < 0.1, 'the same size on screen either way');
});

test('every label is rewritten, subjects included', () => {
  const { written } = drawn();
  assert.ok(written.length >= 5, `${written.length} labels`);
  relabel(written, 3);
  for (const label of written) {
    assert.ok(label.text.textContent.length > 0);
    assert.ok(Number(label.text.getAttribute('font-size')) > 0);
  }
});

test('fitting gives back the frame it chose, for zoom to start from', () => {
  const { svg, view } = drawn();
  const box = fitTo(svg, view.curves.flatMap((c) => c.loops.flat()), 20);

  assert.ok(box && box.width > 0 && box.height > 0);
  assert.deepEqual(
    svg.getAttribute('viewBox').split(' ').map(Number).slice(2),
    [box.width, box.height],
  );
});
