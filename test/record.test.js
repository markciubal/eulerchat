import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { identity, seal, unseal } from '../lib/seal.js';
import { World, seed } from '../server/store.js';
import { communityColour, stroke } from '../lib/palette.js';
import { challenge } from '../lib/proof.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

/**
 * The promises the interface makes, tested against the code that makes them.
 *
 * Two of them were broken, and neither was visible from anywhere else: the
 * store was right, the crypto was right, the frames over the wire were right,
 * and the browser still threw the record away and still sent plaintext.
 * Nothing short of loading the client and working it would have found either.
 *
 * The reporting ones are here for the same reason. Whether a person is asked
 * before an encrypted message of theirs is shown to a moderator is not a fact
 * about the server; it is a fact about what the browser does in the half
 * second after they press a button.
 */

/** Wait on a condition rather than on a guess about how long something takes. */
async function waitFor(ready, what, limitMs = 5000) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The client, loaded against the real page, with the world faked around it. */
async function loadClient({ storage = {}, href } = {}) {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const { document, window } = parseHTML(html);

  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = FakeSocket.OPEN;
      this.sent = [];
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    }
    send(payload) {
      this.sent.push(JSON.parse(payload));
    }
    close() {}
    emit(type, event) {
      this.listeners.get(type)?.(event);
    }
  }

  // Real timers, because what is under test here is a wait that must outlast a
  // slow reply — stubbing them out would prove nothing.
  const store = new Map(Object.entries(storage));
  Object.assign(globalThis, {
    document,
    window,
    WebSocket: FakeSocket,
    location: { protocol: 'http:', host: 'localhost:8787', pathname: '/', origin: 'http://localhost:8787', href },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    Notification: class {
      static permission = 'default';
      static requestPermission = async () => 'default';
    },
    DOMPoint: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
      matrixTransform() {
        return this;
      }
    },
  });

  await import(`../public/app.js?record=${Date.now()}${Math.random()}`);
  const socket = sockets[0];
  const emit = (frame) => socket.emit('message', { data: JSON.stringify(frame) });

  return {
    document,
    socket,
    emit,
    store,
    kept: () => JSON.parse(store.get('eulerchat.kept') ?? '[]'),
    $: (id) => document.getElementById(id),
  };
}

/** Enough frames that the client believes it is in a room it can post to. */
const arrive = (emit) => {
  emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3 });
  emit({ type: 'history', rooms: {} });
  emit({
    type: 'state',
    subscription: ['art'],
    funnel: 0,
    rail: { held: ['art'], suggested: [], popular: [], total: 1 },
  });
  emit({
    type: 'atlas',
    subjects: ['art'],
    extent: 1000,
    zones: [{ key: 'art', subjects: ['art'], population: 4, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } }],
    curves: [
      {
        subject: 'art',
        components: 1,
        anchor: { x: 0, y: 0, room: 60 },
        loops: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]],
      },
    ],
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: ['art'],
    rooms: [
      {
        key: 'art', subjects: ['art'], population: 4, here: 4, member: true,
        messages: 0, stats: { messages: 0, perMinute: 0, last: null },
      },
    ],
  });
};

const message = (body, at = Date.now()) => ({
  type: 'message',
  message: { room: 'art', subjects: ['art'], author: 'someone', body, at },
});

test('a kept record survives the tab being closed', async () => {
  // What was recorded yesterday, as localStorage would still be holding it.
  const yesterday = [{ room: 'art', author: 'hila', body: 'said before', at: 1 }];
  const client = await loadClient({
    storage: { 'eulerchat.kept': JSON.stringify(yesterday) },
  });

  arrive(client.emit);
  client.emit({ type: 'recording', on: true });
  client.emit(message('said today'));

  const kept = client.kept();
  // The bug: state started empty and was written straight over the saved list,
  // so the first message after a reload erased every earlier one. Somebody who
  // turned this on precisely so they would still have the conversation lost it
  // by reopening the page.
  assert.deepEqual(
    kept.map((m) => m.body),
    ['said before', 'said today'],
    'what was kept before must still be there afterwards',
  );
});

test('nothing is kept unless it was asked for', async () => {
  const client = await loadClient();
  arrive(client.emit);
  client.emit(message('not recorded'));

  assert.equal(client.store.has('eulerchat.kept'), false, 'off by default, and off means nothing written');
});

test('asking to encrypt and not being able to does not send it anyway', async () => {
  const client = await loadClient();

  // Opening is what makes the keys, so this is the case where everything about
  // the encryption is fine and only the reader list goes unanswered.
  client.socket.emit('open', {});
  await waitFor(() => client.socket.sent.some((f) => f.type === 'keys'), 'keys to be made');

  arrive(client.emit);

  // They tick the box, and the browser can do it.
  const sealed = client.$('sealed');
  sealed.checked = true;
  sealed.dispatchEvent(new client.document.defaultView.Event('change'));

  // Go into the room the way a person does, by clicking it. Without this the
  // composer has nowhere to post to and returns before doing anything at all.
  const chip = client.document.querySelector('#rooms button');
  assert.ok(chip, 'the room should be listed to click');
  chip.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const body = client.$('body');
  body.value = 'the chanterelles are up behind the quarry';
  client.$('composer').dispatchEvent(
    new client.document.defaultView.Event('submit', { cancelable: true, bubbles: true }),
  );

  // The reader list is never answered — a server that is slow, or a connection
  // that drops between asking and replying.
  await new Promise((r) => setTimeout(r, 400));

  const posts = client.socket.sent.filter((f) => f.type === 'post');
  // The old code slept 120ms, found no readers, and posted the words in the
  // clear with a note about it. A promise to encrypt that cannot be kept has
  // to fail, not silently do the opposite of what was asked.
  assert.deepEqual(posts, [], 'nothing may be sent unlocked when locking was asked for');
  assert.ok(
    client.socket.sent.some((f) => f.type === 'readers'),
    'it should at least have asked who was there',
  );
  // And they have not lost what they wrote. The box is emptied when a message
  // has gone, not when it was asked to go, so a wait costs them nothing.
  assert.equal(body.value, 'the chanterelles are up behind the quarry', 'their words are still there');
});

test('being told there is nobody to lock it for says so, and keeps the message', async () => {
  const client = await loadClient();
  client.socket.emit('open', {});
  await waitFor(() => client.socket.sent.some((f) => f.type === 'keys'), 'keys to be made');
  arrive(client.emit);

  const sealed = client.$('sealed');
  sealed.checked = true;
  sealed.dispatchEvent(new client.document.defaultView.Event('change'));
  client.document.querySelector('#rooms button')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const text = 'for nobody in particular';
  const body = client.$('body');
  body.value = text;
  client.$('composer').dispatchEvent(
    new client.document.defaultView.Event('submit', { cancelable: true, bubbles: true }),
  );

  // The server answers honestly: there is nobody here holding a key.
  await waitFor(() => client.socket.sent.some((f) => f.type === 'readers'), 'the list to be asked for');
  client.emit({ type: 'readers', room: 'art', readers: [] });

  await waitFor(() => /not sent/i.test(client.$('notice').textContent), 'to be told');
  assert.deepEqual(client.socket.sent.filter((f) => f.type === 'post'), [], 'and nothing went');
  assert.equal(body.value, text, 'their words are still there to send later');
});

test('when the readers are there, the words go out locked and not otherwise', async () => {
  const client = await loadClient();
  client.socket.emit('open', {});
  await waitFor(() => client.socket.sent.some((f) => f.type === 'keys'), 'keys to be made');
  arrive(client.emit);

  const sealed = client.$('sealed');
  sealed.checked = true;
  sealed.dispatchEvent(new client.document.defaultView.Event('change'));

  const chip = client.document.querySelector('#rooms button');
  chip.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const secret = 'the chanterelles are up behind the quarry';
  client.$('body').value = secret;
  client.$('composer').dispatchEvent(
    new client.document.defaultView.Event('submit', { cancelable: true, bubbles: true }),
  );

  // Answer the reader list, as a server would, with somebody real to seal to.
  await waitFor(() => client.socket.sent.some((f) => f.type === 'readers'), 'the reader list to be asked for');
  const reader = await identity();
  client.emit({ type: 'readers', room: 'art', readers: [{ keyId: reader.id, publicKey: reader.publicKey }] });

  await waitFor(() => client.socket.sent.some((f) => f.type === 'post'), 'the message to go');
  const post = client.socket.sent.find((f) => f.type === 'post');

  assert.equal(post.body, '', 'no plaintext may travel beside the envelope');
  assert.ok(post.envelope?.sealed, 'it should be sealed');
  assert.ok(!JSON.stringify(post).includes('chanterelles'), 'nothing readable in what is sent');

  // And the person it was sealed for can actually read it — a locked message
  // nobody can open would satisfy every assertion above and be useless.
  assert.equal(await unseal(post.envelope, reader), secret);
});

// --- reporting -------------------------------------------------------------

/** A message as it arrives from the server, from somebody who is not you. */
const from = (author, body, extra = {}) => ({
  type: 'message',
  message: {
    id: extra.id ?? 'm1',
    room: 'art',
    subjects: ['art'],
    author,
    authorId: extra.authorId ?? 'someone-else',
    body,
    at: Date.now(),
    ...extra,
  },
});

/** Get into the room with a message in it, ready to be worked. */
async function inRoom(client, message) {
  arrive(client.emit);
  client.emit(message);
  client.document.querySelector('#rooms button')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  return client.document.querySelector('#log .report');
}

test('there is a way to report somebody else, and not yourself', async () => {
  const client = await loadClient();
  await inRoom(client, from('hila', 'something unpleasant'));

  const buttons = client.document.querySelectorAll('#log .report');
  assert.equal(buttons.length, 1, 'their message can be reported');

  // Your own cannot. A report button on your own words is a confusing offer
  // at best and a way to waste a moderator's time at worst.
  client.emit(from('you', 'my own words', { id: 'm2', authorId: 'u1' }));
  client.document.querySelector('#rooms button')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.document.querySelectorAll('#log .report').length, 1, 'still only theirs');
});

test('reporting asks what was wrong before it sends anything', async () => {
  const client = await loadClient();
  const button = await inRoom(client, from('hila', 'something unpleasant'));

  button.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  // Nothing has been sent yet — being asked is the point, both so a moderator
  // knows what to look for and so there is a moment between irritation and a
  // complaint.
  assert.deepEqual(client.socket.sent.filter((f) => f.type === 'report'), []);

  const panel = client.document.querySelector('.why');
  assert.ok(panel, 'a panel asking why');
  assert.ok(panel.querySelectorAll('.why-choice').length >= 5, 'with reasons to pick from');

  // Pick one, and only then does it go.
  panel.querySelector('.why-choice')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const [sent] = client.socket.sent.filter((f) => f.type === 'report');
  assert.equal(sent.messageId, 'm1');
  assert.ok(sent.reason, 'with a reason attached');
  assert.equal(sent.disclosed, undefined, 'an unencrypted message needs no disclosure');
  assert.equal(client.document.querySelector('.why'), null, 'and the panel goes away');
});

test('reporting an encrypted message says so before it is shown to anybody', async () => {
  const client = await loadClient();
  // As it arrives once the browser has opened it: sealed, with the text the
  // reader could decrypt.
  const button = await inRoom(client, from('hila', 'what was actually said', { sealed: true }));

  button.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const panel = client.document.querySelector('.why');

  // The consent moment. The server has never been able to read this message,
  // so reporting it is the reader choosing to show it — and they have to be
  // told that before they choose, not after.
  const warning = panel.querySelector('.discloses');
  assert.ok(warning, 'an encrypted message must say what reporting it does');
  assert.match(warning.textContent, /encrypted/i);
  assert.match(warning.textContent, /shows this one message/i);
  assert.deepEqual(client.socket.sent.filter((f) => f.type === 'report'), [], 'and still nothing sent');

  panel.querySelector('.why-choice')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const [sent] = client.socket.sent.filter((f) => f.type === 'report');
  assert.equal(sent.disclosed, 'what was actually said', 'now, and only now, the text goes');
});

test('a message already reported says so instead of offering again', async () => {
  const client = await loadClient();
  const button = await inRoom(client, from('hila', 'something unpleasant'));

  button.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  client.document.querySelector('.why .why-choice')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const after = client.document.querySelector('#log .report');
  assert.equal(after.textContent, 'reported');
  assert.equal(after.disabled, true);
});

test('cancelling reports nothing', async () => {
  const client = await loadClient();
  const button = await inRoom(client, from('hila', 'something unpleasant'));

  button.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  client.document.querySelector('.why .why-cancel')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  assert.equal(client.document.querySelector('.why'), null);
  assert.deepEqual(client.socket.sent.filter((f) => f.type === 'report'), []);
});

// --- votes, replies and groups in the browser ------------------------------

test('agreeing sends a vote and shows what everyone else thinks', async () => {
  const client = await loadClient();
  await inRoom(client, from('hila', 'a thought'));

  const agree = client.document.querySelector('#log .vote-up');
  assert.ok(agree, 'there is a way to agree');
  agree.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const [sent] = client.socket.sent.filter((f) => f.type === 'vote');
  assert.equal(sent.value, 1);
  assert.equal(sent.messageId, 'm1');

  // The tally is what the server says it is, not what this browser guessed.
  client.emit({ type: 'votes', messageId: 'm1', up: 3, down: 1, score: 2 });
  assert.match(client.document.querySelector('#log .vote-up').textContent, /3/);
  assert.match(client.document.querySelector('#log .vote-down').textContent, /1/);
});

test('replying carries the message it answers, and can be called off', async () => {
  const client = await loadClient();
  await inRoom(client, from('hila', 'is akrasia a failure of reason or of desire?'));

  client.document.querySelector('#log .reply')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.$('replying').hidden, false, 'it says who you are answering');
  assert.match(client.$('replying').textContent, /hila/);

  client.$('body').value = 'of desire, surely';
  client.$('composer').dispatchEvent(
    new client.document.defaultView.Event('submit', { cancelable: true, bubbles: true }),
  );

  const [post] = client.socket.sent.filter((f) => f.type === 'post');
  assert.equal(post.replyTo, 'm1');
  assert.equal(client.$('replying').hidden, true, 'and it stops being a reply afterwards');

  // Starting one by accident must be easy to undo.
  client.document.querySelector('#log .reply')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  client.document.querySelector('.stop-replying')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.$('replying').hidden, true);
});

test('a message quotes what it was answering', async () => {
  const client = await loadClient();
  await inRoom(client, {
    type: 'message',
    message: {
      id: 'm9', room: 'art', subjects: ['art'], author: 'wren', authorId: 'w',
      body: 'of desire, surely', at: Date.now(),
      replyTo: { id: 'm1', author: 'hila', excerpt: 'is akrasia a failure', sealed: false },
    },
  });

  const quote = client.document.querySelector('#log .quoted');
  assert.ok(quote, 'the answer shows what it answered');
  assert.match(quote.textContent, /hila/);
  assert.match(quote.textContent, /akrasia/);
});

test('making a group offers a link that carries its name', async () => {
  const client = await loadClient();
  arrive(client.emit);

  client.$('cluster-new').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const link = client.$('cluster-url').getAttribute('href');
  assert.match(link, /cluster=/, 'a link somebody can be sent');
  assert.equal(client.$('cluster-share').hidden, false);

  // Leave, and join another by the name somebody read out.
  client.$('cluster-leave').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  client.$('cluster-name').value = 'Kite Fox 9';
  client.$('cluster-join').dispatchEvent(new client.document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(client.$('cluster-now').textContent, /^kite-fox-9$/, 'typed as said, read as meant');
  assert.equal(client.$('group-label').textContent, 'kite-fox-9', 'and the header says which group');
});

test('nonsense is not a group name', async () => {
  const client = await loadClient();
  arrive(client.emit);

  client.$('cluster-name').value = 'Not/A Group';
  client.$('cluster-join').dispatchEvent(new client.document.defaultView.Event('submit', { bubbles: true, cancelable: true }));

  // Said in the panel it was typed into, not under the composer out of sight.
  assert.match(client.$('cluster-error').textContent, /not a group name/i);
  assert.equal(client.$('cluster-share').hidden, true);
  assert.equal(client.$('group-label').textContent, 'Group');
});

test('the invitation is drawn as a square of elements, not a picture', async () => {
  const client = await loadClient();
  arrive(client.emit);
  client.$('cluster-new').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const holder = client.$('cluster-qr');
  const cells = holder.querySelectorAll('i');
  assert.ok(cells.length > 0, 'there is a square to point a camera at');

  // A whole number of rows, and it is elements rather than an image, because
  // this place does not do pictures.
  const size = Number(holder.style.getPropertyValue('--qr-size'));
  assert.ok(size >= 21, `a QR symbol is at least 21 modules across, got ${size}`);
  assert.equal(cells.length, size * size);
  assert.equal(holder.querySelectorAll('img, svg, picture').length, 0);
  assert.ok([...cells].some((c) => c.className === 'qr-on'), 'some of it is dark');
});

// --- keys ------------------------------------------------------------------

test('the browser shows that its key is its own, when the server asks', async () => {
  const client = await loadClient();
  client.socket.emit('open', {});
  await waitFor(() => client.socket.sent.some((f) => f.type === 'keys'), 'the key to be claimed');
  const claimed = client.socket.sent.find((f) => f.type === 'keys');

  // Asked as a server asks, with a real challenge, and checked as one checks.
  const asked = await challenge(claimed.publicKey);
  client.emit({ type: 'challenge', keyId: claimed.keyId, offer: asked.offer });

  await waitFor(() => client.socket.sent.some((f) => f.type === 'proof'), 'an answer');
  const answer = client.socket.sent.find((f) => f.type === 'proof');
  assert.equal(await asked.check(answer.mac), true);
});

test('a connection that blinks says its key again', async () => {
  // It used to be said once per page. Whoever reconnected was then somebody
  // the server held no key for: nothing could be locked for them, and now
  // there would be nothing beside their name either.
  const client = await loadClient();
  client.socket.emit('open', {});
  await waitFor(() => client.socket.sent.filter((f) => f.type === 'keys').length === 1, 'the first claim');
  client.socket.emit('open', {});
  await waitFor(() => client.socket.sent.filter((f) => f.type === 'keys').length === 2, 'the second claim');

  const [first, second] = client.socket.sent.filter((f) => f.type === 'keys');
  assert.equal(second.keyId, first.keyId, 'and it is the same key, not another one');
  assert.deepEqual(
    client.socket.sent.filter((f) => f.type === 'resume'), [],
    'with a key to show, an id is not what they come back by',
  );
});

test('a key is drawn apart from the name, and cannot be typed into one', async () => {
  const client = await loadClient();
  await inRoom(client, from('wren', 'said under a key', { id: 'k1', authorKey: '3fA9xQ2kZk81mmQp' }));
  // The server refuses the dot in a name. The picture must not depend on that.
  client.emit(from('wren·3fA9xQ2k', 'said under nothing', { id: 'k2' }));
  client.document.querySelector('#rooms button')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const [real, fake] = client.document.querySelectorAll('#log .author');
  const letters = real.querySelector('.key');
  assert.ok(letters, 'the key has an element of its own');
  assert.equal(letters.textContent, '·3fA9xQ2k', 'eight letters of it, after a dot');
  assert.match(letters.title, /3fA9xQ2kZk81mmQp/, 'and all of it for anybody who asks');

  // To a reader skimming, these two say the same thing. To anything that
  // looks, only one of them has a key.
  assert.equal(fake.textContent, real.textContent);
  assert.equal(fake.querySelector('.key'), null);
});

test('your own key is shown beside your name once it has been shown to the server', async () => {
  const client = await loadClient();
  arrive(client.emit);
  assert.equal(client.$('key-wrap').hidden, true, 'nothing to show before then');

  client.emit({ type: 'welcome', you: { id: 'u1', name: 'wren', keyId: '3fA9xQ2kZk81mmQp' }, maxArity: 3 });
  assert.equal(client.$('key-wrap').hidden, false);
  assert.equal(client.$('key-mark').textContent, '·3fA9xQ2k');
  // In full somewhere, because the full one is what a moderator list is made of.
  assert.match(client.$('key-mark').title, /3fA9xQ2kZk81mmQp/);
});

test('the name comes back with the key', async () => {
  // The server forgets a person a minute after they go. Tomorrow the key is
  // the same and the name would be `guest-3f2a`, unless the browser says it.
  const client = await loadClient({ storage: { 'eulerchat.name': 'wren' } });
  client.socket.emit('open', {});
  await waitFor(() => client.socket.sent.some((f) => f.type === 'keys'), 'the key to be claimed');

  // Before the key is shown there is nobody in particular to be called wren.
  client.emit({ type: 'welcome', you: { id: 'u1', name: 'guest-3f2a' }, maxArity: 3 });
  assert.deepEqual(client.socket.sent.filter((f) => f.type === 'identify'), []);

  client.emit({ type: 'welcome', you: { id: 'u1', name: 'guest-3f2a', keyId: '3fA9xQ2kZk81mmQp' }, maxArity: 3 });
  assert.deepEqual(client.socket.sent.filter((f) => f.type === 'identify'), [{ type: 'identify', name: 'wren' }]);

  // Once. A server that tidied the name into something else must not be
  // argued with for ever.
  client.emit({ type: 'welcome', you: { id: 'u1', name: 'wre', keyId: '3fA9xQ2kZk81mmQp' }, maxArity: 3 });
  assert.equal(client.socket.sent.filter((f) => f.type === 'identify').length, 1);
});

test('a kept copy holds everything the server will check it by', async () => {
  const client = await loadClient();
  arrive(client.emit);
  client.emit({ type: 'recording', on: true });
  client.emit(from('wren', 'worth keeping', { id: 'k3', v: 2, authorKey: '3fA9xQ2kZk81mmQp' }));

  // The name and the key are part of what the server hashed. A copy without
  // them is a copy of some other message, and is refused as one.
  const [kept] = client.kept();
  assert.equal(kept.v, 2);
  assert.equal(kept.authorKey, '3fA9xQ2kZk81mmQp');
  assert.equal(kept.author, 'wren');
});

// --- portals ----------------------------------------------------------------

test('the standing claim that everyone can read this stops being made in a portal', async () => {
  // The interface says "Everyone can read this" above the composer, in those
  // words, where nobody has to click anything to see it. A portal is the one
  // room where that is false, and a claim about privacy that quietly goes
  // wrong in one place is worse than one that was never made.
  const address = 'portal-abcdefghijkmnpqrstuvwxy';
  const client = await loadClient();
  arrive(client.emit);

  const note = client.document.querySelector('.public-note');
  assert.match(note.textContent, /Everyone can read this/, 'the open rooms still say so');

  // The same frames, with a portal among the rooms.
  client.emit({
    type: 'atlas',
    subjects: ['art'],
    extent: 1000,
    zones: [{ key: 'art', subjects: ['art'], population: 4, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } }],
    curves: [{ subject: 'art', components: 1, anchor: { x: 0, y: 0, room: 60 }, loops: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]] }],
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: ['art', address],
    rooms: [
      { key: 'art', subjects: ['art'], population: 4, here: 4, member: true, messages: 0, stats: { messages: 0, perMinute: 0, last: null } },
      { key: address, subjects: [address], population: 2, here: 2, member: true, messages: 0, stats: { messages: 0, perMinute: 0, last: null } },
    ],
  });

  const chips = [...client.document.querySelectorAll('.room-chip')];
  const portal = chips.find((c) => c.textContent.includes('portal-'));
  assert.ok(portal, 'the portal should be listed like any other room');
  portal.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  assert.doesNotMatch(note.textContent, /Everyone can read this/, 'that sentence must not survive');
  assert.match(note.textContent, /Only the two of you can find this/);
  // And it must not overclaim in the other direction either: the server still
  // knows two people are talking, and the interface has to say so.
  assert.match(note.textContent, /does not hide/);
  assert.match(note.textContent, /you are talking, and when/);
  assert.equal(client.$('room-title').textContent, 'A portal');

  // Going back to an open room brings the warning back.
  chips.find((c) => c.textContent.includes('art'))
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.match(note.textContent, /Everyone can read this/);
});

