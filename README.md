# eulerchat

A chat room shaped like an Euler diagram. Subjects are regions on a plane, the
places where they overlap are rooms, and a coordinate is an address.

It is anonymous by default and public by design: no accounts, no names to
claim, and everything said in the clear readable by anybody without asking.
[PRIVACY.md](PRIVACY.md) is the plain statement of what that means — who can
see what, what the server keeps and for how long, what encryption does and
does not do, and why there is no federation.

```
npm i eulerchat      # the layout engine, or
npx eulerchat        # the chat server
```

The layout engine stands on its own and has no server or DOM in it, so it will
draw area-proportional Euler diagrams for anything; the chat app is one caller.

```js
import { census, layout, zones, atlas } from 'eulerchat';
```

```
npm install
npm start          # http://localhost:8787 — 1,100 interests, nobody in them yet
npm run start:sample # the same, with a few made-up people in three of them
npm run start:large # 1000 interests, 4000 made-up people
npm run start:questions # the sample people ask questions, as system messages
npm run demo       # http://localhost:8790 — 50,000 made-up people, talking; never a deployment
npm test

node server/index.js --interests 300 --people 2000
```

## Using it in your own project

Three independent pieces, each usable without the others. Typed, ESM, and the
library half has no dependencies at all.

### Draw a diagram

```js
import { census, layout, toSVG } from 'eulerchat';

const people = [
  new Set(['art']), new Set(['art', 'philosophy']), new Set(['philosophy']),
];

const svg = toSVG(layout(census(people)), { title: 'interests' });
```

`toSVG` returns a standalone SVG string — no DOM, no stylesheet, styles
inlined — so it can go to a file, an `<img>`, an HTTP response or a
rasteriser. `census` counts by containment (a region's population is everyone
holding *all* of its subjects), which is what circle areas mean.

For more than three subjects, or any zone arity, use the atlas. It needs
exclusive counts, so `zones` rather than `census`:

```js
import { zones, atlas, toSVG } from 'eulerchat';

const map = atlas(zones(people, ['art', 'philosophy', 'music']));
map.report.exact;        // no region drawn that nobody occupies, none lost
map.report.disconnected; // subjects that ended up in more than one patch

toSVG(map, { theme: 'dark', size: 1200 });
```

Both layouts report what they could not do. `layout(...).fit` carries
`faithful`, `phantoms`, `worst` and a per-region breakdown; `atlas(...).report`
carries `exact`, `wellFormed` and `worstSplit`. Neither is ever silently wrong.

### Use the routing without the drawing

The delivery rule is one pure predicate, and the census is a plain `Map`:

```js
import { receives, census, neighbourhood } from 'eulerchat';

receives(['art', 'philosophy'], ['art']);              // true
receives(['art'], ['art', 'philosophy']);              // false
neighbourhood(census(people), ['art'], 3);             // what to show someone
```

### Notifications

Delivery and notification are different questions. `T ⊆ S` settles which
messages *reach* you, and in a busy subject that is a great many. Which of
them deserve your attention is answered by the shape of the room:

| Room | Reaches | |
|---|---|---|
| `art` | everyone holding art | you are one of a crowd — counted, not shown |
| `art+philosophy` | only people holding both | narrower, more specific — badged |
| a room of two | almost only you | nearly a direct message — interrupts |

Narrow rooms are loud and broad rooms are quiet, which is the opposite of
what message volume alone would give you. Being named always interrupts;
the room you are currently reading never does.

```js
import { classify } from 'eulerchat';

classify(event, {
  userId, name, subscription,
  intimate: 8,        // at or below this many people, a room is conspicuous
  muted: ['art'],
  viewing: 'art+philosophy',   // what they are reading does not interrupt them
});
// -> { kind, level: 'quiet' | 'notify' | 'alert', room, title, body } | null
```

It returns `null` for anything in a room the watcher could not already read.
That rule is the one worth keeping whatever else is tuned: a notification must
never reveal a conversation somebody is not part of.

**Two events no flat chat model has.** Rooms here are derived from membership,
so they genuinely come into and go out of existence — and the incremental
census knows the exact moment a region key is created or destroyed:

```
"art ∩ music ∩ philosophy now exists"
 Nobody held all of these before. You are the only one here so far.
```

Subscribe to them, on the world itself, with no transport attached:

```js
const stop = world.watch((event) => {
  // { type: 'message' | 'room-opened' | 'room-closed', room, ... }
});
```

`Notifications` in `eulerchat/app` wires those to per-person preferences,
unread counts and a backlog for people who are away. A listener returning
false means undelivered, and it is held until they reconnect:

```js
import { Notifications } from 'eulerchat/app';

const notes = new Notifications(world);
notes.onNotify((userId, note) => myPushService.send(userId, note));
notes.drain(userId);   // what they missed, most urgent first
```


### Mount the chat server in an app you already have

```js
import { createEulerChat, World, stock } from 'eulerchat/app';

const chat = createEulerChat({
  world: stock(new World()),  // the catalogue alone, which is also the default; `seed(new World())`
                              // adds a few made-up people, for a demo; or build your own
  server: myHttpServer,       // attaches to yours; omit to get its own
  mount: '/chat',             // lives under a path; omit for the root
  serveClient: true,          // also serve the bundled UI
  publicApi: false,           // the default: no open read API unless asked for
  dumps: undefined,           // the firehose in public 1MB dumps; on wherever publicApi is
  moderators: [],             // key fingerprints that may read reports; nobody by default
  authenticate: undefined,    // (req) => account | null, if you have accounts; see below
});

chat.world;     // membership, messages, diagramFor(), atlasFor()
chat.sessions;  // who is connected, and on what
chat.close();
```

### Or bring your own transport

The `World` holds no connections. Delivery is a question about membership, and
it answers with people:

```js
const audience = world.audienceFor(['art', 'philosophy']);  // user ids
```

Where those people currently are is a separate concern, and `Sessions` is one
answer to it — but anything will do, because nothing in the world requires a
socket:

```js
import { Sessions } from 'eulerchat/app';

const live = new Sessions();          // generic over whatever a connection is
live.open('s1', userId, myChannel);
for (const s of live.reaching(audience)) s.socket.send(payload);
```

One person may hold several connections at once — two tabs, a phone and a
laptop — and `forUser`, `present` and `reaching` are all written for that.

Importing this does not bind a port or read `process.argv`. The CLI
(`npx eulerchat`) is a thin wrapper that adds those and a crash reporter.

It answers for its own paths and stays silent on everything else, so your
routes are untouched — and it takes first refusal on them, because a host that
ends its routing with a catch-all 404 would otherwise reply before this ever
ran. If you would rather place it yourself, behind your own middleware, pass
`serveClient: false` and call `chat.handleRequest` wherever you like.

There are four worked examples in `examples/`: drawing a diagram from set data
with no server at all, adding the rooms to an app you already have, driving the
rooms over your own transport, and building an atlas.

### Subpaths

| import | what |
|---|---|
| `eulerchat` | everything below, re-exported |
| `eulerchat/regions` | region algebra: `census`, `zones`, `receives`, `neighbourhood` |
| `eulerchat/euler` | circle layout: `layout`, `lensArea`, `separation` |
| `eulerchat/atlas` | routed layout: `atlas` |
| `eulerchat/svg` | `toSVG` |
| `eulerchat/notify` | `classify`, `mentions` — what is worth interrupting for |
| `eulerchat/taxonomy` | `radialLayout`, `anchorsFor` — where subjects sit |
| `eulerchat/knowledge` | a small default hierarchy |
| `eulerchat/mold` | `Mold`, `weave` — what grows between them |
| `eulerchat/abbrev` | `shortLabels`, `abbreviate` — naming the overlaps |
| `eulerchat/scheme` | `SCHEMES`, `tokensOf`, `styleOf`, `tidy` — how the place looks, legibly |
| `eulerchat/emblem` | `emblemOf`, `emblem`, `EMBLEMS` — what a subject's field looks like |
| `eulerchat/seal` | `identity`, `rememberedIdentity`, `seal`, `unseal` — a key per message |
| `eulerchat/proof` | `challenge`, `prove`, `mark` — showing a key is yours |
| `eulerchat/portal` | `portalWith` — a room only two people can find |
| `eulerchat/plain` | `plain` — words only: no images, no emoji |
| `eulerchat/cluster` | `newCluster`, `within`, `inviteLink`, `groupRoom`, `named` — small groups by name |
| `eulerchat/receipt` | `verify`, `findDeletion` — checking what was deleted |
| `eulerchat/flag` | `scan`, `rank`, `REASONS` — which rooms need looking at |
| `eulerchat/public-api` | `createPublicApi` — the open read side and the firehose |
| `eulerchat/qr` | `qr`, `toText` — the invitation as a square |
| `eulerchat/ledger` | `FileLedger`, `MemoryLedger` — the durable anchor |
| `eulerchat/knowledge` | the bundled catalogue, `alsoCalled`, `childrenOf()`, `subfields()` |
| `eulerchat/adapt` | `fromRows` — read the tables you already have |
| `eulerchat/embed` | `mountMap`, `viewFor` — the map in an element you own |
| `eulerchat/react` | `<EulerMap />` |
| `eulerchat/app` | `createEulerChat` |
| `eulerchat/store` | `World`, `seed` |


## This place is public

**Off by default, and you have to ask for it.**

```js
createEulerChat({ world, server, publicApi: true });   // serves everything below
```

The bundled server (`npx eulerchat`) passes that flag, because it is the
deployment that decided this place is public. A library consumer gets the
opposite default: whoever installed this did not make that decision, and
finding out about it when somebody scrapes them is not how they should.
`chat.api.handleRequest` exists either way, for anybody placing it behind their
own routing.

With it on, everything said in the clear is readable by anybody, without
identifying themselves:

```
GET /api/rooms                  rooms of up to three interests, with populations
GET /api/rooms/{key}/log        one room's messages     ?since=&limit=
GET /api/scrape                 everything, resumable   ?since=&limit=
GET /api/receipts               the record of deletions ?since=
GET /api/firehose               a live stream of events (server-sent events)
GET /api/dumps                  the firehose, a megabyte at a time: what there is
GET /api/dumps/{id}             one dump, one JSON event per line (NDJSON)
GET /streams                    a page for watching all of the above
```

The firehose is the same shape as BlueSky's: connect, and receive everything as
it happens.

```js
const stream = new EventSource('http://localhost:8787/api/firehose');
stream.addEventListener('message', (e) => console.log(JSON.parse(e.data)));
```

Its events are `message`, `room-opened`, `room-closed`, `forgotten` (the
messages the place has let go, named by their commitments rather than their
ids, with the hash of the deletion receipt that names them too; a big one
comes in `part`s of 2,000, each with the same receipt) and
`dump` (a new dump is ready to fetch). A reader who falls a megabyte behind is
let go rather than queued for without end, and can pick up what they missed
from the dumps.

**Dumps are for whoever was not listening.** Everything the firehose sends is
also gathered, one line per event, until the next line would take it past a
megabyte. What has gathered then becomes a dump, and the gathering starts
again from nothing, so nothing is ever sent out more than a megabyte at a
time. The first line of each says what it is.

