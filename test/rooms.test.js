import test from 'node:test';
import assert from 'node:assert/strict';
import { World, stock } from '../server/store.js';
import { MAX_ARITY, ROOM_ARITY, neighbourhood, buildIndex, census } from '../lib/regions.js';
import { groupRoom, newCluster, within } from '../lib/cluster.js';
import { watchable } from '../lib/lurk.js';

/**
 * Rooms of more than three interests, and a group on the map of somebody who
 * holds busier things outside it.
 */

const FIVE = ['film photography', 'music', 'painting', 'photography', 'visual art'];

/** A world where some hold all five, and more hold four of them. */
function fiveWorld() {
  const world = stock(new World());
  const all = [];
  for (let i = 0; i < 3; i++) {
    const u = world.addUser(`all-${i}`);
    for (const s of FIVE) world.join(u, s);
    all.push(u);
  }
  for (let i = 0; i < 4; i++) {
    const u = world.addUser(`four-${i}`);
    for (const s of FIVE.slice(0, 4)) world.join(u, s);
  }
  return { world, all };
}

test('a room may combine up to ten interests, though the census counts only three', () => {
  assert.equal(MAX_ARITY, 3, 'the census, which is cubic in what one person holds');
  assert.equal(ROOM_ARITY, 10);

  const { world, all } = fiveWorld();
  const said = world.post(all[0], FIVE, 'all five at once');
  assert.equal(said.subjects.length, 5);
  assert.equal(said.reach, 3, 'it reaches the three holding all five');

  // Counted when asked for, since the census does not keep rooms this big.
  assert.equal(world.census().get(said.room), undefined);
  assert.equal(world.populationOf(said.room), 3);
  assert.equal(world.populationOf(FIVE.slice(0, 4).join('+')), 7);
  assert.equal(world.populationOf('music+photography'), world.census().get('music+photography'), 'and read from the census where it has it');

  // Heard by exactly those, and only posted to by them.
  assert.deepEqual(world.audienceFor(FIVE).sort(), [...all].sort());
  const four = world.addUser('outsider');
  for (const s of FIVE.slice(0, 4)) world.join(four, s);
  assert.throws(() => world.post(four, FIVE, 'not in it'), /not in/);

  // More than ten is not a room.
  const eleven = Array.from({ length: 11 }, (_, i) => `made-up ${i}`);
  for (const s of eleven) world.addSubject(s);
  assert.throws(() => world.post(all[0], eleven, 'too many'), /at most 10 subjects/);
});

test('the map draws rooms of more than three, sized by everybody in them, and can be quick-joined', () => {
  const { world, all } = fiveWorld();
  const view = world.atlasFor(all[0], 5);
  const big = view.rooms.filter((r) => r.subjects.length > 3);
  assert.ok(big.length >= 1, 'a room of four or five is on the map');
  for (const room of big) assert.equal(room.population, world.populationOf(room.key));
  assert.equal(watchable(FIVE.join('+')), FIVE.join('+'), 'a code can be made for one');
  assert.equal(watchable(Array.from({ length: 11 }, (_, i) => `s${i}`).join('+')), null);
});

test("a member holding busier interests outside still sees their group, and what they joined in it", () => {
  const world = stock(new World());
  const outside = ['photography', 'visual art', 'film photography', 'music', 'painting'];
  for (let i = 0; i < 30; i++) {
    const u = world.addUser(`crowd-${i}`);
    for (const s of outside) world.join(u, s);
  }
  const me = world.addUser('me');
  for (const s of outside) world.join(me, s);
  const group = newCluster();
  world.addSubject(groupRoom(group));
  world.join(me, groupRoom(group));
  const chess = within(group, 'chess');
  world.addSubject(chess);
  world.join(me, chess);

  const view = world.atlasFor(me, 5);
  assert.ok(view.subjects.includes(groupRoom(group)), 'the group, which goes round everything in it');
  assert.ok(view.subjects.includes(chess), 'and what they joined in it');
  assert.ok(view.curves.some((c) => c.subject === groupRoom(group)), 'drawn');
  assert.equal(view.subjects.length, 5, 'the rest filled from outside, busiest first');

  // By size alone, as it was: the group, with its one member, lost to the
  // crowd outside every time.
  const counts = census([...world.members.values()]);
  const bySize = neighbourhood(counts, [...world.subscription(me)], 5, buildIndex(counts));
  assert.ok(!bySize.subjects.includes(groupRoom(group)), 'the old ranking left the group off');
});
