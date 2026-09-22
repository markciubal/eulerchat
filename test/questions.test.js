import test from 'node:test';
import assert from 'node:assert/strict';
import { World, seed } from '../server/store.js';
import { MemoryLedger } from '../server/ledger.js';
import { askSomewhere, startQuestions } from '../server/questions.js';
import { ask } from '../lib/questions.js';
import { commitmentInput } from '../lib/receipt.js';
import { classify, QUIET } from '../lib/notify.js';

/**
 * Machine questions: on topic, only ever as a sample person, never where they
 * would get in the way, and labelled in a way that cannot be taken off.
 */

const later = () => Date.now() + 10 * 60 * 1000;
const sequence = (seed = 5) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test('a question names the room it is asked in, and claims nothing', () => {
  const random = sequence();
  const many = ['art', 'music', 'poetry', 'philosophy', 'chess'];
  const most = [...many, 'film', 'jazz', 'opera', 'dance', 'theatre'];
  for (const room of [['entomology'], ['board games'], ['art'], ['art', 'philosophy'], ['music', 'poetry', 'philosophy'], many, most]) {
    for (let i = 0; i < 40; i++) {
      const question = ask(room, { random });
      for (const subject of room) assert.ok(question.includes(subject), `"${question}" is not about ${subject}`);
      assert.match(question, /\?$/, 'it is a question');
      assert.doesNotMatch(question, /\{|\}|undefined|null/, `an unfilled blank in "${question}"`);
      // A question to the room, never somebody claiming to have done something.
      assert.doesNotMatch(question, /\b(I|I'm|I've|my|me|mine)\b/, `"${question}" speaks as somebody`);
    }
  }
});

test('a question is asked as a sample person, in a room somebody online can read', () => {
  const world = seed(new World());
  const reader = world.addUser('reader');
  world.join(reader, 'music');

  const message = askSomewhere(world, { present: [reader], now: later(), random: sequence() });
  assert.ok(message, 'somewhere suited');
  assert.equal(message.machine, true);
  assert.equal(message.room, 'music', 'the only room the one person online can read');
  assert.equal(world.profiles.get(message.authorId).synthetic, true);
  assert.notEqual(message.authorId, reader, 'never as the person reading');
  assert.match(message.body, /music/);

  // Not twice running: the room is waiting for an answer, not another question.
  assert.equal(askSomewhere(world, { present: [reader], now: later(), random: sequence() }), null);
});

test('never as a real person, and never talking over one', () => {
  // A world of real people: nobody synthetic to ask as, so nothing is asked,
  // though the rooms are quiet and somebody is online to read them.
  const real = new World();
  real.addSubject('music');
  const [a, b] = [real.addUser('a'), real.addUser('b')];
  real.join(a, 'music');
  real.join(b, 'music');
  assert.equal(askSomewhere(real, { present: [a], now: later() }), null);

  // A room somebody spoke in a minute ago is left alone.
  const world = seed(new World());
  const reader = world.addUser('reader');
  world.join(reader, 'music');
  world.post(reader, ['music'], 'anyone around?');
  assert.equal(askSomewhere(world, { present: [reader], now: Date.now() + 60_000 }), null);
  // And nobody online, nobody to ask.
  assert.equal(askSomewhere(world, { present: [], now: later() }), null);
});

test('a freshly started sample world does not have to be waited out', () => {
  // Every seeded room was just spoken in, by sample people. That is not a
  // conversation to keep out of, so the first question comes straight away.
  const world = seed(new World());
  const reader = world.addUser('reader');
  world.join(reader, 'music');
  assert.ok(askSomewhere(world, { present: [reader], now: Date.now() }));
});

test('never inside a group', () => {
  const world = seed(new World());
  const reader = world.addUser('reader');
  world.join(reader, world.addSubject('kite-fox-9/music'));
  for (let i = 0; i < 3; i++) {
    const sample = world.addUser(`s${i}`, { synthetic: true });
    world.join(sample, world.addSubject('kite-fox-9/music'));
  }
  assert.equal(askSomewhere(world, { present: [reader], now: later() }), null, 'the people at a table did not ask to be prompted');
});

