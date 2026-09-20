import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { fromRows } from '../lib/adapt.js';
import { mountMap, viewFor } from '../embed/mount.js';
import { census, buildIndex, neighbourhood } from '../lib/regions.js';
import { distanceBetween, radialLayout } from '../lib/taxonomy.js';
import { knowledge } from '../lib/knowledge.js';

const host = () => {
  const { document } = parseHTML('<!doctype html><html><body><div id="map"></div></body></html>');
  Object.defineProperty(globalThis, 'DOMPoint', {
    value: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
      matrixTransform() {
        return this;
      }
    },
    configurable: true,
  });
  return document.getElementById('map');
};

// Rows shaped the way an application would already have them.
const users = [
  { id: 1, username: 'ana', novelty: 0.1 },
  { id: 2, username: 'bo', novelty: 90 },
  { id: 3, username: 'cy' },
];
const interests = [
  { user_id: 1, interest: 'entomology' }, { user_id: 1, interest: 'mycology' },
  { user_id: 2, interest: 'entomology' }, { user_id: 2, interest: 'poetry' },
  { user_id: 3, interest: 'theory of entomology' },
];

test('it reads the tables you already have', () => {
  // The column names are guessed, because making this work should not mean
  // renaming your schema or writing a loop against our API.
  const data = fromRows({ users, interests }, {}, { hierarchy: radialLayout(knowledge) });

  assert.deepEqual(data.people.map((p) => p.name), ['ana', 'bo', 'cy']);
  assert.deepEqual(data.subjects, ['entomology', 'mycology', 'poetry']);
  assert.deepEqual(data.people[0].subjects, ['entomology', 'mycology']);

  // A phrasing is not a different interest.
  assert.deepEqual(data.people[2].subjects, ['entomology']);
  // And the subscriptions are what census() and zones() already take.
  assert.equal(census(data.subscriptions).get('entomology'), 3);
});

test('a preference column is read however it is stored', () => {
  const data = fromRows({ users, interests });
  assert.equal(data.people[0].novelty, 0.1, 'a fraction stays a fraction');
  assert.equal(data.people[1].novelty, 0.9, 'and a percentage becomes one');
  assert.equal(data.people[2].novelty, 0.35, 'missing gets the middle, not an extreme');
});

test('columns can be named, or reached into', () => {
  const rows = [{ key: 'u1', profile: { handle: 'wren' }, tags: 'jazz, poetry' }];
  const data = fromRows({ users: rows }, { id: 'key', name: 'profile.handle', subjects: 'tags' });

  assert.equal(data.people[0].id, 'u1');
  assert.equal(data.people[0].name, 'wren');
  assert.deepEqual(data.people[0].subjects, ['jazz', 'poetry'], 'a comma-separated column works');
});

test('interests may hang off the person instead of a join table', () => {
  const data = fromRows({ users: [{ id: 7, name: 'solo', interests: ['botany', 'geology'] }] });
  assert.deepEqual(data.people[0].subjects, ['botany', 'geology']);
});

test('the novelty dial changes what is suggested', () => {
  // At zero it proposes the nearest neighbour, which is the one somebody was
  // most likely to find unaided. At one it prefers a subject reachable through
  // people but far away in the hierarchy, which is what a new community looks
  // like from the inside.
  const crowd = [
    ...Array.from({ length: 30 }, () => new Set(['entomology'])),
    ...Array.from({ length: 25 }, () => new Set(['mycology'])),
    ...Array.from({ length: 18 }, () => new Set(['poetry'])),
    ...Array.from({ length: 14 }, () => new Set(['entomology', 'mycology'])),
    ...Array.from({ length: 6 }, () => new Set(['entomology', 'poetry'])),
  ];
  const counts = census(crowd);
  const index = buildIndex(counts);
  const distance = distanceBetween(knowledge);
  const first = (novelty) =>
    neighbourhood(counts, ['entomology'], 2, index, { novelty, distance }).suggested[0];

  assert.equal(first(0), 'mycology', 'deep: the near neighbour');
  assert.equal(first(1), 'poetry', 'novel: across the map, but still bridged');
});

test('the hierarchy knows how far apart two subjects are', () => {
  const far = distanceBetween(knowledge);
  assert.equal(far('entomology', 'entomology'), 0);
  assert.ok(far('entomology', 'mycology') < far('entomology', 'poetry'), 'siblings are nearer');
  assert.ok(far('entomology', 'baking') > 0);
  assert.ok(far('entomology', 'nothing known') <= 1);
});

// --- mounting --------------------------------------------------------------

test('it draws into an element with no server anywhere', () => {
  const element = host();
  const map = mountMap(element, { users, interests, focus: '1' });

  assert.ok(element.querySelector('svg'), 'an svg should exist');
  assert.ok(element.querySelectorAll('circle').length > 0, 'and circles in it');
  assert.ok(map.view.rooms.length > 0);
  assert.deepEqual(map.view.subscription, ['entomology', 'mycology']);

  map.destroy();
  assert.equal(element.querySelector('svg'), null, 'and it cleans up after itself');
});

test('it switches between the map and the atlas', () => {
  const element = host();
  const map = mountMap(element, { users, interests, focus: '1' });
  assert.ok(element.querySelectorAll('circle').length > 0);

  map.update({ view: 'atlas' });
  assert.ok(element.querySelectorAll('path').length > 0, 'territories');
  assert.ok(map.view.zones.length > 0);
  assert.ok(map.view.report.exact);

  map.update({ view: 'map' });
  assert.ok(element.querySelectorAll('circle').length > 0);
  map.destroy();
});

test('changing the person changes the view, without re-reading the rows', () => {
  const element = host();
  const map = mountMap(element, { users, interests, focus: '1' });
  const adapted = map.data;

  map.update({ focus: '2' });
  assert.equal(map.data, adapted, 'the rows were not re-adapted');
  assert.deepEqual(map.view.subscription, ['entomology', 'poetry']);
  map.destroy();
});

test('a view can be computed without drawing at all', () => {
  // For a caller who wants the numbers and will draw them their own way.
  const data = fromRows({ users, interests });
  const view = viewFor(data, { focus: '1' });

  assert.ok(view.circles.length > 0);
  assert.ok(view.rooms.some((r) => r.member), 'their own rooms are marked');
  assert.notEqual(view.fit.faithful, undefined, 'and it still says how far to trust it');
});

test('an empty table draws nothing rather than throwing', () => {
  const element = host();
  assert.doesNotThrow(() => {
    const map = mountMap(element, { users: [], interests: [] });
    assert.deepEqual(map.view.rooms, []);
    map.destroy();
  });
});
