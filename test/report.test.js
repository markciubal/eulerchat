import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEulerChat } from '../server/app.js';
import { KEEP_FOR, REPORTS_KEEP_FOR, World } from '../server/store.js';

/** A world with two people in one room and something said in it. */
function room() {
  const world = new World();
  world.addSubject('art');
  const ana = world.addUser('ana');
  const bo = world.addUser('bo');
  world.join(ana, 'art');
  world.join(bo, 'art');
  const said = world.post(ana, ['art'], 'something unpleasant');
  return { world, ana, bo, said };
}

test('reporting a message records who, what and why', () => {
  const { world, bo, said } = room();
  const { already, report } = world.report(bo, said.id, 'abuse', { note: 'aimed at me' });

  assert.equal(already, false);
  assert.equal(report.room, 'art');
  assert.equal(report.by, bo);
  assert.equal(report.reason, 'abuse');
  assert.equal(report.note, 'aimed at me');
  assert.equal(report.message.body, 'something unpleasant', 'the evidence travels with the complaint');
});

test('the same person reporting twice is still one report', () => {
  const { world, bo, said } = room();
  world.report(bo, said.id, 'abuse');
  const second = world.report(bo, said.id, 'abuse');

  // Pressing the button again is not more evidence, and counting it would let
  // one person manufacture a case on their own.
  assert.equal(second.already, true);
  assert.equal(world.reports.get('art').length, 1);
});

test('you cannot report your own message, or a room you are not in', () => {
  const { world, ana, said } = room();
  assert.throws(() => world.report(ana, said.id, 'abuse'), /your own/);

  // Somebody who was never here. Letting them complain would make reporting a
  // way of attacking a room rather than of moderating one.
  const outsider = world.addUser('outsider');
  assert.throws(() => world.report(outsider, said.id, 'abuse'), /not in/);

  assert.throws(() => world.report('nobody', said.id, 'abuse'), /no such person/);
  assert.throws(() => world.report(world.addUser('x'), 'no-such-id', 'abuse'), /no such message/);
});

test('an unrecognised reason is filed rather than refused', () => {
  const { world, bo, said } = room();
  // Refusing would lose a real complaint over a typo in a frame.
  const { report } = world.report(bo, said.id, 'something-made-up');
  assert.equal(report.reason, 'other');
});

test('a report outlives the message it is about', () => {
  // The point of the whole exception. A message reported at hour eleven would
  // otherwise take its own evidence with it an hour later, and a moderator
  // would be looking at a complaint about nothing.
  const { world, bo, said } = room();
  world.report(bo, said.id, 'hate');

  world.messages.get('art')[0].at = Date.now() - KEEP_FOR - 1;
  world.forgetOld();

  assert.equal(world.messages.has('art'), false, 'the conversation is gone as promised');
  const [held] = world.reports.get('art');
  assert.equal(held.message.body, 'something unpleasant', 'the reported message is still there');
  assert.equal(world.concerns()[0].room, 'art');
});

test('reports are forgotten too, on their own longer clock', () => {
  const { world, bo, said } = room();
  world.report(bo, said.id, 'abuse');

  world.reports.get('art')[0].at = Date.now() - REPORTS_KEEP_FOR - 1;
  world.forgetOld();

  assert.equal(world.reports.has('art'), false, 'the exception has an end');
  assert.deepEqual(world.concerns(), []);
});

test('reporting a sealed message is the reporter choosing to show it', () => {
  const world = new World();
  world.addSubject('art');
  const ana = world.addUser('ana');
  const bo = world.addUser('bo');
  world.join(ana, 'art');
  world.join(bo, 'art');

  // The server never could read this one.
  const sealed = world.post(ana, ['art'], '', { envelope: { sealed: true, body: 'opaque', keys: {} } });
  assert.equal(sealed.body, '');

  const { report } = world.report(bo, sealed.id, 'hate', { disclosed: 'what was actually said' });

  assert.equal(report.message.body, 'what was actually said');
  // Recorded as a disclosure, so that nobody later reads this as something the
  // server was able to see on its own. It was not; a person chose to show it.
  assert.equal(report.message.disclosedByReporter, true);
  assert.equal(report.message.sealed, true);
});

test('a sealed message reported without the text is still a report', () => {
  const world = new World();
  world.addSubject('art');
  const ana = world.addUser('ana');
  const bo = world.addUser('bo');
  world.join(ana, 'art');
  world.join(bo, 'art');
  const sealed = world.post(ana, ['art'], '', { envelope: { sealed: true, body: 'opaque', keys: {} } });

  // They are entitled to complain without handing over the text, and the room
  // still needs to appear. A complaint with no evidence is weaker, not void.
  const { report } = world.report(bo, sealed.id, 'threat');
  assert.equal(report.message.body, '');
  assert.equal(report.message.disclosedByReporter, false);
  assert.equal(world.concerns()[0].room, 'art');
});

test('reports do not travel on the feed that notifies people', () => {
  const { world, bo, said } = room();

  const notified = [];
  const reported = [];
  world.watch((event) => notified.push(event));
  world.onReport((report) => reported.push(report));

  world.report(bo, said.id, 'abuse');

  // Who complained about whom must not reach the room. These are two pipes on
  // purpose, so that confusing them has to be a deliberate act.
  assert.deepEqual(notified, [], 'nothing about a report goes to the notification feed');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].by, bo);
});