test('the map pops out and goes home, and there is only ever one of it', async () => {
  // A second drawing would be a second thing to keep in step with the first,
  // so the one in the panel is moved rather than copied. That is cheap to get
  // wrong in a way nothing else would notice, so it is checked by counting.
  const client = await loadClient();
  arrive(client.emit);
  const at = () => {
    const svg = client.$('diagram');
    return svg.closest('.map-stage') ? 'stage' : svg.closest('.map') ? 'panel' : 'nowhere';
  };
  const count = () => client.document.querySelectorAll('#diagram').length;

  assert.equal(at(), 'panel');
  assert.equal(count(), 1);
  const before = client.$('diagram').nextSibling?.className;

  client.$('map-expand').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(at(), 'stage', 'the picture itself should move, not a copy of it');
  assert.equal(count(), 1, 'and there must not be two maps');
  assert.equal(client.$('map-modal').open, true);

  client.$('map-close').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(at(), 'panel', 'and it has to come back');
  assert.equal(count(), 1);
  assert.equal(client.$('map-modal').open, false);
  // Back in the same place, not merely back in the panel.
  assert.equal(client.$('diagram').nextSibling?.className, before);

  // Twice, because the anchor it remembers has to survive a round trip.
  client.$('map-expand').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(at(), 'stage');
  client.$('map-close').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(at(), 'panel');
  assert.equal(client.$('diagram').nextSibling?.className, before);
});

test('the interests are a dialog, opened from the header or the bar along the bottom', async () => {
  // They were a panel under the map, and on a phone a view of their own. Now
  // there is no such panel, and both ways in open the same dialog.
  const client = await loadClient();
  arrive(client.emit);
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const dialog = client.$('interests');

  assert.equal(client.document.querySelector('.rail'), null, 'there should be no rail left');
  for (const id of ['funnel', 'find', 'subject-name', 'subjects']) {
    assert.ok(dialog.contains(client.$(id)), `#${id} should be in the dialog`);
  }
  assert.match(client.$('subjects').textContent, /art/, 'and the list is drawn whether or not it is open');

  const openers = [...client.document.querySelectorAll('.interests-open')];
  // In the header, in the bar along the bottom, and in the note on the map,
  // where it is the first thing the note says to do.
  assert.deepEqual(
    openers.map((b) => (b.closest('.bar') ? 'bar' : b.closest('#switch') ? 'switch' : b.closest('#lede') ? 'lede' : '?')).sort(),
    ['bar', 'lede', 'switch'],
  );
  for (const opener of openers) {
    // Not `false` to begin with: this DOM has no dialogs, so the page's own
    // fallback is what sets it at all.
    assert.equal(Boolean(dialog.open), false);
    press(opener);
    assert.equal(dialog.open, true, 'each button should open it');
    press(client.$('interests-close'));
    assert.equal(dialog.open, false, 'and Close should close it');
  }

  // The bar along the bottom is two places and a button, not three places.
  assert.deepEqual(
    [...client.$('switch').querySelectorAll('[data-view]')].map((b) => b.dataset.view),
    ['map', 'talk'],
  );
});

test('the demo says so in the header, and nowhere else does', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const pill = client.document.querySelector('.demo-pill');
  assert.ok(pill, 'the label is on the page');
  assert.match(pill.textContent, /made up/);
  assert.equal(client.document.body.dataset.demo, undefined, 'an ordinary server is not a demo');
  client.emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 10, demo: true });
  assert.equal(client.document.body.dataset.demo, '', 'the demo says it is one');
  assert.notEqual(pill.getAttribute('aria-hidden'), 'true', 'and it is read out, not only shown');
});

test('the settings are one menu in the header, and the theme is a label beside it', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const press = (id) => client.$(id).dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const menu = client.$('settings-pop');
  const bar = client.document.querySelector('.bar');

  assert.ok(bar.contains(menu), 'the menu hangs from the header');
  for (const id of ['bell', 'recording', 'check-deletions', 'new-key']) {
    assert.ok(menu.contains(client.$(id)), `#${id} should be in Settings`);
  }
  // Where the map sits is with how it is drawn, under View.
  for (const id of ['swap-sides', 'float-map', 'reset-layout']) {
    assert.ok(client.$('view-pop').contains(client.$(id)), `#${id} should be under View`);
  }

  // The theme is in the header itself, in words, saying which one is on.
  const theme = client.$('appearance-open');
  assert.ok(bar.contains(theme) && !menu.contains(theme), 'the theme should be in the header, not in Settings');
  assert.match(theme.textContent.replace(/\s+/g, ' ').trim(), /^Theme \S/);
  assert.ok(theme.classList.contains('bar-text'), 'a label, not a pill');

  assert.equal(menu.hidden, true);
  press('settings-open');
  assert.equal(menu.hidden, false, 'Settings should open its menu');
  assert.equal(client.$('settings-open').getAttribute('aria-expanded'), 'true');

  // The sheet wants the page in view, and the menu would be over it.
  press('appearance-open');
  assert.equal(menu.hidden, true, 'opening the theme sheet should put the menu away');
  assert.equal(client.$('settings-open').getAttribute('aria-expanded'), 'false');

  // Only one divider is left, so only one is remembered — with where the map
  // is: down the left, until somebody moves it.
  const home = { talk: 58, side: 'left', floating: false, float: { x: null, y: null, w: 520, h: 440 } };
  press('reset-layout');
  assert.deepEqual(JSON.parse(client.store.get('eulerchat.layout')), home);
});

test('the map starts on the left, comes out as a window, and docks on either side', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const press = (id) => client.$(id).dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const body = client.document.body;
  const kept = () => JSON.parse(client.store.get('eulerchat.layout'));

  assert.equal(body.dataset.dock, 'left', 'the map should start docked on the left');

  press('swap-sides');
  assert.equal(body.dataset.dock, 'right');
  assert.equal(client.$('swap-sides').getAttribute('aria-pressed'), 'true');
  assert.equal(kept().side, 'right', 'the side should be remembered');

  // Out as a window: placed somewhere on the page, and remembered there.
  press('map-popout');
  assert.equal(body.dataset.dock, 'float');
  assert.equal(client.$('float-map').getAttribute('aria-pressed'), 'true');
  assert.equal(client.$('swap-sides').disabled, true, 'a window has no side to swap');
  const at = kept();
  assert.equal(at.floating, true);
  for (const which of ['x', 'y', 'w', 'h']) {
    assert.equal(typeof at.float[which], 'number', `the window's ${which} should be remembered`);
    assert.match(client.document.querySelector('.map').style.getPropertyValue(`--float-${which}`), /^\d+px$/);
  }

  // Eight places to size it by, none of them the drawing.
  assert.equal(client.document.querySelectorAll('.map > .map-edge').length, 8);

  // The arrow keys move it from its title, and with Shift they size it.
  const key = (name, shiftKey = false) => {
    const evt = new client.document.defaultView.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(evt, { key: name, shiftKey });
    client.$('map-grip').dispatchEvent(evt);
  };
  key('ArrowLeft');
  assert.equal(kept().float.x, at.float.x - 24);
  key('ArrowUp', true);
  assert.equal(kept().float.h, at.float.h - 24);
  assert.equal(kept().float.y, at.float.y, 'sizing should not move it');

  // And back, on the side asked for. Where the window was is kept for next time.
  press('dock-left');
  assert.equal(body.dataset.dock, 'left');
  assert.equal(kept().floating, false);
  assert.equal(kept().float.x, at.float.x - 24);
  press('float-map');
  assert.equal(body.dataset.dock, 'float');
  press('float-map');
  assert.equal(body.dataset.dock, 'left', 'the same button should put it back where it came from');
});

test('a layout kept by an older version, or by hand, is read back safely', async () => {
  const stored = (layout) => ({ storage: { 'eulerchat.layout': JSON.stringify(layout) } });

  // `sides` is from before the map could move: not read, so the map is on the left.
  const old = await loadClient(stored({ talk: 40, sides: 'normal' }));
  assert.equal(old.document.body.dataset.dock, 'left');
  assert.equal(old.document.body.style.getPropertyValue('--talk'), '40%');

  // A window far off the page and too small to use is brought back onto it.
  const lost = await loadClient(stored({ side: 'right', floating: true, float: { x: 99999, y: -500, w: 10, h: 'tall' } }));
  assert.equal(lost.document.body.dataset.dock, 'float');
  const panel = lost.document.querySelector('.map');
  const px = (which) => parseInt(panel.style.getPropertyValue(`--float-${which}`), 10);
  assert.equal(px('w'), 340, 'no narrower than its minimum');
  assert.equal(px('h'), 440, 'and what was not a number is not read');
  assert.equal(px('x'), 1280 - 340, 'and wholly on the page');
  assert.equal(px('y'), 0);
});

// --- walking into a room you are not in -------------------------------------

/** An atlas holding one room you are in and two you are not. */
const outsideRooms = (emit, held = ['art']) =>
  emit({
    type: 'atlas',
    subjects: ['art', 'philosophy'],
    extent: 1000,
    zones: [{ key: 'art', subjects: ['art'], population: 4, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } }],
    curves: [{ subject: 'art', components: 1, anchor: { x: 0, y: 0, room: 60 }, loops: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]] }],
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: held,
    rooms: [
      { key: 'art', subjects: ['art'], population: 4, here: 4, member: held.includes('art'), messages: 0, stats: { messages: 0, perMinute: 0, last: null } },
      { key: 'philosophy', subjects: ['philosophy'], population: 3, here: 3, member: held.includes('philosophy'), messages: 0, stats: { messages: 0, perMinute: 0, last: null } },
      { key: 'art+philosophy', subjects: ['art', 'philosophy'], population: 2, here: 2,
        member: held.includes('art') && held.includes('philosophy'), messages: 0, stats: { messages: 0, perMinute: 0, last: null } },
    ],
  });

/**
 * Open a room by its name, exactly.
 *
 * Matched on the chip's accessible name rather than on its text, because the
 * text is the name and the population run together — and a substring of it
 * picks the wrong room: `art ` is inside `art ∩ philosophy2`.
 */
const clickRoom = (client, subjects) => {
  const chip = [...client.document.querySelectorAll('.room-chip')].find((c) =>
    (c.getAttribute('aria-label') ?? '').startsWith(`${subjects}, `),
  );
  assert.ok(chip, `no chip for ${subjects}`);
  chip.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
};

/**
 * Whether the way-in panel is showing.
 *
 * A count, never the element. `assert.equal(node, null)` on a failure tries to
 * print the node, and printing a DOM node from a shim means walking a tree
 * that points back at itself — the assertion does not fail, it hangs.
 */
const promptShown = (client) => client.document.querySelectorAll('.joining').length === 1;

test('opening a room you are not in offers the way in, and names only what is missing', async () => {
  const client = await loadClient();
  arrive(client.emit);
  outsideRooms(client.emit, ['art']);

  // Nothing of it held: the whole room is the ask.
  clickRoom(client, 'philosophy');
  let prompt = client.document.querySelector('.joining');
  assert.ok(prompt, 'a room you are not in should offer a way in');
  assert.match(prompt.textContent, /You are not in this chat/);
  assert.deepEqual(
    [...prompt.querySelectorAll('.join-here')].map((b) => b.textContent),
    ['Join philosophy'],
  );

  // Half of it held: it must ask for the half that is missing, and no more.
  clickRoom(client, 'art and philosophy');
  prompt = client.document.querySelector('.joining');
  assert.deepEqual(
    [...prompt.querySelectorAll('.join-here')].map((b) => b.textContent),
    ['Join philosophy'],
    'it must not ask for what somebody already holds',
  );
  assert.match(prompt.textContent, /You hold art/);

  // A room you are in gets no prompt at all.
  clickRoom(client, 'art');
  assert.equal(promptShown(client), false);
});

test('pressing join sends it, and the room is still there when the map comes back', async () => {
  // The bug this found: a membership change drops the atlas and asks for a
  // fresh one, and the conversation panel was never drawn again when it
  // arrived — so joining left the room you were reading saying "Pick a
  // conversation". Joining from inside that panel made it unmissable.
  const client = await loadClient();
  arrive(client.emit);
  outsideRooms(client.emit, ['art']);
  clickRoom(client, 'art and philosophy');

  client.document.querySelector('.joining .join-here')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(
    client.socket.sent.filter((f) => f.type === 'join').map((f) => f.subject),
    ['philosophy'],
    'the button should join the subject it names',
  );

  // The server answers a join with a fresh state, which stales the atlas.
  client.emit({ type: 'state', subscription: ['art', 'philosophy'], funnel: 0,
    rail: { held: ['art', 'philosophy'], suggested: [], popular: [], total: 2 } });
  assert.equal(client.$('room-title').textContent, 'art and philosophy',
    'the open room must survive the gap with no atlas in hand');

  // Then the atlas arrives, and the room should be readable and postable.
  outsideRooms(client.emit, ['art', 'philosophy']);
  assert.equal(client.$('room-title').textContent, 'art and philosophy');
  assert.equal(promptShown(client), false, 'the prompt has been answered');
  assert.equal(client.$('body').disabled, false, 'and the box should now take a message');
});

// --- the deletion record, from the browser ----------------------------------

/**
 * A real world, with a message of mine in it that only the people in the room
 * could read, and the client believing it is me. The receipt that comes back
 * is the one the real server would send, not one made up to pass.
 */
async function mySealedMessage() {
  const world = new World();
  world.addSubject('art');
  const me = world.addUser('guest');
  world.join(me, 'art');
  const mine = await identity();
  const reader = await identity();
  const envelope = await seal('the chanterelles are up behind the quarry', mine, [reader.publicKey]);
  const sent = world.post(me, ['art'], '', { envelope });

  const client = await loadClient();
  arrive(client.emit);
  client.emit({ type: 'welcome', you: { id: me, name: 'guest' }, maxArity: 3 });
  client.emit({ type: 'message', message: sent });
  client.document.querySelector('#rooms button')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  return { world, me, sent, client };
}

test('deleting an encrypted message checks the receipt names it, and keeps only its hash', async () => {
  const { world, me, sent, client } = await mySealedMessage();

  const remove = client.document.querySelector('#log .forget');
  assert.ok(remove, 'my own encrypted message should offer delete');
  remove.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(client.socket.sent.some((f) => f.type === 'forget' && f.messageId === sent.id));

  // The server deletes it and answers with its entry in the record.
  client.emit({ type: 'receipt', receipt: world.forget(me, sent.id) });
  await waitFor(() => /names this encrypted message/.test(client.$('notice').textContent), 'the receipt to be checked');

  const kept = JSON.parse(client.store.get('eulerchat.deletions') ?? '[]');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].sealed, true);
  assert.equal(kept[0].seq, 0);
  // Enough to find it in the record again, and nothing that would put it back.
  const saved = JSON.stringify(kept);
  assert.ok(!saved.includes('chanterelles'), 'not the words');
  assert.ok(!saved.includes(sent.envelope.body), 'and not the scrambled text');
});

test('a receipt that does not name the message is said to, not passed over', async () => {
  const { world, me, sent, client } = await mySealedMessage();
  client.document.querySelector('#log .forget')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const receipt = world.forget(me, sent.id);
  const wrong = { ...receipt, commitments: ['0'.repeat(64)] };
  client.emit({ type: 'receipt', receipt: wrong });
  await waitFor(() => /does not name this message/.test(client.$('notice').textContent), 'the mismatch to be reported');
  assert.equal(client.store.has('eulerchat.deletions'), false, 'and nothing is kept on the strength of it');
});

test('checking the record confirms an encrypted deletion, and catches an edited record', async () => {
  const { world, me, sent, client } = await mySealedMessage();
  client.document.querySelector('#log .forget')
    .dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  client.emit({ type: 'receipt', receipt: world.forget(me, sent.id) });
  await waitFor(() => client.store.has('eulerchat.deletions'), 'the deletion to be kept');

  client.$('check-deletions').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(client.socket.sent.some((f) => f.type === 'receipts'), 'it should ask for the record');

  client.emit({ type: 'receipts', receipts: world.receipts() });
  await waitFor(() => /unbroken/.test(client.$('deletion-status').textContent), 'the record to be checked');
  assert.match(client.$('deletion-status').textContent, /1 message you deleted \(1 encrypted\) is still recorded/);

  // The same record with one entry quietly rewritten.
  const edited = structuredClone(world.receipts());
  edited[0].commitments = ['f'.repeat(64)];
  client.emit({ type: 'receipts', receipts: edited });
  await waitFor(() => /Problem/.test(client.$('deletion-status').textContent), 'the edit to be caught');
});

// --- the first-visit tip on the map ---------------------------------------------

/** The map as somebody sees it before they have joined anything. */
const nothingJoinedYet = (emit) => {
  emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3 });
  emit({ type: 'history', rooms: {} });
  emit({ type: 'state', subscription: [], funnel: 0, rail: { held: [], suggested: [], popular: [], total: 0 } });
  emit({
    type: 'atlas',
    subjects: ['art'],
    extent: 1000,
    zones: [{ key: 'art', subjects: ['art'], population: 4, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } }],
    curves: [
      { subject: 'art', components: 1, anchor: { x: 0, y: 0, room: 60 }, loops: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]] },
    ],
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: [],
    rooms: [
      { key: 'art', subjects: ['art'], population: 4, here: 4, member: false, messages: 0, stats: { messages: 0, perMinute: 0, last: null } },
    ],
  });
};