```sh
curl -s localhost:8787/api/dumps              # {"bytes":1000000,"pending":{…},"dumps":[{"id":1,…,"url":"/api/dumps/1"}]}
curl -s localhost:8787/api/dumps/1 | head -2  # {"type":"dump","id":1,…}  then the first event
```

A dump is not an archive, because a copy kept by the server would be the
server breaking its own word. A message the place forgets, on the clock or on
request, goes from the dump it is in at the same moment, and a later dump
carries the `forgotten` event that says so; a copy taken earlier should
forget it too. Every field a commitment covers is in the message as the
stream sent it, so a copy is matched by recomputing it:

```js
import { commitment } from './lib/receipt.js';
const gone = new Set(event.commitments);
for (const m of copies) if (gone.has(await commitment(m))) drop(m);
```

Naming them by id would work as well for whoever holds a copy, and would also
tell anybody who had only seen an id, in a reply or a link, that the message
went and why. A dump only ever shrinks, goes twelve hours after the last
thing in it, and is only ever held in memory. At most 64 are kept, so on a busy
server the oldest goes well inside its twelve hours. A portal's messages are in no
dump, and a sealed message is its envelope, exactly as everywhere else here.

`/streams` is that same public view in a page: the firehose live, filtered by
kind or interest; the dumps, with how full the next one is; and the deletion
record. It reads only what anybody can read, the way anybody would. The chat
links to it from Settings, wherever the server publishes.

What all of this adds up to for somebody deciding whether to use it or run it
is in [PRIVACY.md](PRIVACY.md), in one page and in plain words.

That openness is a decision about what this place *is*, and it has to be
carried through the product rather than mentioned in a footnote. The interface
says so above the composer, where nobody has to click anything to see it,
because a private-feeling chat window in front of a public endpoint is a lie
told by omission. If you fork this and close the API, change that line too.

Two things the open side deliberately does not serve:

- **Sealed messages, as text.** It serves the envelope. The server has no key
  and never did, so there is nothing to withhold and nothing to reveal.
  Encryption is the one thing that still protects anything here, which is
  precisely why it stays.
- **Reports.** They name the person who complained. A reporter identified to
  the room they reported is a reporter who never reports again, which is a
  different kind of harm from publishing a conversation. Those sit behind
  `isModerator`. Opening them should be a decision taken on purpose.

  A report also keeps its evidence — the author, their key, the time and **the
  words** — because the message itself will not be there in a day. That copy
  lives for thirty days, outlives the twelve hours, and is **not** removed when
  the author deletes the message: deleting takes it out of the room, the dumps
  and the open API, and leaves the reported copy where a moderator can read it.
  For a sealed message the server has nothing to copy, so the reporter may
  paste what they read, marked as their disclosure and not as something the
  server could open. Either way, one reader can put words in front of a
  moderator that everyone else's copy has forgotten.

Mounted on your own server the API answers its own endpoints and stays silent
on everything else, so a host route at `/api/me` keeps working. Move it out of
the way with `apiPath`.


## Who somebody is

Nobody, by default, and that is a decision rather than an omission. There are
no accounts. A connection is a guest, a name is whatever somebody typed, and
anybody can type anybody's.

What a person *can* have is a key. The browser makes one, keeps it, and shows
the server that it holds it; from then on the first eight characters of its
fingerprint are written after their name:

```
wren·3fA9xQ2k     the same person as yesterday's wren·3fA9xQ2k
wren·Zk81mmQp     somebody else, who also typed "wren"
wren              somebody with no key at all
```

Names are not reserved. A registry of names is durable state, gets squatted the
day it opens, and still loses to a Cyrillic `а`. The letters cannot be typed:
they are drawn as their own element, the dot is refused in names, and the
server works the fingerprint out from the key rather than taking the client's
word for what it is called.

**Claiming a key is not holding it.** Every key in the place is sent to
everybody, so that messages can be sealed to it. A connection that says "this
one is mine" has therefore said nothing, and until it has answered a challenge
that only the private half can answer, its key is not written beside its name,
is not what a returning visitor is recognised by, and counts for nothing with a
moderator:

```js
import { challenge, prove } from 'eulerchat/proof';

const asked = await challenge(theirPublicKey);   // the server
const mac = await prove(asked.offer, me);        // the browser
await asked.check(mac);                          // true, once
```

The check is a MAC under a secret the two keys agree, not "decrypt this and
send it back" — a client that decrypts what it is handed and returns the
plaintext is a decryption service, and a server could pass off a real sealed
message as the challenge.

**What an unproved claim does do.** It is relayed to every other open
connection as it arrives, and it goes into the reader list that senders wrap
message keys for, which filters on having a key rather than on having proved
one. So claiming a key that is not yours does not get you a name, and it does
get you wrapped keys you cannot open — harmless in itself, and the reason the
list a message is sealed for is worth no more than the server assembling it.

Two connections that show the same key are the same person: one member of a
room, one vote, and closing one window is not leaving. Somebody who drops and
comes back inside their minute of grace is recognised by showing the key, and
**not** by remembering their id — an id is printed on every message a person
posts, so it used to be that knowing one was enough to become them.

### Moderators, without accounts

```
eulerchat --moderator 3fA9xQ2kZk81mmQp      # as many times as there are moderators
EULERCHAT_MODERATORS=3fA9xQ2kZk81mmQp,...
```

```js
createEulerChat({ world, moderators: ['3fA9xQ2kZk81mmQp'] });
```

The full fingerprint, which the interface shows each person for their own key
on hover. It counts only for a connection that has shown the key, because what
sits behind it is the list of who reported whom.

### If you do have accounts

```js
createEulerChat({
  world, server,
  authenticate: async (req) => myAuth.userFor(req.headers.cookie),
  // -> { id: 'u_81', name: 'wren', staff: true }, or null for a visitor
  isModerator: (userId, session) => session.account?.staff === true,
});
```

It is handed the upgrade request and whatever it returns rides along as
`session.account`. `id` makes every connection from that account one person;
`name` is what they are called to begin with; null is a guest like any other.
Throwing refuses the connection, since an answer that could not be obtained is
not a yes. Frames that arrive while you are looking somebody up are held and
replayed, not dropped. Left out, everybody is anonymous, and nothing about the
anonymous path changes when it is put in.

### What a key is not

- **It is not a person.** Keys cost nothing to make, so one person can be as
  many of them as they like. One key, one vote is not one person, one vote, and
  nothing short of accounts or a price makes it so.
- **It is a decision against anonymity, and it should be made knowingly.**
  Everything said under one key can be tied together by anybody, for as long as
  the key is kept — that is the point of it and the cost of it. So the way out
  is as short as the way in: *New key*, under *Settings*, throws it away, and
  whoever comes back is a stranger. `forgetIdentity()` is the same thing in
  code.
- **A lost key is a lost name.** There is no account behind it and nobody to
  ask. Clearing site data loses it; a second device is a second key.
- **It lives in the browser.** The private half is non-extractable, so script
  can use it and cannot read it out — but whoever can run script on your origin
  can use it, and a copied browser profile takes it along.
- **No browser has run the storage.** The proof and the protocol are tested end
  to end over real sockets; the IndexedDB half is tested against a stand-in
  with the same one-operation contract, because there is no IndexedDB in Node.
  Without storage — a private window — the key lasts as long as the page and
  the interface says so.


## Sealing, and what sealing is not

A message can be locked before it leaves the browser. Each one gets its own
AES-GCM key, used once and thrown away; that key is wrapped separately for
every reader through an ECDH agreement with their public key. The server holds
a ciphertext and a bag of wrapped keys it cannot open. One key recovered costs
one message rather than a conversation. Standard primitives throughout — P-256,
HKDF, AES-GCM, through the platform's own `crypto.subtle`.

```js
import { identity, seal, unseal } from 'eulerchat/seal';

const me = await identity();
const you = await identity();
const stranger = await identity();

const envelope = await seal('meet by the mycology circle', me, [you.publicKey]);
await unseal(envelope, you);       // 'meet by the mycology circle'
await unseal(envelope, stranger);  // null — not an error, just not for them
```

The server keeps messages for twelve hours and then forgets them, on a sweep
every ten minutes rather than on request, so that forgetting does not depend on
anybody remembering to ask. A room also holds no more than its last 500
messages: past that the oldest falls off as each new one arrives, which is a
cap on memory rather than a promise about time, and unlike the sweep it writes
no receipt and tells nobody — so in a busy room the honest description is *the
last 500 messages, and none older than twelve hours*.

What the sweep and the delete button drop is written into a chain anybody can
check; see **What deletion can and cannot show**, below. Anyone who wants a
lasting copy can turn one on: it is kept by their own browser, and it is
**every message they can read while it is on**, not only their own — including
the plaintext of encrypted messages, written into `localStorage` after it is
opened. The interface is in two minds about it: the box is labelled *Keep a copy of
what I send* and the help beside it says "your browser keeps a copy of what is
said here", which is the accurate one. See **Open privacy defects**.

**What this does not do**, which matters more than what it does:

- **It does not stop the people in the room keeping a record.** They are handed
  the words — that is what sending is — and nothing here can tell, let alone
  prevent it. Anyone can hold a stream in their own device's memory whatever
  anybody else has set. Deleting the server's copy deletes the server's copy.
- **It does not authenticate anybody.** The server decides which public keys
  belong to a room, so a dishonest one can add a key of its own and be handed a
  wrapped key like any other member. This protects a conversation from a server
  that stores and later leaks, not from one that is actively against you.
  Defending against that needs people to compare keys by some route the server
  does not control, which is not built. A key that is kept between visits gives
  them something stable to compare — the letters after a name are its
  fingerprint — but the server still assembles the reader list, so that
  narrows the gap and does not close it. It also answers that question to
  anybody who asks: the `readers` frame takes a room key from whoever sends it
  and hands back the fingerprint and public key of everyone present, without
  checking that the asker is in the room, or a member rather than a lurker.
  That is a live defect — see **Open privacy defects** — and not a property
  worth having.
- **It does not hide who is talking to whom**, or when, or how often. The server
  routes, so the server knows. The envelope says it out loud as well: it
  carries the sender's public key, and the wrapped keys are filed under each
  reader's fingerprint, so anybody holding the envelope — which the open API
  serves to anybody at all — can read off who sent it and which keys it was
  locked for. The words are the secret; the shape of the conversation is not.
- **It does not survive the key.** The per-message key is used once and thrown
  away, but it is wrapped by an agreement between two long-lived keys, so
  whoever obtains one of those keys can open every envelope they have kept that
  was wrapped for it. There is no forward secrecy here and none is claimed: a
  key kept for a year is a year of envelopes waiting on it. **New key** in
  Settings ends that, for everything sent afterwards.

