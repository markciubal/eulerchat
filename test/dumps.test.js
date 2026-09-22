import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { identity } from '../lib/seal.js';
import { portalWith } from '../lib/portal.js';
import { commitment } from '../lib/receipt.js';
import { World } from '../server/store.js';
import { FORGOTTEN_PER_EVENT, createEulerChat } from '../server/app.js';
import { createPublicApi } from '../server/public-api.js';
import { DUMP_BYTES, createDumps } from '../server/dumps.js';

/**
 * The firehose, kept a megabyte at a time: never more than that sent out at
 * once, what has gathered let go once it is a dump, and nothing in a dump
 * that the place itself has forgotten.
 */

const WebSocket = createRequire(import.meta.url)('ws');
const bytesOf = (text) => Buffer.byteLength(text);
const said = (i, extra = {}) => ({ type: 'message', id: `m${i}`, room: 'art', body: `message ${i} `.padEnd(120, '.'), at: 1_000 + i, ...extra });

test('what gathers becomes a dump at the limit, and is let go once it is one', () => {
  const made = [];
  const dumps = createDumps({ bytes: 4000, onDump: (d) => made.push(d), now: () => 2_000 });
  for (let i = 0; i < 200; i++) dumps.add(said(i));

  const { bytes, pending, dumps: listed } = dumps.list();
  assert.equal(bytes, 4000);
  assert.ok(listed.length >= 5, `${listed.length} dumps`);
  assert.deepEqual(listed.map((d) => d.id), listed.map((_, i) => i + 1), 'numbered in order');
  assert.deepEqual(made.map((d) => d.id), listed.map((d) => d.id), 'each one said as it was made');

  // Every event is in exactly one place: a dump, or what is gathering now.
  const inDumps = listed.reduce((n, d) => n + d.events, 0);
  assert.equal(inDumps + pending.events, 200, 'nothing kept twice, nothing lost');
  assert.ok(pending.bytes < 4000, 'what is gathering is under the limit');

  for (const d of listed) {
    const body = dumps.body(d.id);
    assert.ok(bytesOf(body) <= 4000, `dump ${d.id} is ${bytesOf(body)} bytes`);
    assert.equal(bytesOf(body), d.bytes, 'and the list says its size truly');
    const lines = body.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'dump', 'the first line says what it is');
    assert.equal(lines[0].events, lines.length - 1);
    // A second full dump would not have fitted what went into the next one.
    if (d.id < listed.length) assert.ok(d.bytes > 4000 - 512 - 200, `dump ${d.id} was cut early at ${d.bytes}`);
  }
  assert.equal(dumps.body(999), null);
});

test('a megabyte is the most any dump can be, and an event too big for one is refused', () => {
  assert.equal(DUMP_BYTES, 1_000_000);
  const dumps = createDumps({ now: () => 2_000 });
  const long = 'x'.repeat(4000);
  for (let i = 0; i < 600; i++) dumps.add(said(i, { body: long }));
  dumps.add(said(9999, { body: 'y'.repeat(DUMP_BYTES) }));
  const { dumps: listed, tooBig } = dumps.list();
  assert.equal(tooBig, 1);
  assert.ok(listed.length >= 2);
  for (const d of listed) assert.ok(bytesOf(dumps.body(d.id)) <= DUMP_BYTES, `${d.bytes}`);
});

test('a forgotten message goes from every dump, and an emptied dump goes altogether', () => {
  const dumps = createDumps({ bytes: 2000, now: () => 2_000 });
  for (let i = 0; i < 30; i++) dumps.add(said(i));
  const [first] = dumps.list().dumps;
  const body = dumps.body(first.id);
  const ids = body.trimEnd().split('\n').slice(1).map((l) => JSON.parse(l).id);

  // The last one said is still gathering, not yet in any dump.
  const gathering = dumps.list().pending.events;
  assert.ok(gathering >= 1);

  dumps.forget([ids[0], 'm29', 'not-a-message-here']);
  const after = dumps.body(first.id);
  assert.ok(!after.includes(`"${ids[0]}"`), 'out of the dump');
  assert.ok(bytesOf(after) < bytesOf(body), 'which only ever shrinks');
  assert.equal(dumps.list().pending.events, gathering - 1, 'and out of what is gathering');

  dumps.forget(ids.slice(1));
  assert.equal(dumps.body(first.id), null, 'nothing left in it, so it is not there');
  assert.ok(!dumps.list().dumps.some((d) => d.id === first.id));
});

