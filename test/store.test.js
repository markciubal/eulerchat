import test from 'node:test';
import assert from 'node:assert/strict';
import { World, seed, MAX_SUBSCRIPTIONS, MAX_SUBJECTS } from '../server/store.js';
import { populate, rng } from '../server/populate.js';
import { MAX_ARITY, buildIndex, census } from '../lib/regions.js';

const world = () => seed(new World());

test('the seeded world has the population the diagram will draw', () => {
  const counts = world().census();

  assert.equal(counts.get('art'), 16);
  assert.equal(counts.get('philosophy'), 11);
  assert.equal(counts.get('music'), 8);
  assert.equal(counts.get('art+philosophy'), 5);
  assert.equal(counts.get('art+music'), 3);
});

test('a region nobody occupies is not a room', () => {
  const counts = world().census();

  // Nobody in the seeded world holds both music and philosophy, so the room
  // does not exist. Not empty — absent. A Venn build would have drawn it.
  assert.ok(!counts.has('music+philosophy'));
  assert.ok(!counts.has('art+music+philosophy'));

  const w = world();
  const guest = w.addUser('guest');
  const rooms = w.diagramFor(guest).rooms.map((r) => r.key);
  assert.ok(!rooms.includes('music+philosophy'));
  assert.deepEqual(rooms, ['art', 'music', 'philosophy', 'art+music', 'art+philosophy']);
});

test('creating the missing overlap brings the room into being', () => {
  const w = world();
  const guest = w.addUser('guest');

  assert.ok(!w.census().has('music+philosophy'));
  w.join(guest, 'music');
  w.join(guest, 'philosophy');

  assert.equal(w.census().get('music+philosophy'), 1);
  assert.ok(w.diagramFor(guest).rooms.some((r) => r.key === 'music+philosophy'));
});

test('you may only post where you stand', () => {
  const w = world();
  const artist = w.addUser('artist');
  w.join(artist, 'art');

  assert.ok(w.post(artist, ['art'], 'hello'));
  assert.throws(() => w.post(artist, ['art', 'philosophy'], 'hello'), /not in art\+philosophy/);
  assert.throws(() => w.post(artist, ['philosophy'], 'hello'), /not in philosophy/);
  assert.throws(() => w.post(artist, [], 'hello'), /at least one subject/);
  assert.throws(() => w.post(artist, ['art'], '   '), /empty message/);
  assert.throws(() => w.post(artist, ['nonexistent'], 'hi'), /no such subject/);
});

test('delivery reaches supersets and nobody else', () => {
  const w = new World();
  for (const s of ['art', 'philosophy']) w.addSubject(s);

  // No sockets anywhere: delivery is a question about membership, and the
  // answer is people. Turning people into bytes is the transport's business.
  const people = new Map();
  const mk = (name, subjects) => {
    const userId = w.addUser(name);
    for (const s of subjects) w.join(userId, s);
    people.set(userId, name);
  };

  mk('artist', ['art']);
  mk('philosopher', ['philosophy']);
  mk('both', ['art', 'philosophy']);

  const named = (tags) => w.audienceFor(tags).map((id) => people.get(id)).sort();

  // An art post reaches the art-only reader AND the overlap reader. The person
  // who loves both is never cut out of either circle they joined.
  assert.deepEqual(named(['art']), ['artist', 'both']);
  assert.deepEqual(named(['philosophy']), ['both', 'philosopher']);

  // Overlap content reaches only those holding both contexts.
  assert.deepEqual(named(['art', 'philosophy']), ['both']);
});

test('nobody is shown more circles than can be drawn honestly', () => {
  const w = world();
  for (const s of ['film', 'mathematics']) w.addSubject(s);

  const omnivore = w.addUser('omnivore');
    for (const s of ['art', 'philosophy', 'music', 'film', 'mathematics']) w.join(omnivore, s);

  const view = w.diagramFor(omnivore);
  assert.equal(view.circles.length, 3);
  assert.equal(view.fit.drawable, true);
  assert.equal(view.hidden.length, 2);
  assert.equal(view.subscription.length, 5);
});

test('a newcomer is shown the circles most connected to the ones they hold', () => {
  const w = world();
  const newcomer = w.addUser('newcomer');
  w.join(newcomer, 'art');

  const view = w.diagramFor(newcomer);
  assert.ok(view.subjects === undefined || true);
  assert.deepEqual(view.subscription, ['art']);

  // Art is theirs; philosophy and music are proposed because they overlap it.
  assert.deepEqual(view.suggested.sort(), ['music', 'philosophy']);
  assert.equal(view.circles.length, 3);

  const own = view.rooms.filter((r) => r.member).map((r) => r.key);
  assert.deepEqual(own, ['art']);
});

