import test from 'node:test';
import assert from 'node:assert/strict';
import { available, fingerprint, identity, seal, unseal } from '../lib/seal.js';
import http from 'node:http';
import { createEulerChat } from '../server/app.js';
import { World, seed, KEEP_FOR } from '../server/store.js';

test('a message is readable by its readers and nobody else', async () => {
  const ana = await identity();
  const bo = await identity();
  const stranger = await identity();

  const envelope = await seal('meet by the mycology circle', ana, [ana.publicKey, bo.publicKey]);

  assert.equal(await unseal(envelope, bo), 'meet by the mycology circle');
  assert.equal(await unseal(envelope, ana), 'meet by the mycology circle', 'including the sender');
  // Not an error — arriving after a message was sent is the ordinary case.
  assert.equal(await unseal(envelope, stranger), null);
});

test('nothing readable survives into the envelope', async () => {
  const ana = await identity();
  const bo = await identity();
  const envelope = await seal('the quiet part', ana, [bo.publicKey]);

  const wire = JSON.stringify(envelope);
  assert.ok(!wire.includes('the quiet part'), 'the text must not be in what is sent');
  assert.ok(!wire.includes('quiet'));
  // What a server holds: a ciphertext and a bag of wrapped keys it cannot open.
  assert.deepEqual(Object.keys(envelope).sort(), ['body', 'from', 'iv', 'keys', 'sealed']);
});

test('the key is used once and never again', async () => {
  // One key recovered should cost one message, not a conversation.
  const ana = await identity();
  const bo = await identity();

  const one = await seal('identical', ana, [bo.publicKey]);
  const two = await seal('identical', ana, [bo.publicKey]);

  assert.notEqual(one.body, two.body, 'the same words must not encrypt the same way twice');
  assert.notEqual(one.iv, two.iv);
  assert.notEqual(one.keys[bo.id].key, two.keys[bo.id].key);
});

test('a tampered envelope does not open', async () => {
  const ana = await identity();
  const bo = await identity();
  const envelope = await seal('the original', ana, [bo.publicKey]);

  const meddled = { ...envelope, body: envelope.body.replace(/.$/, 'A') };
  await assert.rejects(() => unseal(meddled, bo), 'AES-GCM should refuse a changed message');
});

test('a public key names itself the same way every time', async () => {
  const me = await identity();
  assert.equal(await fingerprint(me.publicKey), me.id);
  assert.equal(me.id.length, 16);
  assert.ok(available());
});

test('unsealing something that is not sealed is not an error', async () => {
  const me = await identity();
  assert.equal(await unseal(null, me), null);
  assert.equal(await unseal({ body: 'plain' }, me), null);
});

// --- what the server keeps -------------------------------------------------

test('the server forgets after twelve hours', async () => {
  const world = new World();
  world.addSubject('art');
  const someone = world.addUser('someone');
  world.join(someone, 'art');

  world.post(someone, ['art'], 'old news');
  world.post(someone, ['art'], 'today');
  const log = world.messages.get('art');
  // Aged in the middle on purpose: deletion must not depend on the old ones
  // happening to come first.
  log[0].at = Date.now() - KEEP_FOR - 1;

  assert.equal(world.forgetOld(), 1, 'everything past the window goes');
  assert.deepEqual(
    world.messages.get('art').map((m) => m.body),
    ['today'],
  );

  // A room with nothing left in it is not kept as an empty one.
  world.messages.get('art')[0].at = Date.now() - KEEP_FOR - 1;
  world.forgetOld();
  assert.equal(world.messages.has('art'), false);
});

test('a sealed message is stored as something the server cannot read', async () => {
  const ana = await identity();
  const bo = await identity();
  const envelope = await seal('only for bo', ana, [bo.publicKey]);

  const world = new World();
  world.addSubject('art');
  const sender = world.addUser('ana');
  world.join(sender, 'art');
  const message = world.post(sender, ['art'], '', { envelope });

  assert.equal(message.sealed, true);
  assert.equal(message.body, '', 'no plaintext is kept');
  assert.ok(!JSON.stringify(world.messages.get('art')).includes('only for bo'));

  // And it is still a real message: routed, counted, and readable by its reader.
  assert.equal(world.stats('art').messages, 1);
  assert.equal(await unseal(message.envelope, bo), 'only for bo');
});

test('keeping a copy is one person\'s setting about their own copy', async () => {
  const world = seed(new World());
  const someone = world.addUser('someone');
  const other = world.addUser('other');

  assert.equal(world.recording(someone), false, 'nobody records by default');
  assert.equal(world.setRecording(someone, true), true);
  assert.equal(world.recording(someone), true);
  // It says nothing about anybody else, and binds nobody.
  assert.equal(world.recording(other), false);
  assert.equal(world.setRecording('nobody at all', true), false);
});

// --- over a real connection ------------------------------------------------

