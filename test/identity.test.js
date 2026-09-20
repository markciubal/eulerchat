import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { forgetIdentity, identity, rememberedIdentity } from '../lib/seal.js';
import { challenge, mark, prove } from '../lib/proof.js';
import { commitmentInput } from '../lib/receipt.js';
import { createEulerChat, World } from '../server/app.js';
import { MemoryLedger } from '../server/ledger.js';

/**
 * Who somebody is, which here can only mean: which key they hold.
 *
 * Everything below is one claim tested from several sides - that a key beside
 * a name cannot be had by asking for it. Not by saying it is yours, not by
 * typing something that looks like it, not by handing back a message after a
 * restart with a different one attached, and not by knowing the id of whoever
 * does hold it.
 */

// --- showing a key ----------------------------------------------------------

test('whoever holds the key can show it, and nobody else can', async () => {
  const wren = await identity();
  const mallory = await identity();

  const asked = await challenge(wren.publicKey);
  assert.equal(await asked.check(await prove(asked.offer, wren)), true);

  // Mallory has the public key - everybody does - and her own private one.
  const again = await challenge(wren.publicKey);
  assert.equal(await again.check(await prove(again.offer, mallory)), false);
});

test('a challenge answers once, and an old answer is no use for a new one', async () => {
  const wren = await identity();

  const first = await challenge(wren.publicKey);
  const answer = await prove(first.offer, wren);

  // Somebody who watched one exchange go by has the answer to that question
  // and to no other.
  const second = await challenge(wren.publicKey);
  assert.equal(await second.check(answer), false, 'replayed against a fresh challenge');

  // A wrong answer spends the challenge, so it cannot be followed by guesses.
  const third = await challenge(wren.publicKey);
  assert.equal(await third.check('00'), false);
  assert.equal(await third.check(await prove(third.offer, wren)), false, 'already spent');
});

test('nonsense is refused rather than thrown over', async () => {
  const wren = await identity();
  for (const junk of [undefined, null, '', 'zz', 'abc', {}, 12, 'ff'.repeat(32)]) {
    const asked = await challenge(wren.publicKey);
    assert.equal(await asked.check(junk), false, `accepted ${JSON.stringify(junk)}`);
  }

  // A key that is not a key cannot be challenged at all, which is the caller's
  // cue to refuse the claim.
  await assert.rejects(challenge({ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'AAAA' }));
  await assert.rejects(challenge(null));
});

// --- keeping a key ----------------------------------------------------------

/** What a browser's storage does, without a browser: keep the first, hand it back. */
const shelf = () => {
  let held = null;
  return {
    keep: async (candidate) => (held ??= candidate),
    drop: async () => {
      held = null;
    },
  };
};

test('the same browser is the same key next time', async () => {
  const store = shelf();
  const monday = await rememberedIdentity(store);
  const tuesday = await rememberedIdentity(store);

  assert.equal(tuesday.id, monday.id);
  assert.equal(monday.kept, true);

  // And it is a key that works, not only a name that matches.
  const asked = await challenge(monday.publicKey);
  assert.equal(await asked.check(await prove(asked.offer, tuesday)), true);
});

test('two tabs opening at once end up as one person', async () => {
  const store = shelf();
  const [left, right] = await Promise.all([rememberedIdentity(store), rememberedIdentity(store)]);
  assert.equal(left.id, right.id);
});

test('nowhere to keep a key is not an error, and says so', async () => {
  const broken = {
    keep: async () => {
      throw new Error('a private window');
    },
  };
  for (const store of [null, broken, { keep: async () => ({ nonsense: true }) }]) {
    const me = await rememberedIdentity(store);
    assert.equal(me.kept, false);
    const asked = await challenge(me.publicKey);
    assert.equal(await asked.check(await prove(asked.offer, me)), true, 'it still has to work');
  }
});

test('a key that is thrown away is gone, and what follows is a stranger', async () => {
  // The way out of being recognisable has to be as short as the way in.
  const store = shelf();
  const before = await rememberedIdentity(store);
  assert.equal(await forgetIdentity(store), true);
  const after = await rememberedIdentity(store);

  assert.notEqual(after.id, before.id);
});

