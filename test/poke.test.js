import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { World, seed } from '../server/store.js';
import { createEulerChat } from '../server/app.js';
import { PORTAL_PREFIX } from '../lib/portal.js';

const WebSocket = createRequire(import.meta.url)('ws');

/** A server, and connections to it that can wait for frames; closed with it. */
async function serve(world) {
  const chat = createEulerChat({ world, serveClient: false });
  await new Promise((resolve) => chat.server.listen(0, resolve));
  const url = `ws://127.0.0.1:${chat.server.address().port}/`;
  const sockets = [];
  const open = async () => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const frames = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw)));
    await new Promise((resolve) => ws.once('open', resolve));
    const until = async (want) => {
      for (let i = 0; i < 300; i++) {
        const found = frames.find(want);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      return null;
    };
    await until((f) => f.type === 'welcome');
    return { ws, frames, until, send: (p) => ws.send(JSON.stringify(p)) };
  };
  const close = () => {
    for (const ws of sockets) ws.terminate();
    chat.close();
  };
  return { open, close };
}

test('poked, the server answers with a question from its databank for that room, to the poker alone', async () => {
  const world = seed(new World());
  const { open, close } = await serve(world);
  try {
    const poker = await open();
    const other = await open();
    const said = [...world.messages.values()].reduce((n, log) => n + log.length, 0);

    poker.send({ type: 'poke', room: 'art+philosophy' });
    const reply = await poker.until((f) => f.type === 'poked');
    assert.ok(reply, 'answered');
    assert.equal(reply.room, 'art+philosophy');
    assert.equal(reply.machine, true, 'and says it is the server talking');
    assert.deepEqual([...reply.about].sort(), ['art', 'philosophy']);
    assert.match(reply.text, /\?$/, 'a question');
    assert.ok(/art/.test(reply.text) && /philosophy/.test(reply.text), `about the room: ${reply.text}`);

    // Nothing posted, and nobody else told.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal([...world.messages.values()].reduce((n, log) => n + log.length, 0), said);
    assert.ok(!other.frames.some((f) => f.type === 'poked' || f.type === 'message'));
  } finally {
    close();
  }
});

test('with no room, or a portal, the question is about something they hold', async () => {
  const world = seed(new World());
  const portal = world.addSubject(`${PORTAL_PREFIX}${'abcdefgh'.repeat(3)}`);
  const { open, close } = await serve(world);
  try {
    const poker = await open();
    poker.send({ type: 'join', subject: 'music' });
    await poker.until((f) => f.type === 'state');

    poker.send({ type: 'poke' });
    const plain = await poker.until((f) => f.type === 'poked');
    assert.deepEqual(plain.about, ['music']);
    assert.match(plain.text, /music/);

    poker.send({ type: 'poke', room: portal });
    const hidden = await poker.until((f) => f.type === 'poked' && f.room === portal);
    assert.deepEqual(hidden.about, ['music'], 'never made from a portal name');
    assert.doesNotMatch(hidden.text, new RegExp(PORTAL_PREFIX));
  } finally {
    close();
  }
});

test('poking is rate-limited like everything else', async () => {
  const world = seed(new World());
  const { open, close } = await serve(world);
  try {
    const poker = await open();
    for (let i = 0; i < 40; i++) poker.send({ type: 'poke', room: 'art' });
    const slowed = await poker.until((f) => f.type === 'error' && /slow down/.test(f.message));
    assert.ok(slowed, 'a flood is told to slow down');
  } finally {
    close();
  }
});