test('a moderator can clear a room, and a new report brings it back', () => {
  const { world, bo, said } = room();
  world.report(bo, said.id, 'language');
  assert.equal(world.concerns().length, 1);

  assert.equal(world.clear('art', 'mod'), true);
  assert.deepEqual(world.concerns(), [], 'judged fine, so it stops filling the list');
  // The evidence is not deleted by a judgement about it.
  assert.equal(world.reports.get('art').length, 1);
  assert.equal(world.concern('art').cleared.by, 'mod');

  const again = world.post(bo, ['art'], 'more of it');
  world.report(world.profiles.keys().next().value, again.id, 'abuse');
  assert.equal(world.concerns().length, 1, 'a fresh complaint reopens it');
});

test('the word list is off until an operator turns it on', () => {
  const { world, ana } = room();
  world.post(ana, ['art'], 'what the fuck is this');
  assert.equal(world.flagged.get('art') ?? 0, 0, 'nothing is scanned by default');

  world.watchWords();
  world.post(ana, ['art'], 'what the fuck is this');
  assert.equal(world.flagged.get('art'), 1);

  // And it cannot see a sealed message, which is what sealing means.
  world.post(ana, ['art'], '', { envelope: { sealed: true, body: 'opaque', keys: {} } });
  assert.equal(world.flagged.get('art'), 1, 'a sealed message is not guessed at');

  assert.equal(world.watchWords(null), false);
});

test('concerns answers which rooms, not which messages', () => {
  const world = new World();
  for (const subject of ['art', 'music']) world.addSubject(subject);
  const people = Array.from({ length: 5 }, (_, i) => world.addUser(`p${i}`));
  for (const person of people) {
    world.join(person, 'art');
    world.join(person, 'music');
  }

  const bad = world.post(people[0], ['art'], 'something unpleasant');
  const mild = world.post(people[0], ['music'], 'a bit rude');
  for (const person of people.slice(1)) world.report(person, bad.id, 'hate');
  world.report(people[1], mild.id, 'language');

  const concerns = world.concerns();
  assert.equal(concerns[0].room, 'art', 'the worse room leads');
  assert.equal(concerns[0].reporters, 4);
  assert.equal(concerns[0].level, 'urgent');
  assert.ok(concerns[0].why.includes('4 different people'));
  assert.deepEqual(concerns[0].subjects, ['art']);

  // And a moderator can open one room and see what is behind the number.
  const detail = world.concern('art');
  assert.equal(detail.detail.length, 4);
  assert.equal(detail.detail[0].message.body, 'something unpleasant');
});

// --- over a real connection ------------------------------------------------

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

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
    seen,
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    }),
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor(match, limitMs = 8000) {
      const test = typeof match === 'string' ? (f) => f.type === match : match;
      const already = seen.find(test);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`nothing matched; saw ${seen.map((f) => f.type).join(', ')}`)),
          limitMs,
        );
        waiters.push({ match: test, resolve: (f) => (clearTimeout(timer), resolve(f)) });
      });
    },
    close: () => ws.close(),
  };
}

test('a report reaches the moderator and never the room', async () => {
  const world = new World();
  world.addSubject('art');

  // The host decides who moderates, and here it decides by name — which no
  // real deployment should, and is exactly the point: the library does not
  // care how the question is answered, only that somebody else answers it.
  let moderating = false;
  const host = http.createServer();
  const chat = createEulerChat({
    world,
    server: host,
    isModerator: (userId) => moderating && world.profiles.get(userId)?.name === 'moderator',
  });
  const port = await listen(host);

  const author = connect(port);
  const reporter = connect(port);
  const mod = connect(port);

  try {
    await Promise.all([author.ready, reporter.ready, mod.ready]);
    await Promise.all([author.waitFor('state'), reporter.waitFor('state'), mod.waitFor('state')]);

    mod.send({ type: 'identify', name: 'moderator' });
    await mod.waitFor('welcome');

    for (const who of [author, reporter, mod]) who.send({ type: 'join', subject: 'art' });
    const joined = (f) => f.type === 'state' && f.subscription.includes('art');
    await Promise.all([author.waitFor(joined), reporter.waitFor(joined), mod.waitFor(joined)]);

    author.send({ type: 'post', tags: ['art'], body: 'something unpleasant' });
    const delivered = await reporter.waitFor((f) => f.type === 'message' && f.message.body.includes('unpleasant'));

    // Before anyone is trusted, the list is refused.
    mod.send({ type: 'concerns' });
    assert.equal((await mod.waitFor('error')).message, 'not allowed');

    reporter.send({ type: 'report', messageId: delivered.message.id, reason: 'abuse' });
    const ack = await reporter.waitFor('reported');
    assert.equal(ack.room, 'art');
    assert.equal(ack.already, false);

    // Now trusted, and the room appears with the reason it appeared.
    moderating = true;
    mod.send({ type: 'concerns' });
    const list = await mod.waitFor('concerns');
    assert.equal(list.rooms[0].room, 'art');
    assert.equal(list.rooms[0].reporters, 1);
    assert.ok(list.rooms[0].why.includes('reported'));

    // The author is told nothing. Whoever complained is not identified to the
    // room, and in a room of three that identification would be immediate.
    await new Promise((r) => setTimeout(r, 150));
    const leaked = author.seen.filter((f) => /report|concern/i.test(JSON.stringify(f)));
    assert.deepEqual(leaked, [], 'nothing about the report may reach the room');
  } finally {
    author.close();
    reporter.close();
    mod.close();
    await chat.close?.();
    host.close();
  }
});
