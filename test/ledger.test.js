import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileLedger, MemoryLedger, isLedger } from '../server/ledger.js';
import { KEEP_FOR, World } from '../server/store.js';

/** A world with something said in it, anchored to a ledger. */
function spoken(ledger = new MemoryLedger()) {
  const world = new World();
  world.useLedger(ledger);
  world.addSubject('art');
  const ana = world.addUser('ana');
  world.join(ana, 'art');
  const said = world.post(ana, ['art'], 'the chanterelles are up behind the quarry');
  return { world, ledger, ana, said };
}

/** The server restarted: same ledger, nothing else. */
const restarted = (ledger) => {
  const world = new World();
  const loaded = world.useLedger(ledger);
  return { world, loaded };
};

test('the ledger holds hashes, not conversations', () => {
  const { ledger } = spoken();

  const written = JSON.stringify(ledger.load());
  assert.ok(!written.includes('chanterelles'), 'the words must not be in the anchor');
  assert.ok(!written.includes('quarry'));
  assert.equal(ledger.load()[0].kind, 'post');
  assert.equal(ledger.load()[0].commitment.length, 64);
});

test('a copy somebody kept comes back; an invented one does not', () => {
  const { ledger, said } = spoken();
  const { world, loaded } = restarted(ledger);

  assert.equal(loaded.messages, 1, 'the anchor survived');
  assert.equal(world.messages.size, 0, 'but the conversation did not');

  assert.deepEqual(world.restore([said]).restored, 1);
  assert.equal(world.messages.get('art')[0].body, 'the chanterelles are up behind the quarry');
});

test('nothing a client makes up is accepted', () => {
  const { ledger, said } = spoken();
  const { world } = restarted(ledger);

  const forgeries = [
    { what: 'invented from nothing', message: { ...said, id: 'zzzzzzzz', body: 'I never said this' } },
    { what: 'a word changed', message: { ...said, body: 'the chanterelles are gone' } },
    { what: 'put in somebody else\'s mouth', message: { ...said, author: 'bo', authorId: 'bo' } },
    { what: 'moved to another room', message: { ...said, room: 'music' } },
    { what: 'back-dated', message: { ...said, at: said.at - 5000 } },
    { what: 'not a message at all', message: { nonsense: true } },
  ];

  for (const { what, message } of forgeries) {
    const result = world.restore([message]);
    assert.equal(result.restored, 0, `accepted something ${what}`);
    assert.equal(result.refused.unknown, 1);
  }
  assert.equal(world.messages.size, 0, 'and none of it reached a room');
});

test('a restart does not undo a deletion', () => {
  // The reason the ledger has to know about deletions at all. Somebody pressed
  // delete; a client that kept a copy must not be able to put it back by
  // waiting for the server to restart.
  const { world: first, ledger, ana, said } = spoken();
  first.forget(ana, said.id);

  const { world } = restarted(ledger);
  const result = world.restore([said]);

  assert.equal(result.restored, 0);
  assert.equal(result.refused.deleted, 1);
  assert.equal(world.messages.size, 0);
});

test('a restart does not undo the twelve hours either', () => {
  // Even with no explicit deletion. The promise was twelve hours, not twelve
  // hours and however long the server happened to stay up.
  const { ledger, said } = spoken();
  const { world } = restarted(ledger);

  const old = { ...said, at: Date.now() - KEEP_FOR - 1 };
  const result = world.restore([old]);

  // It fails as unknown rather than expired, which is the stronger answer: a
  // changed timestamp is a different message and hashes differently.
  assert.equal(result.restored, 0);

  // And a genuine one, once the clock has moved past its window, is refused
  // on its own terms.
  const later = world.restore([said], { now: said.at + KEEP_FOR + 1 });
  assert.equal(later.restored, 0);
  assert.equal(later.refused.expired, 1);
});

