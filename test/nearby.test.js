import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFERED, livelyNearby } from '../public/nearby.js';

const now = 1_700_000_000_000;

/** A room as the map has them. Busy and spoken in, unless said otherwise. */
const room = (over = {}) => ({
  key: 'art',
  subjects: ['art'],
  population: 12,
  member: false,
  messages: 4,
  activity: 0.5,
  stats: { messages: 4, perMinute: 0.4, last: { at: now - 60_000 } },
  ...over,
});

test('what is offered is lively and beside what you hold', () => {
  const found = livelyNearby({
    now,
    held: ['art'],
    rooms: [
      room({ key: 'art', subjects: ['art'], activity: 0.3 }),
      room({ key: 'art+philosophy', subjects: ['art', 'philosophy'], activity: 0.9 }),
      // Nowhere near what they hold.
      room({ key: 'karate', subjects: ['karate'], activity: 1 }),
    ],
  });
  assert.deepEqual(found.map((one) => one.key), ['art+philosophy', 'art'], 'the livelier first');
  assert.equal(found[0].why, 'next to art');
});

test('a chat one community along is offered, and said to be a hop away', () => {
  const found = livelyNearby({
    now,
    held: ['guitar'],
    // Everything in the community guitar is in.
    alongside: ['guitar', 'piano', 'drums'],
    rooms: [
      room({ key: 'piano', subjects: ['piano'], activity: 0.4 }),
      room({ key: 'quantum computing', subjects: ['quantum computing'], activity: 0.95 }),
    ],
  });
  assert.deepEqual(found.map((one) => one.key), ['piano']);
  assert.match(found[0].why, /one along/);
});

test('busy is about being spoken in, not about being big', () => {
  const found = livelyNearby({
    now,
    held: ['art'],
    rooms: [
      // Nine hundred people and nothing said since this morning.
      room({ key: 'art', population: 900, activity: 0, stats: { messages: 80, perMinute: 0, last: { at: now - 6 * 60 * 60 * 1000 } } }),
      // Four people, talking just now.
      room({ key: 'art+poetry', subjects: ['art', 'poetry'], population: 4, activity: 0.02, stats: { messages: 3, perMinute: 1, last: { at: now - 30_000 } } }),
    ],
  });
  assert.deepEqual(found.map((one) => one.key), ['art+poetry'], 'the one where something is happening');
});

test('a chat of one, or one nothing was ever said in, is not something happening', () => {
  const found = livelyNearby({
    now,
    held: ['art'],
    rooms: [
      room({ key: 'art+solo', subjects: ['art', 'solo'], population: 1 }),
      room({ key: 'art+silent', subjects: ['art', 'silent'], messages: 0, stats: { messages: 0, perMinute: 0, last: null }, activity: 0.9 }),
    ],
  });
  assert.deepEqual(found, []);
});

test('your own busy chats are offered too, and say so', () => {
  const found = livelyNearby({
    now,
    held: ['art'],
    rooms: [room({ key: 'art', member: true, activity: 0.6 })],
  });
  assert.equal(found[0].why, 'yours, and busy');
  assert.equal(found[0].member, true);
});

test('three at most, however much is going on', () => {
  const rooms = Array.from({ length: 9 }, (_, i) =>
    room({ key: `art+${i}`, subjects: ['art', `other ${i}`], activity: (i + 1) / 10 }),
  );
  const found = livelyNearby({ now, held: ['art'], rooms });
  assert.equal(found.length, OFFERED);
  assert.deepEqual(found.map((one) => one.key), ['art+8', 'art+7', 'art+6'], 'the liveliest of them');
});

test('nothing at all where nothing is near, or nothing is happening', () => {
  assert.deepEqual(livelyNearby(), []);
  assert.deepEqual(livelyNearby({ rooms: [room()], held: [] }), [], 'holding nothing is near nothing');
});