test('the tip on the map can be closed, and stays closed', async () => {
  const client = await loadClient();
  nothingJoinedYet(client.emit);
  assert.equal(client.$('lede').hidden, false, 'with nothing joined the tip should show');

  client.$('lede-close').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.$('lede').hidden, true, 'Close should close it');
  assert.equal(client.store.get('eulerchat.tipClosed'), '1', 'and this browser should remember that');

  // The map is redrawn all the time, and every redraw decided afresh whether
  // to show the tip. With nothing joined it would have come straight back.
  nothingJoinedYet(client.emit);
  assert.equal(client.$('lede').hidden, true, 'a redraw should not bring it back');

  // Nor should coming back tomorrow.
  const again = await loadClient({ storage: { 'eulerchat.tipClosed': '1' } });
  assert.equal(again.$('lede').hidden, true, 'closed before, it should start closed');
  nothingJoinedYet(again.emit);
  assert.equal(again.$('lede').hidden, true, 'and stay closed once the map arrives');
});

test('View note brings the tip back, even once something is joined', async () => {
  const client = await loadClient({ storage: { 'eulerchat.tipClosed': '1' } });
  const click = (id) => client.$(id).dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  // Closed before, and with an interest joined: two reasons for it to be gone.
  arrive(client.emit);
  assert.equal(client.$('lede').hidden, true);

  click('view-open');
  assert.equal(client.$('view-pop').hidden, false, 'View should open its menu');
  click('tip-show');
  assert.equal(client.$('lede').hidden, false, 'View note should show the note');
  assert.equal(client.$('view-pop').hidden, true, 'and close the menu, which would be in its way');
  assert.equal(client.store.has('eulerchat.tipClosed'), false, 'it is no longer closed');

  // Asked for, it stays, although joining something would otherwise hide it.
  arrive(client.emit);
  assert.equal(client.$('lede').hidden, false, 'a redraw should not take it away again');

  click('lede-close');
  assert.equal(client.$('lede').hidden, true, 'Close still closes it');
  assert.equal(client.store.get('eulerchat.tipClosed'), '1');
  arrive(client.emit);
  assert.equal(client.$('lede').hidden, true, 'and it stays closed');
});

// --- groups, from the header -------------------------------------------------

const click = (client, id) =>
  client.$(id).dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

/** The atlas as it comes back once somebody is in a group's own conversation. */
const inGroupRoom = (emit, group, population = 1) => {
  const key = `${group}/everyone`;
  emit({ type: 'state', subscription: [key], funnel: 0, rail: { held: [key], suggested: [], popular: [], total: 1 } });
  emit({
    type: 'atlas',
    subjects: [key],
    extent: 1000,
    zones: [{ key, subjects: [key], population, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } }],
    curves: [{ subject: key, components: 1, anchor: { x: 0, y: 0, room: 60 }, loops: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]] }],
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: [key],
    rooms: [{ key, subjects: [key], population, here: population, member: true, messages: 0, stats: { messages: 0, perMinute: 0, last: null } }],
  });
};

test('creating a group puts you in a conversation of its own, and opens it', async () => {
  const client = await loadClient();
  client.emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3 });

  click(client, 'group-open');
  assert.equal(client.$('group-pop').hidden, false, 'the header button opens the group panel');
  click(client, 'cluster-new');

  const group = client.$('group-label').textContent;
  assert.match(group, /^[a-z]+-[a-z]+-\d+$/, 'the header now names the group');
  assert.ok(client.$('group-open').classList.contains('in'));
  assert.equal(client.store.get('eulerchat.group'), group, 'and this browser remembers it');

  // Without this, the people who scanned the code arrived in a group with
  // nothing in it, and had to agree on an interest before anyone could talk.
  const joined = client.socket.sent.find((f) => f.type === 'createSubject');
  assert.equal(joined?.name, `${group}/everyone`);

  inGroupRoom(client.emit, group);
  // Named as it is read, with the group said once, beside it.
  assert.equal(client.$('room-title').textContent, 'everyone', 'and it is opened');
  assert.match(client.$('room-meta').textContent, new RegExp(`in ${group}`));
  assert.match(client.$('cluster-count').textContent, /just you/i);

  // Somebody scans it: whoever is holding the code up sees it work.
  inGroupRoom(client.emit, group, 3);
  assert.match(client.$('cluster-count').textContent, /3 people/);
});

test('arriving by a scanned code joins the group and its conversation', async () => {
  const client = await loadClient({ href: 'http://localhost:8787/?cluster=moss-lark-42' });
  client.emit({ type: 'welcome', you: { id: 'u2', name: 'guest' }, maxArity: 3 });

  assert.equal(client.$('group-label').textContent, 'moss-lark-42');
  assert.ok(client.socket.sent.some((f) => f.type === 'createSubject' && f.name === 'moss-lark-42/everyone'));
  inGroupRoom(client.emit, 'moss-lark-42', 2);
  assert.equal(client.$('room-title').textContent, 'everyone', 'straight into the conversation');
  assert.match(client.$('room-meta').textContent, /in moss-lark-42/);
});

test('coming back to a group holds its conversation again, and opens nothing', async () => {
  // A reload of the same address. Being in a group is holding its own
  // conversation, which is what wraps its rooms, so it is held again — but
  // quietly: somebody coming back is not pulled out of whatever they open.
  // Leaving the conversation on purpose is leaving the group, which forgets it.
  const client = await loadClient({
    href: 'http://localhost:8787/?cluster=moss-lark-42',
    storage: { 'eulerchat.group': 'moss-lark-42' },
  });
  client.emit({ type: 'welcome', you: { id: 'u2', name: 'guest' }, maxArity: 3 });

  assert.equal(client.$('group-label').textContent, 'moss-lark-42', 'still in the group');
  assert.ok(
    client.socket.sent.some((f) => f.type === 'createSubject' && f.name === 'moss-lark-42/everyone'),
    'and in its conversation again',
  );
  assert.match(client.$('notice').textContent, /^$/, 'without announcing it as a new arrival');

  inGroupRoom(client.emit, 'moss-lark-42', 2);
  assert.equal(client.$('room-title').textContent, 'Pick a chat', 'nor opening it');
});

test('leaving a group leaves every conversation in it', async () => {
  const client = await loadClient({ storage: { 'eulerchat.group': 'kite-fox-9' } });
  arrive(client.emit);
  client.emit({
    type: 'state',
    subscription: ['art', 'kite-fox-9/everyone', 'kite-fox-9/music', 'moss-lark-42/everyone'],
    funnel: 0,
    rail: { held: [], suggested: [], popular: [], total: 0 },
  });

  click(client, 'cluster-leave');
  const left = client.socket.sent.filter((f) => f.type === 'leave').map((f) => f.subject).sort();
  assert.deepEqual(left, ['kite-fox-9/everyone', 'kite-fox-9/music'], 'this group, and nothing outside it');
  assert.equal(client.$('group-label').textContent, 'Group');
  assert.equal(client.store.has('eulerchat.group'), false);
});

test('a returning visitor who scans a code joins as themselves, not as the stranger they were for a moment', async () => {
  // A connection starts as somebody new and becomes who it was once its key
  // is proven, which re-sends the welcome. Joining only on the first welcome
  // put the stranger in the group and left the real person out of it.
  const client = await loadClient({ href: 'http://localhost:8787/?cluster=moss-lark-42' });
  const joins = () => client.socket.sent.filter((f) => f.type === 'createSubject' && f.name === 'moss-lark-42/everyone').length;

  client.emit({ type: 'welcome', you: { id: 'stranger', name: 'guest' }, maxArity: 3 });
  inGroupRoom(client.emit, 'moss-lark-42');
  assert.equal(joins(), 1);

  client.emit({ type: 'welcome', you: { id: 'returning', name: 'hila' }, maxArity: 3 });
  assert.equal(joins(), 2, 'the person the key belongs to joins too');

  // A rename re-sends the welcome as well, and must not join anybody again.
  client.emit({ type: 'welcome', you: { id: 'returning', name: 'hila b' }, maxArity: 3 });
  assert.equal(joins(), 2);
});

test('leaving before the connection knows who it is still leaves', async () => {
  const client = await loadClient({ storage: { 'eulerchat.group': 'kite-fox-9' } });
  client.emit({ type: 'welcome', you: { id: 'stranger', name: 'guest' }, maxArity: 3 });
  client.emit({ type: 'state', subscription: [], funnel: 0, rail: { held: [], suggested: [], popular: [], total: 0 } });

  click(client, 'cluster-leave');
  assert.equal(client.socket.sent.some((f) => f.type === 'leave'), false, 'nothing to leave yet');

  // Then the key is proven, and the person's own rooms arrive.
  client.emit({ type: 'welcome', you: { id: 'returning', name: 'hila' }, maxArity: 3 });
  client.emit({
    type: 'state',
    subscription: ['art', 'kite-fox-9/everyone'],
    funnel: 0,
    rail: { held: [], suggested: [], popular: [], total: 0 },
  });
  const left = client.socket.sent.filter((f) => f.type === 'leave').map((f) => f.subject);
  assert.deepEqual(left, ['kite-fox-9/everyone']);
});

// --- browsing the catalogue ----------------------------------------------------

test('the catalogue can be browsed by category, and joined from there', async () => {
  // The levels are the real ones, from a real stocked world, so this cannot
  // pass against a shape the server does not send.
  const world = new World();
  const { stock } = await import('../server/store.js');
  stock(world);

  const client = await loadClient();
  arrive(client.emit);
  assert.ok(client.socket.sent.some((f) => f.type === 'browse' && f.at === null), 'it asks for the top level');

  const rows = () => [...client.document.querySelectorAll('#subjects li')];
  const named = (name) => rows().find((li) => li.querySelector('.name')?.textContent === name);

  client.emit({ type: 'browse', ...world.browse() });
  const sport = named('sport');
  assert.ok(sport, 'the divisions are listed');
  assert.ok(sport.classList.contains('category'));
  assert.match(sport.querySelector('.inside').textContent, /^team sports, .+ and \d+ more$/, 'the biggest of it first');
  assert.equal(client.document.querySelector('#subjects .crumbs'), null, 'nothing to go back to at the top');
  assert.match(client.$('rail-total').textContent, /browse/);

  // Into a category: the name is the way in.
  sport.querySelector('.browse-into').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(client.socket.sent.some((f) => f.type === 'browse' && f.at === 'sport'));
  client.emit({ type: 'browse', ...world.browse('racket sports') });

  const crumbs = client.document.querySelector('#subjects .crumbs');
  assert.equal(crumbs.textContent, 'All / sport / racket sports');
  assert.deepEqual([...crumbs.querySelectorAll('button')].map((b) => b.textContent), ['All', 'sport']);

  // Something with nothing beneath it is an ordinary row, and joins.
  const padel = named('padel');
  assert.ok(padel && !padel.classList.contains('category'));
  assert.equal(padel.querySelector('.count').textContent, '', 'no column of noughts');
  [...padel.querySelectorAll('button')].at(-1).dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(client.socket.sent.some((f) => f.type === 'join' && f.subject === 'padel'));

  // And back up.
  crumbs.querySelector('button').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.socket.sent.filter((f) => f.type === 'browse' && f.at === null).length, 2);
});

test('searching puts the browsing away, and clearing the search brings it back', async () => {
  const world = new World();
  const { stock } = await import('../server/store.js');
  stock(world);
  const client = await loadClient();
  arrive(client.emit);
  client.emit({ type: 'browse', ...world.browse() });
  assert.ok(client.document.querySelector('#subjects .browse-into'));

  client.$('subject-name').value = 'soccer';
  client.emit({ type: 'results', query: 'soccer', subjects: world.searchSubjects('soccer') });
  assert.equal(client.document.querySelector('#subjects .browse-into'), null);
  assert.equal(client.document.querySelector('#subjects .name').textContent, 'football', 'the other name found it');

  client.$('subject-name').value = '';
  client.$('subject-name').dispatchEvent(new client.document.defaultView.Event('input', { bubbles: true }));
  assert.ok(client.document.querySelector('#subjects .browse-into'));
});

// --- muting ------------------------------------------------------------------

/** Something said in `art` by whoever the fields say, as the server sends it. */
const said = (fields) => ({
  type: 'message',
  message: { room: 'art', subjects: ['art'], at: Date.now(), ...fields },
});

const wren = { author: 'wren', authorId: 'id-wren', authorKey: 'KEYwren1' };

test('swearing brings an offer to mute, once, and muting folds them away', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const offers = () => client.document.querySelectorAll('#log .mute-offer').length;

  client.emit(said({ ...wren, id: 'm1', body: 'what a lovely underpainting' }));
  assert.equal(offers(), 0, 'clean words bring nothing');

  client.emit(said({ ...wren, id: 'm2', body: 'this is shit' }));
  assert.equal(offers(), 1, 'swearing brings the offer');
  assert.match(client.document.querySelector('#log .mute-offer').textContent, /wren.*used profanity/);

  client.emit(said({ ...wren, id: 'm3', body: 'fuck this' }));
  assert.equal(offers(), 1, 'once per person, not once per word');

  // Whole words, so a town and an adjective are not swearing.
  client.emit(said({ author: 'ash', authorId: 'id-ash', authorKey: 'KEYash01', id: 'm4', body: 'off to Scunthorpe, a classic' }));
  assert.equal(offers(), 1);

  press(client.document.querySelector('#log .mute-yes'));
  assert.equal(offers(), 0, 'muting answers the offer');
  const log = client.$('log').textContent;
  assert.doesNotMatch(log, /underpainting|this is shit|fuck this/, 'their words are folded away');
  assert.match(log, /3 messages from someone you muted/, 'into one line, not three');
  assert.match(log, /Scunthorpe/, 'and nobody else is');

  // Held by key, in this browser, and listed where it can be undone. What is
  // written down is a digest of the fingerprint rather than the fingerprint:
  // the list is not a plain list of who you cannot stand.
  const kept = JSON.parse(client.store.get('eulerchat.muted'));
  assert.equal(kept.length, 1);
  assert.match(kept[0].who, /^[0-9a-f]{16}$/, 'a digest');
  assert.ok(!JSON.stringify(kept).includes('KEYwren1'), 'and never the key itself');
  assert.equal(kept[0].name, 'wren', 'the name stays, since the list is read by a person');
  assert.match(client.$('muted-list').textContent, /wren/);
  assert.equal(client.$('muted-none').hidden, true);

  // Asked for, the words come back, marked as what they are.
  press(client.document.querySelector('#log .muted-run button'));
  assert.match(client.$('log').textContent, /underpainting/);
  assert.equal(client.document.querySelectorAll('#log .muted-mark').length, 3);

  press(client.document.querySelector('#muted-list button'));
  assert.equal(client.document.querySelectorAll('#log .muted-mark').length, 0, 'unmuted from Settings');
  assert.deepEqual(JSON.parse(client.store.get('eulerchat.muted')), []);
  assert.equal(client.$('muted-none').hidden, false);
});

test('a mute follows the key, survives a reload, and stops the badge', async () => {
  // Written by an older browser, before the list was digested: still a mute.
  const client = await loadClient({
    storage: { 'eulerchat.muted': JSON.stringify([{ who: 'key:KEYwren1', name: 'wren', keyId: 'KEYwren1' }]) },
  });
  arrive(client.emit);
  clickRoom(client, 'art');
  assert.match(client.$('muted-list').textContent, /wren/, 'still muted after a reload');

  // The same name under another key is somebody else, and is not muted.
  client.emit(said({ ...wren, id: 'm1', body: 'from the muted one' }));
  client.emit(said({ author: 'wren', authorId: 'id-other', authorKey: 'KEYother', id: 'm2', body: 'from another wren' }));
  const log = client.$('log').textContent;
  assert.doesNotMatch(log, /from the muted one/);
  assert.match(log, /from another wren/);

  // A mute button on the message, which says which way it goes.
  const buttons = [...client.document.querySelectorAll('#log .mute')].map((b) => b.getAttribute('aria-label'));
  assert.deepEqual(buttons, ['Mute wren'], 'only the unmuted wren has one showing');

  const waiting = () => (client.$('rooms-waiting').hidden ? 0 : Number(client.$('rooms-waiting').textContent));
  const note = (fromKey, fromId) => ({
    type: 'notification',
    notification: {
      kind: 'mention', level: 'alert', room: 'art', subjects: ['art'], at: Date.now(),
      title: 'wren mentioned you', body: '@guest', from: 'wren', fromKey, fromId,
    },
  });
  const before = waiting();
  client.emit(note('KEYwren1', 'id-wren'));
  assert.equal(waiting(), before, 'somebody muted does not badge a room');
  client.emit(note('KEYother', 'id-other'));
  assert.equal(waiting(), before + 1, 'somebody else with the same name does');
});

test('the offer is never about your own words or the past, and can be turned off', async () => {
  const client = await loadClient();
  arrive(client.emit);
  // Swearing from before this page opened, arriving all at once.
  client.emit({
    type: 'history',
    rooms: { art: [{ id: 'h1', room: 'art', author: 'old', authorId: 'id-old', authorKey: 'KEYold01', body: 'shit happened', at: 1 }] },
  });
  clickRoom(client, 'art');
  const offers = () => client.document.querySelectorAll('#log .mute-offer').length;
  assert.equal(offers(), 0, 'what was said before you came is not asked about');

  client.emit(said({ author: 'guest', authorId: 'u1', id: 'm1', body: 'oh shit' }));
  assert.equal(offers(), 0, 'nor is anything you said');

  const offer = client.$('offer-mute');
  offer.checked = false;
  offer.dispatchEvent(new client.document.defaultView.Event('change'));
  assert.equal(client.store.get('eulerchat.offerMute'), 'off');
  client.emit(said({ ...wren, id: 'm2', body: 'bollocks' }));
  assert.equal(offers(), 0, 'turned off, nobody is offered');
});

// --- a group wraps its rooms -----------------------------------------------------

test('inside a group the map is the map outside, with a line round it', async () => {
  const client = await loadClient({ storage: { 'eulerchat.group': 'kite-fox-9' } });
  arrive(client.emit);
  const everyone = 'kite-fox-9/everyone';
  const art = 'kite-fox-9/art';
  const square = (r, dx) => [[[dx - r, -r], [dx + r, -r], [dx + r, r], [dx - r, r]]];
  const stats = { messages: 0, perMinute: 0, last: null };

  client.emit({
    type: 'state',
    subscription: [art, everyone],
    funnel: 0,
    rail: { held: [art, everyone], suggested: ['kite-fox-9/philosophy'], popular: [], total: 3 },
  });
  client.emit({
    type: 'atlas',
    subjects: [art, everyone],
    extent: 1000,
    zones: [
      { key: everyone, subjects: [everyone], population: 2, x: -60, y: 0, room: 40, seed: { x: -60, y: 0 }, loops: square(40, -60) },
      { key: `${art}+${everyone}`, subjects: [art, everyone], population: 3, x: 60, y: 0, room: 40, seed: { x: 60, y: 0 }, loops: square(40, 60) },
    ],
    curves: [
      // The group's own conversation: its ground is every room in the group.
      { subject: everyone, components: 1, anchor: { x: -60, y: 0, room: 40 }, loops: [[[-100, -40], [100, -40], [100, 40], [-100, 40]]] },
      { subject: art, components: 1, anchor: { x: 60, y: 0, room: 40 }, loops: square(40, 60) },
    ],
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: [art, everyone],
    rooms: [
      { key: everyone, subjects: [everyone], population: 5, here: 2, member: true, messages: 0, stats },
      { key: `${art}+${everyone}`, subjects: [art, everyone], population: 3, here: 3, member: true, messages: 0, stats },
    ],
  });

  const map = client.$('diagram');
  assert.equal(map.querySelectorAll('.territory.group-frame').length, 1, 'the group is drawn as one frame');
  const words = [...map.querySelectorAll('.atlas-label')].map((t) => t.textContent);
  assert.ok(words.includes('kite-fox-9'), `the frame carries the group's name: ${words}`);
  assert.ok(words.includes('art'), 'and art inside it is called art');
  assert.ok(!words.some((w) => w.includes('/')), 'nothing on the map wears the prefix');
  assert.equal(map.querySelectorAll('.zone-label').length, 0, 'art inside the frame is art, not an overlap');
  assert.ok(
    ![...map.querySelectorAll('.texture')].some((t) => (t.getAttribute('data-subject') ?? '').includes('everyone')),
    'the frame is not sown over every room in it',
  );

  const chips = [...client.document.querySelectorAll('.room-chip')].map((c) => c.getAttribute('aria-label'));
  assert.ok(chips.some((l) => l.startsWith('art, ')), chips.join(' | '));

  const rows = [...client.document.querySelectorAll('#subjects .name')].map((n) => n.textContent);
  assert.ok(rows.includes('art') && rows.includes('philosophy'), rows.join(', '));

  // Leaving the conversation that wraps the group is leaving the group, and
  // the button says so.
  const leave = [...client.document.querySelectorAll('#subjects button')].find((b) => b.textContent === 'Leave group');
  assert.ok(leave, 'the group\'s own conversation offers to leave the group');
  leave.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.$('group-label').textContent, 'Group', 'and does');
});

// --- machine questions -------------------------------------------------------

