import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { World, seed } from '../server/store.js';
import { createEulerChat } from '../server/app.js';
import { watchable, watchLink, watchedFrom } from '../lib/lurk.js';
import { PORTAL_PREFIX } from '../lib/portal.js';

/** A portal's name: the prefix and twenty-four letters, as `lib/portal.js` makes them. */
const PORTAL = `${PORTAL_PREFIX}${'abcdefgh'.repeat(3)}`;

const WebSocket = createRequire(import.meta.url)('ws');

/**
 * Quick join: a code that opens one conversation to lurk in —
 * counted as a number and never as who, joined to nothing.
 */

test('a quick-join link names one room, the way rooms are named everywhere else', () => {
  const link = watchLink('https://example.com/chat/', 'philosophy+art');
  assert.equal(link, 'https://example.com/chat/?watch=philosophy%2Bart');
  assert.equal(watchedFrom(link), 'art+philosophy', 'written the one way a room is written');
  assert.equal(watchedFrom(watchLink('https://example.com', 'kite-fox-9/art+kite-fox-9/everyone')), 'kite-fox-9/art+kite-fox-9/everyone');

  // A room may combine up to ten interests, so four is one and eleven is not.
  assert.equal(watchable('a+b+c+d'), 'a+b+c+d');
  for (const junk of ['', 'a+b+c+d+e+f+g+h+i+j+k', '<script>', 'ART', 'x'.repeat(40), 'nope/art']) {
    assert.equal(watchable(junk), null, `"${junk}" is not a room`);
  }
  assert.equal(watchedFrom('https://example.com/?cluster=kite-fox-9'), null);
});

test('a portal cannot be watched: it is not for finding', () => {
  assert.equal(watchable(PORTAL), null);
  assert.equal(watchable(`art+${PORTAL}`), null, 'nor any room that touches one');
  assert.equal(new World().look(PORTAL), null);
});

test('a room looked at from outside is what anybody could already read', () => {
  const world = seed(new World());
  const view = world.look('art+philosophy');
  assert.equal(view.room, 'art+philosophy');
  assert.equal(view.here, true);
  assert.ok(view.population > 0);
  assert.ok(view.messages.length > 0, 'the conversation so far');
  assert.equal(world.look('philosophy+art').room, 'art+philosophy');
  assert.equal(world.look('art+zzqx lore').here, false, 'a room nobody has opened yet');
});

/** A server, and a way of opening connections to it that can wait for frames. */
async function serve(world) {
  const chat = createEulerChat({ world, serveClient: false });
  await new Promise((resolve) => chat.server.listen(0, resolve));
  // Closing the server leaves the connections to it open, and an open one
  // keeps the test's process alive after a failed assertion skipped its own
  // close — which hung the whole run rather than reporting the failure.
  const sockets = [];
  const shut = chat.close.bind(chat);
  chat.close = () => {
    for (const ws of sockets) ws.terminate();
    return shut();
  };
  const url = `ws://127.0.0.1:${chat.server.address().port}/`;
  const open = async () => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const frames = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw)));
    await new Promise((resolve) => ws.once('open', resolve));
    const until = async (want, after = 0) => {
      for (let i = 0; i < 300; i++) {
        const found = frames.slice(after).find(want);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      return null;
    };
    await until((f) => f.type === 'welcome');
    return { ws, frames, until, send: (p) => ws.send(JSON.stringify(p)) };
  };
  return { chat, open };
}

test('a lurker hears the one conversation, and nobody hears about the lurker', async () => {
  const world = new World();
  world.addSubject('music');
  const { chat, open } = await serve(world);
  try {
    const member = await open();
    member.send({ type: 'join', subject: 'music' });
    // The state that has the join in it: one also comes on connecting, and
    // under load that one can be the first to arrive.
    await member.until((f) => f.type === 'state' && f.subscription?.includes('music'));
    const counted = world.census().get('music');

    const lurker = await open();
    lurker.send({ type: 'watch', room: 'music' });
    const watching = await lurker.until((f) => f.type === 'watching');
    assert.equal(watching.room, 'music');
    assert.equal(watching.population, counted);

    // Not a member of anything, not in the head count, not among who a message reaches.
    assert.equal(world.census().get('music'), counted, 'the lurker is not a member');
    const lurkerId = [...chat.sessions].find((s) => s.watching === 'music').userId;
    assert.equal(world.subscription(lurkerId).size, 0);
    assert.ok(!world.audienceFor(['music']).includes(lurkerId));

    // And yet it hears what is said.
    member.send({ type: 'post', tags: ['music'], body: 'anyone for scales?' });
    const heard = await lurker.until((f) => f.type === 'message');
    assert.equal(heard?.message.body, 'anyone for scales?');

    // Until it stops watching.
    lurker.send({ type: 'unwatch' });
    await new Promise((r) => setTimeout(r, 30));
    const before = lurker.frames.length;
    member.send({ type: 'post', tags: ['music'], body: 'still here' });
    await member.until((f) => f.type === 'message' && f.message.body === 'still here');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!lurker.frames.slice(before).some((f) => f.type === 'message'), 'a lurker that stopped watching hears nothing');

    member.ws.close();
    lurker.ws.close();
  } finally {
    chat.close();
  }
});

test('a portal is refused to a lurker', async () => {
  const world = new World();
  const portal = world.addSubject(PORTAL);
  const { chat, open } = await serve(world);
  try {
    const lurker = await open();
    lurker.send({ type: 'watch', room: portal });
    const answer = await lurker.until((f) => f.type === 'error' || f.type === 'watching');
    assert.equal(answer.type, 'error');
    lurker.ws.close();
  } finally {
    chat.close();
  }
});

test('a room is told how many are watching it, as they come and go', async () => {
  const world = new World();
  world.addSubject('music');
  const { open, chat } = await serve(world);
  try {
    const member = await open();
    member.send({ type: 'join', subject: 'music' });
    // The state that has the join in it: one also comes on connecting, and
    // under load that one can be the first to arrive.
    await member.until((f) => f.type === 'state' && f.subscription?.includes('music'));
    const told = () => member.frames.filter((f) => f.type === 'lurkers' && f.room === 'music').map((f) => f.count);

    const first = await open();
    first.send({ type: 'watch', room: 'music' });
    assert.equal((await first.until((f) => f.type === 'watching')).lurkers, 1);
    const second = await open();
    second.send({ type: 'watch', room: 'music' });
    assert.equal((await second.until((f) => f.type === 'watching')).lurkers, 2, 'counting itself');
    await member.until(() => told().length >= 2);
    assert.deepEqual(told(), [1, 2]);

    // On the map too, so the count is there before anybody arrives or leaves.
    member.send({ type: 'atlas', subjects: 5 });
    const atlas = await member.until((f) => f.type === 'atlas');
    assert.equal(atlas.rooms.find((r) => r.key === 'music').lurkers, 2);

    first.send({ type: 'unwatch' });
    second.ws.close();
    await member.until(() => told().length >= 4);
    assert.deepEqual(told(), [1, 2, 1, 0], 'one stopped watching, and one went');

    // A number, and nothing about who: no id, no name, no key.
    const frame = member.frames.find((f) => f.type === 'lurkers');
    assert.deepEqual(Object.keys(frame).sort(), ['count', 'room', 'type']);

    member.ws.close();
    first.ws.close();
  } finally {
    chat.close();
  }
});
