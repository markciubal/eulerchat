/**
 * The open read side: rooms, logs, bulk scrape, deletion receipts, firehose,
 * and the firehose's dumps.
 *
 * This is a public API in the strong sense. Anyone can read any room's log
 * without identifying themselves, and everything said here in the clear is
 * available to anybody who asks for it. That is a deliberate decision about
 * what this place is, and it has one consequence that has to be carried
 * through the whole product rather than buried in a doc comment: the interface
 * must tell people, before they type, that what they are about to say is
 * public. A private-feeling chat window over a public API is a lie told by
 * omission, and this file is where the lie would start.
 *
 * Two things are not here, for reasons that are not policy:
 *
 *   - A sealed message is served as its envelope and nothing else. The server
 *     has no key and never did, so there is nothing to withhold and nothing to
 *     reveal. Encryption is the one privacy left under an open API, which is
 *     exactly why it stays.
 *   - Reports are not served. They name the person who complained, and
 *     publishing that gets people hurt in a way that publishing their
 *     conversation does not - a reporter identified to the room they reported
 *     is a reporter who will not report again. Those stay behind
 *     `isModerator`. If you want them open, it should be a separate decision
 *     taken on purpose rather than a side effect of this file.
 */

import { parse } from '../lib/regions.js';
import { clusterOf } from '../lib/cluster.js';
import { isPortalRoom } from '../lib/portal.js';
import { DUMP_BYTES, createDumps } from './dumps.js';

const MAX_LIMIT = 500;

/**
 * The most the firehose will hold for one reader who is not keeping up. Past
 * it they are let go rather than buffered for without end, and can pick up
 * what they missed from the dumps, which are the same size for the same
 * reason: nothing goes out from here more than a megabyte at a time.
 */
const MAX_BEHIND = DUMP_BYTES;

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Public means public, including from a browser on another origin. A
    // read-only API that cannot be read from a page is not much of one.
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(text);
};

/** What a message looks like to somebody who is not in the room. */
const publicMessage = (message, tally) => ({
  // Which form of commitment names it, so that a copy taken from here can
  // still be looked up in the deletion record; see `lib/receipt.js`.
  v: message.v,
  id: message.id,
  room: message.room,
  subjects: message.subjects,
  cluster: clusterOf(message.subjects?.[0] ?? '') ?? null,
  author: message.author,
  authorId: message.authorId,
  // Shown in the room beside the name, so it is no more private than the name.
  authorKey: message.authorKey ?? null,
  at: message.at,
  // Written by the server, not by a person; see `server/questions.js`. Said
  // here too, so a copy taken from the open API cannot pass for a person's.
  machine: Boolean(message.machine),
  sealed: Boolean(message.sealed),
  // Readable only to whoever holds a key, which the server does not.
  body: message.sealed ? null : message.body,
  envelope: message.sealed ? message.envelope : undefined,
  votes: tally ?? { up: 0, down: 0, score: 0 },
});

/**
 * Build the handler and the firehose.
 *
 * Returns `{ handleRequest, publish, forget, close }`. `publish` is what the
 * server calls for every event worth streaming; it is kept separate from the
 * world's own watcher so that what goes out publicly is an explicit decision
 * at the call site rather than whatever happens to be emitted internally.
 * `forget` is how the dumps hear that something is gone.
 *
 * `dumps` keeps what the firehose sends, a megabyte at a time, for anybody
 * who was not holding it open; see `dumps.js`. Off unless asked for, like the
 * rest of this: the server turns it on where it turns the API on. `demo`
 * says, in the index and in every dump, that none of it was said by anyone.
 */