test('a dump goes twelve hours after the last thing in it, and only so many are kept', () => {
  let clock = 2_000;
  const dumps = createDumps({ bytes: 2000, keep: 3, keepFor: 10_000, now: () => clock });
  for (let i = 0; i < 100; i++) dumps.add(said(i));
  const listed = dumps.list().dumps;
  assert.equal(listed.length, 3, 'the oldest go first');
  assert.ok(listed[0].id > 1);

  clock = 1_000 + 100 + 10_001;
  assert.deepEqual(dumps.list().dumps, [], 'all of it past its time');
  assert.equal(dumps.list().pending.events, 0, 'what was gathering too');
});

test('a reader a megabyte behind is let go, not buffered for without end', () => {
  const api = createPublicApi(new World(), { dumps: false });
  const ended = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    writableLength: 0,
    writeHead() {
      this.headersSent = true;
      return this;
    },
    write() {},
    end() {
      ended.push(true);
    },
  };
  api.handleRequest({ url: '/api/firehose', method: 'GET', headers: {}, on() {} }, res);
  assert.equal(api.subscribers, 1);
  api.publish({ type: 'message', room: 'art', body: 'keeping up' });
  assert.equal(ended.length, 0);
  res.writableLength = DUMP_BYTES + 1;
  api.publish({ type: 'message', room: 'art', body: 'fallen behind' });
  assert.equal(ended.length, 1);
  assert.equal(api.subscribers, 0);
});

// --- over the wire -------------------------------------------------------------

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function serve(options) {
  const world = new World();
  const chat = createEulerChat({ world, serveClient: true, ...options });
  const port = await listen(chat.server);
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
  return { world, chat, port, get, stop: () => chat.close() };
}

test('the dumps are served as the firehose sent them, and forget what the place forgets', async () => {
  const { world, get, stop } = await serve({ publicApi: true, dumps: { bytes: 3000 } });
  try {
    const art = world.addSubject('art');
    const author = world.addUser('author');
    world.join(author, art);
    // A portal, whose words never go anywhere public.
    const [ana, bo] = [await identity(), await identity()];
    const portal = world.addSubject(await portalWith(ana, bo.publicKey));
    world.join(author, portal);
    world.post(author, [portal], 'meet by the mycology circle');
    world.post(author, [art], '', { envelope: { sealed: true, body: 'b3BhcXVl', keys: {}, iv: 'x', from: {} } });

    const posted = [];
    for (let i = 0; i < 40; i++) posted.push(world.post(author, [art], `said aloud, number ${i}`));

    const index = await (await get('/api')).json();
    assert.equal(index.dumps, '/api/dumps');
    const list = await (await get('/api/dumps')).json();
    assert.ok(list.dumps.length >= 2, `${list.dumps.length} dumps`);
    assert.equal(list.bytes, 3000);

    const res = await get(list.dumps[0].url);
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    const text = await res.text();
    assert.ok(bytesOf(text) <= 3000);
    const lines = text.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'dump');
    assert.ok(!lines[0].demo, 'a real server does not call itself a demo');

    let everything = '';
    for (const d of list.dumps) everything += await (await get(d.url)).text();
    assert.ok(!everything.includes('mycology'), 'a portal is in no dump');
    assert.ok(!everything.includes(portal), 'not even its name');
    const sealed = everything.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.sealed);
    assert.equal(sealed.body, null, 'a sealed message is its envelope, and nothing more');
    assert.equal(sealed.envelope.body, 'b3BhcXVl');

    // Asked for back: gone from the dump it was in, and said on the stream.
    const first = lines.find((l) => l.type === 'message' && !l.sealed);
    world.forget(author, first.id);
    const after = await (await get(list.dumps[0].url)).text();
    assert.ok(!after.includes(`"${first.id}"`), 'out of the dump');

    // And a later dump says so, for anybody who took a copy before: by the
    // commitment they can work out from their copy alone, and by nothing
    // anybody without one could look up.
    world.forget(author, sealed.id);
    for (let i = 0; i < 20; i++) world.post(author, [art], `and more, number ${i}`);
    const later = (await (await get('/api/dumps')).json()).dumps;
    let events = [];
    for (const d of later) events = events.concat((await (await get(d.url)).text()).trimEnd().split('\n').map((l) => JSON.parse(l)));
    const [told, toldSealed] = events.filter((e) => e.type === 'forgotten');
    assert.ok(told, 'the forgetting is in a dump');
    assert.deepEqual(told.commitments, [await commitment(first)], 'found from the copy');
    assert.deepEqual(toldSealed.commitments, [await commitment(sealed)], 'a sealed one too, from its envelope');
    assert.equal(told.receipt, world.deletions[told.seq].hash, 'with the record that names it');
    assert.deepEqual(world.deletions[told.seq].commitments, told.commitments);
    assert.ok(!('ids' in told), 'and not by id');
    assert.ok(!JSON.stringify(events.filter((e) => e.type === 'forgotten')).includes(first.id), 'nowhere in it');
    assert.equal(told.reason, 'asked');
    assert.ok(!events.some((e) => e.type === 'message' && e.id === first.id), 'and the words are in none');
    assert.ok(!('part' in told), 'a small one comes whole');
  } finally {
    stop();
  }
});