The first and the third are said in the interface too, in those words,
because a product that implies more privacy than it delivers is worse than one
that offers none: people choose what to say based on what they think is true.
The other two are not, and that is a gap rather than a decision — the help text
says that only people in the chat can read an encrypted message, where the
truth is the people connected with a key at that moment, and it says nothing
about a dishonest server adding a key or about there being no forward secrecy.
See **Open privacy defects**.

If a message cannot be locked — no reader list, keys not made yet, the server
unreachable — it is **not sent**. It stays in the box and says why. A request to
encrypt that cannot be honoured has to fail rather than quietly do the opposite.


## Surviving a restart

The server keeps one small durable thing, and it is not the conversations. Each
line is a hash of one message as it was posted, the room it was posted in, when,
and its number in order — sixty-four characters however long the message was,
and never the words or who wrote them — plus the record of deletions.
Append-only, a single file you can read in a text editor. The room and the time
are the part that outlives the twelve hours: the file says that something was
said in `art+philosophy` at a moment, and nothing else about it.

```
eulerchat --ledger ./data/ledger.jsonl   # on by default
eulerchat --no-ledger                    # keep nothing
```

```js
import { FileLedger } from 'eulerchat/ledger';
world.useLedger(new FileLedger('./data/ledger.jsonl'));
// -> { messages: 4210, deletions: 19 }
```

The conversations come back from the people who kept a copy. A browser with
*Keep my copy* turned on offers what it has when it reconnects, and the
server accepts a message only if its hash is one it committed to at the time.
That is what makes restoring from clients safe rather than reckless: without
the anchor, a server rebuilding from client data is rebuilding from
unauthenticated input, and anybody could attribute words to somebody who never
said them.

Three things are refused however confidently they are offered:

| | |
|---|---|
| **a hash it does not know** | invented, altered, re-attributed or moved between rooms |
| **anything in the deletion chain** | somebody pressed delete; a restart is not a way to undo that |
| **anything past twelve hours** | the promise was twelve hours, not twelve hours and a restart |

*Re-attributed* includes the name. It did not always: the hash covered an
author's id, which is a random string nobody ever sees, and not the name a
message is shown under — so a genuine message could be handed back under any
name at all and still match. Every message posted now is hashed in a second
form that covers the name and the key beside it, and is written as JSON rather
than joined with a character a message body is free to contain. What an older
ledger holds still verifies in the first form, for the twelve hours any of it
has left.

`Ledger` is two methods, `append` and `load`, so putting this behind Postgres,
Redis or a queue does not mean implementing a storage engine. `load` only runs
at boot.

**What this does not give you.** Completeness: clients hand back what they
happened to keep, so a room nobody was recording comes back empty and a
restored room may have holes. What comes back is genuine, which is a different
claim from all of it coming back. Nor does it protect you from whoever runs the
server — the ledger is a file on their disk, and an operator who edits it can
authorise anything. The chaining makes that detectable to somebody who noted an
earlier head, not impossible.


## What deletion can and cannot show

**Nobody can prove a deletion.** A server that copied your message elsewhere,
or whose disk was imaged, or whose operator simply remembers, can publish a
flawless receipt for a deletion that never happened. There is no cryptography
for "and then I forgot", and the word *proof* is avoided here on purpose.

What is here is narrower, and real. Every deletion is recorded, in order, each
entry bound to the one before it by a hash:

```js
import { verify, findDeletion } from 'eulerchat/receipt';

const { receipts } = await (await fetch('http://localhost:8787/api/receipts')).json();

await verify(receipts);                // { ok: true, problems: [], head: '...' }
await findDeletion(myCopy, receipts);  // { deleted: true, at: 1732..., reason: 'expired' }
```

So a server that says it deletes on a schedule and does not, or that goes back
and edits its own history, can be caught. Messages are named by a hash of
themselves rather than by their text, so the record can be published without
republishing the conversations: only somebody already holding a message can
recognise it there. Dishonesty becomes detectable rather than impossible, which
is the most any log can do.

You can also delete your own message at any time. It leaves the same trail.

**One inconsistency to know about.** The firehose names a deleted message by
its commitment precisely so that nobody who had merely seen an id — in a reply,
in a link — is told it went and why. The websocket does not: `forget` sends
`{type:'forgotten', messageId}` to every open connection, the room's audience
and everybody else alike. The words are gone either way; what leaks is that a
particular id was deleted. See **Open privacy defects**.


## Words only

No images and no emoji, in messages or anywhere in the product.

```js
import { plain } from 'eulerchat/plain';

plain('the chanterelles are up [an emoji here] <img src=x>');
// { text: 'the chanterelles are up', emoji: 1, images: 1, changed: true }
```

Removal rather than refusal: losing a whole message because one character came
off somebody's keyboard wrong is a worse outcome than dropping the character.
The browser cleans the box as you type, so nobody is edited without watching it
happen, and the server cleans again because a client is only a suggestion. A
sealed message can only be cleaned in the browser, since the server cannot read
one.

The rule covers the interface too, and a test walks the whole source tree and
fails if a pictograph appears anywhere in it. That is how the one I had put in
a label was found.

The one kind of drawing the interface does have is the kind the map already
was: shapes made in code. The emblems beside subject names are that — see
**The ground says what it is** — and nothing a person can say to another person
can contain one.


## Small groups, by name

`kite-fox-9/art` is a different subject from `art`. That is the entire
mechanism: containment already keeps the two apart, so nothing in the routing
had to learn that groups exist.

```js
import { newCluster, within, inviteLink } from 'eulerchat/cluster';

const group = newCluster();              // 'kite-fox-9'
within(group, 'art');                    // 'kite-fox-9/art'
inviteLink('https://example.com/', group);
```

**A group wraps its rooms.** Every group has a conversation of its own,
`kite-fox-9/everyone`, and holding anything in the group means holding it too;
the server sees to that, and leaving it is leaving the group. Every room in the
group is therefore inside it, so on the map its ground is exactly the area of
the group's rooms, drawn as a dashed line round them with the group's name on
the top edge. A room can combine up to ten subjects, and inside a group one of
them is always the group, so a group's rooms combine nine interests at most.

**The group comes first on the map.** A view shows as many of what somebody
holds as it has room for, the busiest first — which on its own left a group
off it every time, since a group's rooms hold the handful of people in it and
the interests outside hold everybody. So for a member the group's own
conversation comes first, then the rest of the group, and only then the world
outside by size.

