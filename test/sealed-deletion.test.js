import test from 'node:test';
import assert from 'node:assert/strict';
import { identity, seal, unseal } from '../lib/seal.js';
import { commitment, findDeletion, verify } from '../lib/receipt.js';
import http from 'node:http';
import { KEEP_FOR, World } from '../server/store.js';
import { createEulerChat } from '../server/app.js';

/**
 * Encrypted messages in the deletion record.
 *
 * The server never has the words of an encrypted message, so the record names
 * the scrambled text instead — and only somebody who received that message
 * holds the scrambled text, so only they can recognise it there. These tests
 * pin that down from the side of the person holding a copy, which is the only
 * side the record is for.
 */

/** Two people in a room, one of whom has sent the other something encrypted. */
async function sealedExchange() {
  const world = new World();
  world.addSubject('art');
  const ana = world.addUser('ana');
  const bo = world.addUser('bo');
  world.join(ana, 'art');
  world.join(bo, 'art');

  const anaKeys = await identity();
  const boKeys = await identity();
  const secret = 'meet by the mycology circle';
  const envelope = await seal(secret, anaKeys, [boKeys.publicKey]);
  const sent = world.post(ana, ['art'], '', { envelope });

  // What Bo's browser holds: the message as it arrived, and then — once it has
  // decrypted it — the same message with the words filled in. Both are copies
  // somebody might keep, so both have to be recognisable.
  const asArrived = structuredClone(sent);
  const asRead = { ...structuredClone(sent), body: await unseal(envelope, boKeys) };
  return { world, ana, bo, sent, asArrived, asRead, secret };
}

test('deleting an encrypted message records it, by its scrambled text', async () => {
  const { world, ana, sent, asArrived } = await sealedExchange();
  assert.equal(sent.sealed, true);

  const receipt = world.forget(ana, sent.id);
  assert.equal(receipt.reason, 'asked');
  assert.ok(
    receipt.commitments.includes(await commitment(asArrived)),
    'the record should name the message somebody received',
  );
  assert.equal((await verify(world.receipts())).ok, true);
});

test('an encrypted message that ages out is recorded the same way', async () => {
  const { world, asArrived } = await sealedExchange();
  world.forgetOld(Date.now() + KEEP_FOR + 1000);

  const found = await findDeletion(asArrived, world.receipts());
  assert.equal(found.deleted, true);
  assert.equal(found.reason, 'expired');
});

test('a copy with the words filled in is still recognised', async () => {
  // The browser decrypts a message and puts the words where the empty body
  // was. The record is keyed on the scrambled text, not on the body, so the
  // copy a reader actually keeps must still match. If the words went into the
  // hash, no copy anybody kept of an encrypted message would ever be found.
  const { world, ana, sent, asRead, secret } = await sealedExchange();
  assert.equal(asRead.body, secret, 'the reader should have the words');

  world.forget(ana, sent.id);
  assert.equal((await findDeletion(asRead, world.receipts())).deleted, true);
});

test('the record names an encrypted message without carrying it', async () => {
  const { world, ana, sent, secret } = await sealedExchange();
  world.forget(ana, sent.id);

  const published = JSON.stringify(world.receipts());
  assert.ok(!published.includes(secret), 'not the words');
  assert.ok(!published.includes(sent.envelope.body), 'and not the scrambled text either');
});

test('a changed copy is not recognised, so the record cannot be matched by guessing', async () => {
  const { world, ana, sent, asArrived } = await sealedExchange();
  world.forget(ana, sent.id);

  const altered = structuredClone(asArrived);
  altered.envelope.body = `${altered.envelope.body.slice(0, -4)}AAAA`;
  assert.equal((await findDeletion(altered, world.receipts())).deleted, false);

  const moved = { ...structuredClone(asArrived), room: 'music' };
  assert.equal((await findDeletion(moved, world.receipts())).deleted, false);
});

test('the record can be fetched over the live connection, with the open read side off', async () => {
  // A host that mounts this without the public API still owes the people in
  // its rooms a way to check what was deleted. The record is hashes only, so
  // handing it to them hands over nothing a message could be rebuilt from.
  const { world, ana, sent } = await sealedExchange();
  world.forget(ana, sent.id);

  const host = http.createServer();
  const chat = createEulerChat({ world, server: host, serveClient: false });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  const socket = new WebSocket(`ws://127.0.0.1:${host.address().port}`);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    const answer = new Promise((resolve) =>
      socket.addEventListener('message', (e) => {
        const frame = JSON.parse(e.data);
        if (frame.type === 'receipts') resolve(frame);
      }),
    );
    socket.send(JSON.stringify({ type: 'receipts' }));
    const frame = await answer;

    assert.deepEqual(frame.receipts, world.receipts());
    assert.equal(frame.head, world.deletions.at(-1).hash);
    assert.equal((await verify(frame.receipts)).ok, true);
  } finally {
    socket.close();
    chat.close();
    await new Promise((r) => host.close(r));
  }
});
