import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { identity } from '../lib/seal.js';
import { PORTAL_PREFIX, dayOf, isPortal, isPortalRoom, portalWith, portalsWith } from '../lib/portal.js';
import { World } from '../server/store.js';
import { createPublicApi } from '../server/public-api.js';

/**
 * A room only two people can find.
 *
 * Two claims, and both have to be shown rather than stated: that the two of
 * them arrive at the same address without sending it, and that nobody else
 * arrives at it at all. The third - that the open side does not publish what
 * it cannot derive - is the one a mistake would be quietest about, so it is
 * tested against the real handler over a real socket.
 */

test('both sides work out the same address, and neither has to send it', async () => {
  const ana = await identity();
  const bo = await identity();

  const hers = await portalWith(ana, bo.publicKey);
  const his = await portalWith(bo, ana.publicKey);

  assert.equal(hers, his);
  assert.ok(isPortal(hers));
  // And it is a name the catalogue will actually take.
  assert.match(hers, /^[a-z0-9][a-z0-9 -]{0,30}$/);
  assert.equal(new World().addSubject(hers), hers, 'a portal has to survive being named');
});

test('a third party cannot work it out, even holding both public keys', async () => {
  // Every public key here is broadcast to everybody, so this is the ordinary
  // case rather than a hard one: Mallory has both and still needs a private
  // half she does not have.
  const ana = await identity();
  const bo = await identity();
  const mallory = await identity();

  const theirs = await portalWith(ana, bo.publicKey);
  for (const guess of [
    await portalWith(mallory, ana.publicKey),
    await portalWith(mallory, bo.publicKey),
    await portalWith(ana, mallory.publicKey),
  ]) {
    assert.notEqual(guess, theirs);
  }
});

test('the address changes with the day, so one that leaks stops working', async () => {
  const ana = await identity();
  const bo = await identity();

  const monday = await portalWith(ana, bo.publicKey, { on: '2026-03-02' });
  const tuesday = await portalWith(ana, bo.publicKey, { on: '2026-03-03' });
  assert.notEqual(monday, tuesday);

  // Both sides still agree on any given day, whichever way round they ask.
  assert.equal(monday, await portalWith(bo, ana.publicKey, { on: '2026-03-02' }));

  // And the same instant in two time zones is the same day, so two people do
  // not end up in different rooms for the sake of an hour.
  assert.equal(dayOf('2026-03-02T23:30:00Z'), dayOf('2026-03-02T23:30:00+00:00'));

  // Midnight does not end a conversation: yesterday's address is still known.
  const [today, before] = await portalsWith(ana, bo.publicKey);
  assert.notEqual(today, before);
  assert.equal(today, await portalWith(ana, bo.publicKey));
});

test('a region is a portal if any part of it is', () => {
  assert.equal(isPortalRoom(`${PORTAL_PREFIX}abcdefgh`), true);
  // The portal subject names the whole region, so the whole key is withheld.
  assert.equal(isPortalRoom(`art+${PORTAL_PREFIX}abcdefgh`), true);
  assert.equal(isPortalRoom('art+philosophy'), false);
  assert.equal(isPortalRoom(''), false);
  assert.equal(isPortalRoom(null), false);
  // A subject somebody typed that merely begins with the word is not one of
  // these — but it is also not a name anybody can reach, since the catalogue
  // would take it and the open side would then withhold it. Worth knowing.
  assert.equal(isPortal('portal-ish idea'), true);
});

// --- what the open side does with one ---------------------------------------

/** A world with something said in the open and something said in a portal. */
async function spoken() {
  const ana = await identity();
  const bo = await identity();
  const address = await portalWith(ana, bo.publicKey);

  const world = new World();
  const art = world.addSubject('art');
  const portal = world.addSubject(address);
  const a = world.addUser('ana');
  const b = world.addUser('bo');
  for (const who of [a, b]) {
    world.join(who, art);
    world.join(who, portal);
  }
  world.post(a, [art], 'said in the open');
  world.post(a, [portal], 'meet by the mycology circle');

  return { world, address, art };
}

test('the open read side does not publish a portal', async () => {
  const { world, address } = await spoken();
  const api = createPublicApi(world, {});
  const server = http.createServer((req, res) => {
    api.handleRequest(req, res);
    if (!res.headersSent) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();

  try {
    // The room list: the open room is there, the portal is not.
    const { rooms } = await get('/api/rooms');
    assert.deepEqual(rooms.map((r) => r.key), ['art']);

    // The whole scrape, which is the endpoint that exists to hand over
    // everything. It must not be a way around the line above.
    const { messages } = await get('/api/scrape');
    assert.deepEqual(messages.map((m) => m.body), ['said in the open']);

    // And asking for it by name, which is what somebody who had guessed an
    // address would do. The answer is the one a room that does not exist
    // gets, because a different answer would confirm the guess.
    const direct = await fetch(`http://127.0.0.1:${port}/api/rooms/${encodeURIComponent(address)}/log`);
    assert.equal(direct.status, 404);
    const missing = await fetch(`http://127.0.0.1:${port}/api/rooms/nothing-here/log`);
    assert.equal(direct.status, missing.status);
    assert.deepEqual(await direct.json(), await missing.json());

    // Nothing anywhere in the open side mentions the address or the words.
    const everything = JSON.stringify([
      await get('/api/rooms'),
      await get('/api/scrape'),
      await get('/api/receipts'),
    ]);
    assert.ok(!everything.includes(address), 'the address must not appear anywhere');
    assert.ok(!everything.includes('mycology'), 'nor anything said inside');
  } finally {
    api.close();
    await new Promise((r) => server.close(r));
  }
});

test('the firehose carries the open rooms and not the portal', async () => {
  // The live stream is the endpoint most likely to be forgotten, because it
  // is fed from a different call site than the ones above. So it is read the
  // way anybody watching it would: over a socket, as it happens.
  const { world, address, art } = await spoken();
  const api = createPublicApi(world, {});
  const server = http.createServer((req, res) => {
    api.handleRequest(req, res);
    if (!res.headersSent) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const stop = new AbortController();
  let seen = '';
  try {
    const stream = await fetch(`http://127.0.0.1:${port}/api/firehose`, { signal: stop.signal });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const reading = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          seen += decoder.decode(value, { stream: true });
        }
      } catch {
        /* aborted at the end of the test, which is how it stops */
      }
    })();

    // Let the connection settle, then say one of each.
    await new Promise((r) => setTimeout(r, 120));
    api.publish({ type: 'message', room: art, body: 'said in the open' });
    api.publish({ type: 'message', room: address, body: 'meet by the mycology circle' });
    api.publish({ type: 'room-opened', room: address, at: Date.now() });
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(seen.includes('said in the open'), 'the open room should reach the stream');
    assert.ok(!seen.includes('mycology'), 'nothing said in a portal may reach the stream');
    assert.ok(!seen.includes(address), 'nor may its address');
    assert.ok(!seen.includes('room-opened'), 'a portal opening is not an event anybody is told about');

    stop.abort();
    await reading;
  } finally {
    stop.abort();
    api.close();
    await new Promise((r) => server.close(r));
  }
});
