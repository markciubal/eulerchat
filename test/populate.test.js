import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/store.js';
import { populate } from '../server/populate.js';

const big = (options = {}) =>
  populate(new World(), { subjects: 1000, users: 2000, chatter: 50, ...options });

test('a thousand interests builds, and most regions stay unoccupied', () => {
  const world = big();
  assert.equal(world.subjects.size, 1000);

  const counts = world.census();
  const arity = [0, 0, 0, 0];
  for (const k of counts.keys()) arity[k.split('+').length]++;

  // An interest nobody holds is in the catalogue but not in the census, so it
  // is never drawn and never offered — the same rule that keeps unoccupied
  // intersections from existing, applied to a circle rather than a lens.
  assert.ok(arity[1] <= 1000);
  assert.ok(arity[1] > 900, `${arity[1]} interests have anyone in them`);
  assert.ok(arity[2] > 1000, `expected real pair density, got ${arity[2]}`);

  // A Venn build would carry 1000 + 499,500 pairs + ~166 million triples.
  // Deriving regions from membership keeps the world to the tiny occupied
  // fraction of that, which is the entire reason this scales at all.
  const venn = 1000 + (1000 * 999) / 2;
  assert.ok(counts.size < venn, `${counts.size} occupied vs ${venn} pairs alone in a Venn build`);
});

test('at a thousand interests people still land in overlaps', () => {
  // The failure this guards against is not slowness, it is emptiness: scatter
  // people thinly enough across enough interests and every circle is drawn
  // disjoint, so the overlap rooms — the whole product — are never populated.
  const world = big();
  const userIds = [...world.members.keys()];
  const sample = userIds.filter((_, i) => i % 40 === 0);

  let withOverlap = 0;
  for (const userId of sample) {
    const view = world.diagramFor(userId);
    assert.ok(view.circles.length <= 3, 'nobody is shown an undrawable diagram');
    if (view.rooms.some((r) => r.subjects.length > 1)) withOverlap++;
  }

  const share = withOverlap / sample.length;
  assert.ok(share > 0.9, `only ${(share * 100).toFixed(0)}% of people can see an overlap`);
});

test('a view costs about the same at a thousand interests as at three', () => {
  // The neighbourhood projection means the solver never sees more than three
  // circles, so the cost of a view is bounded by the view rather than by the
  // size of the catalogue. This is the load-bearing claim for scale.
  const world = big();
  const sample = [...world.members.keys()].filter((_, i) => i % 40 === 0);

  world.diagramFor(sample[0]); // warm the census and index
  const started = performance.now();
  for (const userId of sample) world.diagramFor(userId);
  const each = (performance.now() - started) / sample.length;

  assert.ok(each < 25, `each view took ${each.toFixed(1)}ms`);
});

test('a session is only redrawn when its own picture moves', () => {
  const world = big();
  const ids = [...world.members.keys()];
  const watchers = ids.slice(0, 200);

  const before = watchers.map((userId) => world.viewSignature(userId));

  // Someone joins an interest. Almost nobody else is looking at it.
  const loner = ids.at(-1);
  world.join(loner, [...world.subjects][7]);

  const moved = watchers.filter((userId, i) => world.viewSignature(userId) !== before[i]);
  assert.ok(
    moved.length < watchers.length / 4,
    `${moved.length} of ${watchers.length} sessions would redraw for one join`,
  );
});

test('the same seed builds the same world', () => {
  const a = big({ seed: 7 }).census();
  const b = big({ seed: 7 }).census();
  assert.equal(a.size, b.size);
  for (const [k, n] of a) assert.equal(b.get(k), n, `region ${k}`);
});

test('seeded chatter obeys the rule the server enforces', () => {
  const world = big({ chatter: 200 });
  let posted = 0;

  for (const [roomKey, log] of world.messages) {
    posted += log.length;
    for (const message of log) {
      assert.equal(message.room, roomKey);
      // Every seeded message must have been postable by its author.
      const held = world.subscription(message.authorId);
      for (const subject of message.subjects) {
        assert.ok(held.has(subject), `${message.author} posted to ${roomKey} without holding ${subject}`);
      }
    }
  }
  assert.ok(posted > 0, 'expected some seeded conversation');
});
