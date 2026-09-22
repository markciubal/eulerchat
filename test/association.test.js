import test from 'node:test';
import assert from 'node:assert/strict';
import { associations } from '../lib/association.js';
import { census } from '../lib/regions.js';
import { World } from '../server/store.js';
import { populate } from '../server/populate.js';

/** A census of people, each a list of what they hold. */
const of = (...people) => census(people.map((p) => new Set(p)));
const times = (n, held) => Array.from({ length: n }, () => held);

test('a link is two interests people hold together, and how many do', () => {
  const links = associations(of(['chess', 'go'], ['chess', 'go'], ['chess'], ['go', 'shogi']));
  assert.deepEqual(
    links.map(([a, b, both]) => [a, b, both]),
    [['chess', 'go', 2]],
    'go and shogi are held together by one person, which is not a link',
  );
});

test('one person is never a link, however few there are', () => {
  const links = associations(of(['rare', 'rarer'], ['rare'], ['rarer']));
  assert.deepEqual(links, []);
});

test('a strong pair of dozens outranks a pair two people happen to share', () => {
  const links = associations(
    of(
      ...times(27, ['organic chemistry', 'inorganic chemistry']),
      ...times(40, ['organic chemistry']),
      ...times(4, ['inorganic chemistry']),
      ['java', 'spreadsheets'],
      ['java', 'spreadsheets'],
      ['java'],
      ['spreadsheets'],
    ),
  );
  assert.deepEqual(links[0].slice(0, 2), ['inorganic chemistry', 'organic chemistry']);
  assert.ok(links[0][3] > links[1][3], 'and says so in the share');
});

test('every interest keeps its own strongest, and the cap is only on the rest', () => {
  // A crowd holding four interests between them makes six strong pairs; one
  // small pair is weak beside them. By strength alone the crowd would take
  // every place, but the small pair is those two interests' only link.
  const crowd = times(30, ['a', 'b', 'c', 'd']);
  const held = of(...crowd, ['x', 'y'], ['x', 'y'], ['x'], ['y']);
  const links = associations(held, { each: 1, most: 3 });
  assert.ok(links.some(([a, b]) => a === 'x' && b === 'y'), 'x and y keep the one link they have');
  // Each of the six keeps one; a cap of three does not cut them to fit.
  const linked = new Set(links.flatMap(([a, b]) => [a, b]));
  assert.deepEqual([...linked].sort(), ['a', 'b', 'c', 'd', 'x', 'y']);
  assert.equal(links.at(-1).slice(0, 2).join('+'), 'x+y', 'still strongest first');

  // With room to spare, the rest of the crowd's pairs fill it.
  assert.equal(associations(held, { each: 1, most: 10 }).length, 7);
});

test('only the open world is linked, and a busy world is capped', () => {
  const world = populate(new World(), { subjects: 300, users: 900, chatter: 0 });
  world.addSubject('kite-fox-9/chess');
  world.addSubject('kite-fox-9/go');
  for (let i = 0; i < 3; i += 1) {
    const someone = world.addUser(`g${i}`);
    world.join(someone, 'kite-fox-9/chess');
    world.join(someone, 'kite-fox-9/go');
  }

  const { links, subjects } = world.chart();
  assert.ok(links.length > 100, `${links.length} links`);
  assert.ok(links.length <= Math.max(1500, 2 * subjects.length), 'two each at most, past the cap');
  assert.ok(!links.some(([a, b]) => a.includes('/') || b.includes('/')), 'a group is its own business');
  const on = new Set(subjects.map((s) => s.id));
  for (const [a, b, both, share] of links) {
    assert.ok(on.has(a) && on.has(b), `${a} and ${b} are both on the sheet`);
    assert.ok(both >= 2 && share > 0 && share < 1);
  }
  // Strongest first.
  for (let i = 1; i < links.length; i += 1) assert.ok(links[i - 1][3] >= links[i][3]);
});
