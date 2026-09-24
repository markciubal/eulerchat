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

test('taking the made-up people away takes their words with them, with a receipt', async () => {
  const { world, ws, next, stop } = await open({ machines: true });
  try {
    const welcome = await next('welcome');
    // Somebody real, in a room, who says something that must survive all this.
    const me = welcome.you.id;
    const art = [...world.subjects][0];
    world.join(me, art);
    const mine = world.post(me, [art], 'said by a person');

    ws.send(JSON.stringify({ type: 'machines', count: 30 }));
    await next('machines');

    // A made-up one says something too — nothing here posts on their behalf,
    // but a demo's traffic does, and a world handed in may have.
    const madeUp = [...world.members.keys()].filter((id) => id !== me);
    const talker = madeUp.find((id) => [...(world.members.get(id) ?? [])].length);
    const room = [...world.members.get(talker)][0];
    const theirs = world.post(talker, [room], 'said by a machine');
    assert.ok(world.messages.get(room)?.some((m) => m.id === theirs.id));
    const receiptsBefore = world.deletions.length;

    ws.send(JSON.stringify({ type: 'machines', count: 0 }));
    await next('machines');

    // Their words are gone from the room, and from what anybody would count.
    assert.ok(!(world.messages.get(room) ?? []).some((m) => m.id === theirs.id), 'not in the room');
    const everything = [...world.messages.values()].flat();
    assert.ok(!everything.some((m) => m.authorId === talker), 'nowhere at all');
    assert.ok(everything.some((m) => m.id === mine.id), 'and a person’s words are untouched');

    // And it left the usual trail rather than vanishing quietly.
    assert.equal(world.deletions.length, receiptsBefore + 1);
    const receipt = world.deletions.at(-1);
    assert.equal(receipt.reason, 'removed');
    assert.equal(receipt.count, 1);
    assert.ok(receipt.hash && receipt.previous !== undefined, 'chained like any other');
  } finally {
    stop();
  }
});

test('taking away people who said nothing writes no receipt', async () => {
  const { world, ws, next, stop } = await open({ machines: true });
  try {
    await next('welcome');
    ws.send(JSON.stringify({ type: 'machines', count: 10 }));
    await next('machines');
    const before = world.deletions.length;
    ws.send(JSON.stringify({ type: 'machines', count: 0 }));
    await next('machines');
    assert.equal(world.deletions.length, before, 'nothing was said, so nothing was forgotten');
  } finally {
    stop();
  }
});