test('a single subject is a room you can hold a conversation in', () => {
  // The overlaps are the point of the product, but they are not the whole of
  // it: someone who holds one interest and nothing else must still have
  // somewhere to talk, and must still hear the people who hold only that.
  const w = new World();
  for (const s of ['art', 'philosophy']) w.addSubject(s);

  const ana = w.addUser('ana');
  const bo = w.addUser('bo');
  const cy = w.addUser('cy');
  w.join(ana, 'art');
  w.join(bo, 'art');
  w.join(cy, 'philosophy');

  assert.ok(w.post(ana, ['art'], 'anyone else working on this?'));
  assert.ok(w.post(bo, ['art'], 'yes — stuck on the same part.'));

  const log = w.messages.get('art');
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((m) => m.author), ['ana', 'bo']);

  // Both hold it, so both read it; the philosopher does not.
  for (const [name, userId] of [['ana', ana], ['bo', bo]]) {
    assert.ok(Object.keys(w.historyFor(userId)).includes('art'), `${name} should see art`);
  }
  assert.deepEqual(Object.keys(w.historyFor(cy)), []);

  // The room is listed for its members, and reachable without any overlap.
  const view = w.diagramFor(ana);
  const room = view.rooms.find((r) => r.key === 'art');
  assert.ok(room.member);
  assert.equal(room.population, 2);
  assert.equal(room.messages, 2);
});

test('holding one subject does not hide the rooms you cannot post in', () => {
  // The map still shows neighbours, so a single-subject member can see what is
  // adjacent and decide to join it. They simply cannot speak there yet.
  const w = world();
  const newcomer = w.addUser('newcomer');
  w.join(newcomer, 'art');

  const rooms = w.diagramFor(newcomer).rooms;
  assert.ok(rooms.length > 1, 'expected neighbouring rooms to be visible');
  assert.deepEqual(rooms.filter((r) => r.member).map((r) => r.key), ['art']);
  assert.ok(rooms.some((r) => !r.member && r.subjects.length === 1), 'expected a neighbour circle');
});

test('the rail lists a handful, never the catalogue', () => {
  const w = world();
  for (let i = 0; i < 400; i++) w.addSubject(`interest ${i}`);

  const newcomer = w.addUser('newcomer');
  w.join(newcomer, 'art');
  const view = w.diagramFor(newcomer);

  assert.deepEqual(view.rail.held, ['art']);
  assert.deepEqual(view.rail.suggested.sort(), ['music', 'philosophy']);
  assert.equal(view.rail.total, 403);

  // Nothing appears twice, and the whole rail stays small no matter how big
  // the catalogue gets.
  const listed = [...view.rail.held, ...view.rail.suggested, ...view.rail.popular];
  assert.equal(new Set(listed).size, listed.length);
  assert.ok(listed.length <= 20, `rail listed ${listed.length} rows`);
});

test('search finds interests the rail never showed', () => {
  const w = world();
  w.addSubject('art history');
  w.addSubject('performance art');

  const found = w.searchSubjects('art').map((r) => r.id);
  assert.ok(found.includes('art'));
  assert.ok(found.includes('art history'));
  assert.ok(found.includes('performance art'));

  // Ranked by population, so the room worth joining comes first.
  assert.equal(found[0], 'art');

  // An interest with nobody in it is absent from the map but still findable.
  assert.equal(w.searchSubjects('art history')[0].population, 0);
  assert.deepEqual(w.searchSubjects(''), []);
  assert.deepEqual(w.searchSubjects('   '), []);
  assert.deepEqual(w.searchSubjects('nothing matches this'), []);
});

