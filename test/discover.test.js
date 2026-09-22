import test from 'node:test';
import assert from 'node:assert/strict';
import { World, seed, stock } from '../server/store.js';
import { populate } from '../server/populate.js';
import { parse } from '../lib/regions.js';

/** A world where the same few people hold the same few things. */
const build = (groups) => {
  const world = new World();
  for (const [count, subjects] of groups) {
    for (const s of subjects) world.addSubject(s);
    for (let i = 0; i < count; i++) {
      const userId = world.addUser(`p${world.members.size}`);
      for (const s of subjects) world.join(userId, s);
    }
  }
  return world;
};

const big = () => populate(new World(), { subjects: 1000, users: 4000, chatter: 0 });

test('nothing already held is ever offered', () => {
  const world = big();

  for (const userId of [...world.members.keys()].filter((_, i) => i % 97 === 0)) {
    const held = world.subscription(userId);
    for (const found of world.discoveries(userId)) {
      assert.ok(!held.has(found.subject), `offered ${found.subject}, which they hold`);
    }
  }
});

test('the evidence is a room that exists, one subject away', () => {
  // The claim being made is not "people like you liked this" but "there are
  // this many people in that room and you are one subject short of it". So
  // every room named has to be an occupied region of the census, counted
  // correctly, and everything in it besides the offered subject has to be
  // something this person already holds.
  const world = big();
  const counts = world.census();

  for (const userId of [...world.members.keys()].filter((_, i) => i % 211 === 0)) {
    const held = world.subscription(userId);
    for (const found of world.discoveries(userId)) {
      assert.ok(found.rooms.length > 0, `${found.subject} was offered with no evidence`);
      assert.ok(found.opens >= found.rooms.length);

      for (const room of found.rooms) {
        assert.equal(room.population, counts.get(room.key), `${room.key} is not a room`);
        const subjects = parse(room.key);
        assert.ok(subjects.includes(found.subject), `${room.key} does not contain it`);
        for (const s of subjects) {
          if (s !== found.subject) assert.ok(held.has(s), `${room.key} needs ${s} too`);
        }
      }
    }
  }
});

test('a small specific room beats a big vague one', () => {
  // Two people who both hold `art` have not met. Two who both hold
  // `entomology` are nearly the same person, and a room of three of them is
  // worth more than a room of thirty who all like art — which is the whole
  // difference between this and the popularity list beside it.
  //
  // Sized so that the two genuinely contest it: fifty people in the vague
  // room against three in the specific one, which is far enough apart that a
  // ranking letting population keep counting past a roomful would pick the
  // other one.
  const world = build([
    [5, ['art']],
    [50, ['art', 'photography']],
    [3, ['entomology', 'mycology']],
    [1, ['entomology']],
    [336, ['carpentry']],
  ]);
  const me = world.addUser('wren');
  world.join(me, 'art');
  world.join(me, 'entomology');

  const found = world.discoveries(me);
  const named = found.map((f) => f.subject);
  assert.ok(named.includes('mycology') && named.includes('photography'), named.join(', '));
  assert.equal(found[0].subject, 'mycology', `ranked ${named.join(' > ')}`);

  // And it wins while being the smaller room by an order of magnitude, which
  // is the part a ranking by size could not produce.
  const specific = found.find((f) => f.subject === 'mycology');
  const vague = found.find((f) => f.subject === 'photography');
  assert.equal(specific.rooms[0].key, 'entomology+mycology');
  assert.equal(specific.rooms[0].population, 3);
  assert.equal(vague.rooms[0].key, 'art+photography');
  assert.equal(vague.rooms[0].population, 50);
  assert.ok(specific.score > vague.score);
});