**Inside, a copy of the world outside.** Only the membership is
different. Whatever is worked out from a name is worked out from the name without
the prefix: `kite-fox-9/art` has art's colour and emblem, is anchored where art
is, widens into the group's own `visual art`, and is suggested beside the group's
copies of whatever art is suggested beside outside. Search and browse walk the
whole catalogue and hand back the group's copies, and nobody is shown another
group's rooms. The map lays a group out with its frame left out of the
placement (the atlas's `frames` option), so the same people are drawn room for
room as they would be outside, and the frame goes round the result.

**The name is published.** The open side lists occupied rooms, and a
group's room key contains its name — so a stranger scraping the open side gets
`kite-fox-9` the moment anybody joins it, along with everything said inside.
"Anyone who has the name can walk in" is true, and the set of people who have
the name is everybody. For a conversation that should be hard to find, see
**A portal** below.

Share the link, or the square beside it, which is drawn as a grid of elements
rather than as a picture. The encoder is checked cell for cell against an
independent implementation across every version and error-correction level it
supports, and across all eight data masks — though no phone has been pointed at
one, so that is bit-exact agreement rather than a scan. **It is a door with a name, not a lock**: anyone who
has the name can walk in, and anyone you share it with can share it onward.
Right for the six people at your table; wrong for anything that would matter if
a stranger read it. What is said inside is still public unless it is locked.


## Quick join, to lurk

Every open conversation has a **Quick join** code: a square to scan, or a
link, `?watch=<room>`. Scanning it opens that one conversation to lurk in,
which is close to a browser's private window:

- **Reading along, not joining.** A lurker is not a member of anything. It is not
  in the room's head count and not on the list an encrypted message is locked
  for, so encrypted messages stay locked to it (`World.look`, the `watch`
  frame).
- **Sent more than it shows.** Every connection is greeted before it says what
  it is, so a lurker is also handed a `welcome`, an empty `history` and a
  `state` frame carrying the rail — the busiest dozen interests, a few
  suggestions and the size of the catalogue — and it receives every key claim
  made by anybody while it is connected, because those are broadcast to all
  open connections. The page ignores the lot and shows one conversation. That
  is the client being polite about frames the server should not have sent it,
  and it is in **Open privacy defects** until the server stops.
- **Counted, never named.** Each room says how many are lurking in it,
  on its chip, in its header and on its hover card. It is a number and never
  who, kept by the server's connections rather than the world, and the people
  in the room are told as it changes, because somebody talking deserves to
  know how big the audience is.
- **Nothing kept, nothing tied.** No key is made or shown, no earlier visit or
  group is picked up, saved copies are not offered back, and nothing is written
  to the device's storage.
- **Nothing else on screen.** No map, no interests, no name or group. The
  conversation has the page, and the header says *Lurking · just watching*.
- **It ends when they decide.** *Join in* joins what the conversation is about,
  inside its group if it is in one, and leaves it open. *Look around* shows the
  rest of the place. Either way the device goes back to its own key, name and
  group, and the `?watch` comes out of the address.

A portal cannot be quick-joined: it is not for finding. The group invitation
still joins the group outright, since a group is for talking in.

## System messages

Anything a person did not write is labelled as a **system message**: the lines
the sample worlds are made with (`seed`'s handful, `populate`'s openers), and
the questions below. They carry the sample people's names, because rooms are
only ever spoken in by their members, and the label is what says nobody said
them.

`--questions [seconds]` (or `questions: true` / `{ every, quiet }` in
`createEulerChat`) has one of the sample people put an on-topic question to a
quiet room every minute or so: *What drew you to board games rather than
somewhere else in games?* It is for demo worlds, so that walking into one is
walking into something.

- **Written offline.** `lib/questions.js` builds each question from the room's
  own interests and from where the catalogue puts them: the field above an
  interest, the interests beside it, both halves of an overlap. No model, no
  network, nothing leaves the server. The sentences are questions to the room,
  never claims about having done or read anything.
- **Labelled, and the label cannot come off.** A message the server wrote
  carries `machine: true`, set only by the server and part of the message's hash,
  so a copy handed back after a restart cannot drop the label, and a person's
  words cannot gain one. The browser prints *system message* beside the name
  and sets the question in italic behind a dashed rule. Screen readers hear it
  as a system message, and the open API carries the flag.
- **Only ever as a sample person.** It asks only as people marked synthetic
  (`addUser(name, { synthetic: true })`, as `seed` and `populate` make them) who
  already stand in the room, and never as anybody real, online or not. In a
  world of real people it asks nothing at all.
- **Out of the way.** A question goes only to a room somebody online can read,
  that no person has spoken in for three minutes, and never twice running. None
  go inside a group or a portal, and a machine question never interrupts
  anybody: it is counted, not notified.
- **Mutable.** **Settings → Alerts → System messages** mutes the lot of them,
  which is worth having in a demo, where fifty thousand made-up people are
  talking. Muted, the server is told `{ system: false }` and stops telling this
  page about them at all, so they are not counted as unread either; the
  messages still arrive in the room, folded into one line that says how many
  and shows them on a press, the way a muted person's messages are. Nothing is
  asked for on your behalf while they are muted, so an empty chat is not poked
  for a question to start it with; **Poke the server** still is. What is muted
  is kept in the browser and said again on every connection, since the server
  keeps preferences by who somebody is and a fresh guest is somebody new.

## A portal

Every other room here is named after what it is about, and anybody can read
the name — a room is a place, and places have addresses you can say out loud.
A portal is the exception. Its name is derived from a secret two people
already share, so both of them compute the same address and nobody else can
compute it at all.

```js
import { portalWith } from 'eulerchat/portal';

const address = await portalWith(me, theirPublicKey);   // 'portal-w4qk…'
world.join(myId, world.addSubject(address));            // an ordinary subject
```

It is an ordinary subject as far as everything else is concerned. `T ⊆ S`
routes it, the census counts it, and the notification rules classify it as the
two-person room it is — none of that had to learn that portals exist.

**Why derived rather than random.** A random name would also be hard to guess,
which is what the group invitations above do. The difference is what happens
next: a random name has to be sent to the other person somehow, it is a bearer
token for as long as it exists, and once it has leaked it has leaked for good.
A derived name is never transmitted — both sides recompute it from keys they
already hold — and because the day goes into the derivation, an address that
does leak stops working tomorrow. `portalsWith` returns today's and
yesterday's, so a conversation survives midnight.

The open read side does not carry these: not in `/api/rooms`, not in
`/api/scrape`, not on the firehose, not in the dumps, and asking for one by
name gets the same 404 a room that does not exist gets — a different answer
would confirm the guess. The interface stops saying *everyone can read this*
inside one, because there it would be false.

**The socket is another matter, and today it leaks.** Those filters are on the
HTTP side only. To everything a connected browser is sent, a portal is an
ordinary subject with no group prefix, so it passes the `clusterOf(id) === null`
test that keeps groups out of the shared views — and a stranger who holds an
interest one of the two also holds is sent the address. Confirmed by running
it: the minimap (`overview`), All interests (`chart`), search, the popular
list and the suggestions all carry a live portal address, and `atlasFor` hands
a non-member the overlap room `art+portal-…` on their own map. The address is
meant to be the whole of a portal's protection, so this is a hole in it and not
a documentation wrinkle; it is listed in **Open privacy defects** until it is closed.
The ledger writes one line per message with its room key, portals included, so
an operator's disk also holds the addresses that were spoken in, and their
times, after the words have gone.

**What it does not do**, which matters more than what it does:

- **It does not hide that two people are talking, or when.** The server still
  routes. It sees an opaque name, two members and a pattern of activity. Only
  the address is hidden, and the words only if they are sealed as well.
- **It does not authenticate anybody.** The public keys come from the server,
  so a dishonest server can offer a key of its own and derive an address with
  you. The same limit sealing has, for the same reason.
- **It is not a lock.** Anyone who learns today's address can join like anybody
  else; the routing has no idea portals exist. It is a door somewhere nobody
  else can find, not a door that refuses to open. The daily rotation is what
  makes that survivable rather than fatal — and, while the socket carries the
  address to strangers, what keeps yesterday's leak from being permanent.

Still open: how the second person learns a portal has been opened. The server
cannot be told without learning who is talking to whom, which is the thing
being avoided — so discovery has to happen in the browser, and it is not built.


## Votes

One person, one vote. Pressing the same button again takes it back, and
changing your mind replaces rather than adds. *Person* is doing less work
there than it sounds: it means one key, or one connection for somebody with no
key, and both are free to make more of. Two windows showing the same key are
one voter; somebody determined to be several is several.

Nothing about votes feeds the report ranking, and that separation is
load-bearing. A message plenty of people disagree with is not a message that
broke a rule, and if the two were connected then organising a few friends would
be the quickest way to get somebody moderated.


## The two decisions everything else follows from

### 1. Delivery is containment, not partition

A message tagged with a set of subjects **T** reaches every reader whose
subscription **S** satisfies `T ⊆ S`.

The tempting alternative is to treat each Venn region as a sealed room: a post
in the art-only lune goes only to people who are in art and *not* philosophy.
That is backwards. The person who loves both is the most engaged reader you
have, and strict lunes hide half the platform from them. Containment means:

| Post in | Reaches |
|---|---|
| `art` | everyone in art, including the art+philosophy crowd |
| `art+philosophy` | only people holding both, because it assumes both contexts |

Nobody is structurally hidden from anybody, and a subscriber to *n* subjects
sees exactly `2ⁿ − 1` rooms. See `receives()` in [lib/regions.js](lib/regions.js).

A single subject is a room like any other — hold one interest and you can talk
in it with everyone else who holds it, overlap or no overlap. Two consequences
follow, and both are load-bearing:

- **The lit area on the map is the audience.** Regions are *drawn* exclusively
  (the fill for `art` is art minus everything else) but *routed* by
  containment, so selecting `art` lights the whole art circle rather than the
  art-only sliver. The same `receives` predicate decides both, so the picture
  cannot promise an audience the router will not deliver.
- **Every room is listed, not only clicked.** A room whose exclusive area is
  covered over by its neighbours has no ground to click, which happens most
  often to single-subject rooms since those are what the overlaps eat into.
  The chips under the diagram reach every room regardless of geometry.

### 2. Euler, not Venn

A Venn diagram insists every intersection exists. An Euler diagram draws only
the non-empty ones. Real subject spaces are Euler-shaped — most combinations of
subjects have nobody in them — and a Venn build would manufacture `2ⁿ − 1`
rooms, nearly all of them dead. Empty rooms are what kill chat platforms, and
exponentially many empty rooms kill them faster.

So regions are derived from membership rather than enumerated from the
catalogue. A region nobody occupies never acquires a key, is never drawn, and
cannot be walked into. In the seeded world nobody holds both music and
philosophy, so `music+philosophy` does not exist — not empty, *absent*. Join
both and it comes into being.

## Positions are derived, never authored

If someone places the circles by hand the map lies: two circles can visually
overlap while sharing no members. Instead:

- a circle's **area** is its population
- a lens **area** is the shared membership of those two subjects
- positions are solved from the census, deterministically — the same census
  always produces the same picture

So the diagram is a live picture of the social graph, and adjacency means
something. That is also the discovery mechanism: a circle you are not in is
visible precisely because it overlaps one you are.

## The diagram reports its own dishonesty

Three circles give you three distances. Those three distances fix three
pairwise overlaps **and** the triple intersection — four quantities from three
knobs, so something must be wrong. Left alone, a spring solver satisfies the
pairs perfectly and dumps the entire error on the triple, which is the worst
possible outcome: the triple is the region this product exists for. Measured on
a symmetric three-subject world, that is a **39%** overshoot.

`layout()` re-solves for least total relative error instead, trading a few
percent on each pair to pull the triple back to ~13%, and then audits every
region by sampling and reports what it could not achieve:

```js
fit.regions   // every region: true population vs drawn area, worst first
fit.worst     // the region the picture is least honest about
fit.faithful  // false when any region is materially misdrawn
fit.drawable  // false past three circles
```

The UI prints this under the diagram. A picture that cannot be accurate says so.

## Nobody sees more than three circles

Four sets cannot be drawn as a Venn diagram with circles. This is a geometric
fact, not a rendering budget — ellipses reach five, and arbitrary closed curves
manage any number at the cost of looking like nothing at all. Rather than
degrade past that point, each person gets their own local view: the subjects
they hold, plus the neighbouring subjects that share the most members with
them, capped at three. That is the circles' view (`diagramFor`), and the
census counts combinations of up to three to match (`MAX_ARITY`), which is
also what keeps it from growing out of hand: it is cubic in what one person
holds. The map people use is the atlas, which is not circles and draws a
region of any size, so a room may combine up to ten subjects (`ROOM_ARITY`).
The population of a room bigger than three is counted when it is asked for,
from the holders of the rarest of its subjects, rather than kept.

### Circles are the reason for the residual error

Three circles give three distances, and three distances have to satisfy three
pairwise overlaps *and* the triple — four targets, three knobs. The leftover
shows up as the few percent `fit` reports.

An ellipse adds an aspect ratio and a rotation, which is enough freedom to
satisfy everything. Measured against the same three worlds:

| world | circles | ellipses | aspect needed |
|---|---|---|---|
| symmetric, small triple | 11.9% | 0.7% | 1.34 |
| symmetric, fat triple | 6.6% | 0.4% | 1.25 |
| lopsided | 2.1% | 0.9% | 1.05 |

The last column is the surprise: allowed aspect ratios up to 3.0, the solver
never wanted more than 1.34. Accuracy does not cost roundness — a 5–34%
ovalling is barely visible and removes nearly all the error.

Not yet adopted, because it is not free. Circle pairs have a closed-form lens
area, which is what makes the audit nearly instant; ellipse pairs have no such
formula, so every region would go back to being sampled. The solver would need
re-tuning against the same budget before this is a straight win.

### Circles get the regions wrong too, not just their sizes

Sizing is the smaller problem. A convex shape cannot always produce *exactly*
the set of regions the data calls for, and it fails in both directions.
Measured over 400 real views of the 1000-interest world:

| | |
|---|---|
| views where a region is drawn that nobody occupies | 5.7% |
| triple rooms drawn too small to click (<20px²) | 22.0% |
| triple rooms drawn as a speck (<300px²) | 24.9% |
| triple rooms drawn well (within 25%) | 33.6% |

Three circles overlapping pairwise tend to share a common patch whether or not
anyone holds all three — and when the overlaps are large, avoiding it is not
merely hard but geometrically impossible. `fit.phantoms` reports any such
region, and their presence makes a diagram unfaithful; removal is attempted but
only kept when it costs no accuracy, because a solver told to remove an
unavoidable phantom will flatten every area in the diagram trying.

Note the second half of that table is a *dynamic range* problem, not a shape
problem. The rooms that come out as specks almost all hold one person, inside
circles holding thirty to ninety. No choice of outline fixes that: a region
carved out big enough to click would no longer have an area proportional to its
population. Flexible boundaries would fix which regions exist; they would not
fix one person being a thousandth of the picture.

## Scale

Measured on a synthetic world of 1000 interests and 4000 people (45,683
occupied regions), which is what `npm run start:large` builds:

| | |
|---|---|
| building a view (`diagramFor`) | 3.7ms median, 6.1ms p95 |
| join round-trip, over a socket | 15.6ms median |
| broadcast after a join, 1000 sessions | 122ms, 27 of 1000 redrawn |
| people whose view contains an overlap room | 100% |

Three things make that hold, and all three are the same idea applied at a
different layer — **never touch the whole world to answer a local question**:

1. **The solver never sees more than three circles.** Because each person is
   projected to their own neighbourhood, the cost of a view is bounded by the
   view rather than by the catalogue. This is the load-bearing claim: a view
   costs about the same at a thousand interests as at three.
2. **A join updates the census in place.** Rebuilding meant re-expanding 4000
   people into 45,683 regions because one person clicked join — about 300ms.
   Joining a subject can only affect regions containing that subject, of which
   there are a handful. That alone took a join from ~300ms to ~15ms.
3. **A session is only redrawn when its own picture moves.** Someone joining an
   obscure interest cannot change a diagram that does not contain it, so each
   session is asked a cheap question first and only the few that answer yes pay
   for a solve. At 1000 sessions a join redraws 27 of them.

The list of interests follows the same rule: it shows what you hold, what is
being suggested and a few busy rooms, never the catalogue. A thousand rows
rebuilt on every push is the same mistake as a thousand-circle diagram.

### What the numbers do not cover

**First paint is still linear.** A thousand sessions connecting at once costs
~3.3s of solving, because each one is a genuinely different neighbourhood and
the cache cannot help (398 distinct views per 400 people). Spread over real
arrivals this is ~4ms each and invisible; as a thundering herd after a restart
it is not. Solving off the event loop would fix it.

**Density is a product assumption, not a guarantee.** The 100% figure above
holds because the generator clusters people into themes. Spread the same 4000
people uniformly over 1000 interests and essentially no pair would share a
member — every circle drawn disjoint, no overlap rooms, and the product has
nothing to offer. Whether a real population clusters is the question the
prototype cannot answer.

## Layout

```
lib/index.js      the public API (`import { layout, atlas } from 'eulerchat'`)
lib/regions.js    region algebra — addresses, containment, census, zones
lib/euler.js      circle solver, refinement, and the honesty audit
lib/atlas.js      routed-boundary layout: growth, tracing, smoothing
server/store.js   world state, the T ⊆ S routing rule, incremental census
server/populate.js synthetic worlds at scale
server/index.js   static files + WebSocket
public/diagram.js circle rendering and the coordinate → room lookup
public/atlasview.js atlas rendering and its point-in-territory lookup
public/app.js     state and wiring
```

`lib/` is served to the browser as well as imported by the server, so the
client and server share one definition of what a region address is.

## Embedding it: point at your data

The chat server is one way in and not the interesting one for most callers. If
you already know who your people are and what they are interested in — a users
table, a join table, a GraphQL response — you can have the map without a
connection, a poll or an adapter layer.

```jsx
import { EulerMap } from 'eulerchat/react';

<EulerMap
  users={db.users}              // [{ id, username, novelty }]
  interests={db.userInterests}  // [{ user_id, interest }]
  focus={currentUser.id}
  onSelectRoom={(room) => open(room.key)}
/>
```

That is the whole integration. Column names are guessed (`id`/`user_id`,
`username`/`name`/`handle`, `interest`/`subject`/`tag`), and named when they
cannot be:

```jsx
<EulerMap users={rows} columns={{ id: 'uuid', name: 'profile.displayName', subjects: 'tags' }} />
```

Interests may hang off the person as an array or a comma-separated column
instead of living in their own table. Subject names are normalised on the way
in, so `theory of entomology` and `modern entomology` do not become two rooms.

React is an **optional** peer dependency. Nothing else in the package imports
it, and `mountMap(element, options)` is the same thing without a framework:

```js
import { mountMap } from 'eulerchat/embed';
const map = mountMap(element, { users, interests, focus: userId });
map.update({ view: 'atlas' });
map.destroy();
```

Or `viewFor(data, { focus })` for the numbers with nothing drawn.

### Steering what people are shown

A `novelty` column decides which way somebody gets pushed when the map
suggests a subject they do not hold. At 0 it offers the nearest neighbour —
the subject most of their people already share, which is the one they were
most likely to find unaided. At 1 it prefers a subject reachable *through*
people but far away in the hierarchy, which is what a new community looks like
from the inside.

Stored as a fraction or a percentage, either is read. Left out entirely,
people get the middle rather than an extreme.

```
entomologist, novelty 0.0  ->  mycology   (same field, strongest overlap)
entomologist, novelty 1.0  ->  poetry     (different division, but bridged)
```

The crossover is around 0.53 for that pair: reaching across the map has to be
worth more than a strong neighbour before it wins, which is the behaviour you
want from a dial rather than a switch.


## Where subjects sit, and what grows between them

The atlas originally placed subjects by shared membership alone. That is
honest about the community and useless as a map: topology and geometry are
drawn as strangers until somebody happens to hold both, a brand new subject
has no position at all, and every coordinate shifts as people come and go.

Three layers now, each doing one job:

| | decides | from |
|---|---|---|
| **taxonomy** | where subjects *sit* | a knowledge hierarchy, before anyone joins |
| **mould** | which way the ground *runs* between them | agents, fed by who bridges what |
| **quotas** | how much ground each zone *gets* | population — exactly, as before |

Only the first two are new, and neither touches the third, which is why the
map can take an organic shape without giving up the exactness the atlas exists
for.

### A hierarchy anchors the map

```js
import { radialLayout, anchorsFor, knowledge, atlas, zones } from 'eulerchat';

const where = radialLayout(knowledge);          // or your own `child: parent`
const anchors = anchorsFor(subjects, where);
atlas(zones(people, subjects), { anchors });
```

The bundled hierarchy is a dozen divisions, the fields within them, and
beneath those the interests — and it is mostly the interests people join.
Somebody joins `entomology`, not `biology`; the field above it is there to say
where entomology *is*, so that it sits beside mycology and nowhere near
topology before a single person has joined either.

### What a fresh install is stocked with

A little over eleven hundred interests. It used to be three, which was enough
to show how the place works and not enough to give anybody a reason to stay:
somebody who arrives and cannot find their thing concludes there is nothing
here. It was filled in three passes, and each is a different reason to stay.

- **The obvious** — football, cooking, dogs, television, parenting, personal
  finance. If these are missing the place looks empty however much else there is.
- **The niche** — fountain pens, lockpicking, narrowboats, roguelikes. The
  rooms people cannot find elsewhere, and the ones that keep them.
- **The modern** — large language models, pickleball, heat pumps, the
  fediverse. Without them it reads as something nobody has looked at in ten years.

The divisions are the six academic ones, hobbies, and five for the rest of
life: sport, technology, entertainment, lifestyle and society. Where an
interest is big enough to have interests of its own there is a fourth layer:
`photography` holds `film photography`, `video games` holds `roguelikes`, and
both are rooms.

```js
import { World, seed, stock } from 'eulerchat/app';

stock(new World());   // the catalogue alone: interests, no people, nothing said
seed(new World());    // that, and a few made-up people so the map has something on it
```

An interest with nobody in it costs a string in a set. It takes up no room on
the map, which draws only what is occupied, and it is there to be found when
the first person who wants it turns up.

Found two ways. By **searching**, which also knows what people call things:
`soccer` finds `football`, `dnd` finds `dungeons and dragons`, and nobody makes
an empty room called `soccer` next door to the full one (`alsoCalled`, which
only ever informs a search — it never renames a room somebody made on purpose).
And by **browsing**, for whoever arrives with no word in mind:

```js
world.browse();                 // the dozen divisions, each with a few of what is in it
world.browse('sport');          // its fields
world.browse('racket sports');  // badminton, padel, pickleball, squash, table tennis, tennis
```

The interface lists these at the foot of the interests, a level at a time, and
anything on any level can be joined from there. Only what a world actually has
is shown, so a host that stocks its own short list sees that list, arranged.

### The funnel: joining narrow without being alone

A catalogue of two hundred subfields is finer-grained than most communities
are large. The person in entomology and the person in mycology share nothing
at all as far as the rooms are concerned — which is true of their subjects and
false of them, and the reason they never meet.

So a join can carry upward:

```js
world.setFunnel(userId, 1);        // 0 = just this, 1 = + its field, 2 = + its division
world.join(userId, 'entomology');  // -> entomology, biology
```

Both now hold `biology` and have somewhere to find each other, without either
having to claim their real interest is something broader than it is. Their own
rooms are untouched — widening adds, it does not replace — and the broader
room is created if the catalogue has not got it yet, because a funnel that
quietly does nothing whenever the field happens to be missing is worse than no
funnel. It never reaches the root: a room containing everybody is not a room.

### Hobbies, not only fields

The taxonomy is academic in structure and not in content. Hobbies are the
largest division in it — handcraft, cooking, drinks, games, outdoors, growing,
movement, tinkering, collections, playing music, writing — because a catalogue
that only admits scholarship has nothing to offer somebody who came for bread
and bicycles. Same layers, so a hobby funnels upward exactly as a subfield
does.

### A facet is not a different subject

`theory of entomology`, `modern entomology` and `field entomology` are
entomology. Three rooms for one small community is fragmentation nobody would
defend if asked directly, so `addSubject` normalises:

```js
world.addSubject('theory of entomology');   // -> 'entomology'
world.addSubject('history of jazz');        // -> 'jazz'
world.addSubject('theory of everything');   // -> unchanged
world.addSubject('field theory');           // -> unchanged
```

A facet is only stripped when what remains is a subject the hierarchy actually
knows, and that restraint is the whole safety of it — a rule that stripped
unconditionally would quietly rename things nobody meant to rename.

Laid out on a disc, a compact patch to each branch with a gutter between
branches — siblings adjacent, unrelated branches apart — and deterministic.
It used to give each branch a wedge of the circle, which holds up for three
hundred names and not for a thousand: a field became a sliver a hundred units
long and five degrees wide, and the two ends of `mathematics` were further
apart than `algebra` was from `baking` next door. Across the bundled
catalogue a subject is now nearer to a sibling than to a stranger from
another division 99 times in 100. Names it does not know are left unanchored and placed by
co-membership as before; a facet like `modern jazz` resolves to `jazz`, so a
real catalogue anchors without anyone curating every phrasing. Cycles are
tolerated, because a hierarchy baked out of Wikipedia will have them.

What this buys, measured by churning a population and seeing how far subjects
move on a map 1000 units across:

| | mean drift | worst |
|---|---|---|
| membership only | 444 | 589 |
| anchored to a hierarchy | **40** | **68** |

Eleven times steadier. That is the difference between a map that breathes and
one that rearranges itself around whoever is currently online — the objection
that made the atlas a snapshot rather than a surface.

### A mould weaves the routes

```js
atlas(counts, { anchors, mold: true });   // or { mold: { generations, agents } }
```

Subjects are food; the people holding two subjects are the traffic between
them. Agents shuttle along their own pair, deposit, sense and turn, and the
field diffuses and decays — so the routes people actually bridge get trodden
into existence and the rest fade. `atlas(...).network` reports what it joined.

It is not free, and the defaults are not the textbook ones. With the values a
general Physarum model uses, agents merge into a single mass governed by the
geometry, and the network that emerges came out **anti-correlated** with the
co-membership it was supposed to be tracing. Two things fix it: agents that
keep their pair for good rather than merely starting on it, and connectivity
measured by widest path rather than along the straight line between two
subjects — a mould route bends by nature, and a chord probe scores a perfectly
good curved channel at zero.

Correlation between channel strength and people bridging a pair, across four
populations, three never used for tuning: **0.69, 0.97, 0.42, 1.00**.


### Everything is on the map, and you are somewhere on it

A view can only draw a handful of subjects legibly, which leaves someone with
no idea what else exists or whereabouts they are among it. So the view is a
neighbourhood and the minimap is the whole thing:

```js
world.overview();   // every occupied subject at its place in the hierarchy
```

Subjects the hierarchy has never heard of are not dropped — they go on an
outer ring, which then reads as exactly what it is, everything not yet
classified. Facets of one subject would otherwise stack invisibly on top of
it (`modern painting`, `early painting` and `field painting` all resolving to
`painting`), so each cluster is fanned into a small constellation: on a
catalogue of 600, 599 distinct positions.

The atlas itself opens framed on the subjects you hold, with exactly 20px of
margin. Padding in pixels cannot simply be added to a viewBox — the viewBox is
in user units and the scale between them is the thing being solved for, so
widening the box to make room shrinks the very margin it widened for.
`fitTo` solves for the scale first.

### All interests, on one sheet

The minimap is too small to go into, so pressing it (or **Explore all
interests** in the View menu) opens it full size: every interest there is,
held or not, laid out as on the minimap, sized by how many hold it, with the
dozen divisions named over their patches.

```js
world.chart();   // every open interest, its place and its ancestors, plus
                 // the divisions and fields named at the middle of each
```

It is asked for with a `chart` frame when the explorer opens rather than
pushed, since it is about a hundred kilobytes that most visits never look at.
Group rooms are left off it, and off the minimap: a group's `chess` is chess,
lit as held there, and is nobody else's business.

**Every ten seconds.** An open page asks for its map again every ten seconds,
and for the chart too while the explorer is open, so how tall things stand
keeps up with what is being said even when nobody joins or leaves. Nothing is
asked while the page is out of sight. Each ask says which drawing it already
has, and while that is still the drawing only the numbers come back:

```js
{ type: 'atlas', subjects: 5, have: 'a1b2…' }   // → { type: 'atlas', only: 'rooms', shape, rooms, subscription }
{ type: 'chart', have: 'c3d4…' }                 // → { type: 'chart', only: 'activity', shape, activity: [[id, a], …] }
```

A map is about two hundred kilobytes and its rooms about two; the chart is
about a hundred and fifty and how lively its interests are about ten. An ask
without `have`, or with a drawing that is no longer current, gets the whole
thing, named by `shape`. The server keeps each solved map by what it was
drawn from (which subjects, how many hold each region of them, the group), so
asking again costs a few milliseconds rather than a fresh solve, and only the
rooms (how busy each is, and whether the asker is in it) are worked out anew.
The page redraws at most every ten seconds for anything but its own change.

- **Moving round.** Drag, scroll or pinch. Field names come in at 1.3 screen
  pixels per unit of the sheet and interest names at 2.8. The thresholds are in
  pixels rather than in how far it has been zoomed, since the same zoom on a
  phone has a third of the room. Dots grow more slowly than the sheet (its zoom
  to the power 0.4). An interest's facets sit in a tight knot round it, and dots
  that grew with the sheet overlapped exactly as much however far in it went.
- **Picking one.** Pressing a dot shows its name, its place (`arts › visual
  art`) and how many hold it, with **Join**, **Leave**, **Open its
  conversation** and **Browse** its field in the interests list.
- **Joining one, from wherever it is named.** Every row in the lists beside the
  sheet — the matches for a search, and the interests often held with the one
  picked — carries **Join** next to the name, wearing that interest's own
  swatch: the same square, colour and emblem the map draws it with, and the
  same one a chat's chip carries, so a row here and a patch of the map read as
  the same thing. One already held says *Yours* and does nothing; leaving is
  done where leaving is done, since a button that joins on one press and leaves
  on the next loses somebody an interest by mis-aiming.
- **Finding one.** Typing lights the matches, dims the rest and lists the first
  eight, and Enter flies to the first. That is also the way round it without a
  pointer: a thousand dots are not something to tab through.

### Communities, and branching out into one

The hierarchy says what an interest *is*. The links All interests draws say
who comes with it: pairs of interests that people hold both of, weighted by
how strongly (`lib/association.js`). Grouped, those links give communities —
interests the same people turn up to together, which often cut across the
hierarchy. Guitar, piano and drumming land in one because the same people
hold them; so, in the right crowd, do history, hiking and climbing.

```js
world.communities();  // { list: [{ lead, name, members, near }], of: Map(interest → index) }
```

Found by the Louvain method over the links and nothing else; see
`lib/communities.js`. A thousand interests and fifteen hundred links take
about forty milliseconds, and it is worked out again only when who holds what
changes, as the chart is. Every order it goes in is fixed, so the same links
give the same communities on every server, and each is named by its most-held
interests. A link needs two people holding both and only the open world is
linked, so a community says nothing the sheet did not already show; nothing
inside a group is in one.

**Branching out** is the map of somewhere you are not. Right-click a chat on
the map — or hold a finger on it — and the menu offers the community each of
its interests is in, and the ones next to those. Branching draws that
community in place of your own map: the interest you came from, and the
community's interests most held with it.

```js
world.branchFor(userId, 'guitar');                       // guitar's own community
world.branchFor(userId, 'guitar', { toward: 'python' }); // the one next to it: what bridges the two
```

Nothing is joined by branching. Chats you are in are yours as always, and the
rest are drawn as chats you are not in yet, to open, look in on and join like
any other. A bar along the bottom says what is being shown and takes you back;
your own map is kept up to date beside it, so the list of chats stays yours. A
branch is asked for again every ten seconds, like the map, and answered the
same way — only the rooms, while the drawing in hand is still the drawing:

```js
{ type: 'branch', from: 'guitar', toward: null, subjects: 5, have: 'a1b2…' }
```

**Joining one.** Where a community is offered — the bar under a branch, and
the list in All interests — it can be joined whole or in part. **Join all**
takes everything in it you do not already hold; **Join some** opens a switch
for each interest, on for the ones that would be joined, with what you hold
already on and fixed, and a button saying how many. Both go in one frame:

```js
{ type: 'join', subjects: ['piano', 'drums', 'singing'] }
```

One ask and one redraw rather than a dozen of each, capped at `JOIN_AT_ONCE`.
Nobody may hold more than `MAX_SUBSCRIPTIONS` interests — the census is cubic
in what one person holds — so joining a big community can run into that: what
fits is joined, and the rest is refused with a message saying why, rather than
the whole ask failing on the last of them.

**Coloured by community.** The button under 3D in All interests colours every
interest by the community it is in rather than by its own name, and lists the
communities beside the sheet, biggest first, each with its colour and how many
interests are in it. Picking one lights it on the sheet and offers it: branch
out into it, join all of it, or join some. An interest in no community stays
grey. Hues are dealt round the wheel by the golden angle so that neighbours
look unalike (`communityColour`), through the same lightness window as every
other colour here, so both themes are served without a branch.

### A menu for whatever was pressed

The right button, a long press, or the keyboard's menu key opens a menu for
what is under it, where the browser would otherwise put its own
(`public/menu.js`). A right *drag* still turns the map, so only a right button
let go where it was pressed is a menu; on a phone a finger held still for half
a second is, and a finger that moves is moving the map.

A chat's menu opens it, joins what it needs, pins it, copies its quick-join
link, and branches out from each of its interests. The map's own resets the
view, switches the heights, opens All interests, and goes back from a branch.
An interest in All interests has its own, inside the sheet — everything
outside an open modal dialog is inert, and a menu there could be seen and not
pressed. Each is a list of sections, so anything offered later is one more
section rather than another menu.

### In relief: as tall as it is lively

The map and All interests are drawn in 3D by default. Every conversation on
the map stands as a block, and every interest in All interests as a column,
as tall as it has been lively lately compared with the liveliest on the whole
platform. **View → 3D** lays both flat again (remembered in the browser), and
the turn buttons go round a twelfth of a turn at a time to see behind tall ones.

```js
world.activity();  // { rooms, subjects }: each 0..1 against the liveliest
```

- **What counts.** Every message, with its weight halving each hour
  (`HALF_LIFE` in `lib/activity.js`). Messages per minute over five minutes,
  which a room's card shows, is nought everywhere five minutes after the last
  word; this way the relief stays put while the place is quiet, because
  every message ages at the same rate and the ratios between rooms do not
  change. System messages count, and so a stocked demo world is not flat.
  Portals are not counted at all. Groups are counted but do not set the scale,
  so nothing outside a group can tell from the heights that it is busy.
- **Height.** The square root of activity, over a small floor: a room nobody
  has spoken in yet is low, never flattened away.
- **Moving round it.** The same gestures on the map and in All interests
  (`public/gestures.js`). Getting about is the thing done most, so it is the
  one finger; turning the map to see behind something is the second hand's
  job, as it is on a phone's maps:

  | gesture | does |
  |---|---|
  | one finger or the mouse, dragged | move |
  | two fingers dragged | orbit: across turns, up and down tilts, twisted turns (flat: moves) |
  | two fingers pinched | zoom |
  | right button, or Shift, dragged | orbit, with a mouse; the middle button moves |
  | trackpad: two fingers scrolled / pinched | orbit (flat: move) / zoom |
  | mouse wheel | zoom, a notch at a time |
  | double tap or double click (Shift: out), two-finger tap | zoom in (out) |
  | right click, a long press, or the menu key | the menu for what is there |

  On a phone a tap on the map opens a conversation and leaves the map for it,
  so a finger's tap waits a moment (`DOUBLE_GAP`) to be sure it is not the
  first of a double tap; a mouse's click does not wait. Orbiting All interests
  moves the thousand columns already drawn rather than drawing them again
  (`reprojectChart`), and puts them back in order from the back only now and
  then while moving and exactly once it stops, which took a frame from a
  tenth of a second to about a fiftieth.
- **How it is drawn.** Still SVG: the sheet is turned, then tilted away, which
  is an affine map, so each room's flat drawing (colour, emblems, the edges of
  its subjects' outlines) is laid on its top with one `transform`. Walls are
  the room's own colour, lighter or darker by which way they face.
  Because "further back" and "higher" both go straight up the screen, drawing
  level by level from the ground up is enough to get the overlaps right, with
  no sorting of shapes against each other. See `public/relief.js`. A room's
  top is not over its own ground any more, so every top and wall carries
  `data-zone`, and a press reads the room off what is drawn there.

### Where things are

What is used every visit is in front; what is set once is a menu away.
Nothing was taken out to get there. The words are one per thing: a **chat**
is where people talk (the code and the API still say room), and an
**interest** is what you hold.

- **Header:** Interests (in the accent until you hold something), Group, your
  name and key, Theme, and Settings (an icon on a phone). **Settings** is about
  you: alerts, **Your messages** (keep a copy of what I send, check the
  deletion record), **Muting and reporting**, and your key.
- **The map's strip:** Chats (the chats on the map, yours first, busiest
  first), Explore interests, and as icons Pop out, Expand and View. **View** is
  about the map: reset, 3D and turning, how many interests to draw, the
  minimap, layout (swap sides, pop out, reset), and how this works.