test('the label is in the hash, so a restart cannot take it off or put it on', () => {
  const ledger = new MemoryLedger();
  const world = seed(new World());
  world.useLedger(ledger);
  const reader = world.addUser('reader');
  world.join(reader, 'music');
  const question = askSomewhere(world, { present: [reader], now: later() });
  const person = world.post(reader, ['music'], 'a person, answering');

  // Every message written before this still names itself the same way.
  assert.equal(commitmentInput({ ...person }), commitmentInput({ ...person, machine: false }));
  assert.notEqual(commitmentInput({ ...person }), commitmentInput({ ...person, machine: true }));

  const fresh = new World();
  fresh.useLedger(ledger);
  assert.equal(fresh.restore([{ ...question, machine: undefined }]).restored, 0, 'a machine question passed off as a person\'s');
  assert.equal(fresh.restore([{ ...person, machine: true }]).restored, 0, 'a person\'s words passed off as a machine\'s');

  const back = fresh.restore([question, person]);
  assert.equal(back.restored, 2);
  const log = fresh.messages.get('music');
  assert.equal(log.find((m) => m.id === question.id).machine, true, 'and it comes back labelled');
  assert.equal(log.find((m) => m.id === person.id).machine, undefined);
});

test('a machine question never interrupts anybody', () => {
  const note = classify(
    {
      type: 'message',
      room: 'music',
      message: { id: 'q', room: 'music', author: 'player-1', authorId: 'p', body: 'What got you into music?', at: 1, reach: 2, machine: true },
    },
    { userId: 'me', name: 'osmo', subscription: ['music'] },
  );
  assert.equal(note.level, QUIET, 'a room of two would otherwise be an alert');
});

test('on a timer, until stopped', async () => {
  const world = seed(new World());
  const reader = world.addUser('reader');
  world.join(reader, 'music');
  const delivered = [];
  const asking = startQuestions({
    world,
    present: () => [reader],
    deliver: (message) => delivered.push(message),
    every: 5,
    quiet: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  asking.stop();
  const count = delivered.length;
  assert.ok(count >= 1, 'something was asked');
  assert.ok(delivered.every((m) => m.machine && m.room === 'music'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(delivered.length, count, 'and nothing after it was stopped');
});

// --- everything nobody said is a system message -------------------------------

test('every line a sample world is made with is a system message', async () => {
  const { populate } = await import('../server/populate.js');
  for (const world of [seed(new World()), populate(new World(), { subjects: 40, users: 120 })]) {
    const said = [...world.messages.values()].flat();
    assert.ok(said.length, 'the world was made with something said in it');
    assert.ok(said.every((m) => m.machine === true), 'and none of it is passed off as a person');
    assert.ok(said.every((m) => world.profiles.get(m.authorId)?.synthetic), 'under sample people\'s names only');
  }
});

test('a person cannot label their own words a system message, or anybody else\'s', async () => {
  const { createRequire } = await import('node:module');
  const { createEulerChat } = await import('../server/app.js');
  const WebSocket = createRequire(import.meta.url)('ws');

  const world = new World();
  world.addSubject('music');
  const chat = createEulerChat({ world, serveClient: false });
  await new Promise((resolve) => chat.server.listen(0, resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${chat.server.address().port}/`);
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw)));
  const until = async (test) => {
    for (let i = 0; i < 200 && !frames.some(test); i++) await new Promise((r) => setTimeout(r, 10));
    return frames.find(test);
  };

  try {
    await new Promise((resolve) => ws.once('open', resolve));
    await until((f) => f.type === 'welcome');
    ws.send(JSON.stringify({ type: 'join', subject: 'music' }));
    await until((f) => f.type === 'state');
    ws.send(JSON.stringify({ type: 'post', tags: ['music'], body: 'just me', machine: true }));
    const got = await until((f) => f.type === 'message');
    assert.equal(got.message.body, 'just me');
    assert.equal(got.message.machine, undefined, 'what a connection sends cannot set it');
  } finally {
    ws.close();
    chat.close();
  }
});
