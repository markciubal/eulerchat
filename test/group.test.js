import test from 'node:test';
import assert from 'node:assert/strict';
import { World, seed } from '../server/store.js';
import { hue, isChosen, regionFill, setHue, stroke } from '../lib/palette.js';
import { signature } from '../lib/glyph.js';
import { anchorsFor, radialLayout } from '../lib/taxonomy.js';
import { knowledge } from '../lib/knowledge.js';
import { classify } from '../lib/notify.js';
import { groupRoom, inner, isGroupRoom, named } from '../lib/cluster.js';

/**
 * A group wraps its rooms, and holds a copy of the world outside it.
 *
 * Two promises, tested separately. The wrapping is a fact about membership:
 * everybody holding anything in a group holds the group's own conversation,
 * so every room in the group is inside it. The copy is a fact about
 * everything worked out from a name: `kite-fox-9/art` is art, and wears its
 * colour, sits where it sits, and is suggested beside what it is suggested
 * beside outside.
 */

const G = 'kite-fox-9';
const inside = (name) => `${G}/${name}`;

// --- the wrapping ------------------------------------------------------------

test('holding anything in a group means holding its own conversation', () => {
  const world = seed(new World());
  const u = world.addUser('u');
  world.join(u, world.addSubject(inside('art')));

  assert.deepEqual([...world.subscription(u)].sort(), [inside('art'), inside('everyone')]);
  assert.equal(world.groupOf(u), G);

  // So every room in the group is inside the conversation that wraps it.
  const v = world.addUser('v');
  world.join(v, world.addSubject(inside('art')));
  world.join(v, world.addSubject(inside('philosophy')));
  const map = world.atlasFor(v, 5);
  assert.ok(map.zones.length > 1);
  for (const zone of map.zones) {
    assert.ok(zone.subjects.includes(groupRoom(G)), `${zone.key} is outside the group's outline`);
  }

  // Nobody holds the group's own conversation alone any more, so it has no
  // ground — and is still one of the rooms, or the group could not talk.
  assert.ok(!map.zones.some((z) => z.key === groupRoom(G)));
  const own = map.rooms.find((r) => r.key === groupRoom(G));
  assert.ok(own, 'the group\'s own conversation is listed without ground of its own');
  assert.equal(own.population, 2);
  assert.equal(own.member, true);

  // And each interest is named on its own ground, not on an overlap: ground
  // shared only with the group that wraps it is still its own.
  const inside_ = (point, loops) => {
    let crossings = 0;
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const [ax, ay] = loop[i];
        const [bx, by] = loop[(i + 1) % loop.length];
        if (ay > point.y !== by > point.y && point.x < ((bx - ax) * (point.y - ay)) / (by - ay) + ax) crossings++;
      }
    }
    return crossings % 2 === 1;
  };
  const art = map.curves.find((c) => c.subject === inside('art'));
  const ownGround = map.zones.find((z) => z.key === `${inside('art')}+${groupRoom(G)}`);
  assert.ok(inside_(art.anchor, ownGround.loops), 'art is named where art is, not where art meets philosophy');
});

test('leaving the group\'s own conversation is leaving the group', () => {
  const world = seed(new World());
  const u = world.addUser('u');
  world.join(u, 'art');
  world.join(u, world.addSubject(inside('art')));
  world.join(u, world.addSubject(inside('music')));

  world.leave(u, groupRoom(G));
  assert.deepEqual([...world.subscription(u)], ['art'], 'the open world is left alone');
  assert.equal(world.groupOf(u), null);
});

test('also joining widens inside the group, not out of it', () => {
  const world = seed(new World());
  const u = world.addUser('u');
  world.setFunnel(u, 1);
  world.join(u, world.addSubject(inside('painting')));

  const held = [...world.subscription(u)];
  assert.ok(held.includes(inside('visual art')), `the group's copy of the field: ${held}`);
  assert.ok(!held.includes('visual art'), 'and not the open one');
});

// --- the copy ----------------------------------------------------------------

test('inside a group an interest looks like itself', () => {
  assert.equal(hue(inside('art')), hue('art'));
  assert.equal(stroke(inside('philosophy')), stroke('philosophy'));
  assert.equal(signature(inside('music')), signature('music'));

  // A colour picked for art is picked for art, wherever it is.
  try {
    setHue('art', 42);
    assert.equal(hue(inside('art')), 42);
    assert.ok(isChosen(inside('art')));
  } finally {
    setHue('art', null);
  }

  // The group's own conversation is in every room in it, and does not tint them.
  assert.equal(regionFill([inside('art'), groupRoom(G)]), regionFill(['art']));
  assert.equal(regionFill([inside('art'), inside('music'), groupRoom(G)]), regionFill(['art', 'music']));
});

test('inside a group an interest sits where it sits outside', () => {
  const positions = radialLayout(knowledge);
  const outside = anchorsFor(['painting'], positions).get('painting');
  const within = anchorsFor([inside('painting')], positions).get(inside('painting'));
  assert.ok(within, 'a group\'s interest is placed, not left on the unclassified ring');
  assert.deepEqual(within, outside);
});