test('handing the same copy back twice is not two messages', () => {
  const { ledger, said } = spoken();
  const { world } = restarted(ledger);

  assert.equal(world.restore([said]).restored, 1);
  const again = world.restore([said]);
  assert.equal(again.restored, 0);
  assert.equal(again.refused.duplicate, 1);
  assert.equal(world.messages.get('art').length, 1);
});

test('several people restoring the same room agree about it', () => {
  const world = new World();
  const ledger = new MemoryLedger();
  world.useLedger(ledger);
  world.addSubject('art');
  const ana = world.addUser('ana');
  world.join(ana, 'art');

  const first = world.post(ana, ['art'], 'one');
  const second = world.post(ana, ['art'], 'two');
  const third = world.post(ana, ['art'], 'three');

  const { world: fresh } = restarted(ledger);
  // Two clients with overlapping, partial copies, arriving in the wrong order.
  fresh.restore([third, first]);
  fresh.restore([second, third]);

  assert.deepEqual(
    fresh.messages.get('art').map((m) => m.body),
    ['one', 'two', 'three'],
    'the room is put back in the order it was said, not the order it came back',
  );
});

test('a sealed message comes back sealed, and still unreadable here', () => {
  const world = new World();
  const ledger = new MemoryLedger();
  world.useLedger(ledger);
  world.addSubject('art');
  const ana = world.addUser('ana');
  world.join(ana, 'art');

  const envelope = { sealed: true, body: 'b3BhcXVl', keys: {}, iv: 'x', from: {} };
  const sealed = world.post(ana, ['art'], '', { envelope });

  const { world: fresh } = restarted(ledger);
  assert.equal(fresh.restore([sealed]).restored, 1);

  const back = fresh.messages.get('art')[0];
  assert.equal(back.sealed, true);
  assert.equal(back.body, '', 'the server still cannot read it, which is the point');
  assert.equal(back.envelope.body, 'b3BhcXVl');
});

test('a world with no ledger behaves exactly as it always did', () => {
  const world = new World();
  world.addSubject('art');
  const ana = world.addUser('ana');
  world.join(ana, 'art');

  const said = world.post(ana, ['art'], 'nothing durable here');
  assert.equal(world.messages.get('art').length, 1);
  assert.equal(world.ledger, null);
  // Commitments are still computed, so restoring within one run works.
  assert.equal(world.committed.size, 1);
  void said;
});

test('a ledger needs the two methods and nothing else', () => {
  assert.equal(isLedger({ append() {}, load() {} }), true);
  assert.equal(isLedger({ append() {} }), false);
  assert.equal(isLedger(null), false);
  assert.throws(() => new World().useLedger({}), /append\(\) and load\(\)/);
});

// --- on disk ---------------------------------------------------------------

test('a file ledger survives the process that wrote it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eulerchat-'));
  const file = path.join(dir, 'ledger.jsonl');

  try {
    const ledger = new FileLedger(file);
    const { world, ana, said } = spoken(ledger);
    const second = world.post(ana, ['art'], 'and another thing');
    ledger.close();

    // A different process would do exactly this.
    const reopened = new FileLedger(file);
    const { world: fresh, loaded } = restarted(reopened);
    assert.equal(loaded.messages, 2);

    assert.equal(fresh.restore([said, second]).restored, 2);
    assert.deepEqual(
      fresh.messages.get('art').map((m) => m.body),
      ['the chanterelles are up behind the quarry', 'and another thing'],
    );
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a half-written last line does not stop the server starting', () => {
  // The one way this file gets damaged is a process dying mid-write, which
  // damages exactly the final line. Refusing to boot would turn one lost
  // message into a lost server.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eulerchat-'));
  const file = path.join(dir, 'ledger.jsonl');

  try {
    const ledger = new FileLedger(file);
    spoken(ledger);
    ledger.close();
    fs.appendFileSync(file, '{"kind":"post","commit');

    const reopened = new FileLedger(file);
    assert.equal(reopened.load().length, 1, 'the good records are still there');
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