- **A chat:** its name and Quick join at the top. On a phone, a Chats button to
  get back to the list. Encrypt and Poke the server above the box you type in,
  only when you can post. Each message shows reply, and the rest behind ⋯:
  agree, disagree, mute, report and delete. With a mouse they appear on hover.
- **Interests:** search first, then the whole list to pick from, then what is
  suggested. **Joining options** is folded away at the foot.

### Small things that help

- **Every chat of yours is in the list.** The map draws a handful of
  interests; the atlas also lists, as `offMap`, the other chats you are in that
  somebody else is in too (the busiest hundred), so none is out of reach.
  They are dashed in Chats and do not redraw the map when they change.
- **Pinned**, **Lively now** (activity of 0.3 or more against the liveliest on
  the platform, three at most), **Yours** and **Others on this map**, in that
  order, in Chats. Pins are kept in this browser only.
- **After your first join**, the busiest chat it put you in is opened.
- **An empty chat** asks the server, once, for a question to start it with,
  shown as Poke the server's answer is.
- **The lurk bar** says what Join in adds, and how many are in the chat and
  talking.
- **Explore's "Often held with"** offers **Open the chat for both** where the
  two meet on your map.
- **On the map**, rooms you are not in yet are fainter: one tap from their way
  in.
- **Moderators** — keys the host trusts, told so in `welcome` — get
  **Reports** in Settings: each chat reported, why and how often, with **Look
  in** (a lurk, in its own tab) and **Clear**.

