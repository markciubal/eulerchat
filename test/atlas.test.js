import test from 'node:test';
import assert from 'node:assert/strict';
import { atlas } from '../lib/atlas.js';
import { zones } from '../lib/regions.js';
import { zoneAt } from '../public/atlasview.js';

const people = (n, subjects) => Array.from({ length: n }, () => new Set(subjects));

test('the atlas draws exactly the rooms that exist', () => {
  // The case that defeats circles: every pair meets, nobody holds all three.
  // Circles at these sizes must share a common patch, so they show a room that
  // is not there. Routed boundaries simply do not draw one.
  const view = atlas(
    zones(
      [
        ...people(12, ['art']), ...people(12, ['philosophy']), ...people(12, ['music']),
        ...people(6, ['art', 'philosophy']),
        ...people(6, ['art', 'music']),
        ...people(6, ['music', 'philosophy']),
      ],
      ['art', 'philosophy', 'music'],
    ),
  );

  assert.deepEqual(
    view.zones.map((z) => z.key).sort(),
    ['art', 'art+music', 'art+philosophy', 'music', 'music+philosophy', 'philosophy'],
  );
  assert.ok(!view.zones.some((z) => z.subjects.length === 3), 'no three-way room should appear');

  assert.equal(view.report.phantoms, 0);
  assert.equal(view.report.vanished, 0);
  assert.ok(view.report.exact);
  assert.ok(view.report.wellFormed, 'three subjects should draw in one piece each');
});

test('ground is proportional to population', () => {
  const view = atlas(
    zones(
      [...people(40, ['a']), ...people(20, ['b']), ...people(10, ['a', 'b'])],
      ['a', 'b'],
    ),
  );
  assert.ok(view.report.worstError < 0.05, `worst area error ${view.report.worstError}`);
});

test('a zone of any arity can be drawn', () => {
  // Four sets cannot be drawn as a Venn diagram with circles at all, and five
  // is past what ellipses manage. A routed boundary has no such ceiling.
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];
  const view = atlas(
    zones(
      [
        ...people(8, ['a']), ...people(8, ['b']), ...people(8, ['c']),
        ...people(8, ['d']), ...people(8, ['e']), ...people(8, ['f']),
        ...people(4, ['a', 'b']), ...people(4, ['c', 'd']), ...people(4, ['e', 'f']),
        ...people(3, six),
      ],
      six,
    ),
  );

  const deepest = view.zones.find((z) => z.subjects.length === 6);
  assert.ok(deepest, 'the six-subject zone should be drawn');
  assert.equal(deepest.population, 3);
  assert.equal(view.report.phantoms, 0);
  assert.equal(view.report.vanished, 0);
});

test('every room can be reached by clicking, and no click lands in a void', () => {
  // The circle map draws 22% of its three-way rooms too small to click. Here
  // a room is given ground before anything is drawn, so it always has some.
  const subjects = ['art', 'philosophy', 'music'];
  const view = atlas(
    zones(
      [
        ...people(10, ['art']), ...people(10, ['philosophy']), ...people(10, ['music']),
        ...people(5, ['art', 'philosophy']), ...people(5, ['art', 'music']),
        ...people(2, subjects),
      ],
      subjects,
    ),
  );

  const known = new Set(view.zones.map((z) => z.key));
  const reached = new Set();
  const step = view.extent / 120;

  for (let x = -view.extent / 2; x < view.extent / 2; x += step) {
    for (let y = -view.extent / 2; y < view.extent / 2; y += step) {
      const at = zoneAt(view.curves, x, y);
      if (!at) continue;
      assert.ok(known.has(at), `a point resolved to ${at}, which is not a room`);
      reached.add(at);
    }
  }

  for (const zone of view.zones) {
    assert.ok(reached.has(zone.key), `${zone.key} has no ground to click`);
  }
});

test('a subject in several patches is reported, never glossed over', () => {
  const subjects = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const crowd = [];
  for (let i = 0; i < subjects.length; i++) {
    crowd.push(...people(6, [subjects[i]]));
    for (let j = i + 1; j < subjects.length; j++) {
      crowd.push(...people(2, [subjects[i], subjects[j]]));
    }
  }

  const view = atlas(zones(crowd, subjects));

  // Areas stay right at this size; connectedness is what gives way, so the
  // report has to carry it rather than claim a clean diagram.
  assert.ok(view.report.worstError < 0.1, `areas drifted: ${view.report.worstError}`);
  assert.equal(view.report.exact, true);
  assert.equal(
    view.report.wellFormed,
    view.report.disconnected.length === 0,
    'wellFormed must agree with the list it summarises',
  );
  assert.ok(view.report.worstSplit >= 1);
});

test('the same population grows the same atlas', () => {
  const crowd = [
    ...people(9, ['art']), ...people(6, ['philosophy']),
    ...people(4, ['art', 'philosophy']), ...people(3, ['music', 'art']),
  ];
  const a = atlas(zones(crowd, ['art', 'philosophy', 'music']));
  const b = atlas(zones(crowd, ['art', 'philosophy', 'music']));

  assert.deepEqual(a.zones, b.zones);
  assert.deepEqual(a.curves, b.curves);
});

test('an empty world draws nothing rather than throwing', () => {
  const view = atlas(zones([], ['art']));
  assert.deepEqual(view.zones, []);
  assert.deepEqual(view.curves, []);
  assert.ok(view.report.exact);
  assert.equal(zoneAt(view.curves, 0, 0), null);
});

test('zones count exact membership, not containment', () => {
  // The census counts by containment; the atlas needs the partition instead.
  const counts = zones(
    [new Set(['art']), new Set(['art', 'philosophy']), new Set(['philosophy'])],
    ['art', 'philosophy'],
  );
  assert.equal(counts.get('art'), 1, 'art alone, not art-and-philosophy too');
  assert.equal(counts.get('philosophy'), 1);
  assert.equal(counts.get('art+philosophy'), 1);

  // Subjects outside the view are ignored rather than forming zones.
  const narrowed = zones([new Set(['art', 'music'])], ['art']);
  assert.equal(narrowed.get('art'), 1);
  assert.equal(narrowed.size, 1);
});
