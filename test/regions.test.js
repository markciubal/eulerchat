import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, key, parse, subsets, receives, census, reachableRooms } from '../lib/regions.js';

test('a region has exactly one name regardless of how it is written', () => {
  assert.equal(key(['philosophy', 'art']), 'art+philosophy');
  assert.equal(key(['art', 'philosophy']), 'art+philosophy');
  assert.equal(key(['art', 'art', 'philosophy']), 'art+philosophy');
  assert.deepEqual(parse(key(['philosophy', 'art'])), ['art', 'philosophy']);
  assert.deepEqual(canonical(['b', 'a', 'b']), ['a', 'b']);
});

test('subsets enumerates every non-empty combination up to the arity cap', () => {
  assert.deepEqual(subsets(['art', 'philosophy']).map(key), [
    'art',
    'art+philosophy',
    'philosophy',
  ]);
  assert.equal(subsets(['a', 'b', 'c', 'd'], 3).length, 14); // 4 + 6 + 4
  assert.equal(subsets(['a', 'b', 'c', 'd'], 1).length, 4);
});

test('delivery is containment: tags ⊆ subscription', () => {
  const both = ['art', 'philosophy'];

  // The person in the overlap receives from every room they contain.
  assert.ok(receives(both, ['art']));
  assert.ok(receives(both, ['philosophy']));
  assert.ok(receives(both, ['art', 'philosophy']));

  // The single-subject reader gets their own circle but not the intersection,
  // because intersection content assumes a context they do not have.
  assert.ok(receives(['art'], ['art']));
  assert.ok(!receives(['art'], ['art', 'philosophy']));
  assert.ok(!receives(['art'], ['philosophy']));
});

test('nobody is structurally hidden from the overlap', () => {
  // The failure mode of strict Venn lunes: an art-only post being invisible to
  // the most engaged reader on the platform. It must not happen here.
  const artOnlyPost = ['art'];
  assert.ok(receives(['art', 'philosophy'], artOnlyPost));
});

test('census counts containment, and never names an empty region', () => {
  const counts = census([
    ['art'],
    ['art', 'philosophy'],
    ['philosophy'],
    ['art', 'philosophy', 'music'],
  ]);

  assert.equal(counts.get('art'), 3);
  assert.equal(counts.get('philosophy'), 3);
  assert.equal(counts.get('music'), 1);
  assert.equal(counts.get('art+philosophy'), 2);
  assert.equal(counts.get('art+music'), 1);
  assert.equal(counts.get('music+philosophy'), 1);
  assert.equal(counts.get('art+music+philosophy'), 1);

  // The Euler property: a region nobody occupies has no entry at all. There is
  // no zero to filter out and no room to walk into.
  assert.equal(counts.size, 7);
});

test('an unoccupied intersection is simply absent', () => {
  const counts = census([['art'], ['philosophy']]);
  assert.equal(counts.size, 2);
  assert.equal(counts.get('art+philosophy'), undefined);
  assert.ok(!counts.has('art+philosophy'));
});

test('a subscriber reaches 2^n - 1 rooms', () => {
  assert.equal(reachableRooms(['art']).length, 1);
  assert.equal(reachableRooms(['art', 'philosophy']).length, 3);
  assert.equal(reachableRooms(['art', 'philosophy', 'music']).length, 7);
});

test('arity is capped where circles give out', () => {
  const counts = census([['a', 'b', 'c', 'd']]);
  for (const k of counts.keys()) {
    assert.ok(parse(k).length <= 3, `${k} exceeds the drawable arity`);
  }
});
