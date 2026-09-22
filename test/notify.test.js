import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT, NOTIFY, QUIET, classify, mentions } from '../lib/notify.js';
import { Notifications } from '../server/notifications.js';
import { World, seed } from '../server/store.js';

const post = (over = {}) => {
  // `...over` last would clobber the merged message with the partial, which is
  // how this helper first handed the classifier a message with no body.
  const { message, ...rest } = over;
  const room = rest.room ?? message?.room ?? 'art';
  return {
    type: 'message',
    ...rest,
    room,
    message: {
      id: 'm1',
      room,
      subjects: room.split('+'),
      author: 'wren',
      authorId: 'wren-id',
      body: 'a thought about underpainting',
      at: 1000,
      reach: 40,
      ...message,
    },
  };
};

const watcher = (over = {}) => ({
  userId: 'me',
  name: 'osmo',
  subscription: ['art', 'philosophy'],
  ...over,
});

test('a notification never mentions a room you are not in', () => {
  // The rule that matters more than any tuning: notifications must not leak
  // the existence of conversations somebody cannot read.
  const outsider = watcher({ subscription: ['music'] });

  assert.equal(classify(post(), outsider), null);
  assert.equal(
    classify({ type: 'room-opened', room: 'art+philosophy', population: 2, at: 1 }, outsider),
    null,
  );

  // Holding one subject of an overlap is not holding the overlap.
  const partial = watcher({ subscription: ['art'] });
  assert.equal(
    classify(
      post({ room: 'art+philosophy', message: { room: 'art+philosophy', subjects: ['art', 'philosophy'] } }),
      partial,
    ),
    null,
  );
});

test('the narrower the room, the louder it is', () => {
  // A broad subject is a crowd; a small overlap is nearly addressed to you.
  const loud = (reach, room = 'art', subjects = ['art']) =>
    classify(post({ room, message: { room, subjects, reach } }), watcher()).level;

  assert.equal(loud(400), QUIET, 'a huge room should not interrupt');
  assert.equal(loud(6), NOTIFY, 'a small room should');
  assert.equal(loud(2), ALERT, 'a room of two is nearly a direct message');

  // Arity counts even when a room is not small: an overlap is specific.
  assert.equal(loud(60, 'art+philosophy', ['art', 'philosophy']), NOTIFY);
});

test('being named always interrupts', () => {
  const named = classify(
    post({ message: { body: 'what does @osmo think?', reach: 5000 } }),
    watcher(),
  );
  assert.equal(named.level, ALERT);
  assert.equal(named.kind, 'mention');
  assert.match(named.title, /mentioned you/);

  // Even in a room they are looking at, and even when otherwise quiet.
  const whileReading = classify(
    post({ message: { body: '@osmo here', reach: 5000 } }),
    watcher({ viewing: 'art' }),
  );
  assert.equal(whileReading.level, ALERT);

  assert.ok(mentions('hey @osmo', 'osmo'));
  assert.ok(mentions('HEY @OSMO!', 'osmo'));
  assert.ok(!mentions('osmo without the at sign', 'osmo'), 'bare names match too much');
  assert.ok(!mentions('@osmonaut', 'osmo'), 'should not match a longer name');
  assert.ok(!mentions('anything', ''));
});

test('you are not notified of your own messages', () => {
  const mine = classify(post({ message: { authorId: 'me' } }), watcher());
  assert.equal(mine, null);
});

test('the room you are looking at does not interrupt you', () => {
  const quiet = classify(post({ message: { reach: 4 } }), watcher({ viewing: 'art' }));
  assert.equal(quiet.level, QUIET, 'reading beats being told');

  const elsewhere = classify(post({ message: { reach: 4 } }), watcher({ viewing: 'philosophy' }));
  assert.equal(elsewhere.level, NOTIFY);
});

test('muting silences a room completely', () => {
  const muted = watcher({ muted: ['art'] });
  assert.equal(classify(post(), muted), null);
  // Including mentions — muting means muting.
  assert.equal(classify(post({ message: { body: '@osmo' } }), muted), null);
});

test('a notification says who it is from, by key and id as well as by name', () => {
  // A name is whatever somebody typed, so a browser that has muted a person
  // can only recognise them by these. Nothing new is shown: the message they
  // come from is already readable by whoever this is sent to.
  const keyed = classify(post({ message: { authorKey: 'KEYwren1' } }), watcher());
  assert.equal(keyed.from, 'wren');
  assert.equal(keyed.fromId, 'wren-id');
  assert.equal(keyed.fromKey, 'KEYwren1');

  const keyless = classify(post(), watcher());
  assert.equal(keyless.fromKey, null);
});

test('a room coming into existence is news', () => {
  const opened = classify(
    { type: 'room-opened', room: 'art+philosophy', population: 3, at: 5 },
    watcher(),
  );
  assert.equal(opened.kind, 'room-opened');
  assert.equal(opened.level, NOTIFY);
  assert.match(opened.title, /now exists/);

  const closed = classify({ type: 'room-closed', room: 'art+philosophy', at: 6 }, watcher());
  assert.equal(closed.kind, 'room-closed');

  // A single subject appearing is just somebody joining it, not a new place.
  assert.equal(classify({ type: 'room-opened', room: 'art', population: 1, at: 7 }, watcher()), null);

  // And it can be turned off.
  assert.equal(
    classify({ type: 'room-opened', room: 'art+philosophy', population: 3, at: 8 }, watcher({ lifecycle: false })),
    null,
  );
});

