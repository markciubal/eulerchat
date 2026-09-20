import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEulerChat, World, seed } from '../server/app.js';
import { KEEP_FOR } from '../server/store.js';
import { clusterFromLink, clusterOf, inviteLink, isCluster, label, newCluster, within } from '../lib/cluster.js';
import { findDeletion, verify } from '../lib/receipt.js';

// --- small private groups --------------------------------------------------

test('a cluster is a name in front, and nothing else', () => {
  assert.equal(within('kite-fox-9', 'art'), 'kite-fox-9/art');
  assert.equal(clusterOf('kite-fox-9/art'), 'kite-fox-9');
  assert.equal(label('kite-fox-9/art'), 'art', 'people see the subject, not the address');

  // Everything outside a cluster is the ordinary open case.
  assert.equal(clusterOf('art'), null);
  assert.equal(label('art'), 'art');

  // Joining twice does not nest twice.
  assert.equal(within('kite-fox-9', 'kite-fox-9/art'), 'kite-fox-9/art');
});

test('a cluster name can be read down a phone and survives a round trip', () => {
  const name = newCluster();
  assert.ok(isCluster(name), `${name} should be a usable name`);

  const link = inviteLink('http://example.com/chat/', name);
  assert.equal(clusterFromLink(link), name);
  assert.equal(clusterFromLink('http://example.com/'), null);
  // A link naming something that is not a cluster names no cluster.
  assert.equal(clusterFromLink('http://example.com/?cluster=../../etc'), null);
});

test('people in a cluster and people outside it do not hear each other', () => {
  const world = new World();
  world.addSubject('art');
  world.addSubject('kite-fox-9/art');

  const outside = world.addUser('outside');
  const inside = world.addUser('inside');
  world.join(outside, 'art');
  world.join(inside, 'kite-fox-9/art');

  world.post(inside, ['kite-fox-9/art'], 'just for us');

  // The whole point of the mechanism: containment already does this, because
  // the two are simply different subjects.
  assert.deepEqual(world.audienceFor(['kite-fox-9/art']), [inside]);
  assert.equal(world.historyFor(outside)['kite-fox-9/art'], undefined);
  assert.ok(world.historyFor(inside)['kite-fox-9/art']);
});

test('a cluster name that is not one is refused', () => {
  const world = new World();
  assert.throws(() => world.addSubject('Not A Cluster/art'), /cluster/);
  // The subject is still tidied the way an unclustered one would be - the
  // address in front is an address, not a word, and is left alone.
  assert.equal(world.addSubject('kite-fox-9/theory of entomology'), 'kite-fox-9/entomology');
  assert.equal(world.addSubject('theory of entomology'), 'entomology');
});

// --- votes -----------------------------------------------------------------

test('one person, one vote, and pressing it again takes it back', () => {
  const world = new World();
  world.addSubject('art');
  const author = world.addUser('author');
  const reader = world.addUser('reader');
  world.join(author, 'art');
  world.join(reader, 'art');
  const said = world.post(author, ['art'], 'a thought');

  assert.equal(world.vote(reader, said.id, 1).score, 1);
  assert.equal(world.vote(reader, said.id, 1).score, 0, 'the same button again undoes it');
  assert.equal(world.vote(reader, said.id, -1).score, -1);
  assert.equal(world.vote(reader, said.id, 1).score, 1, 'changing your mind replaces, not adds');
  assert.equal(world.tally(said.id, reader).yours, 1);

  // Somebody who is not in the room has no say in it.
  const outsider = world.addUser('outsider');
  assert.throws(() => world.vote(outsider, said.id, 1), /not in/);
});

test('votes are not moderation', () => {
  // A message people dislike is not a message that broke a rule. If votes fed
  // the concern ranking, organising a few friends would be the quickest way
  // to get somebody moderated.
  const world = new World();
  world.addSubject('art');
  const author = world.addUser('author');
  world.join(author, 'art');
  const said = world.post(author, ['art'], 'an unpopular opinion');

  for (let i = 0; i < 10; i++) {
    const voter = world.addUser(`v${i}`);
    world.join(voter, 'art');
    world.vote(voter, said.id, -1);
  }

  assert.equal(world.tally(said.id).score, -10);
  assert.deepEqual(world.concerns(), [], 'unpopular is not reportable');
});

// --- deletion receipts -----------------------------------------------------

test('a deletion is recorded in a chain that cannot be quietly rewritten', async () => {
  const world = new World();
  world.addSubject('art');
  const author = world.addUser('author');
  world.join(author, 'art');
  world.post(author, ['art'], 'first');
  world.post(author, ['art'], 'second');

  for (const message of world.messages.get('art')) message.at = Date.now() - KEEP_FOR - 1;
  const kept = world.messages.get('art').map((m) => ({ ...m }));
  world.forgetOld();

  const chain = world.receipts();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].count, 2);
  assert.equal((await verify(chain)).ok, true);

  // Somebody holding their own copy can check that this exact message is named.
  assert.equal((await findDeletion(kept[0], chain)).deleted, true);

  // And editing history after the fact is caught.
  const tampered = structuredClone(chain);
  tampered[0].commitments.pop();
  tampered[0].count -= 1;
  const checked = await verify(tampered);
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join(' '), /changed since it was written/);
});

