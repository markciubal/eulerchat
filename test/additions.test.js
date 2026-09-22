import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { World, seed } from '../server/store.js';
import { createEulerChat } from '../server/app.js';

const WebSocket = createRequire(import.meta.url)('ws');

test('the atlas lists the chats you are in that it does not draw, if anybody else is in them', () => {
  const world = seed(new World());
  const me = world.addUser('me');
  const friend = world.addUser('friend');
  for (const s of ['art', 'philosophy', 'music', 'poetry', 'chess']) {
    if (!world.subjects.has(s)) world.addSubject(s);
    world.join(me, s);
  }
  world.join(friend, 'chess');
  world.join(friend, 'poetry');

  const view = world.atlasFor(me, 3);
  const drawn = view.rooms.filter((r) => !r.offMap);
  const beside = view.rooms.filter((r) => r.offMap);
  const zones = new Set(view.zones.map((z) => z.key));
  assert.ok(drawn.every((r) => zones.has(r.key) || r.here === 0), 'the drawn ones are on the map');
  assert.ok(beside.length > 0, 'some of theirs are not drawn');
  for (const room of beside) {
    assert.ok(!zones.has(room.key), `${room.key} is drawn, and listed twice`);
    assert.equal(room.member, true, 'only their own');
    assert.ok(room.population > 1, `${room.key} has nobody else in it`);
    assert.ok('activity' in room && 'stats' in room);
  }
  // chess+poetry is held by the two of them, and so listed if not drawn.
  const pair = view.rooms.find((r) => r.key === 'chess+poetry');
  assert.ok(pair, 'the chat they share is reachable');
  // The busiest first.
  const order = beside.map((r) => [r.activity, r.population]);
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1][0] > order[i][0] || (order[i - 1][0] === order[i][0] && order[i - 1][1] >= order[i][1]));
  }
});

test('a moderator is told so when welcomed, and nobody else is', async () => {
  for (const [trusted, expected] of [[true, true], [false, false]]) {
    const world = seed(new World());
    const chat = createEulerChat({ world, serveClient: false, isModerator: () => trusted });
    await new Promise((resolve) => chat.server.listen(0, resolve));
    const ws = new WebSocket(`ws://127.0.0.1:${chat.server.address().port}/`);
    try {
      const welcome = await new Promise((resolve, reject) => {
        ws.on('message', (raw) => {
          const frame = JSON.parse(raw);
          if (frame.type === 'welcome') resolve(frame);
        });
        ws.once('error', reject);
      });
      assert.equal(welcome.moderator, expected);
    } finally {
      ws.terminate();
      chat.close();
    }
  }
});