### A map that holds still

The map is drawn again only when what it shows has changed. The server sends
a fresh atlas after every change near anybody's interests, and most of those
change nothing on a given screen, so each one is compared with what is drawn
(`drawnAs`: the shapes, the names, and what decides each room's colour and
height) and an identical one only brings the rooms list up to date. Drawn
again, it keeps the view where it was: framed afresh only the first time, on
**Reset view**, on switching 3D, and when what you hold has changed. Other
people's changes redraw it at most once every ten seconds (`REDRAW_EVERY`),
with the latest of them; your own — the first map, a new interest — at once. A panel
that changes size reshapes the view rather than redrawing it, labels are
rewritten only when their spelling changes, and nothing on the map or in All
interests is text to select, so a double click zooms without painting a word
blue. Measured in Chrome: no change to the map's DOM in ten seconds left alone,
or on a resize.

### Poke the server

**Poke the server**, beside Quick join in an open conversation, sends a `poke`
frame. The server answers with a question from its databank (`lib/questions.js`),
made from that room's interests and where the catalogue puts them — or from
something you hold, if the room gives it nothing to go on. The answer goes to
whoever poked and nobody else, and nothing is posted: it appears above the box,
marked as a system message, with **Use it** (into the box, to change or send as
your own), **Another**, and a close button. Never made from a portal's name or a
group's own conversation, and rate-limited like every other frame.