test('a room of three is worth more than a room of one', () => {
  // Population is a floor under the ranking rather than the ranking: a room
  // needs somebody in it, and the second person is worth far more than the
  // fortieth.
  const world = build([
    [3, ['entomology', 'mycology']],
    [1, ['entomology', 'ornithology']],
    [40, ['painting']],
  ]);
  const me = world.addUser('wren');
  world.join(me, 'entomology');

  const found = world.discoveries(me);
  assert.equal(found[0].subject, 'mycology', found.map((f) => f.subject).join(' > '));
  assert.ok(found.some((f) => f.subject === 'ornithology'), 'a room of one is still a room');
});

test('a triple counts as its own room, on top of the pairs', () => {
  // Joining one subject can open more than one room, and the rooms are not
  // nested versions of each other: `a+b+c` is a different place from `a+c`.
  const world = build([
    [4, ['entomology', 'mycology', 'botany']],
    [2, ['entomology', 'botany']],
  ]);
  const me = world.addUser('wren');
  world.join(me, 'entomology');
  world.join(me, 'mycology');

  const [found] = world.discoveries(me);
  assert.equal(found.subject, 'botany');
  assert.equal(found.opens, 3);
  const keys = found.rooms.map((r) => r.key);
  assert.ok(keys.includes('botany+entomology+mycology'), keys.join(', '));
  assert.equal(found.rooms.find((r) => r.key === 'botany+entomology+mycology').population, 4);
});

test('somebody holding nothing gets somewhere to start, not an empty list', () => {
  const world = big();
  const newcomer = world.addUser('newcomer');

  const found = world.discoveries(newcomer);
  assert.ok(found.length > 0, 'a newcomer was offered nothing at all');

  // There are no overlaps to be one step from, so the room that opens is the
  // subject itself and it says so rather than inventing evidence.
  for (const entry of found) {
    assert.equal(entry.rooms.length, 1);
    assert.equal(entry.rooms[0].key, entry.subject);
    assert.equal(entry.rooms[0].population, entry.population);
  }

  // And it is not the busiest-rooms list wearing a different hat. Rarity pulls
  // against size, so what comes out is the middle.
  const { popular } = world.index();
  const offered = new Set(found.map((f) => f.subject));
  assert.ok(!offered.has(popular[0]), `offered the biggest subject, ${popular[0]}`);
  for (const entry of found) {
    assert.ok(entry.population > 1, 'a room of one is not somewhere to start');
  }
});

test('a world with nobody in it answers, rather than throwing', () => {
  const world = new World();
  assert.deepEqual(world.discoveries('nobody at all'), []);

  world.addSubject('art');
  assert.deepEqual(world.discoveries(world.addUser('first')), [], 'a subject nobody holds is no room');
});

test('the same world gives the same answer, every time', () => {
  const world = big();
  const ids = [...world.members.keys()].filter((_, i) => i % 401 === 0);

  const once = ids.map((id) => JSON.stringify(world.discoveries(id)));
  const twice = ids.map((id) => JSON.stringify(world.discoveries(id)));
  assert.deepEqual(twice, once);

  // Not merely stable within one process: the same population built again
  // answers the same, so nothing here depends on the order people arrived or
  // on an id handed out at random.
  const again = populate(new World(), { subjects: 1000, users: 4000, chatter: 0 });
  const thrice = [...again.members.keys()].filter((_, i) => i % 401 === 0)
    .map((id) => JSON.stringify(again.discoveries(id)));
  assert.deepEqual(thrice, once);
});

test('ties are broken by name', () => {
  // Two subjects with identical evidence are genuinely equally good, and the
  // alphabet settles them so that the answer does not depend on which Set
  // happened to be walked first.
  const world = build([
    [3, ['entomology', 'mycology']],
    [3, ['entomology', 'lichenology']],
    [3, ['entomology', 'ornithology']],
  ]);
  const me = world.addUser('wren');
  world.join(me, 'entomology');

  const found = world.discoveries(me);
  assert.deepEqual(found.map((f) => f.subject), ['lichenology', 'mycology', 'ornithology']);
  assert.equal(new Set(found.map((f) => f.score)).size, 1, 'these are the same offer three times');
});