// --- the dot ----------------------------------------------------------------

test('a name cannot be typed that looks like a name with a key', () => {
  const world = new World();
  const dots = [0x00b7, 0x2022, 0x2027, 0x2219, 0x22c5, 0x30fb, 0xff65].map((c) => String.fromCodePoint(c));

  for (const dot of dots) {
    const id = world.addUser(`wren${dot}3fA9xQ2k`);
    assert.equal(world.profiles.get(id).name, 'wren3fA9xQ2k');
    assert.equal(world.rename(id, `${dot}${dot}hila${dot}`), 'hila');
  }

  // And a name made of nothing else leaves whatever they were called before.
  const id = world.addUser('wren');
  assert.equal(world.rename(id, dots.join('')), 'wren');
});

// --- after a restart --------------------------------------------------------

/** A world with something said in it under a key, and the ledger it was written to. */
function spoken() {
  const ledger = new MemoryLedger();
  const world = new World();
  world.useLedger(ledger);
  world.addSubject('art');
  const wren = world.addUser('wren');
  world.join(wren, 'art');

  const keyed = world.post(wren, ['art'], 'said under a key', { authorKey: 'WrenWrenWrenWren' });
  const bare = world.post(wren, ['art'], 'said under none');

  const fresh = new World();
  fresh.useLedger(ledger);
  return { fresh, keyed, bare };
}

test('a restart is not a way to change who said something', () => {
  const { fresh, keyed, bare } = spoken();

  const forgeries = [
    { what: 'put under another name', message: { ...keyed, author: 'hila' } },
    { what: 'put under another key', message: { ...keyed, authorKey: 'MalloryMalloryMa' } },
    { what: 'given a key it never had', message: { ...bare, authorKey: 'WrenWrenWrenWren' } },
    { what: 'stripped of its key', message: { ...keyed, authorKey: undefined } },
    { what: 'passed off as the old form', message: { ...keyed, v: undefined } },
    // The old form joined its fields with a character a body may contain, so
    // where one field ended was a matter of trust. This is that, tried on.
    { what: 'smuggled through a body', message: { ...bare, body: `${bare.body}\u0000key:WrenWrenWrenWren` } },
  ];

  for (const { what, message } of forgeries) {
    const result = fresh.restore([message]);
    assert.equal(result.restored, 0, `accepted something ${what}`);
    assert.equal(result.refused.unknown, 1, what);
  }

  // And the genuine ones come back as they were said.
  assert.equal(fresh.restore([keyed, bare]).restored, 2);
  const [first, second] = fresh.messages.get('art');
  assert.equal(first.authorKey, 'WrenWrenWrenWren');
  assert.equal(first.author, 'wren');
  assert.equal(second.authorKey, undefined);
});

test('what an older ledger holds still comes back, and gains nothing on the way', () => {
  // A message as it was named before any of this: no form number, no key, and
  // its fields joined with NULs. The ledger line is written by hand, because
  // nothing in the code writes this form any more.
  const old = { id: 'aaaa1111', room: 'art', subjects: ['art'], author: 'ana', authorId: 'u1', body: 'from before', at: Date.now() - 1000 };
  const commitment = createHash('sha256').update(commitmentInput(old)).digest('hex');
  assert.ok(commitmentInput(old).includes('\u0000'), 'this should be the first form');

  const ledger = new MemoryLedger([{ kind: 'post', commitment, room: 'art', at: old.at, seq: 0 }]);
  const world = new World();
  world.useLedger(ledger);

  // Handed back with a key stuck on. The first form does not cover one, so the
  // hash still matches - and the key must not survive, or this would be the
  // way to sign somebody else's words.
  assert.equal(world.restore([{ ...old, authorKey: 'MalloryMalloryMa' }]).restored, 1);
  const back = world.messages.get('art')[0];
  assert.equal(back.body, 'from before');
  assert.equal(back.authorKey, undefined);
});