test('a question the server wrote says so, beside the name and when read aloud', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  client.emit({ type: 'recording', on: true });

  client.emit(said({ author: 'painter-4', authorId: 'id-p4', id: 'q1', body: 'What got you into art?', machine: true }));
  client.emit(said({ author: 'wren', authorId: 'id-wren', id: 'm1', body: 'painting, mostly' }));

  const rows = [...client.document.querySelectorAll('#log li')];
  const question = rows.find((li) => li.textContent.includes('What got you into art?'));
  const answer = rows.find((li) => li.textContent.includes('painting, mostly'));
  assert.ok(question.classList.contains('machine'));
  assert.equal(question.querySelector('.machine-mark')?.textContent, 'system message');
  assert.equal(answer.querySelector('.machine-mark'), null, 'and nobody else\'s does');

  // Read aloud as what it is, not as somebody talking.
  client.emit(said({ author: 'painter-4', authorId: 'id-p4', id: 'q2', body: 'Where do art and music meet?', machine: true }));
  assert.match(client.$('said').textContent, /^System message, as painter-4/);

  // And a kept copy keeps the label, which the server will check it by.
  const kept = client.kept().find((m) => m.id === 'q1');
  assert.equal(kept?.machine, true);
  assert.equal(client.kept().find((m) => m.id === 'm1')?.machine, undefined);
});

// --- quick join: a lurker ----------------------------------------------------------

test('a quick-join code opens one conversation to lurk in, and leaves nothing behind', async () => {
  const client = await loadClient({ href: 'http://localhost:8787/?watch=art' });
  const wrote = [];
  globalThis.sessionStorage = { getItem: () => null, setItem: (k) => wrote.push(k), removeItem: (k) => wrote.push(k) };
  const stored = () => [...client.store.keys()];
  const press = (id) => client.$(id).dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const sent = (type) => client.socket.sent.filter((f) => f.type === type);

  assert.ok('lurking' in client.document.body.dataset, 'the page is a lurker from the start');
  assert.equal(client.$('lurk-bar').hidden, false);

  client.emit({ type: 'welcome', you: { id: 'u9', name: 'guest-9' }, maxArity: 3 });
  assert.deepEqual(sent('watch').map((f) => f.room), ['art'], 'straight to the one conversation');
  for (const type of ['identify', 'resume', 'keys', 'createSubject', 'join', 'atlas', 'restore']) {
    assert.equal(sent(type).length, 0, `a lurker sends no ${type}`);
  }

  client.emit({
    type: 'watching',
    room: 'art',
    subjects: ['art'],
    population: 12,
    stats: { messages: 1, perMinute: 0, last: null },
    messages: [{ id: 'h1', room: 'art', author: 'hila', authorId: 'id-hila', body: 'raw umber, mostly', at: 1 }],
  });
  client.emit({ type: 'state', subscription: [], funnel: 0, rail: { held: [], suggested: [], popular: [], total: 1 } });
  assert.equal(sent('atlas').length, 0, 'a lurker is never drawn a map');
  assert.equal(client.$('room-title').textContent, 'art');
  assert.match(client.$('room-meta').textContent, /you are lurking$/);

  // Counted with the others watching, never named.
  client.emit({ type: 'lurkers', room: 'art', count: 3 });
  assert.match(client.$('room-meta').textContent, /you and 2 more are lurking/);
  assert.match(client.$('log').textContent, /raw umber/);
  assert.equal(client.$('room-share').hidden, true, 'nothing to share from a lurker');

  // What arrives is heard, and survives a history the lurker has no rooms in.
  client.emit(said({ id: 'm1', author: 'wren', authorId: 'id-wren', body: 'anyone else underpainting?' }));
  client.emit({ type: 'history', rooms: {} });
  assert.match(client.$('log').textContent, /underpainting/);
  assert.match(client.$('log').textContent, /raw umber/);
  assert.equal(client.document.querySelectorAll('#log .msg-action, #log .votes').length, 0, 'watching is not taking part');

  assert.deepEqual(stored(), [], 'nothing written on this device');
  assert.deepEqual(wrote, [], 'not even which connection it was');

  // Joining in is the press that says they are here.
  press('lurk-join');
  assert.equal('lurking' in client.document.body.dataset, false);
  assert.equal(client.$('lurk-bar').hidden, true);
  assert.equal(sent('unwatch').length, 1);
  assert.deepEqual(sent('createSubject').map((f) => f.name), ['art']);
  assert.equal(sent('atlas').length, 1, 'and the rest of the place is asked for');
});

test('looking around ends lurking too, and joins nothing', async () => {
  const client = await loadClient({ href: 'http://localhost:8787/?watch=art%2Bphilosophy' });
  client.emit({ type: 'welcome', you: { id: 'u9', name: 'guest-9' }, maxArity: 3 });
  client.$('lurk-leave').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal('lurking' in client.document.body.dataset, false);
  assert.equal(client.socket.sent.filter((f) => f.type === 'createSubject' || f.type === 'join').length, 0);
});

test('an open conversation offers a quick-join code for itself', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  const share = client.$('room-share');
  assert.equal(share.hidden, false);
  share.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.$('room-share-pop').hidden, false);
  assert.equal(client.$('room-share-url').getAttribute('href'), 'http://localhost:8787/?watch=art');
  assert.ok(client.$('room-share-qr').children.length > 400, 'drawn as a square of cells');
});

test('the people in a room see how many are lurking in it, and not who', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  const chip = () => [...client.document.querySelectorAll('.room-chip')].find((c) => (c.getAttribute('aria-label') ?? '').startsWith('art, '));

  assert.equal(chip().querySelector('.lurk-count'), null, 'nobody watching, nothing said');
  assert.doesNotMatch(client.$('room-meta').textContent, /lurking/);

  client.emit({ type: 'lurkers', room: 'art', count: 2 });
  assert.equal(chip().querySelector('.lurk-count')?.textContent, '2 lurking');
  assert.match(chip().getAttribute('aria-label'), /art, 4 people, 2 lurking/);
  assert.match(client.$('room-meta').textContent, /4 people · 2 lurking · you are here/);

  client.emit({ type: 'lurkers', room: 'art', count: 0 });
  assert.equal(chip().querySelector('.lurk-count'), null, 'and gone again when they are');
});

// --- icons --------------------------------------------------------------------

test('the buttons carry icons, every icon exists, and they stay when the words change', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const buttons = [
    'interests-open', 'group-open', 'settings-open', 'appearance-open', 'bell', 'swap-sides', 'reset-layout',
    'check-deletions', 'new-key', 'room-share', 'send', 'rooms-open', 'room-list', 'map-expand', 'view-open', 'refit',
    'tip-show', 'lede-close', 'interests-close', 'create', 'map-close', 'appearance-close', 'cluster-new',
    'cluster-copy', 'cluster-leave', 'lurk-join', 'lurk-leave', 'room-share-copy',
    'float-map', 'map-popout', 'map-grip', 'dock-left', 'dock-right', 'explore-open-map',
  ];
  for (const id of buttons) assert.ok(client.$(id).querySelector('svg.icon use'), `#${id} has an icon`);
  for (const tab of client.$('switch').querySelectorAll('button')) assert.ok(tab.querySelector('svg.icon'));

  // Every icon used is one the page draws.
  for (const use of client.document.querySelectorAll('svg.icon use')) {
    const name = use.getAttribute('href').slice(1);
    assert.ok(client.$(name)?.tagName.toLowerCase() === 'symbol', `no icon called ${name}`);
  }

  // Words rewritten, icon kept: the bell is painted as the page loads.
  assert.match(client.$('bell').textContent, /alerts/i);
  assert.ok(client.$('bell').querySelector('svg.icon'));
  press(client.$('cluster-copy'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(client.$('cluster-copy').textContent, /Selected|Copied/);
  assert.ok(client.$('cluster-copy').querySelector('svg.icon'), 'copying keeps the icon');

  // And the one made by the script: the way into a room you are not in.
  outsideRooms(client.emit);
  clickRoom(client, 'philosophy');
  assert.ok(client.document.querySelector('#log .join-here svg.icon use'));
  assert.match(client.document.querySelector('#log .join-here').textContent, /Join philosophy/);
});

// --- all interests -----------------------------------------------------------

/** A pointer event, which linkedom has no constructor for. */
const pointer = (client, target, type, { x = 0, y = 0, id = 1 } = {}) =>
  target.dispatchEvent(
    Object.assign(new client.document.defaultView.Event(type, { bubbles: true }), { pointerId: id, clientX: x, clientY: y }),
  );

/**
 * How big a dot is drawn against its size on the sheet: its radius flat, the
 * scale of its whole column in relief.
 */
const sizeOf = (dot) => {
  if (dot.hasAttribute('r')) return Number(dot.getAttribute('r')) / Number(dot.getAttribute('data-r'));
  const scaled = /scale\(([\d.]+)\)/.exec(dot.getAttribute('transform') ?? '');
  return scaled ? Number(scaled[1]) : 1;
};

/** A real stocked world's chart, with art in it, since `arrive` holds art. */
const stockedChart = async () => {
  const { stock } = await import('../server/store.js');
  const world = new World();
  stock(world);
  world.addSubject('art');
  world.join(world.addUser('someone'), 'art');
  return world.chart();
};

test('the minimap opens every interest on one sheet, fetched only then', async () => {
  const client = await loadClient();
  arrive(client.emit);
  assert.ok(!client.socket.sent.some((f) => f.type === 'chart'), 'nothing is fetched for a sheet nobody opened');

  // The minimap itself and the button beside it both go in.
  click(client, 'minimap');
  assert.ok(client.$('explorer').open, 'pressing the minimap opens it');
  assert.equal(client.socket.sent.filter((f) => f.type === 'chart').length, 1, 'and asks for the chart');
  click(client, 'explorer-close');
  assert.ok(!client.$('explorer').open);
  click(client, 'explore-open');
  assert.equal(client.socket.sent.filter((f) => f.type === 'chart').length, 2, 'afresh each time it opens');

  const chart = await stockedChart();
  client.emit({ type: 'chart', ...chart });
  const sheet = client.$('explorer-chart');
  assert.equal(sheet.querySelectorAll('.dot').length, chart.subjects.length, 'every interest is a dot');
  assert.equal(sheet.querySelectorAll('.chart-division').length, 12, 'the divisions are named over their patches');
  assert.ok(sheet.querySelectorAll('.chart-field').length > 50, 'and the fields, for when it is zoomed');
  assert.ok(sheet.querySelector('.dot[data-id="art"]').classList.contains('mine'), 'what they hold is marked');
  assert.ok(sheet.querySelector('.dot[data-id="chess"]').classList.contains('empty'), 'and what nobody holds is faint');
  assert.ok(!sheet.classList.contains('close'), 'names of interests wait for the zoom');

  // In close enough, and the interests are named; out again, and they go.
  const art = sheet.querySelector('.dot[data-id="art"]');
  const r = () => sizeOf(art);
  for (let i = 0; i < 4; i += 1) click(client, 'explorer-in');
  assert.ok(sheet.classList.contains('near') && sheet.classList.contains('close'));
  // The dots grow more slowly than the sheet, or a knot of them would stay
  // a knot however far in it was zoomed.
  assert.ok(r() < 0.6, `dots at ${r().toFixed(2)} of their size on the sheet`);
  click(client, 'explorer-home');
  assert.ok(!sheet.classList.contains('near'));
  assert.equal(r(), 1);
});

test('Explore sits beside Conversations on the map, and goes to the same place', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const button = client.$('explore-open-map');
  assert.equal(button.parentNode, client.$('rooms-open').parentNode, 'beside Conversations');
  assert.equal(button.previousElementSibling, client.$('rooms-open'), 'and straight after it');
  // Named whatever the width does to its words.
  assert.equal(button.getAttribute('aria-label'), 'Explore interests');

  click(client, 'explore-open-map');
  assert.ok(client.$('explorer').open, 'pressing it opens every interest');
  assert.equal(client.socket.sent.filter((f) => f.type === 'chart').length, 1);
});

test('a pointer resting on Explore plays a little of the sheet, and leaving puts it away', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const { Event } = client.document.defaultView;
  const { World: Stocked } = await import('../server/store.js');
  const { populate } = await import('../server/populate.js');
  const overview = populate(new Stocked(), { subjects: 200, users: 400, chatter: 0 }).overview();
  client.emit({ type: 'overview', ...overview });

  const card = client.$('explore-peek');
  assert.equal(card.getAttribute('aria-hidden'), 'true', 'nothing in it a screen reader needs');
  const point = (id, type, pointerType = 'mouse') => {
    const evt = new Event(type);
    evt.pointerType = pointerType;
    client.$(id).dispatchEvent(evt);
  };

  // It plays for as long as the pointer rests, which in a test that fails
  // halfway is for ever: whatever happens, the pointer leaves.
  try {
    // A finger does not rest.
    point('explore-open-map', 'pointerenter', 'touch');
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(card.hidden, true, 'not for a touch');

    // Passing over is not resting.
    point('explore-open-map', 'pointerenter');
    point('explore-open-map', 'pointerleave');
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(card.hidden, true, 'not for a pointer on its way past');

    for (const id of ['explore-open-map', 'explore-open']) {
      point(id, 'pointerenter');
      await waitFor(() => !card.hidden, `the card, on ${id}`);
      const map = client.$('explore-peek-map');
      assert.equal(map.querySelectorAll('.peek-dots circle').length, overview.subjects.length, 'every interest is a dot on it');
      assert.match(client.$('explore-peek-say').textContent, /every interest/i, 'and it says what it is showing');
      // Off to the first stop, where the names come up.
      await waitFor(() => map.querySelectorAll('.peek-names text').length > 0, 'names at the first stop', 4000);
      assert.match(client.$('explore-peek-say').textContent, /names/i);
      point(id, 'pointerleave');
      assert.equal(card.hidden, true, 'leaving puts it away at once');
    }
  } finally {
    point('explore-open-map', 'pointerleave');
  }
});

test('an interest is found by typing, and joined or opened from beside the sheet', async () => {
  const client = await loadClient();
  arrive(client.emit);
  click(client, 'explore-open');
  client.emit({ type: 'chart', ...(await stockedChart()) });
  const { Event } = client.document.defaultView;
  const sheet = client.$('explorer-chart');

  const find = client.$('explorer-find');
  find.value = 'ches';
  find.dispatchEvent(new Event('input'));
  const listed = [...client.document.querySelectorAll('#explorer-found button')];
  assert.equal(listed[0]?.getAttribute('aria-label'), 'chess, nobody yet', 'the match is listed, and says how many');
  assert.ok(sheet.classList.contains('searching'));
  assert.ok(sheet.querySelector('.dot[data-id="chess"]').classList.contains('found'), 'and lit on the sheet');
  assert.ok(!sheet.querySelector('.dot[data-id="art"]').classList.contains('found'), 'with the rest dimmed');

  // Enter takes the first: the way round it without a pointer.
  find.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter' }));
  assert.equal(client.$('explorer-pick').hidden, false);
  assert.equal(client.$('explorer-name').textContent, 'chess');
  assert.equal(client.$('explorer-path').textContent, 'hobbies › games', 'where it sits, broadest first');
  assert.match(client.$('explorer-said').textContent, /^chess\. Nobody has joined it yet/, 'and said aloud');
  assert.ok(sheet.classList.contains('close'), 'flown to, close enough to read');
  assert.ok(sheet.querySelector('.chart-name[data-id="chess"]').classList.contains('picked'));
  assert.equal(sheet.querySelector('.chart-dots').lastElementChild.getAttribute('data-id'), 'chess', 'in front of its neighbours');

  const actions = () => [...client.$('explorer-actions').querySelectorAll('button')];
  assert.deepEqual(actions().map((b) => b.textContent), ['Join', 'Browse games']);
  actions()[0].dispatchEvent(new Event('click', { bubbles: true }));
  assert.ok(client.socket.sent.some((f) => f.type === 'join' && f.subject === 'chess'));

  // Joined: the panel changes its offer, and the chart is counted again.
  const asked = client.socket.sent.filter((f) => f.type === 'chart').length;
  client.emit({
    type: 'state',
    subscription: ['art', 'chess'],
    funnel: 0,
    rail: { held: ['art', 'chess'], suggested: [], popular: [], total: 2 },
  });
  assert.deepEqual(actions().map((b) => b.textContent), ['Open its chat', 'Leave', 'Browse games']);
  assert.ok(sheet.querySelector('.dot[data-id="chess"]').classList.contains('mine'));
  assert.equal(client.socket.sent.filter((f) => f.type === 'chart').length, asked + 1);

  // Browsing its field leaves for the interests list, at that field.
  actions()[2].dispatchEvent(new Event('click', { bubbles: true }));
  assert.ok(!client.$('explorer').open);
  assert.ok(client.$('interests').open);
  assert.ok(client.socket.sent.some((f) => f.type === 'browse' && f.at === 'games'));
});

test('pressing a dot picks it, and dragging the sheet does not', async () => {
  const client = await loadClient();
  arrive(client.emit);
  click(client, 'explore-open');
  client.emit({ type: 'chart', ...(await stockedChart()) });
  const sheet = client.$('explorer-chart');
  const art = sheet.querySelector('.dot[data-id="art"]');

  pointer(client, art, 'pointerdown', { x: 10, y: 10 });
  pointer(client, sheet, 'pointermove', { x: 60, y: 40 });
  pointer(client, sheet, 'pointerup', { x: 60, y: 40 });
  assert.equal(client.$('explorer-pick').hidden, true, 'a drag that began on a dot moved the sheet instead');

  // Released on the sheet, as a captured pointer is: still the dot pressed.
  pointer(client, art, 'pointerdown', { x: 10, y: 10 });
  pointer(client, sheet, 'pointerup', { x: 11, y: 10 });
  assert.equal(client.$('explorer-name').textContent, 'art');
  assert.match(client.$('explorer-people').textContent, /^1 person holds it, you among them\.$/);

  // Held, so its conversation is one press away, and the sheet gets out of it.
  const open = client.$('explorer-actions').querySelector('button');
  assert.equal(open.textContent, 'Open its chat');
  open.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(!client.$('explorer').open);
  assert.equal(client.$('room-title').textContent, 'art');
});

test('lines join interests people hold together, and a picked one lists and follows its own', async () => {
  const client = await loadClient();
  arrive(client.emit);
  click(client, 'explore-open');
  const chart = await stockedChart();
  chart.links = [
    ['art', 'chess', 9, 0.3],
    ['art', 'padel', 2, 0.05],
    ['chess', 'padel', 4, 0.2],
  ];
  client.emit({ type: 'chart', ...chart });
  const sheet = client.$('explorer-chart');

  // Under the dots, in weights by how strong they are.
  const layer = sheet.querySelector('.chart-links');
  assert.ok(layer, 'the lines are drawn');
  assert.equal(layer.nextElementSibling, sheet.querySelector('.chart-dots'), 'under the dots');
  const segments = [...layer.querySelectorAll('path.chart-link')].map((p) => p.getAttribute('d').split('M').length - 1);
  assert.equal(segments.reduce((a, b) => a + b, 0), 3, 'one segment for each link');
  assert.ok(layer.querySelector('.weight-2') && layer.querySelector('.weight-0'), 'the strongest heavier than the weakest');
  assert.equal(client.$('explorer-with-wrap').hidden, true, 'nothing listed until something is picked');

  // Picked: its own lines over the rest, the far ends named, and a list.
  pointer(client, sheet.querySelector('.dot[data-id="art"]'), 'pointerdown', { x: 10, y: 10 });
  pointer(client, sheet, 'pointerup', { x: 10, y: 10 });
  assert.ok(sheet.classList.contains('linking'));
  assert.equal(sheet.querySelectorAll('.chart-link-picked line').length, 2, 'art has two lines');
  for (const id of ['chess', 'padel']) {
    assert.ok(sheet.querySelector(`.chart-name[data-id="${id}"]`).classList.contains('linked'), `${id} is named`);
  }
  assert.equal(client.$('explorer-with-wrap').hidden, false);
  const listed = [...client.$('explorer-with').querySelectorAll('button:not(.join-dot)')];
  assert.deepEqual(listed.map((b) => b.getAttribute('aria-label')), [
    'chess, 9 people hold both',
    'padel, 2 people hold both',
  ], 'strongest first, and says what the line means');
  // And each is offered beside its name, wearing its own swatch.
  assert.deepEqual(
    [...client.$('explorer-with').querySelectorAll('.join-dot')].map((b) => b.getAttribute('aria-label')),
    ['Join chess', 'Join padel'],
  );

  // Following one goes there: chess picked, its lines drawn, art's put away.
  listed[0].dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.$('explorer-name').textContent, 'chess');
  assert.equal(sheet.querySelectorAll('.chart-link-picked line').length, 2, 'chess has two lines too');
  assert.ok(!sheet.querySelector('.chart-name[data-id="chess"]').classList.contains('linked'), 'not linked to itself');
  assert.ok(sheet.querySelector('.chart-name[data-id="art"]').classList.contains('linked'));
  assert.deepEqual(
    [...client.$('explorer-with').querySelectorAll('button:not(.join-dot)')].map((b) => b.querySelector('span').textContent),
    ['art', 'padel'],
  );
});