export function createPublicApi(world, { mount = '', basePath = '/api', dumps: dumping = false, demo = false } = {}) {
  // A host that already has its own `/api` can move this out of the way.
  const listeners = new Set();
  let closed = false;

  const at = (path) => `${mount}${basePath}${path}`;

  /** Send one event to everybody holding the firehose open. */
  const broadcast = (event) => {
    if (!listeners.size) return;
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of listeners) {
      // Somebody reading slower than the place talks, and a megabyte behind:
      // let go, rather than hold an ever longer queue of it for them.
      if (res.writableLength > MAX_BEHIND) {
        listeners.delete(res);
        res.end();
        continue;
      }
      try {
        res.write(frame);
      } catch {
        listeners.delete(res);
      }
    }
  };

  const dumps = dumping
    ? createDumps({
        ...(typeof dumping === 'object' ? dumping : {}),
        demo,
        // Said on the firehose, so that a reader knows there is one to fetch.
        onDump: (dump) => broadcast({ type: 'dump', ...dump, url: at(`/dumps/${dump.id}`), at: Date.now() }),
      })
    : null;

  /** One event, to the firehose and into the dumps. */
  const publish = (event) => {
    if (closed) return;
    // A portal is the one room this side of the product does not carry. The
    // check is here rather than at the call site because this is the single
    // place everything public passes through, and a second call site would
    // eventually be added without one.
    if (isPortalRoom(event.room)) return;
    dumps?.add(event);
    broadcast(event);
  };

  /** These messages are gone: out of every dump, as they are out of the place. */
  const forget = (ids) => dumps?.forget(ids);

  const rooms = () => {
    const census = world.census();
    return [...census.entries()].filter(([key]) => !isPortalRoom(key)).map(([key, population]) => {
      const subjects = parse(key);
      const log = world.messages.get(key) ?? [];
      return {
        key,
        subjects,
        cluster: clusterOf(subjects[0] ?? '') ?? null,
        population,
        messages: log.length,
        last: log.at(-1)?.at ?? null,
      };
    });
  };

  const logFor = (key, since, limit) => {
    const log = world.messages.get(key) ?? [];
    const slice = log.filter((m) => m.at > since).slice(0, limit);
    return {
      room: key,
      subjects: parse(key),
      messages: slice.map((m) => publicMessage(m, world.tally(m.id))),
      // Where to carry on from, so a scraper does not have to guess.
      nextSince: slice.at(-1)?.at ?? since,
      more: slice.length === limit,
    };
  };

  function handleRequest(req, res) {
    if (res.headersSent || res.writableEnded) return false;

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    if (!path.startsWith(at(''))) return false;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
      }).end();
      return true;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'read only' });
      return true;
    }

    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const rest = path.slice(at('').length);

    // What is here, so that a scraper does not have to be told separately.
    if (rest === '' || rest === '/') {
      json(res, 200, {
        rooms: at('/rooms'),
        log: at('/rooms/{key}/log'),
        scrape: at('/scrape'),
        receipts: at('/receipts'),
        firehose: at('/firehose'),
        dumps: dumps ? at('/dumps') : null,
        ...(demo ? { demo: true } : {}),
        notes: {
          open: 'Everything readable here is public. Sealed messages are served as ciphertext.',
          sealed: 'A sealed message has body null and an envelope the server cannot open.',
          reports: 'Not served here. Reports name the person who made them.',
          dumps:
            'The firehose, a megabyte at a time: one JSON event per line. A dump loses a message '
            + 'when the place forgets it, and goes twelve hours after the last thing in it.',
          ...(demo ? { demo: 'A demo. Every word here was made up by the server.' } : {}),
        },
      });
      return true;
    }

    // The firehose, for anybody who was not holding it open.
    if (dumps && rest === '/dumps') {
      const { dumps: made, ...more } = dumps.list();
      json(res, 200, {
        ...more,
        dumps: made.map((d) => ({ ...d, url: at(`/dumps/${d.id}`) })),
        ...(demo ? { demo: true } : {}),
      });
      return true;
    }

    const dumpMatch = dumps && rest.match(/^\/dumps\/(\d+)$/);
    if (dumpMatch) {
      const body = dumps.body(dumpMatch[1]);
      if (body === null) {
        json(res, 404, { error: 'no such dump, or it has been forgotten' });
        return true;
      }
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'content-disposition': `inline; filename="eulerchat-dump-${dumpMatch[1]}${demo ? '-demo' : ''}.ndjson"`,
        'access-control-allow-origin': '*',
        // Not cacheable: it shrinks as what is in it is forgotten, and a
        // cached copy is a copy that did not.
        'cache-control': 'no-store',
      });
      res.end(body);
      return true;
    }

    if (rest === '/rooms') {
      json(res, 200, { rooms: rooms() });
      return true;
    }

    const logMatch = rest.match(/^\/rooms\/([^/]+)\/log$/);
    if (logMatch) {
      const key = decodeURIComponent(logMatch[1]);
      // The same answer a room that does not exist gets, and deliberately the
      // same one: a portal that denied itself in different words would be
      // confirming, to anybody who had guessed an address, that they had
      // guessed right.
      if (isPortalRoom(key) || (!world.messages.has(key) && !world.census().has(key))) {
        json(res, 404, { error: 'no such room' });
        return true;
      }
      json(res, 200, logFor(key, since, limit));
      return true;
    }

    // Everything, in one pass, oldest first and resumable.
    if (rest === '/scrape') {
      const all = [];
      for (const [key, log] of world.messages.entries()) {
        if (isPortalRoom(key)) continue;
        for (const message of log) if (message.at > since) all.push(message);
      }
      all.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      const page = all.slice(0, limit);
      json(res, 200, {
        messages: page.map((m) => publicMessage(m, world.tally(m.id))),
        nextSince: page.at(-1)?.at ?? since,
        more: all.length > page.length,
      });
      return true;
    }

    if (rest === '/receipts') {
      json(res, 200, {
        receipts: world.receipts({ since }),
        head: world.deletions.at(-1)?.hash ?? '',
        note:
          'Each entry is bound to the one before it, so the record cannot be edited after '
          + 'the fact without breaking. It does not show that no copy was kept elsewhere; '
          + 'nothing can.',
      });
      return true;
    }

    if (rest === '/firehose') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
        // Proxies that buffer turn a stream into a very slow batch.
        'x-accel-buffering': 'no',
      });
      res.write(`: open\n\n`);
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return true;
    }

    // Not one of ours. Silence rather than a 404, which is the same rule the
    // static handler follows and for the same reason: mounted on somebody
    // else's server, a path under this prefix may well be theirs. Answering it
    // writes a second set of headers over a reply they have already sent and
    // takes the process down. A server of our own has a catch-all of its own.
    return false;
  }

  return {
    handleRequest,
    publish,
    forget,
    publicMessage,
    get subscribers() {
      return listeners.size;
    },
    close() {
      closed = true;
      for (const res of listeners) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
      listeners.clear();
    },
  };
}
