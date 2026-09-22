import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { communities } from '../lib/communities.js';
import { MAX_SUBSCRIPTIONS, World } from '../server/store.js';
import { JOIN_AT_ONCE, createEulerChat } from '../server/app.js';

const WebSocket = createRequire(import.meta.url)('ws');

/** Two tight groups of interests with one weak link between them, and a pair on its own. */
const LINKS = [
  ['guitar', 'piano', 9, 0.6],
  ['guitar', 'drums', 8, 0.5],
  ['piano', 'drums', 7, 0.5],
  ['python', 'rust', 9, 0.6],
  ['python', 'haskell', 6, 0.4],
  ['rust', 'haskell', 7, 0.5],
  ['drums', 'python', 2, 0.05],
  ['knitting', 'crochet', 4, 0.5],
];
const POPULATION = new Map([
  ['guitar', 40], ['piano', 30], ['drums', 20], ['python', 50], ['rust', 25], ['haskell', 10], ['knitting', 12], ['crochet', 8],
]);

test('interests held together by the same people come out as one community', () => {
  const { list, of } = communities(LINKS, POPULATION);
  const groups = list.map((c) => [...c.members].sort());
  assert.deepEqual(groups, [['haskell', 'python', 'rust'], ['drums', 'guitar', 'piano'], ['crochet', 'knitting']]);
  assert.equal(of.get('drums'), of.get('guitar'));
  assert.notEqual(of.get('drums'), of.get('python'), 'one weak link does not merge them');
});

test('a community is named by its most-held interests, and knows which are nearest it', () => {
  const { list, of } = communities(LINKS, POPULATION);
  const code = list[of.get('rust')];
  assert.equal(code.lead, 'python');
  assert.deepEqual(code.name, ['python', 'rust', 'haskell']);
  assert.deepEqual(code.near, [of.get('guitar')], 'music, through drums and python');
  assert.deepEqual(list[of.get('knitting')].near, [], 'linked to nothing else');
});

test('the same links give the same communities, whatever order they come in', () => {
  const once = communities(LINKS, POPULATION).list.map((c) => c.members);
  const again = communities([...LINKS].reverse(), POPULATION).list.map((c) => c.members);
  assert.deepEqual(again, once);
  assert.deepEqual(communities([], POPULATION).list, [], 'and none from nothing');
});

/** A world where the same people hold music together, and code together, and a few hold both. */
function world() {
  const w = new World();
  for (const s of ['guitar', 'piano', 'drums', 'singing', 'python', 'rust', 'haskell', 'go']) w.addSubject(s);
  const hold = (name, subjects) => {
    const id = w.addUser(name);
    for (const s of subjects) w.join(id, s);
    return id;
  };
  for (let i = 0; i < 6; i++) hold(`band${i}`, ['guitar', 'piano', 'drums', 'singing'].filter((_, j) => (i + j) % 4 !== 0));
  for (let i = 0; i < 6; i++) hold(`coder${i}`, ['python', 'rust', 'haskell', 'go'].filter((_, j) => (i + j) % 4 !== 0));
  hold('both', ['drums', 'python']);
  hold('both too', ['drums', 'python']);
  return w;
}

test('a branch draws the interest and its community, and joins nothing', () => {
  const w = world();
  const me = w.addUser('me');
  w.join(me, 'guitar');
  const before = [...w.subscription(me)];

  const view = w.branchFor(me, 'guitar', { limit: 4 });
  assert.equal(view.branch.from, 'guitar');
  assert.equal(view.branch.toward, null);
  assert.ok(view.branch.community.name.includes('guitar'));
  const drawn = new Set(view.zones.flatMap((z) => z.subjects));
  assert.ok(drawn.has('guitar'), 'grown from where they are');
  assert.ok([...drawn].every((s) => ['guitar', 'piano', 'drums', 'singing'].includes(s)), [...drawn].join());
  assert.deepEqual([...w.subscription(me)], before, 'nothing joined');
  for (const room of view.rooms) assert.equal(room.member, room.subjects.every((s) => s === 'guitar'), room.key);
  assert.ok(view.communities.guitar, 'what it can branch into from here');
});