test("inside a group the sheet lights the group's copies, and joins into the group", async () => {
  const client = await loadClient({ storage: { 'eulerchat.group': 'kite-fox-9' } });
  arrive(client.emit);
  const everyone = 'kite-fox-9/everyone';
  const art = 'kite-fox-9/art';
  client.emit({
    type: 'state',
    subscription: [art, everyone],
    funnel: 0,
    rail: { held: [art, everyone], suggested: [], popular: [], total: 2 },
  });

  click(client, 'explore-open');
  client.emit({ type: 'chart', ...(await stockedChart()) });
  const sheet = client.$('explorer-chart');
  assert.ok(sheet.querySelector('.dot[data-id="art"]').classList.contains('mine'), 'their art is art');
  assert.equal(sheet.querySelectorAll('.dot.mine').length, 1, "and the group's own conversation is no interest");

  const find = client.$('explorer-find');
  const { Event } = client.document.defaultView;
  find.value = 'chess';
  find.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter' }));
  client.$('explorer-actions').querySelector('button').dispatchEvent(new Event('click', { bubbles: true }));
  const made = client.socket.sent.filter((f) => f.type === 'createSubject').at(-1);
  assert.equal(made?.name, 'kite-fox-9/chess', "joined as the group's copy, not the open one");

  // Leaving leaves the copy actually held.
  pointer(client, sheet.querySelector('.dot[data-id="art"]'), 'pointerdown');
  pointer(client, sheet, 'pointerup');
  const leave = [...client.$('explorer-actions').querySelectorAll('button')].find((b) => b.textContent === 'Leave');
  leave.dispatchEvent(new Event('click', { bubbles: true }));
  assert.ok(client.socket.sent.some((f) => f.type === 'leave' && f.subject === art));
});

// --- relief ------------------------------------------------------------------

/**
 * The map as a real world draws it — rooms with shapes of their own, and one
 * talked in more than the rest — arrived at as `arrive` would.
 */
const seededMap = (client) => {
  const world = seed(new World());
  const member = world.addUser('member');
  world.join(member, 'art');
  world.join(member, 'philosophy');
  for (let i = 0; i < 12; i++) world.post(member, ['art', 'philosophy'], `hello ${i}`);
  const view = world.atlasFor(member, 3);
  client.emit({
    type: 'state',
    subscription: view.subscription,
    funnel: 0,
    rail: { held: view.subscription, suggested: [], popular: [], total: 2 },
  });
  client.emit({ type: 'atlas', ...view });
  return view;
};

const topOf = (client, key) =>
  [...client.$('diagram').querySelectorAll('.relief-top')].find((t) => t.getAttribute('data-zone') === key);

test('the map stands in relief, a raised room opens when pressed, and it can be turned and laid flat', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const view = seededMap(client);
  const map = client.$('diagram');
  assert.ok(map.querySelectorAll('.relief-top').length > 0, 'in relief to begin with');
  assert.equal(client.$('relief').getAttribute('aria-pressed'), 'true');

  // A room's top is not over its own ground any more, so it says which room
  // it is, and pressing it opens that room.
  const busiest = view.rooms.find((r) => r.activity === 1).key;
  const ground = topOf(client, busiest).querySelector('.zone-ground');
  ground.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(topOf(client, busiest).querySelector('.zone-ground').classList.contains('on'), 'the busiest room is open');
  const chip = [...client.document.querySelectorAll('.room-chip')].find((c) => c.getAttribute('aria-pressed') === 'true');
  assert.ok(chip, 'and its chip says so');

  // Turned, it is drawn from another side, at the same zoom.
  const before = topOf(client, busiest).getAttribute('transform');
  const width = map.getAttribute('viewBox').split(' ')[2];
  click(client, 'turn-right');
  assert.notEqual(topOf(client, busiest).getAttribute('transform'), before);
  assert.equal(map.getAttribute('viewBox').split(' ')[2], width);
  click(client, 'turn-left');
  assert.equal(topOf(client, busiest).getAttribute('transform'), before, 'and turned back, as it was');

  // Flat, the map it always was, and remembered.
  click(client, 'relief');
  assert.equal(map.querySelectorAll('.relief-top').length, 0);
  assert.ok(map.querySelectorAll('.zone-ground').length > 0);
  assert.equal(client.$('relief').getAttribute('aria-pressed'), 'false');
  assert.equal(client.$('turn-left').disabled, true, 'nothing to turn when flat');
  assert.equal(client.store.get('eulerchat.relief'), 'flat');
});

test('a map laid flat stays flat on the next visit', async () => {
  const client = await loadClient({ storage: { 'eulerchat.relief': 'flat' } });
  arrive(client.emit);
  seededMap(client);
  assert.equal(client.$('diagram').querySelectorAll('.relief-top').length, 0);
  assert.equal(client.$('relief').getAttribute('aria-pressed'), 'false');
});

test('All interests stands in relief too, and one setting lays both flat', async () => {
  const client = await loadClient();
  arrive(client.emit);
  click(client, 'explore-open');
  client.emit({ type: 'chart', ...(await stockedChart()) });
  const sheet = client.$('explorer-chart');
  const art = () => sheet.querySelector('.dot[data-id="art"]');
  assert.equal(art().tagName.toLowerCase(), 'g', 'each interest a column');
  assert.ok(art().querySelector('.column-top'));
  assert.equal(client.$('explorer-relief').getAttribute('aria-pressed'), 'true');

  const where = art().getAttribute('data-x');
  click(client, 'explorer-turn-right');
  assert.notEqual(art().getAttribute('data-x'), where, 'turned');

  click(client, 'explorer-relief');
  assert.equal(art().tagName.toLowerCase(), 'circle', 'flat, a dot again');
  assert.equal(client.$('explorer-turn-left').disabled, true);
  assert.equal(client.$('relief').getAttribute('aria-pressed'), 'false', 'and the map is flat too');
  assert.equal(client.store.get('eulerchat.relief'), 'flat');
});

// --- adding from the list ------------------------------------------------------------

test('a room of more than three is listed with three squares, how many more, and every name', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const five = ['art', 'chess', 'music', 'philosophy', 'poetry'];
  const key = five.join('+');
  client.emit({
    type: 'atlas',
    subjects: five,
    extent: 1000,
    zones: [{ key, subjects: five, population: 2, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } }],
    curves: five.map((subject) => ({ subject, components: 1, anchor: { x: 0, y: 0, room: 60 }, loops: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]] })),
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: five,
    rooms: [{ key, subjects: five, population: 2, here: 2, member: true, messages: 0, stats: { messages: 0, perMinute: 0, last: null } }],
  });
  const chip = [...client.document.querySelectorAll('.room-chip')].find((c) => (c.getAttribute('aria-label') ?? '').includes('poetry'));
  assert.ok(chip, 'the room is listed');
  assert.equal(chip.querySelectorAll('.chip-glyphs .glyph').length, 3, 'three squares, as the list has room for');
  assert.equal(chip.querySelector('.chip-more')?.textContent, '+2', 'and how many more');
  for (const name of five) assert.match(chip.textContent, new RegExp(name), `${name} is named`);
});

test("inside a group, the list offers the group's copy of what is held outside", async () => {
  const client = await loadClient({ storage: { 'eulerchat.group': 'kite-fox-9' } });
  arrive(client.emit);
  const everyone = 'kite-fox-9/everyone';
  const state = (subscription) =>
    client.emit({ type: 'state', subscription, funnel: 0, rail: { held: subscription, suggested: [], popular: [], total: subscription.length } });
  // Art held outside, and in the group, nothing yet.
  state(['art', everyone]);
  client.document.querySelector('.interests-open').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  client.emit({ type: 'chart', ...(await stockedChart()) });
  const list = client.$('add-interest');
  const option = (value) => [...list.querySelectorAll('option')].find((o) => o.value === value);
  assert.equal(option('art').hasAttribute('disabled'), false, "the group's art is not held, so it can be added");

  option('').selected = false;
  option('art').selected = true;
  list.dispatchEvent(new client.document.defaultView.Event('change', { bubbles: true }));
  assert.ok(
    client.socket.sent.some((f) => f.type === 'createSubject' && f.name === 'kite-fox-9/art'),
    "picking it joins the group's art",
  );

  // Once held there, it is marked there.
  state(['art', 'kite-fox-9/art', everyone]);
  assert.equal(option('art').hasAttribute('disabled'), true);
});

test('Interests lists the whole catalogue by division, and picking from it joins', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const list = client.$('add-interest');
  assert.equal(list.disabled, true, 'nothing to pick until the catalogue comes');

  client.document.querySelector('.interests-open').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(client.socket.sent.some((f) => f.type === 'chart'), 'opening Interests asks for it');
  client.emit({ type: 'chart', ...(await stockedChart()) });
  assert.equal(list.disabled, false);

  // The divisions as groups, each starting with itself, its fields and
  // interests indented under it; what nobody catalogued at the end.
  const groups = [...list.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'));
  assert.equal(groups.length, 13);
  assert.equal(groups[0], 'Applied sciences');
  assert.equal(groups.at(-1), 'Not in the catalogue yet');
  const option = (value) => [...list.querySelectorAll('option')].find((o) => o.value === value);
  assert.equal(option('hobbies').parentElement.getAttribute('label'), 'Hobbies');
  assert.match(option('games').textContent, /^( ){3}› games/);
  assert.match(option('chess').textContent, /^( ){6}› chess/);
  // Held already: listed, marked, not to be picked again.
  assert.ok(option('art').hasAttribute('disabled'));
  assert.match(option('art').textContent, /joined/);

  // Chosen as a browser chooses: the prompt let go, and that one taken.
  option('').selected = false;
  option('chess').selected = true;
  list.dispatchEvent(new client.document.defaultView.Event('change', { bubbles: true }));
  assert.ok(client.socket.sent.some((f) => f.type === 'join' && f.subject === 'chess'), 'picking it joins it');
  assert.equal(client.$('add-said').textContent, 'Joined chess.');
  assert.equal(option('').selected, true, 'and the list goes back to asking');

  client.emit({
    type: 'state',
    subscription: ['art', 'chess'],
    funnel: 0,
    rail: { held: ['art', 'chess'], suggested: [], popular: [], total: 2 },
  });
  assert.ok(option('chess').hasAttribute('disabled'), 'now it is held');
});

// --- orbiting and zooming by hand --------------------------------------------------

/** A finger on the page: a pointer event, which linkedom has no constructor for. */
const finger = (client, target, type, { x = 0, y = 0, id = 1 } = {}) =>
  target.dispatchEvent(
    Object.assign(new client.document.defaultView.Event(type, { bubbles: true, cancelable: true }), {
      pointerId: id,
      clientX: x,
      clientY: y,
      button: 0,
      pointerType: 'touch',
    }),
  );

const later = (ms) => new Promise((r) => setTimeout(r, ms));
const widthOf = (map) => Number(map.getAttribute('viewBox').split(' ')[2]);

test('on a phone a tap on the map waits to be sure, and a double tap zooms instead of opening', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const view = seededMap(client);
  // Let the page's own first fitting of the map land before touching it.
  await later(60);
  const map = client.$('diagram');
  const busiest = view.rooms.find((r) => r.activity === 1).key;
  const ground = () => topOf(client, busiest).querySelector('.zone-ground');

  // Twice, quickly: in, and nothing opened.
  const before = widthOf(map);
  for (const x of [100, 102]) {
    finger(client, ground(), 'pointerdown', { x, y: 100 });
    finger(client, map, 'pointerup', { x, y: 100 });
  }
  await later(360);
  assert.ok(Math.abs(widthOf(map) - before / 2) < 1e-6, 'a double tap zooms in twice as close');
  assert.equal(ground().classList.contains('on'), false, 'and opens nothing');

  // Once: the room, when it is clear no second tap is coming.
  finger(client, ground(), 'pointerdown', { x: 100, y: 100 });
  finger(client, map, 'pointerup', { x: 100, y: 100 });
  assert.equal(ground().classList.contains('on'), false, 'not yet');
  await later(360);
  assert.ok(ground().classList.contains('on'), 'then it opens');
});

test('one finger moves the map; two turn it, and pinched bring it closer; a drag opens nothing', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const view = seededMap(client);
  await later(60);
  const map = client.$('diagram');
  const busiest = view.rooms.find((r) => r.activity === 1).key;
  const start = topOf(client, busiest).getAttribute('transform');
  const left = () => Number(map.getAttribute('viewBox').split(' ')[0]);

  // One finger, dragged across: moved, and not turned.
  const x = left();
  finger(client, map, 'pointerdown', { x: 200, y: 200 });
  finger(client, map, 'pointermove', { x: 240, y: 195 });
  finger(client, map, 'pointermove', { x: 280, y: 190 });
  finger(client, map, 'pointerup', { x: 280, y: 190 });
  await later(40);
  assert.ok(left() < x, 'moved with the finger');
  assert.equal(topOf(client, busiest).getAttribute('transform'), start, 'and not turned');

  // Two fingers dragged across together: turned.
  finger(client, map, 'pointerdown', { id: 1, x: 100, y: 200 });
  finger(client, map, 'pointerdown', { id: 2, x: 200, y: 200 });
  finger(client, map, 'pointermove', { id: 1, x: 130, y: 200 });
  finger(client, map, 'pointermove', { id: 2, x: 230, y: 200 });
  finger(client, map, 'pointermove', { id: 1, x: 160, y: 200 });
  finger(client, map, 'pointermove', { id: 2, x: 260, y: 200 });
  finger(client, map, 'pointerup', { id: 1, x: 160, y: 200 });
  finger(client, map, 'pointerup', { id: 2, x: 260, y: 200 });
  await later(40);
  const turned = topOf(client, busiest).getAttribute('transform');
  assert.notEqual(turned, start, 'turned');

  // Two fingers spread apart: closer, and not turned.
  const width = widthOf(map);
  finger(client, map, 'pointerdown', { id: 1, x: 100, y: 200 });
  finger(client, map, 'pointerdown', { id: 2, x: 200, y: 200 });
  finger(client, map, 'pointermove', { id: 1, x: 70, y: 200 });
  finger(client, map, 'pointermove', { id: 2, x: 230, y: 200 });
  finger(client, map, 'pointermove', { id: 1, x: 40, y: 200 });
  finger(client, map, 'pointermove', { id: 2, x: 260, y: 200 });
  finger(client, map, 'pointerup', { id: 1, x: 40, y: 200 });
  finger(client, map, 'pointerup', { id: 2, x: 260, y: 200 });
  await later(40);
  assert.ok(widthOf(map) < width, 'closer');
  assert.equal(topOf(client, busiest).getAttribute('transform'), turned, 'and not turned');

  // A drag ends in a click on whatever it let go of; that is not a choice.
  const ground = topOf(client, busiest).querySelector('.zone-ground');
  finger(client, ground, 'pointerdown', { x: 100, y: 100 });
  finger(client, map, 'pointermove', { x: 160, y: 130 });
  finger(client, map, 'pointerup', { x: 160, y: 130 });
  ground.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  await later(360);
  assert.equal(topOf(client, busiest).querySelector('.zone-ground').classList.contains('on'), false);
});

// --- a map that holds still ------------------------------------------------------

test('the same map arriving again is not drawn again, and a changed one waits its turn and keeps the view', async (t) => {
  const client = await loadClient();
  arrive(client.emit);
  const view = seededMap(client);
  await later(60);
  const map = client.$('diagram');
  const first = map.querySelector('.relief-top');

  // Somebody else's change nearby: the server sends the atlas again, and it
  // says what it said. Nothing on the map is touched.
  client.emit({ type: 'atlas', ...view, rooms: view.rooms.map((r) => ({ ...r, lurkers: 3 })) });
  assert.equal(map.querySelector('.relief-top'), first, 'the very same drawing');
  assert.ok(client.document.querySelector('.room-chip'), 'though the list is brought up to date');

  // Turned, then something on the map really changes because of somebody
  // else: drawn again, but not at once — other people's changes redraw it at
  // most every ten seconds — and then under the view as it was, rather than
  // framed back to the start.
  click(client, 'turn-right');
  const zoomed = map.getAttribute('viewBox');
  const standing = map.querySelector('.relief-top');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const busier = view.rooms.map((r, i) => ({ ...r, activity: i === 0 ? 1 : 0 }));
  client.emit({ type: 'atlas', ...view, rooms: busier });
  assert.equal(map.querySelector('.relief-top'), standing, 'not yet');
  t.mock.timers.tick(9_000);
  assert.equal(map.querySelector('.relief-top'), standing, 'not yet');
  t.mock.timers.tick(1_000);
  assert.notEqual(map.querySelector('.relief-top'), standing, 'drawn again, ten seconds on');
  assert.equal(map.getAttribute('viewBox'), zoomed, 'and not moved');
  t.mock.timers.reset();

  // Holding something new is a reason to frame it again.
  client.emit({ type: 'atlas', ...view, rooms: busier, subscription: [...view.subscription, 'music'] });
  assert.notEqual(map.getAttribute('viewBox'), zoomed);

  // And Reset view is always a reason.
  click(client, 'turn-left');
  const turned = map.getAttribute('viewBox');
  click(client, 'refit');
  await later(40);
  assert.notEqual(map.getAttribute('viewBox'), turned);
});

test('the same chart arriving again leaves All interests as it is', async () => {
  const client = await loadClient();
  arrive(client.emit);
  click(client, 'explore-open');
  const chart = await stockedChart();
  client.emit({ type: 'chart', ...chart });
  const art = client.$('explorer-chart').querySelector('.dot[data-id="art"]');
  client.emit({ type: 'chart', ...chart });
  assert.equal(client.$('explorer-chart').querySelector('.dot[data-id="art"]'), art);
});

test("somebody else's change reaches All interests at most every ten seconds, and then the latest of them", async (t) => {
  const client = await loadClient();
  arrive(client.emit);
  click(client, 'explore-open');
  const chart = await stockedChart();
  client.emit({ type: 'chart', ...chart });
  const sheet = client.$('explorer-chart');
  const first = sheet.querySelector('.dot[data-id="chess"]');

  // Two people join chess, a moment apart: two charts, each different.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const more = (n) => ({ ...chart, subjects: chart.subjects.map((s) => (s.id === 'chess' ? { ...s, n } : s)) });
  client.emit({ type: 'chart', ...more(1) });
  t.mock.timers.tick(2_000);
  client.emit({ type: 'chart', ...more(2) });
  assert.equal(sheet.querySelector('.dot[data-id="chess"]'), first, 'not drawn again yet');
  t.mock.timers.tick(7_000);
  assert.equal(sheet.querySelector('.dot[data-id="chess"]'), first, 'nor after nine seconds');
  t.mock.timers.tick(1_000);
  const drawn = sheet.querySelector('.dot[data-id="chess"]');
  assert.notEqual(drawn, first, 'drawn again ten seconds on');
  assert.match(drawn.querySelector('title').textContent, /2 people/, 'with the latest of them');
  t.mock.timers.reset();
});

test("the map is asked for every ten seconds, somebody else's changes with it, and their own at once", async (t) => {
  const client = await loadClient();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  arrive(client.emit);
  const asked = () => client.socket.sent.filter((f) => f.type === 'atlas').length;
  const first = asked();
  const drawing = client.$('diagram').firstElementChild;
  assert.ok(drawing, 'a map to look at');

  // Five people come and go near what they hold, a second apart: the server
  // says so each time, and the subscription is the same each time.
  const same = { type: 'state', subscription: ['art'], funnel: 0, rail: { held: ['art'], suggested: [], popular: [], total: 1 } };
  for (let i = 0; i < 5; i++) {
    client.emit(same);
    t.mock.timers.tick(1_000);
  }
  assert.equal(asked(), first, 'not asked again yet');
  assert.equal(client.$('diagram').firstElementChild, drawing, 'and the map in hand is left as it is, to use');
  assert.notEqual(client.$('fit').textContent, 'Drawing the map…', 'not dropped while the next is awaited');
  t.mock.timers.tick(5_000);
  assert.equal(asked(), first + 1, 'asked once, ten seconds on, for how things stand then');
  for (let i = 0; i < 3; i++) client.emit(same);
  assert.equal(asked(), first + 1, 'and not again straight after');

  // Nothing happening near them at all: asked all the same, every ten
  // seconds, for how busy everything has been since.
  t.mock.timers.tick(10_000);
  assert.equal(asked(), first + 2, 'asked again ten seconds on, with nobody coming or going');
  t.mock.timers.tick(10_000);
  assert.equal(asked(), first + 3, 'and again');

  // Their own change is asked about at once, and the ten seconds start again.
  client.emit({ ...same, subscription: ['art', 'music'], rail: { ...same.rail, held: ['art', 'music'] } });
  assert.equal(asked(), first + 4);
  t.mock.timers.tick(9_000);
  assert.equal(asked(), first + 4);
  t.mock.timers.tick(1_000);
  assert.equal(asked(), first + 5);
  t.mock.timers.reset();
});