test('a receipt names messages without republishing them', async () => {
  const world = new World();
  world.addSubject('art');
  const author = world.addUser('author');
  world.join(author, 'art');
  world.post(author, ['art'], 'the chanterelles are up behind the quarry');
  for (const m of world.messages.get('art')) m.at = Date.now() - KEEP_FOR - 1;
  world.forgetOld();

  const published = JSON.stringify(world.receipts());
  assert.ok(!published.includes('chanterelles'), 'a receipt must not put the words back');
  assert.ok(!published.includes('quarry'));
});

test('deleting your own message on request leaves the same trail', async () => {
  const world = new World();
  world.addSubject('art');
  const author = world.addUser('author');
  const other = world.addUser('other');
  world.join(author, 'art');
  world.join(other, 'art');
  const said = world.post(author, ['art'], 'said in haste');

  assert.throws(() => world.forget(other, said.id), /your own/);

  const receipt = world.forget(author, said.id);
  assert.equal(receipt.reason, 'asked');
  assert.equal(world.messages.has('art'), false);
  assert.equal((await verify(world.receipts())).ok, true);
  assert.equal((await findDeletion(said, world.receipts())).deleted, true);
});

// --- the open read side ----------------------------------------------------

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function open() {
  const world = seed(new World());
  // With a catch-all of its own, as any real host has. Without one, a path the
  // library deliberately stays silent on is answered by nobody and the request
  // hangs until it is killed - which is what a missing 404 looks like from the
  // outside, and is worth having the harness reproduce faithfully.
  const host = http.createServer((req, res) => {
    if (!res.headersSent) res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  const chat = createEulerChat({ world, server: host });
  const port = await listen(host);
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
  return { world, chat, host, port, get, stop: () => (chat.close(), host.close()) };
}

test('anyone can read the rooms and any room log', async () => {
  const { get, stop } = await open();
  try {
    const { body: index } = await get('/api');
    assert.ok(index.firehose, 'it says what is here');
    assert.match(index.notes.open, /public/);

    const { body: rooms } = await get('/api/rooms');
    assert.ok(rooms.rooms.length > 1);

    const { body: log } = await get('/api/rooms/art/log');
    assert.ok(log.messages.length >= 1);
    assert.equal(typeof log.messages[0].body, 'string');
    assert.equal((await get('/api/rooms/nonesuch/log')).status, 404);
  } finally {
    stop();
  }
});

test('a scrape is resumable and does not repeat itself', async () => {
  const { get, stop } = await open();
  try {
    const first = (await get('/api/scrape?limit=2')).body;
    assert.equal(first.messages.length, 2);
    assert.equal(first.more, true);

    const second = (await get(`/api/scrape?limit=2&since=${first.nextSince}`)).body;
    const overlap = second.messages.filter((m) => first.messages.some((f) => f.id === m.id));
    assert.deepEqual(overlap, [], 'a cursor that repeats itself makes a scraper loop');
  } finally {
    stop();
  }
});

test('a sealed message is served as ciphertext, never as words', async () => {
  const { world, get, stop } = await open();
  try {
    const author = [...world.profiles.keys()][0];
    world.post(author, ['art'], '', {
      envelope: { sealed: true, body: 'b3BhcXVl', keys: {}, iv: 'x', from: {} },
    });

    const { body } = await get('/api/rooms/art/log');
    const sealed = body.messages.find((m) => m.sealed);
    assert.ok(sealed, 'it is still listed');
    assert.equal(sealed.body, null, 'there is no text to serve and none is invented');
    assert.equal(sealed.envelope.body, 'b3BhcXVl', 'the ciphertext is what the server holds');
  } finally {
    stop();
  }
});

test('reports are not on the open side', async () => {
  const { world, get, stop } = await open();
  try {
    const [author, reader] = [...world.profiles.keys()];
    const said = world.post(author, ['art'], 'something unpleasant');
    world.join(reader, 'art');
    world.report(reader, said.id, 'abuse', { note: 'aimed at me' });

    // Everything else here is open; this is the one thing held back, because
    // naming the person who complained is how reporting stops happening.
    assert.equal((await get('/api/reports')).status, 404);
    const everything = JSON.stringify((await get('/api/scrape?limit=500')).body);
    assert.ok(!everything.includes('aimed at me'), 'and it does not leak through a scrape');
  } finally {
    stop();
  }
});

test('the firehose carries what is said, as it is said', async () => {
  const { world, chat, port, stop } = await open();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/firehose`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
    })().catch(() => {});

    // Wait for the subscription to be registered rather than for the clock.
    const until = Date.now() + 4000;
    while (chat.api.subscribers === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(chat.api.subscribers, 1);

    const author = [...world.profiles.keys()][0];
    world.post(author, ['art'], 'said into the firehose');

    const deadline = Date.now() + 4000;
    while (!seen.includes('said into the firehose') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.match(seen, /event: message/);
    assert.match(seen, /said into the firehose/);

    await reader.cancel().catch(() => {});
  } finally {
    stop();
  }
});

test('the open API only reads', async () => {
  const { port, stop } = await open();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' });
    assert.equal(res.status, 405);
  } finally {
    stop();
  }
});