// --- the registry ----------------------------------------------------------

test('the world announces rooms opening and closing', () => {
  const w = new World();
  for (const s of ['art', 'philosophy']) w.addSubject(s);
  const events = [];
  w.watch((e) => events.push(e));

  const u = w.addUser('u');
  w.census(); // establish the incremental baseline
  w.join(u, 'art');
  w.join(u, 'philosophy'); // this is what brings the overlap into being
  w.leave(u, 'philosophy'); // and this is what ends it

  const shape = events.map((e) => `${e.type}:${e.room}`);
  assert.deepEqual(shape, [
    'room-opened:art',
    'room-opened:philosophy',
    'room-opened:art+philosophy',
    'room-closed:philosophy',
    'room-closed:art+philosophy',
  ]);
  assert.ok(events.every((e) => typeof e.at === 'number'));
});

test('the person who opens a room is told about it', () => {
  // Announcing from inside the census update meant the event fired while the
  // subscription had not yet gained the subject, so the containment check
  // refused to tell the very person who caused it. The event has to describe a
  // world that already exists.
  const w = seed(new World());
  const notes = new Notifications(w);
  const seen = [];
  notes.onNotify((userId, note) => {
    seen.push([userId, note.kind, note.room]);
    return true;
  });

  const wren = w.addUser('wren');
  w.join(wren, 'art');
  w.join(wren, 'philosophy');

  seen.length = 0;
  w.join(wren, 'music'); // brings art+music+philosophy into being, with wren in it

  const born = seen.filter(([, kind]) => kind === 'room-opened');
  assert.ok(
    born.some(([userId, , room]) => userId === wren && room === 'art+music+philosophy'),
    `wren should hear about the room they opened; got ${JSON.stringify(born)}`,
  );
});

test('a listener that throws does not break a join', () => {
  const w = seed(new World());
  w.watch(() => {
    throw new Error('badly behaved');
  });
  const u = w.addUser('u');
  assert.doesNotThrow(() => w.join(u, 'art'));
  assert.ok(w.subscription(u).has('art'));
});

test('notifications go to the people in the room and nobody else', () => {
  const w = seed(new World());
  const notes = new Notifications(w);
  const seen = [];
  notes.onNotify((userId, note) => {
    seen.push([userId, note.kind, note.room]);
    return true; // pretend everyone is connected
  });

  const artist = w.addUser('artist');
  const both = w.addUser('both');
  const musician = w.addUser('musician');
  w.join(artist, 'art');
  w.join(both, 'art');
  w.join(both, 'philosophy');
  w.join(musician, 'music');

  seen.length = 0;
  w.post(both, ['art', 'philosophy'], 'only for people holding both');

  const recipients = seen.filter((s) => s[2] === 'art+philosophy').map((s) => s[0]);
  assert.ok(!recipients.includes(musician), 'a musician must not hear of it');
  assert.ok(!recipients.includes(artist), 'holding one subject is not holding the overlap');
  assert.ok(!recipients.includes(both), 'not your own message');
});

test('what happens while you are away is kept for you', () => {
  const w = seed(new World());
  const notes = new Notifications(w, { hold: 3 });
  // Nobody is connected, so nothing can be delivered.
  notes.onNotify(() => false);

  const away = w.addUser('away');
  const talker = w.addUser('talker');
  w.join(away, 'art');
  w.join(away, 'philosophy');
  w.join(talker, 'art');
  w.join(talker, 'philosophy');

  for (let i = 0; i < 5; i++) w.post(talker, ['art', 'philosophy'], `message ${i}`);

  const missed = notes.drain(away);
  assert.equal(missed.length, 3, 'the backlog is capped, keeping the most recent');
  assert.deepEqual(notes.drain(away), [], 'draining empties it');

  // Counts survive the drain, because they are about rooms rather than events.
  assert.ok(notes.counts(away)['art+philosophy'] >= 5);
  notes.clear(away, 'art+philosophy');
  assert.equal(notes.total(away), 0);
});

test('preferences round-trip and are sanitised', () => {
  const w = seed(new World());
  const notes = new Notifications(w);
  const u = w.addUser('u');

  const set = notes.configure(u, { intimate: 3, muted: ['art', 'art'], mentions: false });
  assert.equal(set.intimate, 3);
  assert.deepEqual(set.muted, ['art'], 'duplicates collapse');
  assert.equal(set.mentions, false);

  assert.equal(notes.configure(u, { intimate: -5 }).intimate, 1, 'clamped');
  assert.equal(notes.configure(u, { intimate: 9999 }).intimate, 500, 'clamped');

  notes.mute(u, 'philosophy');
  assert.ok(notes.settings(u).muted.includes('philosophy'));
  notes.unmute(u, 'philosophy');
  assert.ok(!notes.settings(u).muted.includes('philosophy'));
});

test('closing the registry stops it listening', () => {
  const w = seed(new World());
  const notes = new Notifications(w);
  let count = 0;
  notes.onNotify(() => {
    count++;
    return true;
  });

  const u = w.addUser('u');
  const v = w.addUser('v');
  for (const id of [u, v]) w.join(id, 'art');
  w.post(v, ['art'], 'before');
  const during = count;

  notes.close();
  w.post(v, ['art'], 'after');
  assert.equal(count, during, 'nothing after close');
});