test('out of sight the map is not asked for, and is asked for the moment it is back', async (t) => {
  const client = await loadClient();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  arrive(client.emit);
  const asked = () => client.socket.sent.filter((f) => f.type === 'atlas').length;
  const first = asked();
  Object.defineProperty(client.document, 'hidden', { value: true, configurable: true });
  t.mock.timers.tick(30_000);
  assert.equal(asked(), first, 'nobody looking, nothing asked for');
  Object.defineProperty(client.document, 'hidden', { value: false, configurable: true });
  client.document.dispatchEvent(new client.document.defaultView.Event('visibilitychange'));
  assert.equal(asked(), first + 1, 'back in sight, asked at once');
  t.mock.timers.tick(10_000);
  assert.equal(asked(), first + 2, 'and every ten seconds again after that');
  t.mock.timers.reset();
});

test('asked again, only the rooms come back, and how tall they stand is updated on the map', async (t) => {
  const client = await loadClient();
  // The clock is the test's from the start, so the page's own ten seconds are.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  arrive(client.emit);
  const view = seededMap(client);
  t.mock.timers.tick(60);
  const shape = 'drawing-1';
  client.emit({ type: 'atlas', ...view, shape });
  t.mock.timers.tick(20);
  const busiest = view.rooms.find((r) => r.activity === 1).key;
  const quietest = [...view.rooms].sort((a, b) => a.activity - b.activity)[0].key;
  const lift = (key) => Number(/matrix\([^)]* (-?[\d.]+)\)$/.exec(topOf(client, key).getAttribute('transform'))[1]);
  const before = lift(quietest);

  // The next ask says which drawing it has.
  const sent = client.socket.sent.length;
  t.mock.timers.tick(10_000);
  const ask = client.socket.sent.slice(sent).find((f) => f.type === 'atlas');
  assert.equal(ask?.have, shape, 'names the drawing in hand');

  // The rooms alone come back, the quietest now the busiest: redrawn, taller.
  const rooms = view.rooms.map((r) => ({ ...r, activity: r.key === quietest ? 1 : r.key === busiest ? 0.1 : r.activity }));
  client.emit({ type: 'atlas', only: 'rooms', shape, subscription: view.subscription, rooms });
  t.mock.timers.tick(10_000);
  assert.ok(lift(quietest) < before, 'what was the quietest room now stands taller');
  assert.ok(client.$('diagram').querySelector('.relief-top'), 'on the drawing it already had');

  // Rooms for some other drawing are not laid over this one: it is asked for whole.
  const asks = client.socket.sent.length;
  client.emit({ type: 'atlas', only: 'rooms', shape: 'drawing-2', subscription: view.subscription, rooms });
  const again = client.socket.sent.slice(asks).find((f) => f.type === 'atlas');
  assert.ok(again && again.have === undefined, 'asked for the whole of it');
  t.mock.timers.reset();
});

test('All interests, asked again, has how lively each interest is laid over it', async (t) => {
  const client = await loadClient();
  const chart = { ...(await stockedChart()), shape: 'chart-1' };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  arrive(client.emit);
  click(client, 'explore-open');
  client.emit({ type: 'chart', ...chart });
  const sheet = client.$('explorer-chart');
  const first = sheet.querySelector('.dot[data-id="chess"]');

  // Every ten seconds while it is open, saying which chart it has.
  const sent = client.socket.sent.length;
  t.mock.timers.tick(10_000);
  assert.equal(client.socket.sent.slice(sent).find((f) => f.type === 'chart')?.have, 'chart-1');

  // Chess has got lively: drawn again with it, once its ten seconds are up.
  client.emit({ type: 'chart', only: 'activity', shape: 'chart-1', activity: [['chess', 0.8]] });
  t.mock.timers.tick(10_000);
  t.mock.timers.reset();
  const drawn = sheet.querySelector('.dot[data-id="chess"]');
  assert.notEqual(drawn, first, 'drawn again');
  assert.ok(drawn, 'with everything else still there');
  assert.equal(sheet.querySelectorAll('.dot').length, chart.subjects.length);
});

test('the minimap is drawn again only when what it shows changes', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const { World: Stocked } = await import('../server/store.js');
  const { populate } = await import('../server/populate.js');
  client.emit({ type: 'overview', ...populate(new Stocked(), { subjects: 60, users: 120, chatter: 0 }).overview() });
  const mini = client.$('minimap');
  const dot = () => mini.querySelector('circle');
  const before = dot();
  assert.ok(before, 'drawn');

  // The same state and the same map again, as arrive whenever anybody near
  // comes or goes: the very same dots.
  arrive(client.emit);
  assert.equal(dot(), before, 'not drawn again for nothing');

  // Holding something else is a change it shows.
  client.emit({ type: 'state', subscription: ['art', 'music'], funnel: 0, rail: { held: ['art', 'music'], suggested: [], popular: [], total: 2 } });
  assert.notEqual(dot(), before, 'drawn again for what is held');
});

test('the names on the map and in All interests are not text to select', () => {
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
  for (const sheet of ['#diagram', '#explorer-chart']) {
    const rule = css.match(new RegExp(`\n${sheet} \{[^}]*\}`, 'g')).join('');
    assert.match(rule, /user-select: none/, `${sheet} can be selected`);
  }
  assert.doesNotMatch(css, /\.zone-label:hover text/, 'and a name does not light up under the pointer');
});

// --- poking the server -------------------------------------------------------------

test('poking the server shows its answer to the poker alone, and it can be used or put away', async () => {
  const client = await loadClient();
  arrive(client.emit);
  assert.equal(client.$('poke').hidden, true, 'nothing to poke about before a conversation is open');
  clickRoom(client, 'art');
  assert.equal(client.$('poke').hidden, false);

  click(client, 'poke');
  assert.deepEqual(client.socket.sent.at(-1), { type: 'poke', room: 'art' });
  client.emit({ type: 'poked', room: 'art', about: ['art'], text: 'What got you into art?', machine: true });
  const reply = client.$('poke-reply');
  assert.equal(reply.hidden, false);
  assert.equal(client.$('poke-text').textContent, 'What got you into art?');
  assert.match(reply.textContent, /system message/);
  assert.match(reply.textContent, /only you can see this/);
  assert.ok(!client.socket.sent.some((f) => f.type === 'post'), 'nothing is said in the room');

  // It survives the log being drawn again, as it is for every message.
  client.emit({ type: 'message', message: { id: 'm1', room: 'art', subjects: ['art'], author: 'wren', authorId: 'id-wren', body: 'hi', at: Date.now() } });
  assert.equal(client.$('poke-reply').hidden, false);

  // Another asks again; Use it puts it in the box to change or send.
  click(client, 'poke-again');
  assert.deepEqual(client.socket.sent.at(-1), { type: 'poke', room: 'art' });
  click(client, 'poke-use');
  assert.equal(client.$('body').value, 'What got you into art?');
  assert.equal(client.$('poke-reply').hidden, true);

  // An answer for a room no longer open is not shown in this one.
  client.emit({ type: 'poked', room: 'music', about: ['music'], text: 'What got you into music?', machine: true });
  assert.equal(client.$('poke-reply').hidden, true);

  // Put away, it goes.
  client.emit({ type: 'poked', room: 'art', about: ['art'], text: 'Another question?', machine: true });
  click(client, 'poke-close');
  assert.equal(client.$('poke-reply').hidden, true);
});

// --- the reorganised page ------------------------------------------------------------

test('the list of chats puts yours first, busiest first, under headings that are not buttons', async () => {
  const client = await loadClient();
  arrive(client.emit);
  outsideRooms(client.emit, ['art']);
  const items = [...client.$('rooms').children];
  const heads = items.filter((li) => li.classList.contains('rooms-group')).map((li) => li.textContent);
  assert.deepEqual(heads, ['Yours', 'Others on this map']);
  assert.equal(items[0].textContent, 'Yours', 'yours first');
  assert.equal(client.$('rooms').querySelectorAll('.rooms-group button').length, 0, 'a heading is words, not a button');
  const chips = [...client.$('rooms').querySelectorAll('.room-chip')].map((b) => b.getAttribute('aria-label').split(',')[0]);
  assert.equal(chips[0], 'art', 'the one you are in, first');
  // Among the rest, the busier first: philosophy's three before the pair's two.
  assert.deepEqual(chips.slice(1), ['philosophy', 'art and philosophy']);
  assert.match(client.$('rooms-head').textContent, /Chats · 3/, 'and how many, at the head of the list');
});

test('on a phone, a chat has a way back to the list of chats', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  click(client, 'room-list');
  assert.equal(client.document.body.dataset.view, 'map', 'back on the map');
  assert.equal(client.$('rooms-open').getAttribute('aria-expanded'), 'true', 'with the list open');
  assert.equal(client.$('rooms-pop').hidden, false);
});

test('a message keeps reply in front and the rest in a tray behind ⋯', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  client.emit(said({ id: 'm1', body: 'hello', ...wren }));
  client.emit({ type: 'votes', messageId: 'm1', up: 2, down: 1, score: 1 });
  const li = [...client.document.querySelectorAll('#log li')].find((n) => n.textContent.includes('hello'));
  const head = li.firstElementChild;
  const reply = head.querySelector('.msg-action.reply');
  const more = head.querySelector('.msg-more');
  const tray = head.querySelector('.msg-actions');
  assert.ok(reply && more && tray, 'reply, ⋯ and the tray');
  assert.ok(reply.compareDocumentPosition(more) & 4, 'reply before ⋯');
  assert.equal(more.getAttribute('aria-controls'), tray.id);
  // In the tray, the lighter things first and the ones that cannot be undone last.
  const order = [...tray.querySelectorAll('button')].map((b) => b.className.split(' ').pop());
  assert.deepEqual(order, ['vote-up', 'vote-down', 'mute', 'report']);
  // The counts are in the heading too, without opening anything.
  assert.equal(head.querySelector('.vote-tally')?.textContent, '2 agree · 1 disagree');

  more.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.ok(tray.classList.contains('open'));

  // The reasons for a report open under the words, not inside the heading.
  tray.querySelector('.report').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const why = client.document.querySelector('.why');
  assert.ok(why && !head.contains(why), 'not in the heading');
  assert.equal(why.previousElementSibling?.className, 'text', 'under the message');
});

// --- the recommended additions -----------------------------------------------------

/** The map as it comes back with chats of yours it does not draw, and one lively chat. */
const withOffMap = (emit) => {
  const stats = { messages: 0, perMinute: 0, last: null };
  emit({
    type: 'atlas',
    subjects: ['art', 'philosophy'],
    extent: 1000,
    zones: [{ key: 'art', subjects: ['art'], population: 4, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } }],
    curves: [{ subject: 'art', components: 1, anchor: { x: 0, y: 0, room: 60 }, loops: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]] }],
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: ['art', 'chess', 'philosophy'],
    rooms: [
      { key: 'art', subjects: ['art'], population: 4, here: 4, member: true, messages: 0, stats, activity: 0.1 },
      { key: 'philosophy', subjects: ['philosophy'], population: 3, here: 3, member: true, messages: 0, stats, activity: 0.9 },
      { key: 'art+philosophy', subjects: ['art', 'philosophy'], population: 2, here: 2, member: true, messages: 0, stats, activity: 0 },
      { key: 'chess', subjects: ['chess'], population: 7, here: 0, member: true, messages: 0, stats, activity: 0.05, offMap: true },
    ],
  });
};

test('every chat of yours is listed, drawn on the map or not, the lively ones first', async () => {
  const client = await loadClient();
  arrive(client.emit);
  withOffMap(client.emit);
  const heads = [...client.$('rooms').querySelectorAll('.rooms-group')].map((h) => h.textContent);
  assert.deepEqual(heads, ['Lively now', 'Yours']);
  const chess = [...client.document.querySelectorAll('.room-chip')].find((c) => c.getAttribute('aria-label').startsWith('chess,'));
  assert.ok(chess, 'a chat the map does not draw is still listed');
  assert.ok(chess.classList.contains('off-map'));
  assert.match(chess.getAttribute('aria-label'), /not on the map/);
  const lively = client.$('rooms').children[1].querySelector('.room-chip');
  assert.match(lively.getAttribute('aria-label'), /^philosophy,/, 'the liveliest first');

  // And it opens like any other.
  clickRoom(client, 'chess');
  assert.equal(client.$('room-title').textContent, 'chess');
});

test('a chat can be pinned to the top of the list, and stays pinned next time', async () => {
  const client = await loadClient();
  arrive(client.emit);
  withOffMap(client.emit);
  clickRoom(client, 'chess');
  assert.equal(client.$('room-pin').hidden, false);
  click(client, 'room-pin');
  assert.equal(client.$('room-pin').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(JSON.parse(client.store.get('eulerchat.pinned')), ['chess']);
  assert.equal(client.$('rooms').firstElementChild.textContent, 'Pinned');
  assert.match(client.$('rooms').children[1].querySelector('.room-chip').getAttribute('aria-label'), /^chess,.*pinned/);

  const again = await loadClient({ storage: { 'eulerchat.pinned': '["chess"]' } });
  arrive(again.emit);
  withOffMap(again.emit);
  assert.equal(again.$('rooms').firstElementChild.textContent, 'Pinned', 'remembered in this browser');
});

test('joining a first interest opens the busiest chat it put you in', async () => {
  const client = await loadClient();
  client.emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3 });
  client.emit({ type: 'history', rooms: {} });
  client.emit({ type: 'state', subscription: [], funnel: 0, rail: { held: [], suggested: [], popular: [], total: 0 } });
  assert.equal(client.$('room-title').textContent, 'Pick a chat');
  client.emit({
    type: 'state',
    subscription: ['art', 'chess', 'philosophy'],
    funnel: 0,
    rail: { held: ['art', 'chess', 'philosophy'], suggested: [], popular: [], total: 3 },
  });
  withOffMap(client.emit);
  assert.equal(client.$('room-title').textContent, 'philosophy', 'the liveliest of theirs, opened');
});

test('an empty chat asks the server for a question to start it, once', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const pokes = () => client.socket.sent.filter((f) => f.type === 'poke');
  clickRoom(client, 'art');
  assert.deepEqual(pokes(), [{ type: 'poke', room: 'art' }]);
  client.emit({ type: 'poked', room: 'art', about: ['art'], text: 'What got you into art?', machine: true });
  assert.equal(client.$('poke-text').textContent, 'What got you into art?');
  // Drawn again, as it is for everything, it does not ask again.
  client.emit({ type: 'unread', counts: {} });
  clickRoom(client, 'art');
  assert.equal(pokes().length, 1);
});

test('the lurk bar says what joining in would add, and how busy it is', async () => {
  const client = await loadClient({ href: 'http://localhost:8787/?watch=art%2Bphilosophy' });
  client.emit({ type: 'welcome', you: { id: 'u9', name: 'guest-9' }, maxArity: 3 });
  client.emit({
    type: 'watching',
    room: 'art+philosophy',
    subjects: ['art', 'philosophy'],
    population: 12,
    stats: { messages: 4, perMinute: 0.6, last: null },
    messages: [],
    lurkers: 1,
  });
  assert.equal(
    client.$('lurk-adds').textContent,
    'Join in adds art and philosophy to your interests. 12 people are in it, saying about 0.6 a minute lately.',
  );
  assert.equal(client.$('room-pin').hidden, true, 'and a lurker pins nothing');
});

test('a moderator has reports in Settings, and can look in or clear each', async () => {
  const client = await loadClient();
  arrive(client.emit);
  assert.equal(client.$('moderation').hidden, true, 'nobody else sees it');
  client.emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3, moderator: true });
  assert.equal(client.$('moderation').hidden, false);

  click(client, 'reports-open');
  assert.ok(client.$('reports').open);
  assert.ok(client.socket.sent.some((f) => f.type === 'concerns'));
  client.emit({
    type: 'concerns',
    rooms: [{ room: 'art', subjects: ['art'], reports: [{ reason: 'spam', at: 1 }, { reason: 'spam', at: 2 }], messages: 3, flags: 0, population: 4 }],
  });
  const row = client.$('reports-list').querySelector('.report-row');
  assert.match(row.textContent, /art/);
  assert.match(row.querySelector('.report-why').textContent, /\(2\)/, 'why, and how often');
  assert.equal(client.$('reports-count').textContent, '1');
  const [, clear] = row.querySelectorAll('button');
  clear.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(client.socket.sent.at(-1), { type: 'clear', room: 'art' });
});

test('All interests offers the chat for both of an interest and one often held with it', async () => {
  const client = await loadClient();
  arrive(client.emit);
  outsideRooms(client.emit, ['art', 'philosophy']);
  click(client, 'explore-open');
  const chart = await stockedChart();
  client.emit({ type: 'chart', ...chart, links: [['art', 'philosophy', 2, 0.5]] });
  const find = client.$('explorer-find');
  find.value = 'art';
  find.dispatchEvent(Object.assign(new client.document.defaultView.Event('keydown'), { key: 'Enter' }));
  const open = client.$('explorer-with').querySelector('.with-open');
  assert.ok(open, 'offered where the two meet');
  assert.equal(open.getAttribute('aria-label'), 'Open the chat for art and philosophy');
  open.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(!client.$('explorer').open, 'and the sheet gets out of the way');
  assert.equal(client.$('room-title').textContent, 'art and philosophy');
});

test('a chat that changes beside the map does not redraw the map', async () => {
  const client = await loadClient();
  arrive(client.emit);
  withOffMap(client.emit);
  const drawn = client.$('diagram').firstElementChild;
  withOffMap((frame) => client.emit({ ...frame, rooms: frame.rooms.map((r) => (r.offMap ? { ...r, activity: 0.8 } : r)) }));
  assert.equal(client.$('diagram').firstElementChild, drawn);
});

// --- corrections -------------------------------------------------------------------

test('a room opening is not an unread message on the page either', async () => {
  const client = await loadClient();
  arrive(client.emit);
  client.emit({
    type: 'notification',
    notification: { kind: 'room-opened', level: 'notify', room: 'art', subjects: ['art'], at: 1, title: 'art now exists', body: '' },
  });
  assert.equal(client.$('rooms-waiting').hidden, true, 'no badge');
  client.emit({
    type: 'notification',
    notification: { kind: 'message', level: 'notify', room: 'art', subjects: ['art'], at: 2, title: 'art', body: 'hi' },
  });
  assert.equal(client.$('rooms-waiting').textContent, '1', 'a message still is');
});

test('an interest is counted by everybody holding it, as its chat is', async () => {
  const client = await loadClient();
  arrive(client.emit);
  // The zone is the people holding art and nothing else drawn; the room is
  // everybody holding art. The list of interests used to show the first.
  const stats = { messages: 0, perMinute: 0, last: null };
  client.emit({
    type: 'atlas',
    subjects: ['art', 'philosophy'],
    extent: 1000,
    zones: [
      { key: 'art', subjects: ['art'], population: 3, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } },
      { key: 'art+philosophy', subjects: ['art', 'philosophy'], population: 6, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } },
    ],
    curves: [{ subject: 'art', components: 1, anchor: { x: 0, y: 0, room: 60 }, loops: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]] }],
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: ['art'],
    rooms: [
      { key: 'art', subjects: ['art'], population: 9, here: 3, member: true, messages: 0, stats },
      { key: 'art+philosophy', subjects: ['art', 'philosophy'], population: 6, here: 6, member: false, messages: 0, stats },
    ],
  });
  const row = [...client.document.querySelectorAll('#subjects li')].find((li) => li.querySelector('.name')?.textContent === 'art');
  assert.equal(row.querySelector('.count').textContent, '9');
  const chip = [...client.document.querySelectorAll('.room-chip')].find((c) => c.getAttribute('aria-label').startsWith('art,'));
  assert.match(chip.getAttribute('aria-label'), /^art, 9 people/, 'the same number in both lists');
});

// --- the menu, and branching out into a community ------------------------------------

/** A world where the same people hold music together, and code together, and a few hold both. */
const communityWorld = () => {
  const world = new World();
  for (const s of ['guitar', 'piano', 'drums', 'singing', 'python', 'rust', 'haskell', 'go']) world.addSubject(s);
  const hold = (name, subjects) => {
    const id = world.addUser(name);
    for (const s of subjects) world.join(id, s);
    return id;
  };
  for (let i = 0; i < 6; i++) hold(`band${i}`, ['guitar', 'piano', 'drums', 'singing'].filter((_, j) => (i + j) % 4 !== 0));
  for (let i = 0; i < 6; i++) hold(`coder${i}`, ['python', 'rust', 'haskell', 'go'].filter((_, j) => (i + j) % 4 !== 0));
  hold('both', ['drums', 'python']);
  hold('both too', ['drums', 'python']);
  const me = hold('me', ['guitar']);
  return { world, me };
};

