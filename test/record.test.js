import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { identity, unseal } from '../lib/seal.js';
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
async function loadClient({ storage = {} } = {}) {
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
    location: { protocol: 'http:', host: 'localhost:8787', pathname: '/' },
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

  // And joining an interest now happens inside the group rather than outside.
  client.$('cluster-name').value = 'kite-fox-9';
  client.$('cluster-name').dispatchEvent(new client.document.defaultView.Event('change', { bubbles: true }));
  assert.match(client.$('cluster-now').textContent, /kite-fox-9/);
});

test('nonsense is not a group name', async () => {
  const client = await loadClient();
  arrive(client.emit);

  client.$('cluster-name').value = 'Not A Group';
  client.$('cluster-name').dispatchEvent(new client.document.defaultView.Event('change', { bubbles: true }));

  assert.match(client.$('notice').textContent, /not a group name/i);
  assert.equal(client.$('cluster-share').hidden, true);
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
