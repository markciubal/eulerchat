# Privacy in eulerchat

This is the plain statement of what this place keeps, what it hands out, and
what it cannot protect. The README says how each of these works and why; this
says what is true. Where the two disagree, the code is right and both are
wrong — please open an issue.

**The short version.** eulerchat is a public place with anonymous people in it.
What you get here is anonymity, not secrecy: nobody has to say who they are,
and everything said in the clear can be read by anybody, including people who
never opened the site. Locking a message keeps its words from the server and
from everyone but the people it was locked for; it hides nothing else. Nothing
here protects you from the people in the room, who were handed your words, or
from whoever runs the server.

## Who can see what

| | people in the room | anybody on the internet | the server's operator | kept on your device |
|---|---|---|---|---|
| what you say in the clear | yes | yes, through the open read API | yes | anyone's copy, if *Keep a copy* is on |
| what you say locked (*Encrypt*) | only those connected with a key at that moment | the envelope, never the words | the envelope — unless a reader reports it and pastes what they read | anyone's copy, if *Keep a copy* is on |
| the name you typed | yes | yes | yes | yes |
| your key's fingerprint, if you made one | yes, beside your name | yes, on every message you posted | yes | yes |
| which interests you hold | no — only head counts | no — only head counts | yes | yes |
| which rooms you have **spoken** in | yes | yes, joined up by your id or key | yes | yes |
| that somebody is lurking in a room | a count, never who | a count, never who | the connection, not a person | — |
| who is in a room right now, by key | yes | yes — anybody with a socket can ask, for any room ([defect](README.md#open-privacy-defects)) | yes | — |
| who is talking to whom, and when | yes | yes, for anything not locked | yes, including for locked messages | — |
| your IP address | no | no | whatever their host and proxy log | — |

Three things worth reading twice:

- **Pseudonymous is not anonymous.** Every message carries the author's id, and
  the fingerprint of their key if they have one. Anybody reading the open API
  can join up everything one id or key ever said, across every room. That is
  what a key is *for* — being the same person as yesterday — and it is the cost
  of it. **Settings → New key** throws it away, and whoever comes back is a
  stranger.
- **Holding an interest is quiet; saying something is not.** The server knows
  what you hold; nobody else is told. The moment you speak in a room, that room
  is on the public record beside your id.
- **Some of this is looser in the code than in the design.** Portal addresses
  reach strangers over the socket, anybody can ask who is present in a room by
  key, and a deletion names the message's id to every connection. They are
  listed as [open privacy defects](README.md#open-privacy-defects) rather than
  described as features, and they are true today.

## What the server keeps, and for how long

In memory, and nowhere else:

| | |
|---|---|
| messages | twelve hours, on a sweep every ten minutes — and only the last 500 in any one room, after which the oldest fall off silently |
| who holds what, and who is online | while they are connected; the world is not written down |
| votes | as long as the message they are about |
| reports | thirty days, readable only by a moderator — **with a copy of the reported words**, which outlives the message and its deletion |
| how many are lurking in a room | while those connections are open |

On disk there is one file, the ledger, and it is not the conversations. Each
line is a hash of a message, the room it was in, when, and its number in order
— never the words, never who wrote them. Deletions are written there too, as a
hash chain. It is append-only and you can read it in a text editor.
`--no-ledger` keeps nothing at all.

Two things follow from that file. Nothing prunes it, so it becomes a permanent
record of which rooms were spoken in and when, years after the words went; and
the room keys in it include group rooms and portal addresses, which are the two
kinds of room whose *name* is the private part.

Nothing in this code reads your IP address or user agent, and nothing it prints
to its log contains a message. The machine it runs on, and anything in front of
it, are a different matter and are not ours to promise about.

## What "delete" means here

- Everything goes after twelve hours on its own.
- You can delete your own message at any time, and it goes from the room, from
  the public dumps it was in, and from the open API.
- Every deletion is recorded as a hash of the message, chained to the deletion
  before it, and published. Anybody holding their own copy can recompute the
  hash and find it in the record; nobody else learns anything from it.
- **Nobody can prove a deletion.** A server that copied your words elsewhere,
  or whose disk was imaged, or whose operator simply remembers them, can
  publish a flawless receipt for a deletion that never happened. What the
  record does is make a server that lies about deleting *detectable*, and make
  quiet edits to its own history detectable. That is the most any log can do.
- **A report keeps what it reported.** If somebody reported your message, a
  copy of the words sits with the report for thirty days, and deleting the
  message does not remove it. A moderator can read it. For an encrypted message
  the server had nothing to copy, so what is kept is whatever the reporter
  chose to paste, marked as theirs.
- **The oldest messages in a busy room leave no trail.** Only the last 500 in a
  room are held, and the ones pushed out that way get no receipt and no public
  notice — unlike the twelve-hour sweep and the delete button, which get both.
- Whoever was in the room was handed your words. Nothing here can take them
  back.

## What encryption does, and what it does not

Tick **Encrypt** and the message is locked in your browser before it leaves.
Each message gets its own AES-GCM key, used once; that key is wrapped
separately for each reader through an ECDH agreement (P-256, HKDF) with their
public key. The server stores a ciphertext and a bag of wrapped keys it cannot
open, and serves exactly that on the open side.

It does not:

- **Hide who is talking to whom, or when, or how often.** The server routes, so
  the server knows. Locked or not, the room, the time, the author and the size
  are all visible.
- **Authenticate anybody.** The server assembles the list of readers a message
  is locked for. A dishonest one can put a key of its own on that list and be
  handed a wrapped key like anyone else. This protects a conversation from a
  server that stores now and leaks later, not from one that is against you
  today. Comparing fingerprints by some route the server does not control would
  close that gap, and is not built.
- **Reach anybody who was not there.** A message is locked for the people
  connected with a key at the moment it was sent. Somebody who joins the room a
  minute later cannot read it, and never will.
- **Hide who it was for.** The envelope carries the sender's public key, and
  the wrapped keys are filed under each reader's fingerprint. Anybody reading
  the open API can see who sent a locked message and which keys could open it,
  even though nobody but those keys can read a word of it.
- **Survive your key.** The per-message key is thrown away, but it is wrapped
  by an agreement between two long-lived keys, so whoever obtains one of those
  can open every envelope they kept that was wrapped for it. There is no
  forward secrecy here; do not assume any.
- **Stop the people in the room.** They can read it — that is the point of
  sending it — and they can keep it.

If a message cannot be locked (no reader list, keys not made, the server
unreachable) it is **not sent**. A request to encrypt that cannot be honoured
fails rather than quietly doing the opposite.

## Groups and portals

- **A group** (`kite-fox-9/art`) is a door with a name, not a lock. Anyone with
  the name can walk in, and anyone you tell can tell somebody else. Worse: the
  name is part of the room key, so the open API publishes it the moment
  somebody joins, along with everything said inside. Right for the six people
  at your table; wrong for anything that matters if a stranger reads it.
- **A portal** is a two-person room whose address is derived from a secret the
  two of you already share, so it is never transmitted and it changes daily.
  Portals are kept off the open API, the firehose and the dumps, and asking for
  one by name gets the same answer as a room that does not exist. It hides the
  address, not the fact that two people are talking; and anybody who learns
  today's address can walk in, because the routing has no idea portals exist.

## Lurking

A quick-join code opens one conversation to read along in. A lurker joins
nothing, is not in the head count, is not on the list an encrypted message is
locked for, and is never named — a room is told how many are lurking, and that
is all. Nothing is written to that device: no key, no name, no saved copies, no
group.

The server is less careful than the page: it greets every connection before it
knows what it is, so a lurker is also sent the list of popular interests and
every key claimed while it is connected. The page shows none of it. It is a
[defect](README.md#open-privacy-defects), not a feature.

## What your browser keeps

In this browser: your key (in IndexedDB, non-extractable — script can use it
and cannot read it out), the name you typed, your theme and colours, the map's
layout and whether heights are on, which chats you pinned, which people you
muted and whether to offer that, the group you are in, whether the server's own
messages are muted, and the hashes of messages you deleted. None of that is
sent anywhere. Clearing site data loses all of it, your key included, and there
is no account behind it to ask.

**Keep a copy** is the exception, in two ways. It is labelled *Keep a copy of
what I send*, and it keeps every message this browser can read while it is on —
other people's included, and the plaintext of encrypted ones after they are
opened, in ordinary `localStorage` where any script on the page could read it.
And it is offered back: on reconnecting, the browser hands what it kept to the
server, which is how a room comes back after a restart (**Surviving a
restart**). Turn it on if you want that; know that it is a plaintext archive of
everything you could read, on your disk.

## If you deploy this

- **The bundled server publishes everything.** `npx eulerchat`, `npm start` and
  the `Procfile` all pass `publicApi: true`: the read API, the firehose, the
  dumps and the `/streams` page are on. That is the decision this project made
  about what it is, and the interface says so above every message box. If you
  fork it and close the API, change that line too.
- **As a library, the default is the opposite.** `createEulerChat({ world })`
  publishes nothing until you ask for it, because whoever installed it did not
  make that decision.
- **Tell people before they type.** A private-feeling chat window in front of a
  public endpoint is a lie told by omission.
- **The demo is never a deployment.** `npm run demo` fills the place with
  made-up people, writes nothing, labels every word a system message, and
  refuses to start anywhere that looks like production.
- **There is no federation, and two servers are two separate places.** See
  **Federation, and what there is instead** in the README.

## Where the details are

The README has the reasoning and the code: **This place is public**, **Who
somebody is**, **Sealing, and what sealing is not**, **Surviving a restart**,
**What deletion can and cannot show**, **Small groups, by name**, **Quick join,
to lurk**, **A portal**, **Federation, and what there is instead**, and
**Known limits**.
