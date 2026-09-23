import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MACHINES_MOST, World, createEulerChat, stock } from '../server/app.js';

const WebSocket = createRequire(import.meta.url)('ws');

/** A server, a socket, and a way to wait for one kind of frame. */
async function open(options = {}) {
  const world = stock(new World());
  const chat = createEulerChat({ world, serveClient: false, ...options });
  await new Promise((resolve) => chat.server.listen(0, resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${chat.server.address().port}/`);
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw)));
  const next = (type, timeout = 8000) =>
    new Promise((resolve, reject) => {
      const until = Date.now() + timeout;
      const look = () => {
        const i = frames.findIndex((f) => f.type === type);
        if (i >= 0) return resolve(frames.splice(i, 1)[0]);
        if (Date.now() > until) return reject(new Error(`no ${type} frame`));
        setTimeout(look, 10);
      };
      look();
    });
  await new Promise((resolve) => ws.once('open', resolve));
  return { world, chat, ws, next, frames, stop: () => { ws.terminate(); chat.close(); } };
}

test('a page can fill the world with made-up people, and empty it again', async () => {
  const { world, ws, next, stop } = await open({ machines: true });
  try {
    const welcome = await next('welcome');
    assert.deepEqual(welcome.machines, { most: MACHINES_MOST, count: 0 }, 'the server says it will, and has none');
    const people = () => world.members.size;
    const before = people();

    ws.send(JSON.stringify({ type: 'machines', count: 40 }));
    const made = await next('machines');
    assert.equal(made.count, 40);
    assert.equal(people(), before + 40, 'forty more people');
    // Holding interests, so there is something to draw.
    const theirs = [...world.members.entries()].filter(([, held]) => held.size > 0);
    assert.ok(theirs.length >= 40, 'and they hold things');
    // Saying nothing: nothing here posts on their behalf.
    assert.equal([...world.messages.values()].flat().length, 0);

    // Asked for a different number: that many instead, not that many more.
    ws.send(JSON.stringify({ type: 'machines', count: 10 }));
    assert.equal((await next('machines')).count, 10);
    assert.equal(people(), before + 10);

    // And away: exactly the ones it made, and nobody else.
    ws.send(JSON.stringify({ type: 'machines', count: 0 }));
    assert.equal((await next('machines')).count, 0);
    assert.equal(people(), before, 'whoever was really here is still here');
  } finally {
    stop();
  }
});

test('no more than the most it will make, however many are asked for', async () => {
  const { world, ws, next, stop } = await open({ machines: true });
  try {
    await next('welcome');
    const before = world.members.size;
    ws.send(JSON.stringify({ type: 'machines', count: MACHINES_MOST * 10 }));
    const made = await next('machines', 60_000);
    assert.equal(made.count, MACHINES_MOST);
    assert.equal(world.members.size, before + MACHINES_MOST);
  } finally {
    stop();
  }
});

test('a server that was not asked to make people up will not, and does not offer to', async () => {
  const { world, ws, next, stop } = await open();
  try {
    const welcome = await next('welcome');
    assert.equal(welcome.machines, null, 'nothing offered');
    const before = world.members.size;
    ws.send(JSON.stringify({ type: 'machines', count: 100 }));
    assert.match((await next('error')).message, /does not make up people/);
    assert.equal(world.members.size, before, 'and nobody was made');
  } finally {
    stop();
  }
});

test('everybody connected is told how many there are now', async () => {
  const first = await open({ machines: true });
  try {
    await first.next('welcome');
    const second = new WebSocket(`ws://127.0.0.1:${first.chat.server.address().port}/`);
    const seen = [];
    second.on('message', (raw) => seen.push(JSON.parse(raw)));
    await new Promise((resolve) => second.once('open', resolve));
    first.ws.send(JSON.stringify({ type: 'machines', count: 12 }));
    await first.next('machines');
    const until = Date.now() + 4000;
    while (!seen.some((f) => f.type === 'machines') && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(seen.find((f) => f.type === 'machines')?.count, 12, 'the other window says so too');
    second.terminate();
  } finally {
    first.stop();
  }
});