test('inside a group the same people are drawn exactly as they are outside', () => {
  // The hologram, stated as strictly as it can be: the group's frame is left
  // out of where anything goes, so every room's ground inside is the ground
  // the same people get outside, and the frame is drawn round it.
  const people = [['art'], ['art', 'philosophy'], ['art', 'philosophy'], ['philosophy'], ['music'], ['art', 'music'], ['music', 'philosophy']];

  const group = seed(new World());
  const open = new World();
  for (const s of ['art', 'philosophy', 'music']) open.addSubject(s);
  let me = null;
  let them = null;
  for (const [i, set] of people.entries()) {
    const u = group.addUser(`p${i}`);
    const v = open.addUser(`p${i}`);
    for (const s of set) {
      group.join(u, group.addSubject(inside(s)));
      open.join(v, s);
    }
    me ??= u;
    them ??= v;
  }

  const ground = (view) => new Map(view.zones.map((z) => [named(z.subjects).sort().join('+'), z.loops]));
  const within = ground(group.atlasFor(me, 5));
  const outside = ground(open.atlasFor(them, 5));
  assert.deepEqual([...within.keys()].sort(), [...outside.keys()].sort());
  for (const [room, loops] of outside) assert.deepEqual(within.get(room), loops, `${room} is drawn differently inside`);
});

test('the line round a group is always one line', () => {
  // Laid out without its frame, rooms that share nothing could drift apart
  // and take the frame with them. Whatever the group, it comes out whole.
  let state = 42;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const topics = ['art', 'philosophy', 'music', 'poetry'];

  for (let n = 0; n < 12; n++) {
    const world = new World();
    let me = null;
    for (let i = 0; i < 5 + Math.floor(random() * 7); i++) {
      const u = world.addUser(`p${i}`);
      const set = topics.filter(() => random() < 0.35);
      for (const s of set.length ? set : [topics[i % 4]]) world.join(u, world.addSubject(inside(s)));
      me ??= u;
    }
    for (let i = 0; i < Math.floor(random() * 3); i++) world.join(world.addUser(`a${i}`), world.addSubject(groupRoom(G)));

    const view = world.atlasFor(me, 5);
    const frame = view.curves.find((c) => c.subject === groupRoom(G));
    assert.equal(frame.components, 1, `group ${n} came out in ${frame.components} pieces`);
    assert.equal(view.report.exact, true);
  }
});

test('a group is offered what the world outside would offer, as its own', () => {
  const world = seed(new World());
  const outsider = world.addUser('o');
  world.join(outsider, 'art');
  const offered = world.stateFor(outsider).rail.suggested;
  assert.ok(offered.length, 'the seeded world suggests something beside art');

  const member = world.addUser('u');
  world.join(member, world.addSubject(inside('art')));
  const rail = world.stateFor(member).rail;
  for (const s of offered) assert.ok(rail.suggested.includes(inside(s)), `${inside(s)} in ${rail.suggested}`);
  assert.equal(rail.total, world.stateFor(outsider).rail.total, 'the whole catalogue, not every copy of it');
});

test('search and browse inside a group find the group\'s copies, and nobody else\'s', () => {
  const world = seed(new World());
  // Another group, busy, with art in it.
  for (let i = 0; i < 4; i++) world.join(world.addUser(`m${i}`), world.addSubject('moss-owl-12/art'));
  const member = world.addUser('u');
  world.join(member, world.addSubject(inside('art')));

  const found = world.searchSubjects('art', 20, { group: G });
  assert.ok(found.length);
  assert.ok(found.every((r) => r.id.startsWith(`${G}/`)), JSON.stringify(found));
  assert.equal(found.find((r) => r.id === inside('art'))?.population, 1, 'counted by the group\'s own people');

  const open = world.searchSubjects('art', 20);
  assert.ok(open.some((r) => r.id === 'art'));
  assert.ok(!open.some((r) => r.id.includes('/')), 'nor are groups in the open search');

  const top = world.browse(null, { group: G });
  assert.ok(top.children.length);
  assert.ok(top.children.every((c) => c.id.startsWith(`${G}/`)));
  // Opened from a row, which carries the group's copy as its name.
  const arts = world.browse(inside('arts'), { group: G });
  assert.equal(arts.at, 'arts');
  assert.ok(arts.children.some((c) => c.id === inside('visual art')));

  // And the busy group next door never turns up in this one's lists.
  const rail = world.stateFor(member).rail;
  const listed = [...rail.suggested, ...rail.popular, ...rail.discoveries.map((d) => d.subject)];
  assert.ok(!listed.some((s) => s.startsWith('moss-owl-12/')), listed.join(', '));
  const outsider = world.stateFor(world.addUser('o')).rail;
  const openListed = [...outsider.suggested, ...outsider.popular, ...outsider.discoveries.map((d) => d.subject)];
  assert.ok(!openListed.some((s) => s.includes('/')), openListed.join(', '));
});

test('a room in a group is named, and notified about, as it would be outside', () => {
  assert.equal(isGroupRoom(groupRoom(G)), true);
  assert.equal(isGroupRoom('everyone'), false);
  assert.deepEqual(named([inside('art'), groupRoom(G)]), ['art']);
  assert.deepEqual(named([groupRoom(G)]), ['everyone'], 'the group\'s own conversation is still a room');
  assert.deepEqual(inner([inside('art'), inside('music'), groupRoom(G)]), [inside('art'), inside('music')]);

  const note = classify(
    {
      type: 'message',
      room: `${inside('art')}+${groupRoom(G)}`,
      message: {
        id: 'm1', room: `${inside('art')}+${groupRoom(G)}`, author: 'wren', authorId: 'w',
        body: 'hello', at: 1, reach: 40,
      },
    },
    { userId: 'me', name: 'osmo', subscription: [inside('art'), groupRoom(G)] },
  );
  assert.equal(note.title, 'art');
  assert.equal(note.level, 'quiet', 'as broad as art is outside, not an overlap');
});