test('a branch toward a community next door draws what bridges the two', () => {
  const w = world();
  const me = w.addUser('me');
  w.join(me, 'guitar');
  const music = w.atlasFor(me, 3).communities.guitar;
  assert.ok(music, 'the map says which community guitar is in');
  const [code] = music.near;
  assert.ok(code, 'and which is nearest it');

  const view = w.branchFor(me, 'guitar', { toward: code.lead, limit: 3 });
  assert.equal(view.branch.toward, code.lead);
  assert.deepEqual(view.branch.community.name, code.name);
  const drawn = view.zones.flatMap((z) => z.subjects);
  assert.ok(drawn.includes('python'), 'python first, since drums people hold it');
});

test('there is nothing to branch into from nowhere, or from inside a group', () => {
  const w = world();
  const me = w.addUser('me');
  assert.equal(w.branchFor(me, 'no such thing'), null);
  w.addSubject('lonely');
  assert.equal(w.branchFor(me, 'lonely'), null, 'held with nothing');
  w.addSubject('kite-fox-9/guitar');
  assert.equal(w.branchFor(me, 'kite-fox-9/guitar'), null);
});

test('All interests marks each interest with its community', () => {
  const w = world();
  const chart = w.chart();
  const guitar = chart.subjects.find((s) => s.id === 'guitar');
  const piano = chart.subjects.find((s) => s.id === 'piano');
  assert.equal(guitar.c, piano.c);
  assert.ok(chart.communities[guitar.c].name.length > 0);
  assert.ok(chart.communities[guitar.c].size >= 3);
});

test('a whole community is joined in one ask, and no more than that at a time', async () => {
  const w = world();
  const chat = createEulerChat({ world: w, serveClient: false });
  await new Promise((resolve) => chat.server.listen(0, resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${chat.server.address().port}/`);
  try {
    const welcome = await new Promise((resolve) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw);
        if (frame.type === 'welcome') resolve(frame);
      });
    });
    ws.send(JSON.stringify({ type: 'join', subjects: ['guitar', 'piano', 'drums'] }));
    const held = new Set();
    for (let i = 0; i < 200 && held.size < 3; i++) {
      await new Promise((r) => setTimeout(r, 10));
      for (const s of w.subscription(welcome.you.id)) held.add(s);
    }
    assert.deepEqual([...held].sort(), ['drums', 'guitar', 'piano']);

    // As many as fit: joining a big community runs into the most anybody may
    // hold, and what fits is joined rather than the whole ask failing.
    const many = Array.from({ length: JOIN_AT_ONCE + 10 }, (_, i) => w.addSubject(`interest ${i}`));
    const said = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw);
        if (frame.type === 'error') resolve(frame.message);
      });
    });
    ws.send(JSON.stringify({ type: 'join', subjects: many }));
    assert.match(await said, /at most \d+ subjects/);
    assert.equal([...w.subscription(welcome.you.id)].length, MAX_SUBSCRIPTIONS, 'and everything that fits is in');
  } finally {
    ws.terminate();
    chat.close();
  }
});

test('a page asks for a branch, and is sent only the rooms while the drawing holds', async () => {
  const w = world();
  const chat = createEulerChat({ world: w, serveClient: false });
  await new Promise((resolve) => chat.server.listen(0, resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${chat.server.address().port}/`);
  const frames = [];
  const next = (type) =>
    new Promise((resolve) => {
      const look = () => {
        const i = frames.findIndex((f) => f.type === type);
        if (i >= 0) return resolve(frames.splice(i, 1)[0]);
        setTimeout(look, 10);
      };
      look();
    });
  ws.on('message', (raw) => frames.push(JSON.parse(raw)));
  try {
    await new Promise((resolve) => ws.once('open', resolve));
    await next('welcome');
    ws.send(JSON.stringify({ type: 'branch', from: 'guitar', subjects: 3 }));
    const whole = await next('branch');
    assert.equal(whole.branch.from, 'guitar');
    assert.ok(whole.zones.length > 0 && whole.shape);
    ws.send(JSON.stringify({ type: 'branch', from: 'guitar', subjects: 3, have: whole.shape }));
    const again = await next('branch');
    assert.equal(again.only, 'rooms');
    assert.equal(again.zones, undefined);
    ws.send(JSON.stringify({ type: 'branch', from: 'nothing at all' }));
    assert.equal((await next('branch')).none, true);
  } finally {
    ws.terminate();
    chat.close();
  }
});