// --- over a real connection -------------------------------------------------

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const until = async (ready, what, limitMs = 5000) => {
  const stop = Date.now() + limitMs;
  while (Date.now() < stop) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A client. Given an identity it claims the key on arrival, as the real one
 * does; `honest: false` is somebody who has the public half and nothing else.
 */
function connect(port, { me = null, honest = true, path = '/' } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const seen = [];
  const waiters = [];
  const send = (frame) => ws.send(JSON.stringify(frame));

  ws.addEventListener('message', async (e) => {
    const frame = JSON.parse(e.data);
    seen.push(frame);
    for (const [i, w] of waiters.entries()) {
      if (w.match(frame)) {
        waiters.splice(i, 1);
        w.resolve(frame);
        break;
      }
    }
    if (frame.type === 'challenge' && me) {
      send({ type: 'proof', mac: honest ? await prove(frame.offer, me) : 'ab'.repeat(32) });
    }
  });

  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));

  return {
    seen,
    closed,
    send,
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        if (me) send({ type: 'keys', keyId: me.id, publicKey: me.publicKey });
        resolve();
      });
      ws.addEventListener('error', reject);
    }),
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

const shown = (f) => f.type === 'welcome' && Boolean(f.you.keyId);
const holding = (subject) => (f) => f.type === 'state' && f.subscription.includes(subject);

async function serve(options = {}) {
  const world = new World();
  world.addSubject('art');
  const host = http.createServer();
  const chat = createEulerChat({ world, server: host, serveClient: false, ...options });
  const port = await listen(host);
  return {
    world,
    chat,
    port,
    async close() {
      chat.close();
      await new Promise((resolve) => host.close(resolve));
    },
  };
}

test('claiming a moderator\'s key gets nothing; showing it gets the reports', async () => {
  const moderator = await identity();
  const place = await serve({ moderators: [moderator.id] });

  // Everything Mallory could know: the public key, which is sent to everybody,
  // and the name it goes by. She claims both and cannot answer for either.
  const mallory = connect(place.port, { me: { ...moderator }, honest: false });
  const real = connect(place.port, { me: moderator });

  try {
    await Promise.all([mallory.ready, real.ready]);
    await mallory.waitFor((f) => f.type === 'error' && /did not show/.test(f.message));
    await real.waitFor(shown);

    mallory.send({ type: 'concerns' });
    assert.equal((await mallory.waitFor((f) => f.type === 'error' && f.message === 'not allowed')).message, 'not allowed');

    real.send({ type: 'concerns' });
    assert.deepEqual((await real.waitFor('concerns')).rooms, []);

    // And what each of them says is written accordingly.
    for (const who of [mallory, real]) who.send({ type: 'join', subject: 'art' });
    await Promise.all([mallory.waitFor(holding('art')), real.waitFor(holding('art'))]);

    mallory.send({ type: 'post', tags: ['art'], body: 'trust me, I moderate here' });
    const forged = await real.waitFor((f) => f.type === 'message' && /trust me/.test(f.message.body));
    assert.equal(forged.message.authorKey, undefined, 'a claimed key must not be written beside a name');

    real.send({ type: 'post', tags: ['art'], body: 'the real one' });
    const genuine = await mallory.waitFor((f) => f.type === 'message' && /real one/.test(f.message.body));
    assert.equal(genuine.message.authorKey, moderator.id);
    assert.equal(mark(genuine.message.authorKey).length, 8);
  } finally {
    mallory.close();
    real.close();
    await place.close();
  }
});

test('the fingerprint is worked out here, not taken from whoever presents the key', async () => {
  const moderator = await identity();
  const mallory = await identity();
  const place = await serve({ moderators: [moderator.id] });

  // Her own key, honestly shown - under the moderator's name for it.
  const client = connect(place.port, { me: { ...mallory, id: moderator.id } });
  try {
    await client.ready;
    const welcome = await client.waitFor(shown);
    assert.equal(welcome.you.keyId, mallory.id, 'a key is called what it is, whatever the client calls it');

    client.send({ type: 'concerns' });
    await client.waitFor((f) => f.type === 'error' && f.message === 'not allowed');
  } finally {
    client.close();
    await place.close();
  }
});