test('the novelty dial reaches further out without leaving the map', () => {
  // The same sense the dial has in `neighbourhood`: 0 takes the strongest
  // overlap, 1 takes something reached through people but a long way off in
  // the hierarchy. Poetry is not near entomology and never will be; somebody
  // standing in both is the only reason it is on offer at all.
  const world = build([
    [6, ['entomology', 'mycology']],
    [2, ['entomology', 'poetry']],
    [2, ['entomology']],
    [18, ['poetry']],
    [70, ['carpentry']],
  ]);
  const me = world.addUser('wren');
  world.join(me, 'entomology');

  const first = (novelty) => world.discoveries(me, { novelty }).map((f) => f.subject);
  assert.equal(first(0)[0], 'mycology', 'the same field, and the strongest overlap');
  assert.equal(first(1)[0], 'poetry', 'a different division, but bridged');

  // The dial moves the order, not the offer: both are still on it either way.
  assert.ok(first(0).includes('poetry') && first(1).includes('mycology'));
});

test('it rides in the rail without disturbing what is already there', () => {
  const world = seed(new World());
  const me = world.addUser('wren');
  world.join(me, 'art');

  const { rail } = world.stateFor(me);
  assert.deepEqual(rail.held, ['art']);
  assert.deepEqual([...rail.suggested].sort(), ['music', 'philosophy']);
  // The whole stocked catalogue, and `art`, which is the demo's own word
  // rather than the hierarchy's.
  assert.equal(rail.total, stock(new World()).subjects.size + 1);
  assert.ok(Array.isArray(rail.popular));

  assert.ok(Array.isArray(rail.discoveries));
  assert.equal(rail.discoveries[0].subject, 'philosophy');
  assert.equal(rail.discoveries[0].rooms[0].key, 'art+philosophy');
  assert.equal(rail.discoveries[0].rooms[0].population, 5);

  // Small enough to send on every membership change, and made only of things
  // JSON has: no Sets, no Maps, no undefined, nothing that survives a round
  // trip as something else.
  const wire = JSON.stringify(rail.discoveries);
  assert.deepEqual(JSON.parse(wire), rail.discoveries);
  assert.ok(wire.length < 2000, `${wire.length} bytes of rail`);

  assert.deepEqual(world.diagramFor(me).rail.discoveries, rail.discoveries);
});

test('a discovery costs less than the picture beside it', () => {
  // Measured against something already paid for on every membership change
  // rather than against a stopwatch, because an absolute threshold here fails
  // under load while passing alone — and the claim was always a ratio. Both
  // walk a neighbourhood instead of the world, so neither should grow with the
  // catalogue and this should stay well under one.
  const world = big();
  const sample = [...world.members.keys()].filter((_, i) => i % 13 === 0).slice(0, 150);

  const cost = (fn) => {
    for (const userId of sample) fn(userId); // warm the census, the index, the layouts
    const runs = sample.map((userId) => {
      const at = performance.now();
      fn(userId);
      return performance.now() - at;
    });
    // The middle rather than the mean: one garbage collection should not be
    // the thing that decides whether this passes.
    return runs.sort((a, b) => a - b)[runs.length >> 1];
  };

  const picture = cost((userId) => world.diagramFor(userId));
  const discovery = cost((userId) => world.discoveries(userId));
  const ratio = discovery / Math.max(picture, 0.01);
  assert.ok(ratio < 2, `a discovery costs ${ratio.toFixed(1)}x what drawing the diagram does`);
});

test('holding a subject nobody else holds is not a crash', () => {
  const world = seed(new World());
  const me = world.addUser('hermit');
  world.join(me, world.addSubject('lepidoptery'));

  // Nothing overlaps them at all, so there is no room one step away — but
  // there is still a world out there, and the answer says so.
  const found = world.discoveries(me);
  assert.ok(found.length > 0);
  assert.ok(!found.some((f) => f.subject === 'lepidoptery'));
});