### Adding from the list

Interests has an **Add from the list** dropdown: the whole catalogue in one
native `select`, the twelve divisions as its groups, and under each its fields
and their interests, indented by how deep they sit
(`arts` › `visual art` › `photography`). Choosing one joins it, with the
**Also join** setting applied as usual. Ones already held are marked
"joined" and cannot be picked again. It is filled from the same `chart` frame
All interests uses, asked for when Interests opens.

### The overlaps are labelled

The overlaps are the most interesting ground on the map and were the only part
left unnamed, because the full names do not fit where subjects meet. Initials
do — each shortened only as far as it can be without becoming ambiguous among
what is on screen:

| on screen | labels |
|---|---|
| music, philosophy, math | `mu`, `p`, `ma` — `p` is unique alone, `m` is not |
| + mathematics | `mu`, `p`, `math`, `mathe` |
| amateur running, amateur go | `ar`, `ag` — a phrase gives its initials |

So an overlap reads `mu + p + ma`, and hovering gives the full names and how
many people are there.

The atlas pans and zooms, and the short forms are not permanent: they exist
only because the full names do not fit, so once there is room the real name is
what appears. Two things make that work. Labels hold a constant size on
*screen*, which means their size in map units shrinks as the map grows under
them — without that they would scale with everything else and never fit any
better. And "does it fit" is asked against the room the zone actually has,
which the layout already worked out when it decided where to put the label:
the distance transform that finds the deepest point knows how deep it is, and
that depth is the radius of the largest circle the zone will hold. Labels sit at the deepest point of the zone's own
ground rather than at the seed it grew from, which after growth can be
somewhere else entirely.

```js
import { shortLabels, abbreviate } from 'eulerchat';
abbreviate(['music', 'philosophy', 'math'], shortLabels(subjects));  // 'mu + p + ma'
```

### The ground says what it is

Colour tells two subjects apart and says nothing about either. So each field
has an emblem — picture frames for visual art, the bust of a philosopher for
philosophy, `+ − × =` for mathematics, a flask, an hourglass, an amphora — and
a subject wears the emblem of the field it sits in. It is on the square beside
the name in every list, and it is sown faintly across the subject's ground on
the map, the way a printed map sows reeds over a marsh.

Fifty-one are drawn: the seven divisions and the forty-four fields. Nothing
below that needs one. `entomology` wears the helix because it is under
`biology`; `modern painting` wears the frames because `painting` does; `art`
and `math` find their way by a short list of the words people actually type. A
name the hierarchy cannot place wears no emblem and gets a pattern generated
from a hash of the name instead — stripes, dots, rings — so there is no subject
with nothing on it, including the ones nobody has created yet.

Every subfield of a field shares its emblem, so on the map each is sown at its
own spacing and from its own starting corner. Where two of them overlap the
marks interleave rather than landing on each other.

```js
import { emblemOf } from 'eulerchat/emblem';
emblemOf('entomology');       // 'biology'
emblemOf('kite-fox-9/art');   // 'visual art'
emblemOf('topic 17');         // null — it wears a pattern
```

The emblems are geometry in [`lib/emblem.js`](lib/emblem.js) — paths, circles
and rectangles on a 24-unit square. No image is loaded to draw one.


### How it looks is yours to choose

Under *Theme* in the header: twenty themes to start from, ten
light and ten dark, and sliders to make your own from any of them. It is kept
in this browser and sent nowhere.

| light | dark |
|---|---|
| Paper, Sepia, Mint, Rose, Sky | Ink, Midnight, Forest, Plum, Ember |
| Lavender, Sand, Newsprint, Ledger, Daylight | Slate, Terminal, Blueprint, Black, Starlight |

**There are no colour pickers.** Pale grey text on a pale grey panel is a valid
pair of hex codes, and nine free pickers make an interface unreadable in four
clicks. A scheme is a *recipe* instead: light or dark, what hue the surfaces are
tinted and how strongly, how bright the paper is, the highlight hue, the
lettering, the corners, and whether to raise the contrast. Every colour on the
page is then worked out from that, each placed at a fixed contrast against the
panel it is read on, using the same search that places a subject colour. The
contrasts are the ones the built-in themes were measured at, raised where
needed so text clears 4.5:1 on all three surfaces and not only the panel. A
test sweeps more than nine hundred recipes, across every tint, strength,
brightness and highlight, and checks each against those bars.

The subject colours move too, a little. They were tuned to clear 3:1 against
white and against the dark panel, and a cream or pale green throws less light
than white, so on tinted paper all three brightness tiers come down together
until the brightest clears it again. Hue is what tells subjects apart, and it
never changes. Dark paper is held under the brightness where the dimmest tier
would fail rather than moving the colours up, because that would cost the white
emblem drawn on each swatch its contrast.

```js
import { SCHEMES, tokensOf, styleOf } from 'eulerchat/scheme';

tokensOf({ mode: 'dark', tint: 150, wash: 0.9, accent: 140 });
// { bg, panel, raised, line, edge, muted, ink, accent, warn } — all as hex
styleOf(SCHEMES.find((s) => s.id === 'sepia').recipe);
// { '--panel': '#feecd4', '--face': 'ui-serif, …', '--radius': '6px', … }
```

Nothing is fetched: the four letterings are stacks of fonts already on the
machine. The built-in themes stay in the stylesheet, so a page with no script
still has them, and *Match system* goes back to them.


## Two views, two bargains

The map and the atlas answer the same question with opposite trade-offs, and
both are in the UI because neither dominates.

| | **map** (circles) | **atlas** (routed boundaries) |
|---|---|---|
| subjects at once | 3 | any; legible to about 5 |
| zone arity | 3 | any — a six-subject zone draws fine |
| regions drawn that nobody occupies | 5.7% of views | none, by construction |
| rooms too small to click | 22% of three-way rooms | none, by construction |
| area error | a few %, sometimes 12% | ~1% |
| stability | continuous — a join nudges a radius | regrown; a different population grows differently |
| cost | ~4ms, per viewer, live | ~180ms, on request |

The atlas exists because convex shapes cannot produce an arbitrary set of
regions. Three circles overlapping pairwise share a common patch whether or not
anyone holds all three, and at realistic overlaps avoiding it is not merely
hard but geometrically impossible. So the atlas stops drawing shapes and
intersecting them, and instead gives every zone its ground first — grown
outward from a seed until it holds its share — then traces the outline of each
subject's territory afterwards. Exactness is then a property of the
construction rather than something a solver fits toward.

What it gives up is continuity. The boundaries come out of a growth process, so
a small change in the population does not make a small change in the picture —
which destroys the spatial memory a live map depends on, and is why the map is
still the thing you sit in and the atlas is something you ask for.

**Where it stops working.** Legibility, not accuracy, is the limit:

| subjects | rooms | subjects split across patches | verdict |
|---|---|---|---|
| 3 | 7 | 0 | clean |
| 4 | 14 | 2 | workable |
| 5 | 20 | 4 | cluttered |
| 6 | 30 | 6 | fragmented |
| 8 | 41 | 8 | fragmented |

Those verdicts come from looking at renders (`npm run render`), not from the
numbers. Five was called readable until somebody looked at it: the big
territories are fine but the middle fills with slivers, and a subject arriving
in three pieces reads as three subjects that happen to share a colour.

Areas stay exact at every size; what degrades is that a subject's territory
arrives in several pieces instead of one. That is the known hard part of Euler
layout — realising an arbitrary region structure with every subject connected
is not always possible at all — and it does not respond to more space or a
finer grid, so it is reported (`report.disconnected`, `report.worstSplit`)
rather than papered over. The default is five.

## The demo

`npm run demo` is a place to try this out among company: fifty thousand
made-up people across 1,200 interests, some of them talking at any moment,
others coming and going. Join anything and the rooms round it are already
busy; say something and, now and then, somebody made-up in the room answers a
few seconds later.

How busy a room is has three modes rather than one curve — most rooms are
quiet (a word an hour or so), a good share steady (every few minutes) and a
few busy (twice a minute or more), each spread a factor of two about its
mode — so the map has a floor, a middle and peaks rather than one tower over a
flat plain. Which kind a room is comes from its name, so it is the same kind
every time. The rooms round whoever is online get a share of their own on top
of the rest, and for the first half-minute after somebody arrives a larger
one, so their map comes up while they watch. See `server/traffic.js`.