/** Their own map, holding guitar, drawn. */
const guitarMap = (client) => {
  const { world, me } = communityWorld();
  const view = world.atlasFor(me, 3);
  client.emit({ type: 'state', subscription: view.subscription, funnel: 0, rail: { held: view.subscription, suggested: [], popular: [], total: 1 } });
  client.emit({ type: 'atlas', ...view });
  return { world, me, view };
};

const mouse = (client, target, type, extra = {}) =>
  target.dispatchEvent(
    Object.assign(new client.document.defaultView.Event(type, { bubbles: true, cancelable: true }), {
      pointerId: 7,
      clientX: 40,
      clientY: 50,
      button: 0,
      pointerType: 'mouse',
      ...extra,
    }),
  );
const rightClick = (client, target) => {
  mouse(client, target, 'pointerdown', { button: 2 });
  mouse(client, target, 'pointerup', { button: 2 });
};
const menuOf = (client) => client.document.querySelector('.context-menu');
const menuItem = (client, label) =>
  [...(menuOf(client)?.querySelectorAll('.menu-item') ?? [])].find((b) => b.querySelector('.menu-label').textContent === label);
const groundOf = (client, key) =>
  client.$('diagram').querySelector(`.zone-ground[data-zone="${key}"]`) ?? topOf(client, key)?.querySelector('.zone-ground');

test('a right click on a chat on the map offers it, and ways to branch out from it', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const { view } = guitarMap(client);
  assert.ok(view.communities.guitar, 'the map says which community guitar is in');

  rightClick(client, groundOf(client, 'guitar'));
  const menu = menuOf(client);
  assert.ok(menu, 'a menu, not the browser’s');
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(menu.querySelector('.menu-title').textContent, 'guitar');
  assert.ok(menuItem(client, 'Open the chat'));
  assert.ok(menuItem(client, 'Copy quick-join link'));
  assert.ok(menuItem(client, 'Branch out from guitar'), 'into its own community');
  assert.match(menuItem(client, 'Branch out from guitar').querySelector('.menu-detail').textContent, /^Into .*guitar.* · \d+ interests$/);
  const toward = [...menu.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label').textContent.startsWith('Toward '));
  assert.ok(toward, 'and toward the one next door');
  assert.ok(menuItem(client, 'Reset view'), 'and the map’s own');

  menuItem(client, 'Open the chat').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(menuOf(client), null, 'choosing shuts it');
  assert.equal(client.$('room-title').textContent, 'guitar');
});

test('branching out draws the community in place of their own map, until they go back', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const { world, me, view } = guitarMap(client);
  rightClick(client, groundOf(client, 'guitar'));
  menuItem(client, 'Branch out from guitar').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  const asked = client.socket.sent.filter((f) => f.type === 'branch').at(-1);
  assert.deepEqual({ from: asked.from, toward: asked.toward }, { from: 'guitar', toward: null });
  assert.equal(client.$('branch-bar').hidden, false);
  assert.equal(client.$('branch-what').textContent, 'Branching out from guitar…');

  const branch = world.branchFor(me, 'guitar', { limit: asked.subjects });
  client.emit({ type: 'branch', ...branch });
  const drawn = new Set([...client.$('diagram').querySelectorAll('[data-zone]')].map((z) => z.getAttribute('data-zone')));
  assert.ok([...drawn].some((k) => k.includes('piano')), 'the community is on the map');
  assert.match(client.$('branch-what').textContent, /^From guitar into .*piano/);
  assert.match(client.$('fit').textContent, /^Branched out · /);
  // Its chats are there to open, as chats they are not in yet.
  const outside = branch.rooms.find((r) => !r.member);
  const chip = [...client.document.querySelectorAll('.room-chip')].find((c) => c.getAttribute('aria-label').startsWith(`${outside.subjects.join(' and ')},`));
  assert.ok(chip, 'listed with the rest');
  chip.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(client.$('log').querySelector('.joining'), 'and opened with the way in');

  // Their own map, while branched, is kept for the list and not drawn.
  client.emit({ type: 'atlas', ...view });
  assert.ok([...client.$('diagram').querySelectorAll('[data-zone]')].some((z) => z.getAttribute('data-zone').includes('piano')), 'still the branch');

  // And back.
  click(client, 'branch-back');
  assert.equal(client.$('branch-bar').hidden, true);
  const home = [...client.$('diagram').querySelectorAll('[data-zone]')].map((z) => z.getAttribute('data-zone'));
  assert.deepEqual([...new Set(home)].sort(), [...new Set(view.zones.map((z) => z.key))].sort(), 'their own map again');
  // A branch that arrives late, for where they no longer are, is let go.
  client.emit({ type: 'branch', ...branch });
  assert.equal(client.$('branch-bar').hidden, true);
});

test('a branch with nothing in it says so and goes back', async () => {
  const client = await loadClient();
  arrive(client.emit);
  guitarMap(client);
  rightClick(client, groundOf(client, 'guitar'));
  menuItem(client, 'Branch out from guitar').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  client.emit({ type: 'branch', none: true, from: 'guitar', toward: null });
  assert.equal(client.$('branch-bar').hidden, true);
  assert.match(client.$('notice').textContent, /Nothing to branch into from guitar/);
});

test('a chat in the list has the same menu, and pins from it; Escape shuts it', async () => {
  const client = await loadClient();
  arrive(client.emit);
  guitarMap(client);
  const chip = [...client.document.querySelectorAll('.room-chip')].find((c) => c.getAttribute('aria-label').startsWith('guitar,'));
  chip.focus();
  // The keyboard's menu key: nowhere in particular.
  chip.dispatchEvent(new client.document.defaultView.Event('contextmenu', { bubbles: true, cancelable: true }));
  assert.ok(menuOf(client));
  assert.equal(menuItem(client, 'Reset view'), undefined, 'the chat’s, not the map’s');
  const pin = menuItem(client, 'Pin to the top');
  assert.equal(pin.getAttribute('role'), 'menuitemcheckbox');
  assert.equal(pin.getAttribute('aria-checked'), 'false');
  pin.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(JSON.parse(client.store.get('eulerchat.pinned')), ['guitar']);

  const again = [...client.document.querySelectorAll('.room-chip')].find((c) => c.getAttribute('aria-label').startsWith('guitar,'));
  again.focus();
  again.dispatchEvent(new client.document.defaultView.Event('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(menuItem(client, 'Pinned to the top').getAttribute('aria-checked'), 'true', 'and says so');
  // Escape shuts it; the arrows and the focus are in `test/menu.test.js`,
  // which keeps track of what has the focus, as linkedom does not.
  menuOf(client).dispatchEvent(
    Object.assign(new client.document.defaultView.Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }),
  );
  assert.equal(menuOf(client), null);
});

test('the map pressed where there is no chat has the map’s own menu', async () => {
  const client = await loadClient();
  arrive(client.emit);
  guitarMap(client);
  rightClick(client, client.$('diagram'));
  assert.equal(menuOf(client).querySelector('.menu-title').textContent, 'Map');
  assert.ok(menuItem(client, 'Explore interests'));
  assert.equal(menuItem(client, 'Heights').getAttribute('aria-checked'), 'true');
  menuItem(client, 'Heights').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.$('relief').getAttribute('aria-pressed'), 'false', 'laid flat');
});

test('an interest in All interests can be joined or branched out from, with the menu inside the sheet', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const { world } = guitarMap(client);
  click(client, 'explore-open');
  client.emit({ type: 'chart', ...world.chart() });
  const piano = client.$('explorer-chart').querySelector('[data-id="piano"]');
  rightClick(client, piano);
  const menu = menuOf(client);
  assert.ok(menu);
  assert.equal(menu.parentElement, client.$('explorer'), 'inside the sheet, which is modal');
  assert.ok(menuItem(client, 'Join piano'));
  const branch = menuItem(client, 'Branch out from piano');
  assert.ok(branch, 'from what All interests says of it');
  branch.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.ok(!client.$('explorer').open, 'the sheet makes way for the map');
  assert.equal(client.socket.sent.filter((f) => f.type === 'branch').at(-1).from, 'piano');
});

test('the branch bar offers the community: all of it, or the part of it you pick', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const { world, me } = guitarMap(client);
  rightClick(client, groundOf(client, 'guitar'));
  menuItem(client, 'Branch out from guitar').dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const branch = world.branchFor(me, 'guitar', { limit: 3 });
  client.emit({ type: 'branch', ...branch });

  const members = branch.branch.community.members;
  assert.ok(members.length > 3, 'the whole community, not only what is drawn');
  assert.match(client.$('branch-size').textContent, /interests, 1 yours$/, 'how much of it is already theirs');
  assert.equal(client.$('branch-join-all').hidden, false);
  assert.equal(client.$('branch-join-all').querySelector('.label').textContent, `Join all ${members.length - 1}`);

  // Some of it: a switch each, the ones already held on and fixed.
  click(client, 'branch-join-some');
  assert.ok(client.$('join-some').open);
  assert.equal(client.$('join-some-title').textContent, `Join some of ${branch.branch.community.name.join(', ').replace(/, ([^,]*)$/, ' and $1')}`);
  const switches = [...client.$('join-some-list').querySelectorAll('.switch-row')];
  assert.deepEqual(switches.map((b) => b.querySelector('.switch-name').textContent).sort(), [...members].sort());
  const guitar = switches.find((b) => b.querySelector('.switch-name').textContent === 'guitar');
  assert.equal(guitar.getAttribute('aria-checked'), 'true');
  assert.equal(guitar.disabled, true, 'what is already theirs is not switched off here');
  assert.equal(client.$('join-some-count').textContent, `Join ${members.length - 1} interests`);

  // Switched off, it is not joined.
  const off = switches.find((b) => !b.disabled);
  off.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(off.getAttribute('aria-checked'), 'false');
  assert.equal(client.$('join-some-count').textContent, `Join ${members.length - 2} interests`);
  click(client, 'join-some-go');
  const asked = client.socket.sent.filter((f) => f.type === 'join').at(-1);
  assert.equal(asked.subjects.length, members.length - 2, 'one ask for all of them');
  assert.ok(!asked.subjects.includes('guitar'), 'and not what is already theirs');
  assert.ok(!asked.subjects.includes(off.querySelector('.switch-name').textContent));
  assert.equal(client.$('join-some').open, false);

  // Or all of it, in one go.
  click(client, 'branch-join-all');
  const all = client.socket.sent.filter((f) => f.type === 'join').at(-1);
  assert.deepEqual([...all.subjects].sort(), members.filter((s) => s !== 'guitar').sort());
});

test('All interests can be coloured by community, which lists them and offers each', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const { world } = guitarMap(client);
  click(client, 'explore-open');
  const chart = world.chart();
  client.emit({ type: 'chart', ...chart });
  // In relief each interest is a column, and its colour is on the top of it.
  const fillOf = (id) => {
    const node = client.$('explorer-chart').querySelector(`[data-id="${id}"]`);
    return (node.querySelector?.('.column-top') ?? node).getAttribute('fill');
  };
  const ownColours = ['guitar', 'piano'].map(fillOf);
  assert.notEqual(ownColours[0], ownColours[1], 'by name to begin with');

  click(client, 'explorer-tint');
  assert.equal(client.$('explorer-tint').getAttribute('aria-pressed'), 'true');
  const c = chart.subjects.find((s) => s.id === 'guitar').c;
  assert.equal(fillOf('guitar'), communityColour(c));
  assert.equal(fillOf('piano'), communityColour(c), 'what the same people hold is one colour');
  assert.notEqual(fillOf('python'), communityColour(c), 'and another community is another colour');

  // Listed, biggest first, with what each is called.
  assert.equal(client.$('explorer-communities').hidden, false);
  const rows = [...client.$('community-list').querySelectorAll('.community-row')];
  assert.equal(rows.length, chart.communities.length);
  assert.equal(rows[c].querySelector('.community-name').textContent, chart.communities[c].name.join(', ').replace(/, ([^,]*)$/, ' and $1'));
  assert.equal(rows[c].querySelector('.count').textContent, String(chart.communities[c].size));

  // Picked, it lights up and is offered.
  rows[c].dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.$('community-actions').hidden, false);
  assert.match(client.$('community-held').textContent, /^1 of \d+ already yours$/);
  const lit = [...client.$('explorer-chart').querySelectorAll('.chart-dot.found, .found[data-id]')].map((n) => n.getAttribute('data-id'));
  assert.ok(lit.includes('guitar') && lit.includes('piano'), 'lit on the sheet');
  assert.ok(!lit.includes('python'), 'and nothing else is');

  // Joined whole, from here.
  click(client, 'community-join-all');
  const asked = client.socket.sent.filter((f) => f.type === 'join').at(-1);
  assert.ok(asked.subjects.includes('piano') && !asked.subjects.includes('guitar'));

  // Or branched into, on the map.
  click(client, 'community-branch');
  assert.equal(client.$('explorer').open, false, 'the sheet makes way for the map');
  assert.equal(client.socket.sent.filter((f) => f.type === 'branch').at(-1).from, chart.communities[c].name[0]);

  // Switched off, the sheet goes back to a colour per interest.
  click(client, 'explore-open');
  click(client, 'explorer-tint');
  assert.equal(client.$('explorer-communities').hidden, true);
  assert.deepEqual(['guitar', 'piano'].map(fillOf), ownColours);
});

test('what the server writes can be muted, and is then folded away and not counted', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  client.emit(said({ author: 'p12', authorId: 'id-p12', id: 'q1', body: 'What got you into art?', machine: true }));
  client.emit(said({ ...wren, id: 'm1', body: 'the underpainting, mostly' }));
  const lines = () => [...client.document.querySelectorAll('#log li')].map((li) => li.textContent);
  assert.equal(lines().length, 2);
  assert.match(lines()[0], /system message/);

  // Muted: folded into one line that says where it came from, as a muted
  // person's messages are, and the server is told to stop counting them.
  assert.equal(client.$('hush-system').getAttribute('aria-pressed'), 'false');
  press(client.$('hush-system'));
  assert.equal(client.$('hush-system').getAttribute('aria-pressed'), 'true');
  assert.equal(client.$('hush-system').querySelector('.label').textContent, 'System messages muted');
  assert.deepEqual(client.socket.sent.at(-1), { type: 'notifications', settings: { system: false } });
  const folded = client.document.querySelector('#log .muted-run');
  assert.ok(folded, 'folded away');
  assert.match(folded.textContent, /A message from the server/);
  assert.match(lines().at(-1), /the underpainting/, 'and a person is untouched');

  // Shown again one run at a time, without unmuting everything.
  press(folded.querySelector('button'));
  assert.equal(client.document.querySelector('#log .muted-run'), null);
  assert.match(lines()[0], /What got you into art\?/);

  // Remembered here, and said again on the next connection, since the server
  // knows a fresh guest as somebody new.
  const again = await loadClient({ storage: { 'eulerchat.hushSystem': 'on' } });
  assert.equal(again.$('hush-system').getAttribute('aria-pressed'), 'true');
  arrive(again.emit);
  assert.ok(
    again.socket.sent.some((f) => f.type === 'notifications' && f.settings.system === false),
    'told on arrival',
  );

  // And nothing is asked for on their behalf while they are muted: an empty
  // chat is not poked for a question to start it with.
  clickRoom(again, 'art');
  assert.deepEqual(again.socket.sent.filter((f) => f.type === 'poke'), [], 'nothing poked');
});

test('every interest listed in All interests carries the way in, in its own colours', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const { world } = guitarMap(client);
  click(client, 'explore-open');
  client.emit({ type: 'chart', ...world.chart() });
  const find = client.$('explorer-find');
  find.value = 'piano';
  find.dispatchEvent(new client.document.defaultView.Event('input', { bubbles: true }));

  const row = client.$('explorer-found').querySelector('li');
  assert.equal(row.querySelector('button:not(.join-dot) span').textContent, 'piano');
  const join = row.querySelector('.join-dot');
  assert.ok(join, 'beside the name');
  assert.equal(join.getAttribute('aria-label'), 'Join piano');
  assert.equal(join.querySelector('.label').textContent, 'Join');
  // The square the map draws it with: its colour, in its own swatch.
  const swatch = join.querySelector('svg.glyph');
  assert.ok(swatch, 'wearing its swatch');
  assert.equal(swatch.querySelector('rect').getAttribute('fill'), stroke('piano'));

  join.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(client.socket.sent.at(-1), { type: 'join', subject: 'piano' });
  assert.equal(client.$('explorer-name').textContent, '', 'and joining is not also picking it');

  // Held, it says so and there is nothing to press: leaving is done elsewhere.
  client.emit({
    type: 'state',
    subscription: ['guitar', 'piano'],
    funnel: 0,
    rail: { held: ['guitar', 'piano'], suggested: [], popular: [], total: 2 },
  });
  const held = client.$('explorer-found').querySelector('.join-dot');
  assert.equal(held.querySelector('.label').textContent, 'Yours');
  assert.equal(held.getAttribute('aria-label'), 'piano, already yours');
  assert.equal(held.disabled, true);
});

test('made-up people are offered where the server will make them, and not otherwise', async () => {
  const client = await loadClient();
  arrive(client.emit);
  assert.equal(client.$('machines').hidden, true, 'nothing offered by default');

  client.emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3, machines: { most: 20000, count: 0 } });
  assert.equal(client.$('machines').hidden, false);
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const toggle = client.$('machines-toggle');
  const count = client.$('machines-count');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.querySelector('.label').textContent, 'Populate with');
  assert.equal(count.value, '200', 'a number to start from, editable where it stands');
  assert.equal(count.getAttribute('max'), '20000');

  // Pressed: that many, please.
  press(toggle);
  assert.deepEqual(client.socket.sent.at(-1), { type: 'machines', count: 200 });
  client.emit({ type: 'machines', count: 200, most: 20000 });
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.querySelector('.label').textContent, 'Populated with');
  assert.equal(count.value, '200', 'and says how many there are');

  // The number edited while they are there: that many instead.
  count.value = '50';
  count.dispatchEvent(new client.document.defaultView.Event('change', { bubbles: true }));
  assert.deepEqual(client.socket.sent.at(-1), { type: 'machines', count: 50 });

  // Never more than the server will make, whatever is typed.
  count.value = '999999';
  count.dispatchEvent(new client.document.defaultView.Event('change', { bubbles: true }));
  assert.deepEqual(client.socket.sent.at(-1), { type: 'machines', count: 20000 });
  assert.equal(count.value, '20000', 'and the number says what was asked');

  // Pressed again: away with them.
  client.emit({ type: 'machines', count: 20000, most: 20000 });
  press(toggle);
  assert.deepEqual(client.socket.sent.at(-1), { type: 'machines', count: 0 });
  client.emit({ type: 'machines', count: 0, most: 20000 });
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
});

test('the tour is lit in the header until it is taken, and walks the place once', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const open = client.$('tour-open');
  assert.ok(open.classList.contains('new'), 'lit for somebody who has not taken it');
  assert.equal(open.getAttribute('aria-label'), 'Take a short tour');
  assert.equal(client.$('tour').hidden, true);

  press(open);
  assert.equal(client.$('tour').hidden, false);
  assert.equal(client.$('tour-step').textContent, '1 of 5');
  assert.equal(client.$('tour-title').textContent, 'The map is the place');
  assert.equal(client.$('tour-back').disabled, true);

  // Through it: five steps, the last one finishing rather than going on.
  for (const step of ['2 of 5', '3 of 5', '4 of 5', '5 of 5']) {
    press(client.$('tour-next'));
    assert.equal(client.$('tour-step').textContent, step);
  }
  assert.equal(client.$('tour-next').textContent, 'Done');
  press(client.$('tour-next'));
  assert.equal(client.$('tour').hidden, true, 'and it is over');
  assert.equal(client.store.get('eulerchat.tour'), 'taken');
  assert.ok(!open.classList.contains('new'), 'and the header goes quiet');
  assert.equal(open.getAttribute('aria-label'), 'Take the tour again');

  // Taken before: quiet from the start, and still there to take again.
  const again = await loadClient({ storage: { 'eulerchat.tour': 'taken' } });
  arrive(again.emit);
  assert.ok(!again.$('tour-open').classList.contains('new'));
  press(again.$('tour-open'));
  assert.equal(again.$('tour').hidden, false);
  // Waved away part-way through: remembered all the same.
  press(again.$('tour-stop'));
  assert.equal(again.$('tour').hidden, true);
});