test('a big forgetting goes out in parts, each small enough for any dump', async () => {
  const { world, chat, stop } = await serve({ publicApi: true, dumps: { bytes: DUMP_BYTES } });
  try {
    const told = [];
    const publish = chat.api.publish;
    chat.api.publish = (event) => {
      if (event.type === 'forgotten') told.push(event);
      return publish(event);
    };
    // Across nine rooms, since a room keeps only so many.
    const author = world.addUser('author');
    const rooms = Array.from({ length: 9 }, (_, i) => world.addSubject(`interest ${i}`));
    for (const room of rooms) world.join(author, room);
    for (let i = 0; i < FORGOTTEN_PER_EVENT * 2 + 5; i++) world.post(author, [rooms[i % rooms.length]], `number ${i}`);

    // A day on: all of it past its twelve hours, forgotten in one sweep.
    world.forgetOld(Date.now() + 24 * 3600_000);
    const record = world.deletions.at(-1);
    assert.equal(record.count, FORGOTTEN_PER_EVENT * 2 + 5);
    assert.deepEqual(told.map((e) => [e.part, e.parts]), [[1, 3], [2, 3], [3, 3]]);
    assert.ok(told.every((e) => e.seq === record.seq && e.receipt === record.hash), 'each names the one record');
    assert.deepEqual(told.flatMap((e) => e.commitments), record.commitments, 'and between them, all of it');
    for (const e of told) assert.ok(bytesOf(JSON.stringify(e)) < DUMP_BYTES / 4, `${bytesOf(JSON.stringify(e))} bytes`);
  } finally {
    stop();
  }
});

test('the dumps and the page for them are there only where the open API is', async () => {
  for (const publicApi of [false, true]) {
    const { get, port, stop } = await serve({ publicApi });
    try {
      assert.equal((await get('/api/dumps')).status, publicApi ? 200 : 404);
      const page = await get('/streams');
      assert.equal(page.status, publicApi ? 200 : 404);
      if (publicApi) assert.match(await page.text(), /public\/streams\.js/);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      const welcome = await new Promise((resolve) => {
        ws.on('message', (raw) => {
          const f = JSON.parse(raw);
          if (f.type === 'welcome') resolve(f);
        });
      });
      ws.close();
      assert.equal(welcome.streams, publicApi, 'the page knows whether to offer the way there');
    } finally {
      stop();
    }
  }
});

test('the demo says so in its index and in the first line of every dump', async () => {
  const world = new World();
  const api = createPublicApi(world, { dumps: { bytes: 1500 }, demo: true });
  // Said just now: with the real clock, anything from 1970 is long forgotten.
  for (let i = 0; i < 30; i++) api.publish(said(i, { at: Date.now() }));
  const server = http.createServer((req, res) => {
    api.handleRequest(req, res);
    if (!res.headersSent) res.writeHead(404).end();
  });
  const port = await listen(server);
  try {
    const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal((await (await get('/api')).json()).demo, true);
    const { dumps } = await (await get('/api/dumps')).json();
    const res = await get(dumps[0].url);
    assert.match(res.headers.get('content-disposition'), /-demo\.ndjson/);
    const head = JSON.parse((await res.text()).split('\n')[0]);
    assert.equal(head.demo, true);
    assert.match(head.note, /made up/);
  } finally {
    server.close();
  }
});