```
node server/demo.js --people 50000 --interests 1200 --rate 2 --near 0.6 --churn 0.4 --reply 0.6 --port 8790
```

`--rate` is words a second across the place, `--near` words a second round
whoever is online, `--churn` joins and leaves a second, and `--reply` the
chance somebody answers a real person. At fifty thousand it is ready in about
a second and holds about 150MB.

**It stays away from production.** It is its own entry point, which neither
the `Procfile` nor `npm start` reaches, and it refuses to start where the
environment says it is a deployment — `NODE_ENV=production`, a Heroku dyno,
Render, Fly.io, Railway, Vercel, Cloud Run, AWS, Azure App Service or
Kubernetes. It keeps no ledger and writes nothing, so a restart forgets it all
and none of it can be handed back to a real server. It listens on its own port
(8790, or `DEMO_PORT`, or `--port`) rather than `PORT`, so it never takes a
real server's place. And it says what it is: every page it serves wears a
**Demo** label, and every word its people say is a system message, marked as
such as the sample world's are. Only the made-up people ever say anything;
never a real person, and never inside a group.

The open read API is on, so that the firehose has something in it to watch at
[localhost:8790/streams](http://localhost:8790/streams). It says "demo" too: in
the API's index, in the first line of every dump, and in every dump's file
name. The two thousand words said while it warms up fill most of the first
megabyte, so the first dump is cut about five minutes after it starts, and
one every quarter of an hour after that.

## Deploying

There is a `Procfile` and the port comes from `process.env.PORT`, so it boots
on a single dyno. It starts with the catalogue and nobody in it: no made-up
people and nothing said, which only `--sample` and `--interests` add. Memory is not the constraint — a world of 1000 interests and
50,000 people is 36.5MB of heap, a connected session about 4.8KB, and a diagram
push 3.1KB on the wire. A 512MB dyno has room to spare.

What it does **not** survive is being scaled out:

- **Two dynos are two separate chat rooms.** All state is one in-memory
  `World`, so `ps:scale web=2` splits the population in half with no error and
  no symptom beyond people not hearing each other. This is the blocker, and it
  is the only one that needs architecture rather than code.
- **A dyno restart empties the world.** Heroku cycles dynos at least daily, and
  every deploy does the same. Every membership is gone, and every message with
  it unless somebody's browser kept a copy to hand back (**Surviving a
  restart**) — which needs the anchor to still be there, and by default the
  anchor is a file in the working directory that the same restart wipes. On a
  platform with an ephemeral filesystem, point `--ledger` (or
  `EULERCHAT_LEDGER`) at a mounted disk, or accept that restoring will never
  match anything.
- **The anchor only grows.** One line per message, for ever: a hash, the room
  key, the time and a sequence number. It is loaded whole at boot, nothing
  prunes it, and the room keys in it include groups and portals. It is small
  per message and it is a permanent record of which rooms were spoken in and
  when, long after the words have gone.
- **Solving blocks the event loop.** Layouts run on the main thread, so a burst
  of first paints stalls all other traffic — worse on a shared-CPU dyno than on
  a laptop.
- **One long run ended in an unexplained exit.** A server left up for hours
  exited with code 1 and left no stack behind, and the cause is still not
  known. The obvious gaps were closed afterwards — sockets, the socket server
  and the HTTP server all have error listeners now, and the heartbeat skips
  anything not open — but none of those reproduce it, so the fix is unproven.
  What was certainly missing was the evidence: uncaught exceptions and
  rejections now print a stack and the session counts before exiting.

Idle timeouts are handled: the server pings every 25s, inside Heroku's 55s
cutoff, and the client reconnects with backoff and resumes its identity and
memberships within a 60s grace window.

### What sharing state would take

The pure algebra in `lib/` is already independent of where state lives; only
`World` would be replaced.

- **Census → Redis hash.** `#touch` already does nothing but increment and
  decrement a handful of counters per join, and deletes on zero. That is
  `HINCRBY` plus a conditional `HDEL`, and the Euler property survives the
  translation unchanged.
- **Fan-out → Redis pub/sub.** Publish per subject; each dyno subscribes to the
  subjects its own connections hold and applies `T ⊆ S` locally.
- **Layout cache → Redis, keyed by `censusSignature`.** The key already exists
  and is already content-addressed, so it is shareable as-is.
- **Messages and memberships → Postgres**, with Redis as the hot index.

## Federation, and what there is instead

There is none. No ActivityPub, no relays, no server-to-server anything, not a
line of it. Two eulerchat servers are two separate places with two separate
maps, and nothing here will ever make them one.

That is not an oversight waiting on a library. The map is the product, and the
map is a function of one census: a room exists because the same people hold
both of its interests, and its ground is the number of them. Compose two
populations that never met and every zone is wrong — the overlaps are between
people who are not in the same place, so the picture would assert a room that
nobody is in. Federating this means federating the census, not shuttling
messages, and the honest list of what that needs is:

- **One census, or an agreed way to compose several.** Populations add; the
  regions they make do not, and `T ⊆ S` routing is only true of a population
  that is actually there to be routed to.
- **Identity that crosses.** A key is made in a browser and proved to one
  server (**Who somebody is**). There is no directory, nothing signs for anyone
  else, and a fingerprint from another place means nothing here.
- **Deletion that crosses.** The receipt chain is one server's own history, and
  a `forgotten` event is a request to whoever holds a copy, not a command.
  Nothing can compel a mirror elsewhere to forget, and a federation that cannot
  is a federation that quietly makes deletion a lie.
- **Moderation that crosses**, which is unsolved here for one server (**Known
  limits**) and worse across several.
- **Sealing that crosses.** The reader list for an encrypted message is
  assembled by the server (**Sealing, and what sealing is not**); two servers
  assembling it is two chances to add a key.

**What exists instead is one-way distribution**, and it is deliberate. Everything
said in the clear goes out on a firehose anybody can connect to without saying
who they are, and is gathered into public dumps of up to a megabyte for whoever
was not listening (**This place is public**). One writer, any number of readers,
no accounts, no negotiation. Mirror it, archive it, index it, draw something
else with it: the dumps are NDJSON, the deletion receipts verify anywhere with
`lib/receipt.js`, and the layout engine in `lib/` has no server in it. What no
reader can do is write back, which is exactly why there is nothing to agree on.

The place also distributes rather than hoards in the other direction: it keeps
messages for twelve hours, keeps no conversations on disk at all, and gets them
back after a restart from the browsers that chose to keep a copy, checked
against a hash it committed to at the time (**Surviving a restart**). The
durable thing here is the anchor, not the archive.

**Not to be confused with scaling out.** *What sharing state would take*, above,
is one place across several processes — same population, same census, shared
through Redis and Postgres. That is an engineering job with a known shape.
Federation is many places, and the question it has to answer first is what a
room even means when the people are not in the same room.

## Known limits

- **State is in memory.** Restarting empties the world: every membership, every
  room and every message. What survives is the anchor — a hash of each message,
  its room and its time, plus the deletion chain — and the conversations only
  come back from the browsers that chose to keep a copy, and only what they
  kept. See **Surviving a restart**.
- **Solving blocks the event loop.** Every layout runs on the main thread, so a
  burst of first paints stalls all other traffic. Fine at prototype
  concurrency, not at a thundering herd.
- **Abuse is bounded, not solved.** A subscription is capped at 32 because the
  census enumerates subsets up to arity three and is therefore cubic in what
  one person holds — uncapped, a single client holding 300 subjects built 4.5
  million regions and pushed *everyone's* view past a second. The catalogue is
  capped, and each connection gets a leaky bucket priced by how expensive each
  frame is. None of that is authentication.
- **No accounts, and thin moderation.** A key says somebody is the same
  somebody as before and nothing about who; see **Who somebody is**. Reports
  are collected and a moderator can read them, and that is all a moderator can
  do. Derived rooms have a real unsolved question behind them: neither parent
  circle's moderators obviously own the intersection, and rooms grow
  exponentially while moderators do not.
- **Coming back by id is only as good as the id is secret, and it is not.**
  Somebody with no key is resumed inside their minute of grace by an id that
  is printed on everything they posted. A key closes that for whoever has one;
  a browser that cannot make keys — any page not served over https or from
  localhost — is where it stays open.
- **Anyone can create a subject.** Whoever controls circle creation controls
  whether the map stays legible; this prototype does not control it at all.
- **Rendering is verified by rasteriser, not by browser.** `npm run render`
  draws the real components through a DOM shim and rasterises them, which is
  what caught the labels sitting on boundaries, the enclosed white holes, and
  the overlap that came out grey. It does not exercise CSS, layout, blend
  modes or any interaction — no browser has run this yet.
- **The atlas can leave a lake.** Growth stops when zones reach their quota, so
  a gap fully enclosed by territories can survive. Small ones are absorbed by
  whichever neighbours are still short of their share; a large one stays, and
  reads as a hole in the middle of the map.
- **Subject colours can collide.** Hues come from a hash of the name, which is
  stable across reloads but says nothing about what else is on screen, so a
  view can come up with three neighbouring blues.

### Open privacy defects

These are not decisions. They are places where the code gives away more than
the design says it does, found by reading it against this file, and they are
written here rather than quietly fixed in the prose. Each is a small change to
the server; none is architectural.

- **A portal's address reaches strangers over the socket.** The filters that
  keep portals off the open API were never added to the shared views a browser
  is sent, so the minimap, All interests, search, the popular list, the
  suggestions and the map itself carry a live portal address to anybody holding
  an interest one of the two people also holds. The address is the whole of a
  portal's protection. See **A portal**.
- **`readers` answers for any room, to anybody.** It takes a room key from the
  asker and hands back the key fingerprint and public key of everyone present,
  with no check that the asker is in the room and none that it is a member
  rather than a lurker. It exists so a sender can wrap message keys; it will
  also enumerate who is in a room you have merely guessed the name of.
- **`forget` names the message id to every connection**, rather than to the
  room's audience, and the firehose deliberately does the opposite.
- **A lurker is sent frames it has no business with**: the rail, and every key
  claimed while it is connected. The page ignores them; the server should not
  send them.
- **A busy room loses its oldest messages with no receipt.** The 500-per-room
  cap evicts silently, outside the sweep, so those messages leave no entry in
  the deletion record and no `forgotten` event, and stay in whatever public
  dump already carried them.
- **"Keep a copy of what I send" keeps more than that.** It keeps every message
  the browser can read while it is on, the plaintext of encrypted ones
  included, and offers them back to the server on reconnect. Either the label
  or the behaviour is wrong; the behaviour is what the restore path was built
  for, so it is probably the label.
- **The interface states two of sealing's four limits.** That a dishonest
  server can add a key, and that there is no forward secrecy, are in this file
  and nowhere a person using it would look. The help text also says only
  *people in the chat* can read an encrypted message, where the truth is the
  people connected with a key at that moment.
