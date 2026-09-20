import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { identity, unseal } from '../lib/seal.js';

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