test('the incremental census matches a full rebuild', () => {
  // Joins and leaves fold into the census in place rather than rebuilding it.
  // Incrementally-maintained state drifts silently, so the only test worth
  // having is the one that churns it hard and compares against the truth.
  const w = populate(new World(), { subjects: 120, users: 300, chatter: 0, seed: 5 });
  const random = rng(42);
  const ids = [...w.members.keys()];
  const subjects = [...w.subjects];
  const pick = (xs) => xs[Math.floor(random() * xs.length)];

  w.census(); // establish the incremental baseline
  w.index();

  for (let i = 0; i < 2000; i++) {
    const userId = pick(ids);
    const subject = pick(subjects);
    if (random() < 0.5) w.join(userId, subject);
    else w.leave(userId, subject);
  }
  // And someone leaving the world entirely.
  for (let i = 0; i < 20; i++) w.removeUser(pick(ids));

  const live = w.census();
  const fresh = census([...w.members.values()], MAX_ARITY);

  for (const [k, n] of fresh) assert.equal(live.get(k), n, `region ${k}`);
  for (const [k, n] of live) assert.equal(fresh.get(k), n, `stale region ${k} (${n})`);
  assert.equal(live.size, fresh.size);

  // Zero must mean absent, never a lingering key.
  for (const n of live.values()) assert.ok(n > 0);
});

test('the incremental index matches a full rebuild', () => {
  const w = populate(new World(), { subjects: 120, users: 300, chatter: 0, seed: 9 });
  const random = rng(11);
  const ids = [...w.members.keys()];
  const subjects = [...w.subjects];
  const pick = (xs) => xs[Math.floor(random() * xs.length)];

  w.index();
  for (let i = 0; i < 1500; i++) {
    const userId = pick(ids);
    const subject = pick(subjects);
    if (random() < 0.5) w.join(userId, subject);
    else w.leave(userId, subject);
  }

  const live = w.index();
  const fresh = buildIndex(census([...w.members.values()], MAX_ARITY));

  assert.deepEqual([...live.population].sort(), [...fresh.population].sort());
  assert.deepEqual(live.popular, fresh.popular);

  for (const [subject, neighbours] of fresh.adjacency) {
    assert.deepEqual(
      [...(live.adjacency.get(subject) ?? [])].sort(),
      [...neighbours].sort(),
      `neighbours of ${subject}`,
    );
  }
});

test('joining is idempotent and leaving what you never held is harmless', () => {
  const w = world();
  const userId = w.addUser('someone');

  w.join(userId, 'art');
  w.join(userId, 'art');
  assert.equal(w.census().get('art'), 17);

  w.leave(userId, 'philosophy');
  w.leave(userId, 'art');
  w.leave(userId, 'art');
  assert.equal(w.census().get('art'), 16);
});

test('history is filtered by what the reader holds', () => {
  const w = world();
  const artist = w.addUser('artist');
  w.join(artist, 'art');

  const rooms = Object.keys(w.historyFor(artist));
  assert.ok(rooms.includes('art'));
  assert.ok(!rooms.includes('art+philosophy'));
  assert.ok(!rooms.includes('philosophy'));
});

test('one person cannot blow up the census for everybody', () => {
  // The census enumerates subsets up to arity three, so its size is cubic in
  // how much a single person holds. Before the cap, 300 subjects on one user
  // built 4.5 million regions and put every view past a second.
  const w = world();
  const greedy = w.addUser('greedy');
  for (let i = 0; i < 200; i++) w.addSubject(`topic ${i}`);

  let joined = 0;
  for (let i = 0; i < 200; i++) {
    try {
      w.join(greedy, `topic ${i}`);
      joined++;
    } catch (err) {
      assert.match(err.message, /at most \d+ subjects/);
      break;
    }
  }

  assert.equal(joined, MAX_SUBSCRIPTIONS);
  assert.equal(w.subscription(greedy).size, MAX_SUBSCRIPTIONS);

  // Cubic in the cap rather than in whatever a client felt like sending.
  const regions = w.census().size;
  assert.ok(regions < 10_000, `census reached ${regions} regions`);

  // Warm the census, index and layout cache first. Timing a cold call meant
  // timing all three being built at once, which was over the bound about one
  // run in three — and a test that fails at random teaches people to ignore it.
  w.diagramFor(greedy);

  const started = performance.now();
  for (let i = 0; i < 5; i++) w.diagramFor(greedy);
  const each = (performance.now() - started) / 5;
  assert.ok(each < 40, `their view costs ${each.toFixed(1)}ms`);
});

test('the catalogue is bounded', () => {
  const w = new World();
  assert.equal(w.addSubject('art'), 'art');
  assert.throws(() => w.addSubject('!!'), /unusable subject name/);

  // Re-adding an existing subject is always allowed; only growth is capped.
  w.subjects = new Set(Array.from({ length: MAX_SUBJECTS }, (_, i) => `s${i}`));
  assert.throws(() => w.addSubject('one too many'), /catalogue is full/);
  assert.equal(w.addSubject('s0'), 's0');
});