/**
 * The parts above prove the maths and the store separately. What they cannot
 * prove is that the pieces meet: that a public key announced by one connection
 * reaches another, that the reader list a sender is given is the right one,
 * and that what crosses the wire carries no plaintext. Those are three
 * different frames and a route between them, and none of it is exercised by
 * testing `seal()` against `unseal()` in the same process.
 */
const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** A connection that can be waited on by frame rather than by the clock. */
function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const seen = [];
  const waiters = [];

  ws.addEventListener('message', (e) => {
    const frame = JSON.parse(e.data);
    seen.push(frame);
    for (const [i, w] of waiters.entries()) {
      if (w.match(frame)) {
        waiters.splice(i, 1);
        w.resolve(frame);
        break;
      }
    }
  });

  return {
    ws,
    seen,
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    }),
    send: (frame) => ws.send(JSON.stringify(frame)),
    /** Resolves on the first frame that matches, past or future. */
    waitFor(match, limitMs = 8000) {
      const test = typeof match === 'string' ? (f) => f.type === match : match;
      const already = seen.find(test);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no frame matched in ${limitMs}ms; saw ${seen.map((f) => f.type).join(', ')}`)),
          limitMs,
        );
        waiters.push({ match: test, resolve: (f) => (clearTimeout(timer), resolve(f)) });
      });
    },
    close: () => ws.close(),
  };
}

test('a sealed message crosses the wire without the server ever holding the words', async () => {
  const world = new World();
  world.addSubject('mycology');
  const host = http.createServer();
  const chat = createEulerChat({ world, server: host });
  const port = await listen(host);

  const ana = connect(port);
  const bo = connect(port);
  try {
    await Promise.all([ana.ready, bo.ready]);
    await Promise.all([ana.waitFor('state'), bo.waitFor('state')]);

    const anaKeys = await identity();
    const boKeys = await identity();
    ana.send({ type: 'identify', name: 'ana' });
    bo.send({ type: 'identify', name: 'bo' });
    ana.send({ type: 'keys', keyId: anaKeys.id, publicKey: anaKeys.publicKey });
    bo.send({ type: 'keys', keyId: boKeys.id, publicKey: boKeys.publicKey });

    // Each learns the other exists. Announced both ways, so ana hears about
    // bo's key whether bo arrived first or second.
    await ana.waitFor((f) => f.type === 'key' && f.keyId === boKeys.id);

    ana.send({ type: 'join', subject: 'mycology' });
    bo.send({ type: 'join', subject: 'mycology' });
    // Waited on by what the frame says, not by its type. Both had already been
    // sent a `state` and a `history` on arrival, so waiting for the next one
    // of either resolved against those — and ana went on to ask who was in the
    // room before bo's join had been dealt with. Two connections have no
    // ordering between them; the only honest signal that a join landed is a
    // frame that shows it.
    const joined = (f) => f.type === 'state' && f.subscription.includes('mycology');
    await Promise.all([ana.waitFor(joined), bo.waitFor(joined)]);

    ana.send({ type: 'readers', room: 'mycology' });
    const list = await ana.waitFor('readers');
    const ids = list.readers.map((r) => r.keyId).sort();
    assert.deepEqual(ids, [anaKeys.id, boKeys.id].sort(), 'both people in the room, and nobody else');

    const secret = 'the chanterelles are up behind the quarry';
    const envelope = await seal(secret, anaKeys, list.readers.map((r) => r.publicKey));
    ana.send({ type: 'post', tags: ['mycology'], body: '', envelope });

    const delivered = await bo.waitFor((f) => f.type === 'message' && f.message.sealed);
    assert.equal(await unseal(delivered.message.envelope, boKeys), secret, 'the reader can open it');

    // The two places the words would leak if anything were wrong: what the
    // server kept, and what it put on the wire.
    const stored = JSON.stringify([...world.messages]);
    assert.ok(!stored.includes('chanterelles'), 'the server holds no plaintext');
    assert.ok(!stored.includes(secret));
    assert.equal(world.messages.get('mycology')[0].body, '');

    // And a stranger who was never a reader gets nothing out of it, even
    // holding the whole frame as the server saw it.
    const stranger = await identity();
    assert.equal(await unseal(delivered.message.envelope, stranger), null);
  } finally {
    ana.close();
    bo.close();
    await chat.close?.();
    host.close();
  }
});

test('keeping a copy round-trips over the wire and is off until asked for', async () => {
  const world = seed(new World());
  const host = http.createServer();
  const chat = createEulerChat({ world, server: host });
  const port = await listen(host);

  const someone = connect(port);
  try {
    await someone.ready;
    await someone.waitFor('state');

    someone.send({ type: 'record', on: true });
    assert.equal((await someone.waitFor('recording')).on, true);

    someone.send({ type: 'record', on: false });
    assert.equal((await someone.waitFor((f) => f.type === 'recording' && f.on === false)).on, false);
  } finally {
    someone.close();
    await chat.close?.();
    host.close();
  }
});