test('the tour fills the place while it lasts, and empties it again at the end', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  client.emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3, machines: { most: 20000, count: 0 } });

  press(client.$('tour-open'));
  const asked = client.socket.sent.filter((f) => f.type === 'machines');
  assert.deepEqual(asked.at(-1), { type: 'machines', count: 200 }, 'somewhere to look');
  client.emit({ type: 'machines', count: 200, most: 20000 });

  // Through to the end: they go again.
  for (let i = 0; i < 5; i++) press(client.$('tour-next'));
  assert.equal(client.$('tour').hidden, true);
  assert.deepEqual(client.socket.sent.filter((f) => f.type === 'machines').at(-1), { type: 'machines', count: 0 });

  // Somebody else's made-up people are not the tour's to take away.
  const again = await loadClient({ storage: { 'eulerchat.tour': 'taken' } });
  arrive(again.emit);
  again.emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3, machines: { most: 20000, count: 500 } });
  press(again.$('tour-open'));
  assert.deepEqual(again.socket.sent.filter((f) => f.type === 'machines'), [], 'they were already there');
  press(again.$('tour-stop'));
  assert.deepEqual(again.socket.sent.filter((f) => f.type === 'machines'), [], 'and they stay');
});

test('with nothing drawn yet, the tour opens All interests and starts there', async () => {
  const client = await loadClient();
  client.emit({ type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3 });
  client.emit({ type: 'history', rooms: {} });
  client.emit({ type: 'state', subscription: [], funnel: 0, rail: { held: [], suggested: [], popular: [], total: 0 } });
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));

  press(client.$('tour-open'));
  assert.ok(client.$('explorer').open, 'the one place that is full whatever else is true');
  assert.equal(client.$('tour-title').textContent, 'All the interests there are');
  assert.equal(client.$('tour-step').textContent, '1 of 5');
  // And the tour stands inside the sheet, which is modal: outside it is inert.
  assert.equal(client.$('tour').parentElement?.id, 'explorer');

  // On to the map, and the sheet gets out of the way.
  press(client.$('tour-next'));
  assert.equal(client.$('tour-title').textContent, 'The map is the place');
  assert.ok(!client.$('explorer').open);
  assert.equal(client.$('tour').parentElement?.tagName, 'BODY');

  // With chats on the map it starts where a person is looking instead.
  const drawn = await loadClient();
  arrive(drawn.emit);
  press(drawn.$('tour-open'));
  assert.equal(drawn.$('tour-title').textContent, 'The map is the place');
  assert.ok(!drawn.$('explorer').open);
});

test('pressing Tour also answers the arrow: it stops watching, and is asked back the same way', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const up = () => client.$('tour-nib').style.transform;

  // Watching, until somebody presses the button.
  assert.equal(client.store.has('eulerchat.tour.watch'), false, 'nothing decided yet');
  press(client.$('tour-open'));
  assert.equal(client.store.get('eulerchat.tour.watch'), 'off', 'asked once, and that is enough');

  // The tour points at its steps while it runs; stopping leaves it standing up.
  press(client.$('tour-stop'));
  assert.equal(up(), 'rotate(45.0deg)', 'straight up');

  // A pointer wandering the page no longer turns it.
  client.document.dispatchEvent(
    Object.assign(new client.document.defaultView.Event('pointermove', { bubbles: true }), { clientX: 10, clientY: 500 }),
  );
  assert.equal(up(), 'rotate(45.0deg)');

  // Pressing again asks it back.
  press(client.$('tour-open'));
  assert.equal(client.store.get('eulerchat.tour.watch'), 'on');
  press(client.$('tour-stop'));

  // Remembered between visits.
  const again = await loadClient({ storage: { 'eulerchat.tour.watch': 'off' } });
  arrive(again.emit);
  assert.equal(again.$('tour-nib').style.transform, 'rotate(45.0deg)', 'up from the start');
  again.document.dispatchEvent(
    Object.assign(new again.document.defaultView.Event('pointermove', { bubbles: true }), { clientX: 900, clientY: 40 }),
  );
  assert.equal(again.$('tour-nib').style.transform, 'rotate(45.0deg)', 'and it stays up');
});

test('statistics are worked out in the browser, and show their working', async () => {
  const client = await loadClient({ storage: { 'eulerchat.name': 'wren' } });
  arrive(client.emit);
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const said = () =>
    [...client.$('stats-rows').children].map((node) => node.textContent);

  const before = client.socket.sent.length;
  press(client.$('stats-go'));
  // The only thing the press asks for is the catalogue, which is public and is
  // what All interests fetches anyway. No statistics frame and no aggregate
  // from the server: the arithmetic happens here.
  assert.deepEqual(client.socket.sent.slice(before), [{ type: 'chart' }]);

  // The map it is looking at is counted at once.
  assert.ok(said().some((line) => line === 'Chats on this map'));
  assert.ok(said().some((line) => /^Average people per chat/.test(line)));
  assert.match(client.$('stats-missing').textContent, /All interests/, 'and what is missing is named');

  // The working is there to read, and says where each number came from.
  const log = client.$('stats-log').textContent;
  assert.match(log, /atlas frame/);
  assert.match(log, /average per chat/);
  assert.match(log, /this browser/);
  assert.match(log, /not visible from here/);
  assert.match(log, /server/);

  // The catalogue arriving fills in the rest, without being asked again.
  const world = seed(new World());
  client.emit({ type: 'chart', ...world.chart() });
  assert.ok(said().some((line) => line === 'Interests in the catalogue'));
  assert.equal(client.$('stats-missing').textContent, '', 'nothing missing now');
  assert.equal(client.socket.sent.filter((f) => f.type === 'chart').length, 1);
});

test('how much profanity is forgiven is settable, counted per person, and per day', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const choose = (value) => {
    const box = [...client.document.querySelectorAll('#profanity-choices input')].find((b) => b.value === value);
    box.checked = true;
    box.dispatchEvent(new client.document.defaultView.Event('change', { bubbles: true }));
  };
  const swear = (fields) => client.emit(said({ body: 'this is shit', ...fields }));
  const lines = () => [...client.document.querySelectorAll('#log li')].map((li) => li.textContent);
  const muted = () => [...client.document.querySelectorAll('#muted-list li')].length;

  // The button beside the offer opens the choices, and says what is counted.
  assert.equal(client.$('profanity-pop').hidden, true);
  press(client.$('profanity-open'));
  assert.equal(client.$('profanity-pop').hidden, false);
  assert.equal(client.$('profanity-open').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(
    [...client.document.querySelectorAll('#profanity-choices input')].map((b) => b.value),
    ['10', '5', '0'],
  );
  assert.match(client.$('profanity-said').textContent, /Nothing counted today/);

  // Five a day: the fifth is still shown, the sixth mutes them.
  choose('5');
  for (let i = 1; i <= 5; i++) swear({ ...wren, id: `w${i}` });
  assert.equal(muted(), 0, 'five is forgiven');
  assert.match(client.$('notice').textContent, /^$|Muted/, 'nothing said yet about muting');
  swear({ ...wren, id: 'w6' });
  assert.equal(muted(), 1, 'the sixth is not');
  assert.match(client.$('notice').textContent, /6 profane messages today, past the 5 you forgive/);
  // Their words are folded away, as a muted person's are, and can be shown.
  assert.ok(client.document.querySelector('#log .muted-run'), 'folded, not vanished');

  // Counted per person: somebody else starts from nothing.
  const other = { author: 'rook', authorId: 'id-rook', authorKey: 'KEYrook1' };
  swear({ ...other, id: 'r1' });
  assert.equal(muted(), 1, 'one person\u2019s tally is not everybody\u2019s');

  // What has been counted is remembered, so a reload is not a fresh start.
  press(client.$('profanity-open'));
  press(client.$('profanity-open'));
  assert.match(client.$('profanity-said').textContent, /Counted today: 7 from 2 people/);
  assert.equal(JSON.parse(client.store.get('eulerchat.swears')).length, 2);
  assert.equal(client.store.get('eulerchat.forgive'), '5');
});

test('no tolerance hides the message rather than folding it, and mutes at once', async () => {
  const client = await loadClient({ storage: { 'eulerchat.forgive': '0' } });
  arrive(client.emit);
  clickRoom(client, 'art');
  const lines = () => [...client.document.querySelectorAll('#log li')].map((li) => li.textContent);

  client.emit(said({ ...wren, id: 'm1', body: 'a civil remark' }));
  assert.ok(lines().some((line) => line.includes('a civil remark')));

  client.emit(said({ ...wren, id: 'm2', body: 'this is shit' }));
  assert.equal([...client.document.querySelectorAll('#muted-list li')].length, 1, 'muted at once');
  assert.match(client.$('notice').textContent, /no tolerance for profanity/);
  const shown = lines().join(' ');
  assert.ok(!shown.includes('this is shit'), 'the words are nowhere, not even folded');
  // Muting somebody folds away what they said before, as muting always does;
  // the profane one is not in that fold either.
  const folded = client.document.querySelector('#log .muted-run');
  assert.ok(folded, 'their earlier words are folded, as a muted person\u2019s are');
  assert.match(folded.textContent, /A message from someone you muted/);
});

test('ten a day is what it starts at, and the offer to mute still comes first', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  const offers = () => client.document.querySelectorAll('#log .mute-offer').length;
  client.emit(said({ ...wren, id: 'm1', body: 'this is shit' }));
  assert.equal(offers(), 1, 'asked, rather than done to them');
  assert.equal([...client.document.querySelectorAll('#muted-list li')].length, 0);
  for (let i = 2; i <= 10; i++) client.emit(said({ ...wren, id: `m${i}`, body: 'this is shit' }));
  assert.equal([...client.document.querySelectorAll('#muted-list li')].length, 0, 'ten forgiven');
  client.emit(said({ ...wren, id: 'm11', body: 'this is shit' }));
  assert.equal([...client.document.querySelectorAll('#muted-list li')].length, 1, 'the eleventh is not');
});

test('a mute is one person, by the key they proved, and is written down as a digest', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const shown = () => client.$('log').textContent;

  // Four people, one of whom is about to be muted.
  const people = [
    { author: 'wren', authorId: 'id-wren', authorKey: 'KEYwren1' },
    { author: 'rook', authorId: 'id-rook', authorKey: 'KEYrook1' },
    // No key at all: known by the connection that posted, for this visit only.
    { author: 'guest', authorId: 'id-guest' },
    // The same name as the first, under another key: somebody else.
    { author: 'wren', authorId: 'id-wren2', authorKey: 'KEYwren2' },
  ];
  people.forEach((who, i) => client.emit(said({ ...who, id: `m${i}`, body: `from number ${i}` })));
  assert.equal(client.document.querySelectorAll('#log li').length, 4);

  // Mute the first, from that message's own tray, and answer the question it
  // asks; see `proposeMute`.
  const mine = [...client.document.querySelectorAll('#log li')].find((li) => li.textContent.includes('from number 0'));
  press([...mine.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Mute')));
  press(client.$('mute-ask-yes'));

  assert.doesNotMatch(shown(), /from number 0/, 'that one is folded away');
  for (const still of ['from number 1', 'from number 2', 'from number 3']) {
    assert.match(shown(), new RegExp(still), `${still} is untouched`);
  }
  assert.equal(client.document.querySelectorAll('#muted-list li').length, 1, 'one person, not everybody');

  // Muting somebody with no key holds for this visit and is not written down.
  const guest = [...client.document.querySelectorAll('#log li')].find((li) => li.textContent.includes('from number 2'));
  press([...guest.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Mute')));
  press(client.$('mute-ask-yes'));
  assert.doesNotMatch(shown(), /from number 2/);
  const kept = JSON.parse(client.store.get('eulerchat.muted'));
  assert.equal(kept.length, 1, 'only the one with a key is remembered');
  assert.match(kept[0].who, /^[0-9a-f]{16}$/);
});

test('the hose streams the chats you are in, and leads to the chat or the message', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const lines = () => [...client.document.querySelectorAll('.hose-line')];

  // Nothing asked for, and nothing there yet.
  const before = client.socket.sent.length;
  press(client.$('hose-open'));
  assert.ok(client.$('hose').open);
  assert.deepEqual(client.socket.sent.slice(before), [], 'it is what already arrives, not a request');
  assert.equal(client.$('hose-none').hidden, false);
  press(client.$('hose-close'));

  // What arrives goes into it, whichever chat it was said in.
  client.emit(said({ ...wren, id: 'm1', body: 'said in art' }));
  client.emit({
    type: 'message',
    message: { room: 'art+philosophy', subjects: ['art', 'philosophy'], at: Date.now(), author: 'rook', authorId: 'id-rook', id: 'm2', body: 'said in both' },
  });
  // Waiting, since neither is the chat on screen.
  assert.equal(client.$('hose-waiting').hidden, false);

  press(client.$('hose-open'));
  assert.equal(client.$('hose-waiting').hidden, true, 'looked at, so nothing is waiting');
  assert.equal(lines().length, 2);
  assert.match(lines()[0].textContent, /said in both/, 'newest first');
  assert.equal(lines()[0].querySelector('.hose-where').textContent, 'art + philosophy');
  // The same squares the map draws that chat with, one per interest.
  assert.equal(lines()[0].querySelectorAll('.hose-marks svg.glyph').length, 2);
  assert.equal(lines()[1].querySelectorAll('.hose-marks svg.glyph').length, 1);

  // View context opens that chat and shuts the hose.
  press([...lines()[1].querySelectorAll('button')].find((b) => b.textContent === 'View context'));
  assert.equal(client.$('hose').open, false);
  assert.equal(client.$('room-title').textContent, 'art');

  // Jump goes to the message itself, and lights it where it stands.
  press(client.$('hose-open'));
  press([...lines()[1].querySelectorAll('button')].find((b) => b.textContent === 'Jump'));
  const lit = client.document.querySelector('#log li.lit');
  assert.ok(lit, 'the message is lit');
  assert.equal(lit.dataset.id, 'm1');
  assert.match(lit.textContent, /said in art/);

  // A message the server has since forgotten says so rather than doing
  // nothing: a line can outlive the twelve hours the words had.
  client.emit({ type: 'history', rooms: { art: [] } });
  press(client.$('hose-open'));
  press([...lines()[1].querySelectorAll('button')].find((b) => b.textContent === 'Jump'));
  assert.match(client.$('notice').textContent, /That message has gone/);
});

test('three seconds of stillness says what is busy nearby, and moving takes it away', async () => {
  const client = await loadClient();
  arrive(client.emit);
  const stir = () =>
    client.document.dispatchEvent(
      Object.assign(new client.document.defaultView.Event('pointermove', { bubbles: true }), { clientX: 5, clientY: 5 }),
    );
  const busy = () => client.$('nearby');
  const chips = () => [...client.$('nearby-list').querySelectorAll('.nearby-chip')];

  // A map with something happening on it, beside what they hold.
  const stats = (perMinute, ago) => ({ messages: 4, perMinute, last: { at: Date.now() - ago } });
  client.emit({
    type: 'atlas',
    subjects: ['art', 'philosophy'],
    extent: 1000,
    zones: [{ key: 'art', subjects: ['art'], population: 9, x: 0, y: 0, room: 60, seed: { x: 0, y: 0 } }],
    curves: [{ subject: 'art', components: 1, anchor: { x: 0, y: 0, room: 60 }, loops: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]] }],
    network: [],
    report: { exact: true, phantoms: 0, vanished: 0, worstError: 0, disconnected: [], worstSplit: 1, wellFormed: true },
    subscription: ['art'],
    rooms: [
      { key: 'art', subjects: ['art'], population: 9, here: 9, member: true, messages: 4, stats: stats(0.4, 30_000), activity: 0.4 },
      { key: 'art+philosophy', subjects: ['art', 'philosophy'], population: 6, here: 6, member: false, messages: 9, stats: stats(2, 10_000), activity: 0.9 },
      // Nowhere near what they hold: never offered, however busy.
      { key: 'karate', subjects: ['karate'], population: 40, here: 40, member: false, messages: 50, stats: stats(9, 1000), activity: 1 },
    ],
  });

  assert.equal(busy().hidden, true, 'nothing while anything is happening');
  await later(3200);
  assert.equal(busy().hidden, false, 'after three seconds, what is going on');
  assert.deepEqual(
    chips().map((chip) => chip.querySelector('.chip-name').textContent),
    ['art + philosophy', 'art'],
    'the liveliest first, and nothing from across the map',
  );
  assert.match(chips()[0].querySelector('.nearby-why').textContent, /next to art/);
  assert.match(chips()[1].querySelector('.nearby-why').textContent, /yours, and busy/);

  // Anything at all takes it away again.
  stir();
  assert.equal(busy().hidden, true);

  // And one of them opens its chat.
  await later(3200);
  chips()[0].dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  assert.equal(client.$('room-title').textContent, 'art and philosophy');
  assert.equal(busy().hidden, true, 'and it gets out of the way');
});

test('it keeps quiet for a lurker, and while a sheet is open over the map', async () => {
  const watching = await loadClient({ href: 'http://localhost:8787/?watch=art' });
  watching.emit({ type: 'welcome', you: { id: 'u9', name: 'guest-9' }, maxArity: 3 });
  watching.emit({
    type: 'watching',
    room: 'art',
    subjects: ['art'],
    population: 12,
    stats: { messages: 4, perMinute: 0.6, last: null },
    messages: [],
    lurkers: 1,
  });
  await later(3200);
  assert.equal(watching.$('nearby').hidden, true, 'a lurker came for one conversation');

  const client = await loadClient();
  arrive(client.emit);
  click(client, 'explore-open');
  await later(3200);
  assert.equal(client.$('nearby').hidden, true, 'and somebody with a sheet open is in the middle of something');
});

test('muting asks first, holds the room still, and takes anybody else pressed meanwhile', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const rook = { author: 'rook', authorId: 'id-rook', authorKey: 'KEYrook1' };
  const muteOn = (body) => {
    const li = [...client.document.querySelectorAll('#log li')].find((n) => n.textContent.includes(body));
    press([...li.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Mute')));
  };
  const shown = () => client.$('log').textContent;

  client.emit(said({ ...wren, id: 'm1', body: 'from wren' }));
  client.emit(said({ ...rook, id: 'm2', body: 'from rook' }));

  // Pressed, and nothing has happened yet but a question.
  muteOn('from wren');
  assert.equal(client.$('mute-ask').hidden, false);
  assert.match(client.$('mute-ask-said').textContent, /^Mute wren\?/);
  assert.match(client.$('mute-ask-said').textContent, /for you alone. Nobody is told/);
  assert.equal(client.document.querySelectorAll('#muted-list li').length, 0, 'not muted yet');
  assert.match(shown(), /from wren/, 'and still there to read');

  // The room is held still: what arrives is kept back rather than moving it.
  client.emit(said({ ...rook, id: 'm3', body: 'said while deciding' }));
  assert.doesNotMatch(shown(), /said while deciding/, 'nothing moves under you');

  // Anybody else pressed meanwhile joins the same question.
  muteOn('from rook');
  assert.match(client.$('mute-ask-said').textContent, /^Mute wren and rook\?/);
  assert.equal(client.$('mute-ask-yes').textContent, 'Mute 2');

  // Answered: both, and the room says how far behind it now is.
  press(client.$('mute-ask-yes'));
  assert.equal(client.$('mute-ask').hidden, true);
  assert.equal(client.document.querySelectorAll('#muted-list li').length, 2);
  assert.match(client.$('notice').textContent, /Muted 2 people/);
  assert.equal(client.$('mute-after').hidden, false);
  assert.match(client.$('mute-after-said').textContent, /1 message arrived while you decided/);
  // What they said is folded away now, including what arrived meanwhile.
  assert.doesNotMatch(shown(), /from wren|from rook|said while deciding/);
  assert.match(shown(), /2 messages from someone you muted|messages from people you muted/);

  // Stay, or go to what has arrived: either way the question goes.
  press(client.$('mute-after-jump'));
  assert.equal(client.$('mute-after').hidden, true);
});

test('a mute question can be answered no, or left behind, and nothing happens', async () => {
  const client = await loadClient();
  arrive(client.emit);
  clickRoom(client, 'art');
  const press = (node) => node.dispatchEvent(new client.document.defaultView.Event('click', { bubbles: true }));
  const muteFirst = () => {
    const li = client.document.querySelector('#log li');
    press([...li.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Mute')));
  };

  client.emit(said({ ...wren, id: 'm1', body: 'from wren' }));
  muteFirst();
  press(client.$('mute-ask-no'));
  assert.equal(client.$('mute-ask').hidden, true);
  assert.equal(client.document.querySelectorAll('#muted-list li').length, 0);
  // And the room runs again: what arrives is drawn.
  client.emit(said({ ...wren, id: 'm2', body: 'after the question' }));
  assert.match(client.$('log').textContent, /after the question/);

  // Asked, then gone somewhere else: the question goes with the room.
  withOffMap(client.emit);
  clickRoom(client, 'art');
  muteFirst();
  assert.equal(client.$('mute-ask').hidden, false);
  clickRoom(client, 'philosophy');
  assert.equal(client.$('mute-ask').hidden, true);
  assert.equal(client.document.querySelectorAll('#muted-list li').length, 0, 'and nobody was muted');
});