test('two connections showing one key are one person', async () => {
  const wren = await identity();
  const place = await serve();
  const laptop = connect(place.port, { me: wren });
  const phone = connect(place.port, { me: wren });

  try {
    await Promise.all([laptop.ready, phone.ready]);
    const [a, b] = await Promise.all([laptop.waitFor(shown), phone.waitFor(shown)]);
    // Whichever showed the key second became whoever showed it first.
    const last = (client) => client.seen.filter(shown).at(-1).you.id;
    await until(() => last(laptop) === last(phone), 'the two to be one person');
    void a;
    void b;

    // One member of the room, not two - which is also one vote, not two.
    laptop.send({ type: 'join', subject: 'art' });
    await Promise.all([laptop.waitFor(holding('art')), phone.waitFor(holding('art'))]);
    assert.equal(place.world.census().get('art'), 1);
    await until(() => place.world.profiles.size === 1, 'the spare guest to be let go');

    // Closing one of them is not leaving: the clock must not start on somebody
    // who is still here in another window.
    phone.close();
    await until(() => place.chat.sessions.size === 1, 'the phone to go');
    laptop.send({ type: 'post', tags: ['art'], body: 'still here' });
    await laptop.waitFor((f) => f.type === 'message' && f.message.body === 'still here');
  } finally {
    laptop.close();
    phone.close();
    await place.close();
  }
});

test('somebody with a key is taken back by showing it, and not by knowing their id', async () => {
  const wren = await identity();
  const place = await serve();

  const first = connect(place.port, { me: wren });
  await first.ready;
  const me = (await first.waitFor(shown)).you;
  first.send({ type: 'identify', name: 'wren' });
  first.send({ type: 'join', subject: 'art' });
  await first.waitFor(holding('art'));
  first.close();
  await until(() => place.chat.sessions.size === 0, 'the connection to go');

  // Their id is printed on everything they said. Inside their minute of grace
  // that used to be enough to become them.
  const thief = connect(place.port);
  const back = connect(place.port, { me: wren });
  try {
    await thief.ready;
    thief.send({ type: 'resume', userId: me.id });
    await thief.waitFor('expired');

    await back.ready;
    const again = await back.waitFor((f) => shown(f) && f.you.id === me.id);
    assert.equal(again.you.name, 'wren');
    await back.waitFor(holding('art'));
  } finally {
    thief.close();
    back.close();
    await place.close();
  }
});

test('somebody with no key can still pick up where they left off', async () => {
  // The old way in, for a browser that cannot make keys. Unchanged, including
  // that it is only as good as the id being hard to come by.
  const place = await serve();
  const first = connect(place.port);
  await first.ready;
  const me = (await first.waitFor('welcome')).you;
  first.send({ type: 'join', subject: 'art' });
  await first.waitFor(holding('art'));
  first.close();
  await until(() => place.chat.sessions.size === 0, 'the connection to go');

  const back = connect(place.port);
  try {
    await back.ready;
    back.send({ type: 'resume', userId: me.id });
    await back.waitFor((f) => f.type === 'welcome' && f.you.id === me.id);
    await back.waitFor(holding('art'));
  } finally {
    back.close();
    await place.close();
  }
});

// --- a host with accounts ---------------------------------------------------

const ACCOUNTS = {
  'wren-token': { id: 'u_81', name: 'wren', staff: true },
  'hila-token': { id: 'u_82', name: 'hila' },
};

/** A host that has to go and look somebody up, which takes a moment. */
const lookUp = async (req) => {
  await new Promise((r) => setTimeout(r, 40));
  const token = new URL(req.url, 'http://host').searchParams.get('token');
  if (token === 'broken') throw new Error('the session store is down');
  return ACCOUNTS[token] ?? null;
};

test('a host with accounts can say who a connection is', async () => {
  const place = await serve({
    authenticate: lookUp,
    isModerator: (userId, session) => session.account?.staff === true,
  });

  const wren = connect(place.port, { path: '/?token=wren-token' });
  const hila = connect(place.port, { path: '/?token=hila-token' });
  const visitor = connect(place.port);

  try {
    // Said the moment the socket opens, while the host is still looking them
    // up. It has to be heard once they are let in, not dropped on the floor.
    await wren.ready;
    wren.send({ type: 'join', subject: 'art' });
    await wren.waitFor(holding('art'));

    assert.equal((await wren.waitFor('welcome')).you.name, 'wren');
    await Promise.all([hila.ready, visitor.ready]);
    assert.equal((await hila.waitFor('welcome')).you.name, 'hila');
    assert.match((await visitor.waitFor('welcome')).you.name, /^guest-/, 'nobody in particular is still welcome');

    wren.send({ type: 'concerns' });
    assert.deepEqual((await wren.waitFor('concerns')).rooms, []);
    for (const who of [hila, visitor]) {
      who.send({ type: 'concerns' });
      await who.waitFor((f) => f.type === 'error' && f.message === 'not allowed');
    }
  } finally {
    wren.close();
    hila.close();
    visitor.close();
    await place.close();
  }
});

test('one account in two windows is one person', async () => {
  const place = await serve({ authenticate: lookUp });
  const one = connect(place.port, { path: '/?token=hila-token' });
  const two = connect(place.port, { path: '/?token=hila-token' });

  try {
    await Promise.all([one.ready, two.ready]);
    const [a, b] = await Promise.all([one.waitFor('welcome'), two.waitFor('welcome')]);
    assert.equal(a.you.id, b.you.id);
    assert.equal(place.world.profiles.size, 1);
  } finally {
    one.close();
    two.close();
    await place.close();
  }
});

test('a host that cannot answer has said no', async () => {
  const place = await serve({ authenticate: lookUp });
  const errors = console.error;
  console.error = () => {};

  const client = connect(place.port, { path: '/?token=broken' });
  try {
    await client.ready;
    assert.equal(await client.closed, 1008);
    assert.equal(place.world.profiles.size, 0, 'and nobody was made for them');
    assert.deepEqual(client.seen, [], 'and they were told nothing');
  } finally {
    console.error = errors;
    client.close();
    await place.close();
  }
});

// --- both halves at once ----------------------------------------------------

test('the real client, against the real server, ends up with its key beside its name', async () => {
  // Everything above tests one half against a stand-in for the other, and two
  // halves that each pass can still disagree about what a frame is called.
  // This is the page as a browser loads it, talking to the server as it runs.
  //
  // Last in the file on purpose: the client reconnects for ever by design, so
  // the only way to stop it is to leave it a WebSocket that does nothing.
  const place = await serve();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');
  const { document, window } = parseHTML(html);

  const opened = [];
  const Real = globalThis.WebSocket;
  class Watched extends Real {
    constructor(url) {
      super(url);
      opened.push(this);
    }
  }

  const store = new Map();
  Object.assign(globalThis, {
    document,
    window,
    WebSocket: Watched,
    location: { protocol: 'http:', host: `127.0.0.1:${place.port}`, pathname: '/' },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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

  try {
    await import(`../public/app.js?whole=${Date.now()}`);

    const wrap = document.getElementById('key-wrap');
    await until(() => !wrap.hidden, 'the key to be claimed, shown, and written beside the name');

    const written = document.getElementById('key-mark').textContent;
    assert.match(written, /^·[A-Za-z0-9]{8}$/);

    // And the server agrees about whose key that is, having been shown it.
    const [session] = [...place.chat.sessions];
    assert.equal(session.proven, true);
    assert.equal(`·${mark(session.keyId)}`, written);
    assert.equal(place.world.profiles.size, 1);
  } finally {
    // The page is left standing. Its sockets are closed, which the client
    // answers by reconnecting, and a reconnect reads `location` before it
    // opens anything - so taking the page away here turns a clean finish into
    // an error thrown from a timer after the test has ended. What it is handed
    // to reconnect with does nothing, and the process ends with the file.
    globalThis.WebSocket = class {
      addEventListener() {}
      close() {}
    };
    for (const socket of opened) socket.close();
    await place.close();
  }
});
