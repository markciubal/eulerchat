/**
 * The chat server as something you can mount, rather than something that
 * starts when you import it.
 *
 * `server/index.js` used to create a World, seed it from argv, build an HTTP
 * server and bind a port, all at module load — which meant importing any of it
 * from another project seized a port as a side effect. Everything here takes
 * its world and its HTTP server as arguments and returns handles, so it can be
 * attached to an app that already exists.
 *
 *   import { createEulerChat, World, seed } from 'eulerchat/app';
 *
 *   const chat = createEulerChat({ world: seed(new World()), server: myServer });
 *   // ... later
 *   chat.close();
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { World, seed, stock } from './store.js';
import { populate } from './populate.js';
import { Sessions } from './sessions.js';
import { Notifications } from './notifications.js';
import { parse } from '../lib/regions.js';
import { fingerprint } from '../lib/seal.js';
import { challenge } from '../lib/proof.js';
import { createPublicApi } from './public-api.js';
import { startQuestions } from './questions.js';
import { ask } from '../lib/questions.js';
import { isGroupRoom, named } from '../lib/cluster.js';
import { isPortal } from '../lib/portal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const libDir = path.join(here, '..', 'lib');
const projectRoot = path.join(here, '..');

export { World, seed, stock, populate, Sessions, Notifications };

/**
 * @param {object} [options]
 * @param {World}  [options.world]   the world to serve; a seeded one by default
 * @param {http.Server} [options.server]  an existing server to attach to
 * @param {boolean} [options.serveClient=true]  also serve the bundled UI
 * @param {Iterable<string>} [options.moderators]  key fingerprints that may read reports
 * @param {(req: http.IncomingMessage) => object | null | Promise<object | null>} [options.authenticate]
 *   who the host says a connection is; anonymous when omitted
 * @param {boolean | {every?: number, quiet?: number}} [options.questions]
 *   now and then, have the sample people ask an on-topic question in a quiet
 *   room, labelled as a system message; off unless asked for. See
 *   `server/questions.js`.
 * @returns {{world: World, server: http.Server, wss: WebSocketServer, close: () => void}}
 */
export function createEulerChat(options = {}) {
  // The catalogue alone unless a world is given: a host that forgets to pass
  // one is putting this somewhere real, and made-up people there would be
  // passed off as real ones.
  const { world = stock(new World()), serveClient = true } = options;
  const server = options.server ?? http.createServer();
  const ours = options.server === undefined;
  // Where this lives on the host's server. '' means the root.
  const mount = String(options.mount ?? '').replace(/\/+$/, '');
  // Connections live here rather than on the world; see server/sessions.js.
  const sessions = options.sessions ?? new Sessions();
  const notifications = options.notifications ?? new Notifications(world);

  /**
   * Who may look at reports. Nobody, unless the host says otherwise.
   *
   * Deliberately a question handed back rather than answered here. This
   * package has no idea who your administrators are — it makes an anonymous
   * user per connection — and a library that invented its own notion of an
   * admin would either be ignored by anyone with real accounts or, worse,
   * trusted by someone who assumed it meant something. The host knows; it can
   * say.
   *
   *   createEulerChat({ isModerator: (userId, session) => session.account?.staff === true })
   *
   * `session.account` is whatever the host's own `authenticate` said about the
   * connection, below. A place with no accounts names its moderators by key
   * instead:
   *
   *   createEulerChat({ moderators: ['3fA9xQ2kZk81mmQp'] })
   *
   * which is the full fingerprint the interface shows each person for their
   * own key. It counts only once the connection has SHOWN that it holds the
   * key. Claiming one is free - every key in the place is sent to everybody,
   * so a moderator's is known to anyone who has been in a room with them - and
   * what sits behind this check is the list of who reported whom.
   *
   * Defaulting to nobody means reports are collected and unreadable until
   * somebody decides who should read them, which is the right way round: the
   * failure is that moderation does not happen, not that it happens to the
   * wrong person.
   */
  const moderators = new Set([...(options.moderators ?? [])].map(String));
  const isModerator =
    typeof options.isModerator === 'function'
      ? options.isModerator
      : (userId, session) => session.proven === true && moderators.has(session.keyId);

  /**
   * Who the host says a connection is. Nobody, unless it has a way of knowing.
   *
   * Everybody here is anonymous by default, and that is a decision rather than
   * an omission: a connection is a guest, and the most it can become on its
   * own is a key. A host that already has accounts knows more than that, and
   * this is where it says so - it is handed the upgrade request, with its
   * cookies and headers, and whatever object it returns rides along as
   * `session.account`:
   *
   *   authenticate: async (req) => myAuth.userFor(req.headers.cookie),
   *   // -> { id: 'u_81', name: 'wren', staff: true }, or null for a visitor
   *
   * `name`, if there is one, is what they are called to begin with. `id`, if
   * there is one, makes every connection from that account the same person:
   * two tabs are one member of a room, with one vote. Null or undefined is a
   * guest like any other. Throwing, or a rejected promise, refuses the
   * connection - an answer that could not be obtained is not a yes.
   */
  const authenticate = typeof options.authenticate === 'function' ? options.authenticate : null;

  /**
   * The open read API and the firehose.
   *
   * Mounted before the client is served, because it answers a path of its own
   * and a static handler that got there first would try to find a file called
   * `api`. Everything it serves is public by design; see `public-api.js` for
   * what that decision costs and what it deliberately leaves out.
   */
  const api = createPublicApi(world, { mount, basePath: options.apiPath ?? '/api' });

  // Off unless asked for, and that default is the important part.
  //
  // This serves every conversation to anybody who asks, which is the right
  // thing for a place that has decided it is public and a disaster for
  // somebody who mounted a chat library into their application and never read
  // this far. The person who installed this did not make that decision, and
  // would find out about it when somebody scraped them. So it is opt-in, and
  // the bundled server opts in explicitly.
  //
  // `chat.api.handleRequest` is still there either way, for anybody who wants
  // to place it behind their own middleware.
  if (options.publicApi === true) server.prependListener('request', api.handleRequest);

  // Everything said, as it is said. Fed from the world's own watcher so that
  // nothing can reach a room without also reaching the stream - two separate
  // call sites would eventually disagree about which events exist.
  world.watch((event) => {
    if (event.type === 'message') {
      api.publish({ type: 'message', ...api.publicMessage(event.message, world.tally(event.message.id)) });
    } else if (event.type === 'room-opened' || event.type === 'room-closed') {
      api.publish({ type: event.type, room: event.room, at: Date.now() });
    }
  });

  // A notification only counts as delivered if it reached a live connection;
  // otherwise it is kept for whenever they come back.
  notifications.onNotify((userId, note) => {
    const open = sessions.forUser(userId);
    for (const s of open) send(s.socket, { type: 'notification', notification: note });
    return open.length > 0;
  });

  // --- static ---------------------------------------------------------------

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
  };


  /**
   * Serve the bundled client — and nothing else.
   *
   * Attached to a server the host already owns, this used to answer every
   * request that reached it, so a host route that had already replied got a
   * second set of headers written over it and the process died of
   * ERR_HTTP_HEADERS_SENT. A mounted library gets to answer for its own paths
   * and must stay silent on everything else, so that the host's other
   * listeners see the request untouched.
   */
  const cache = new Map();

  const handleRequest = (req, res) => {
    if (res.headersSent || res.writableEnded) return;

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (mount && !url.pathname.startsWith(`${mount}/`) && url.pathname !== mount) return;
    const rel = url.pathname.slice(mount.length) || '/';

    let file;
    if (rel === '/') file = path.join(publicDir, 'index.html');
    else if (rel.startsWith('/public/') || rel.startsWith('/lib/')) {
      file = path.join(projectRoot, rel.slice(1));
    } else {
      return; // not ours to answer
    }

    // Client modules are served at the same relative depth they sit at on
    // disk, so `../lib/regions.js` resolves the same way in the browser as it
    // does in Node — the browser then runs the very same region algebra as the
    // server, rather than a second copy of it that can drift.
    if (!file.startsWith(publicDir) && !file.startsWith(libDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    // Synchronously, and deliberately. Reading asynchronously meant this
    // returned without answering and without having answered — so any listener
    // after it, including a host's catch-all 404, replied first and the file
    // arrived to a response already sent. Deciding and answering in the same
    // tick is what makes the ordering mean anything.
    //
    // Cached, and checked against the disk on every request. Cached forever,
    // a file edited under a running server was never served again until it
    // restarted — a stylesheet changed and the page kept the old one, which
    // looks exactly like the change not working. A stat is one system call;
    // the read only happens when the file has actually moved.
    let body = null;
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      /* not there: a 404 below */
    }
    if (stat?.isFile()) {
      const known = cache.get(file);
      if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
        body = known.body;
      } else {
        try {
          body = fs.readFileSync(file);
          cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, body });
        } catch {
          cache.delete(file);
        }
      }
    }

    if (body === null) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  };

  // Prepended, not appended. A host that ends its own routing with a catch-all
  // 404 — which most do — would otherwise answer for these paths before this
  // listener ever ran, and appending leaves no way for it to know that
  // something later wants the request. Getting first refusal is safe precisely
  // because this stays silent on anything that is not its own; a host wanting
  // to wrap it in middleware of its own can pass `serveClient: false` and call
  // `handleRequest` wherever it likes.
  if (serveClient) server.prependListener('request', handleRequest);
  // Only a server of our own gets a catch-all; on somebody else's, an
  // unmatched path is their business.
  if (ours) {
    server.on('request', (req, res) => {
      if (!res.headersSent && !res.writableEnded) res.writeHead(404).end('not found');
    });
  }

  // --- live -----------------------------------------------------------------

  // Only upgrades at our own mount point, so a host with its own socket
  // server on the same port keeps it.
  const wss = new WebSocketServer({ server, path: mount || '/' });

  // Same reasoning as the per-socket handler: an unheard 'error' on either of
  // these is an uncaught exception, and an uncaught exception is every room in
  // the place going down at once.
  wss.on('error', (err) => {
  // A listen failure belongs to whoever owns the port, not to the socket
  // layer; reporting it here too just prints it twice.
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') return;
  console.error('websocket server:', err.message);
});
  server.on('clientError', (err, socket) => {
    socket.destroy();
    void err;
  });

  /**
   * Ask the host whether this person may see reports.
   *
   * Wrapped, because it is somebody else's function: one that throws should
   * deny the request and leave the server standing, not take the process down
   * with it. Denial is the safe direction for a predicate whose answer could
   * not be obtained.
   */
  const allowedToModerate = (userId, session) => {
    try {
      return isModerator(userId, session) === true;
    } catch (err) {
      console.error('eulerchat: isModerator threw, treating as no —', err.message);
      return false;
    }
  };

  const send = (socket, payload) => {
    // The readyState check loses a race with a socket closing underneath us, and
    // the failure mode of losing it is an error event rather than a return code.
    try {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    } catch {
      /* they are gone; their close handler will clear them out */
    }
  };

  /**
   * A membership change can reshape anybody's map, because every map is derived
   * from the whole population — but in a world of any size it almost never does.
   * So each session is asked the cheap question first (would this change what
   * you see?) and only the ones that answer yes pay for a solve.
   */
  const pushDiagrams = () => {
    for (const session of sessions) {
      const signature = world.viewSignature(session.userId);
      if (signature === session.lastView) continue;
      session.lastView = signature;
      send(session.socket, { type: 'state', ...world.stateFor(session.userId) });
    }
  };

  /**
   * The server forgets on a schedule rather than on request, so that
   * forgetting does not depend on anybody remembering to ask for it.
   *
   * Unreferenced: a pending sweep is not work worth keeping a process alive
   * for. While the server is listening the loop stays awake anyway, and once
   * it is not, this should not be the thing holding the door open.
   */
  const SWEEP_MS = 10 * 60 * 1000;
  const sweeper = setInterval(() => {
    const dropped = world.forgetOld();
    if (dropped) {
      console.log(`eulerchat: forgot ${dropped} message${dropped === 1 ? '' : 's'} past their twelve hours`);
    }
  }, SWEEP_MS);
  sweeper.unref?.();
  wss.on('close', () => clearInterval(sweeper));

  /** Hand a new message to everybody connected who can read its room. */
  const deliver = (message) => {
    // Only people with a connection open can be sent anything, so the
    // audience search is narrowed to them rather than to every member.
    const audience = world.audienceFor(message.subjects, sessions.present());
    const reached = new Set(sessions.reaching(audience));
    for (const listener of reached) send(listener.socket, { type: 'message', message });
    // And whoever is watching this one room without being in it: a lurker, come
    // in by a quick-join code. Only that room — not the rooms inside it, which
    // a member would also hear — because a lurker is watching a conversation,
    // not holding its subjects.
    if (!lurkers.has(message.room)) return;
    for (const session of sessions) {
      if (session.watching === message.room && !reached.has(session)) {
        send(session.socket, { type: 'message', message });
      }
    }
  };

  /**
   * How many lurkers are watching each room: a number, and never who.
   *
   * Kept here, with the connections, and not in the world: watching is a
   * connection's business and ends with it, and the world's census is of
   * members. The people in a room are told how many are watching it, since
   * somebody talking deserves to know how big the audience is — but nothing
   * about any one of them, so a lurker is seen as one of a number and not as
   * anybody.
   */
  const lurkers = new Map();

  /** Tell everybody who can read a room, and whoever is watching it, how many are. */
  const tellLurkers = (room) => {
    const count = lurkers.get(room) ?? 0;
    const told = new Set(sessions.reaching(world.audienceFor(parse(room), sessions.present())));
    for (const session of sessions) if (session.watching === room) told.add(session);
    for (const listener of told) send(listener.socket, { type: 'lurkers', room, count });
  };

  /** Start or stop one connection watching a room, keeping the count. */
  const watchRoom = (session, room) => {
    const was = session.watching ?? null;
    if (was === room) return;
    if (was) {
      const left = (lurkers.get(was) ?? 1) - 1;
      if (left > 0) lurkers.set(was, left);
      else lurkers.delete(was);
    }
    session.watching = room;
    if (room) lurkers.set(room, (lurkers.get(room) ?? 0) + 1);
    if (was) tellLurkers(was);
    if (room) tellLurkers(room);
  };

  // Questions written by the server, labelled as such, if the host asked for
  // them: a sample world that says something now and then. Off by default,
  // and inert in a world with no sample people in it. See `server/questions.js`.
  const asking = options.questions
    ? startQuestions({
        world,
        present: () => sessions.present(),
        deliver,
        ...(typeof options.questions === 'object' ? options.questions : {}),
      })
    : null;
  wss.on('close', () => asking?.stop());

  /**
   * Platform routers close a connection that carries no data for a while —
   * Heroku's cuts off at 55 seconds — and a quiet room carries none. Without
   * this, someone reading rather than typing is disconnected on a timer.
   */
  const HEARTBEAT_MS = 25_000;
  const heartbeat = setInterval(() => {
    for (const session of sessions) {
      // A socket can be closing while its close event is still queued, and
      // pinging one then makes `ws` emit an error rather than return quietly.
      // One unhealthy connection must not be able to stop the heartbeat for
      // every other connection, so each is attempted on its own.
      try {
        if (session.socket.readyState !== session.socket.OPEN) continue;
        if (session.socket.alive === false) {
          session.socket.terminate();
          continue;
        }
        session.socket.alive = false;
        session.socket.ping();
      } catch {
        /* it is on its way out; the close handler will tidy up */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  /**
   * A dropped connection should not cost someone every interest they joined, so
   * their membership outlives the socket for a short while and a reconnect can
   * reclaim it. They stay in the census meanwhile, which is right: they have not
   * left the rooms, their connection blinked.
   */
  const GRACE_MS = 60_000;
  const orphans = new Map();
  // Closing clears the grace timers, but sockets close asynchronously, so one
  // going down as the server comes down would otherwise arm a fresh minute
  // after the clearing had already happened — and a host that called close()
  // would sit there waiting on it.
  let closed = false;

  /** Whatever happened while they were away, on the way in. */
  const sendBacklog = (socket, userId) => {
    const held = notifications.drain(userId);
    if (held.length) send(socket, { type: 'missed', notifications: held });
    send(socket, { type: 'unread', counts: notifications.counts(userId) });
  };

  /**
   * Which person a claim belongs to, for as long as that person is here.
   *
   * A claim is the one thing about a connection that outlasts it: a key it has
   * shown it holds, or an account the host vouched for. Two connections making
   * the same claim are the same person - one member of a room, one vote - and
   * somebody coming back within their minute of grace is recognised by what
   * they can show rather than by an id they happen to remember.
   */
  const bound = new Map();
  const claimsOf = new Map();

  const holderOf = (claim) => {
    const userId = bound.get(claim);
    return userId && world.profiles.has(userId) ? userId : null;
  };
  const bind = (claim, userId) => {
    bound.set(claim, userId);
    let claims = claimsOf.get(userId);
    if (!claims) claimsOf.set(userId, (claims = new Set()));
    claims.add(claim);
  };
  /** Somebody has gone for good, and what they claimed goes with them. */
  const retire = (userId) => {
    for (const claim of claimsOf.get(userId) ?? []) bound.delete(claim);
    claimsOf.delete(userId);
    world.removeUser(userId);
  };
  /** They were on their way out, and have come back in time. */
  const reclaim = (userId) => {
    const pending = orphans.get(userId);
    if (pending === undefined) return;
    clearTimeout(pending);
    orphans.delete(userId);
  };

  /**
   * One connection, from the moment it is known who - if anybody - the host
   * says it is. Returns what hears its frames.
   */
  const begin = (socket, account) => {
    const sessionId = crypto.randomUUID().slice(0, 8);
    const vouched = account?.id != null ? `account:${account.id}` : null;

    let userId =
      (vouched && holderOf(vouched)) ||
      world.addUser(account?.name ?? `guest-${sessionId.slice(0, 4)}`);
    if (vouched) bind(vouched, userId);
    reclaim(userId);

    const session = sessions.open(sessionId, userId, socket);
    session.account = account;
    // The key this connection has claimed, and whether it has shown it holds
    // it. Everything that gives a key any standing reads `proven`, not `keyId`.
    session.keyId = '';
    session.publicKey = null;
    session.proven = false;

    socket.alive = true;
    socket.on('pong', () => {
      socket.alive = true;
    });

    /** Them, as they are told about themselves: the profile, and their key if shown. */
    const you = () => ({
      ...world.profiles.get(userId),
      keyId: session.proven ? session.keyId : undefined,
    });

    /** Everything a connection needs on finding out who it is. */
    const greet = () => {
      send(socket, { type: 'welcome', you: you(), maxArity: 3 });
      send(socket, { type: 'history', rooms: world.historyFor(userId) });
    };

    /**
     * Stop being the guest made on arrival, and be somebody already here.
     *
     * Whatever the guest had joined in the meantime is carried over rather
     * than lost: showing a key takes a round trip, and a join that arrives
     * inside it was meant by the person, not by the placeholder.
     */
    const become = (existing) => {
      const guest = userId;
      if (existing === guest) return;
      reclaim(existing);

      for (const subject of world.subscription(guest)) {
        try {
          world.join(existing, subject);
        } catch {
          /* already holding as much as one person may; theirs stands */
        }
      }

      userId = existing;
      sessions.reassign(sessionId, existing);
      if (!sessions.forUser(guest).length) retire(guest);

      greet();
      sendBacklog(socket, userId);
      pushDiagrams();
    };

    /**
     * Somebody says a key is theirs. Name it, remember it, and ask them to
     * show it; see `lib/proof.js` for why saying so is not enough.
     *
     * The fingerprint is computed here and whatever the client called it is
     * ignored: a name that is supposed to follow from a key should not be
     * taken from the person presenting the key.
     */
    const claimKey = async (offered) => {
      try {
        const publicKey = { kty: 'EC', crv: 'P-256', x: String(offered?.x ?? ''), y: String(offered?.y ?? '') };
        const keyId = await fingerprint(publicKey);
        const asked = await challenge(publicKey); // throws for a point not on the curve
        if (session.proven) return; // two claims raced, and the other one won

        session.publicKey = publicKey;
        session.keyId = keyId;
        session.challenge = asked;

        for (const other of sessions) {
          if (other === session) continue;
          send(other.socket, { type: 'key', keyId: session.keyId, publicKey: session.publicKey });
          send(session.socket, { type: 'key', keyId: other.keyId, publicKey: other.publicKey });
        }
        send(socket, { type: 'challenge', keyId, offer: asked.offer });
      } catch {
        send(socket, { type: 'error', message: 'that is not a key this place can use' });
      }
    };

    const showKey = async (mac) => {
      const asked = session.challenge;
      session.challenge = null;
      if (!asked || !(await asked.check(mac))) {
        return send(socket, { type: 'error', message: 'that did not show the key is yours' });
      }
      if (socket.readyState !== socket.OPEN) return;
      session.proven = true;

      // An account already says who this is; the key is then only something
      // to write beside the name. Otherwise the key is the whole of who they
      // are, and whoever else is here holding it is the same person.
      const held = `key:${session.keyId}`;
      const existing = vouched ? null : holderOf(held);
      if (existing && existing !== userId) {
        send(socket, { type: 'proven', keyId: session.keyId });
        become(existing);
        return;
      }
      if (!vouched) bind(held, userId);
      send(socket, { type: 'proven', keyId: session.keyId });
      send(socket, { type: 'welcome', you: you(), maxArity: 3 });
    };

    greet();
    pushDiagrams();

    /**
     * A leaky bucket per connection.
     *
     * Every frame here is cheap on its own and ruinous in a loop: twenty
     * thousand subjects can be created in sixteen milliseconds, and an atlas is
     * a couple of hundred milliseconds of solving on the only thread there is.
     * Costs are charged roughly in proportion to what the work actually takes.
     */
    const bucket = { tokens: 60, at: Date.now() };
    const afford = (cost) => {
      const elapsed = (Date.now() - bucket.at) / 1000;
      bucket.at = Date.now();
      bucket.tokens = Math.min(60, bucket.tokens + elapsed * 12);
      if (bucket.tokens < cost) return false;
      bucket.tokens -= cost;
      return true;
    };
    const PRICE = { createSubject: 10, atlas: 8, overview: 6, post: 2, search: 1, browse: 1, join: 1, leave: 1, funnel: 2, keys: 3, proof: 3, readers: 2, record: 1, report: 4, concerns: 3, concern: 2, clear: 2, vote: 1, forget: 2, receipts: 4, restore: 6, watch: 2, unwatch: 1, chart: 6, poke: 3 };

    const hear = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(socket, { type: 'error', message: 'malformed frame' });
      }

      if (!afford(PRICE[msg?.type] ?? 1)) {
        return send(socket, { type: 'error', message: 'slow down a moment' });
      }

      try {
        switch (msg.type) {
          case 'resume': {
            const claimed = String(msg.userId ?? '');
            // Grace expired or never theirs; they stay the guest they are. And
            // the same answer for somebody who was more than an id: an id is
            // printed on every message they posted, so knowing it shows
            // nothing, and a person with a key or an account is taken back by
            // showing the key or being vouched for again - never by this.
            if (!orphans.has(claimed) || claimsOf.has(claimed)) {
              send(socket, { type: 'expired' });
              break;
            }
            become(claimed);
            break;
          }

          case 'identify': {
            world.rename(userId, msg.name);
            send(socket, { type: 'welcome', you: you(), maxArity: 3 });
            break;
          }

          case 'join': {
            world.join(userId, String(msg.subject));
            send(socket, { type: 'history', rooms: world.historyFor(userId) });
            pushDiagrams();
            break;
          }

          case 'leave': {
            world.leave(userId, String(msg.subject));
            pushDiagrams();
            break;
          }

          case 'watch': {
            // Watching one room without being in it: a lurker, come in by a
            // quick-join code; see `lib/lurk.js`. Nothing joins, nothing is
            // counted, and the connection is only remembered as watching for
            // as long as it is open.
            const view = world.look(msg.room);
            if (!view) {
              send(socket, { type: 'error', message: 'there is no conversation to watch there' });
              break;
            }
            watchRoom(session, view.room);
            send(socket, { type: 'watching', ...view, lurkers: lurkers.get(view.room) ?? 0 });
            break;
          }

          case 'unwatch': {
            watchRoom(session, null);
            break;
          }

          case 'keys': {
            // A public key, so others can seal to this person. The server
            // relays these and holds no private key of anybody's — but it does
            // decide whose keys go in the list, which is the limit of what
            // this protects against and is said plainly in the interface.
            //
            // One key to a connection, once shown. Somebody who wants to be a
            // different key wants to be a different person, and that is a new
            // connection rather than a second claim on this one.
            if (session.proven) {
              send(socket, { type: 'error', message: 'this connection already has a key' });
              break;
            }
            void claimKey(msg.publicKey);
            break;
          }

          case 'proof': {
            void showKey(msg.mac);
            break;
          }

          case 'restore': {
            // Copies somebody kept, offered back after a restart. Every one is
            // checked against the ledger; nothing is taken on trust. See
            // `World.restore`, which is where the checking lives.
            const offered = Array.isArray(msg.messages) ? msg.messages.slice(0, 500) : [];
            const result = world.restore(offered);
            if (result.restored) {
              // Everyone gets the rooms back, not just whoever happened to
              // still have them.
              for (const listener of sessions) {
                send(listener.socket, { type: 'history', rooms: world.historyFor(listener.userId) });
              }
              console.log(
                `eulerchat: ${result.restored} message${result.restored === 1 ? '' : 's'} restored from a client`,
              );
            }
            send(socket, { type: 'restored', ...result });
            break;
          }

          case 'vote': {
            const result = world.vote(userId, String(msg.messageId ?? ''), msg.value);
            // To everyone in the room: a tally nobody else sees is not a tally.
            for (const listener of sessions.reaching(
              world.audienceFor(parse(result.room), sessions.present()),
            )) {
              send(listener.socket, {
                type: 'votes',
                messageId: result.messageId,
                up: result.up,
                down: result.down,
                score: result.score,
              });
            }
            break;
          }

          case 'forget': {
            const receipt = world.forget(userId, String(msg.messageId ?? ''));
            for (const listener of sessions) {
              send(listener.socket, { type: 'forgotten', messageId: String(msg.messageId ?? '') });
            }
            send(socket, { type: 'receipt', receipt });
            break;
          }

          case 'receipts': {
            // The whole deletion record, so a browser can check it against the
            // copies it kept. Over the socket as well as the open read API,
            // because a host that leaves that API off still owes the people
            // in its rooms a way to see what was deleted. It carries hashes
            // only, which nobody can turn back into a message; only somebody
            // already holding a message can recognise it in here — and for an
            // encrypted one, only the people it was sent to.
            send(socket, {
              type: 'receipts',
              receipts: world.receipts(),
              head: world.deletions.at(-1)?.hash ?? '',
            });
            break;
          }

          case 'report': {
            // Confidential in both directions: the answer goes to the person
            // who sent it and to nobody else, and it says only that the report
            // was filed. Telling a room that one of its messages was reported
            // would identify the reporter by elimination in any room small
            // enough to matter.
            const outcome = world.report(
              userId,
              String(msg.messageId ?? ''),
              String(msg.reason ?? 'other'),
              { disclosed: msg.disclosed, note: msg.note },
            );
            send(socket, { type: 'reported', room: outcome.room, already: outcome.already });
            break;
          }

          case 'concerns': {
            // Answered rather than ignored. That moderation exists is in the
            // README; who is trusted with it is what matters, and saying no
            // reveals nothing about that — while silence would leave a host
            // whose own predicate is wrong with nothing at all to go on.
            if (!allowedToModerate(userId, session)) {
              send(socket, { type: 'error', message: 'not allowed' });
              break;
            }
            send(socket, { type: 'concerns', rooms: world.concerns() });
            break;
          }

          case 'concern': {
            if (!allowedToModerate(userId, session)) {
              send(socket, { type: 'error', message: 'not allowed' });
              break;
            }
            send(socket, { type: 'concern', detail: world.concern(String(msg.room ?? '')) });
            break;
          }

          case 'clear': {
            if (!allowedToModerate(userId, session)) {
              send(socket, { type: 'error', message: 'not allowed' });
              break;
            }
            const roomKey = String(msg.room ?? '');
            world.clear(roomKey, world.profiles.get(userId)?.name ?? 'moderator');
            send(socket, { type: 'concerns', rooms: world.concerns() });
            break;
          }

          case 'record': {
            world.setRecording(userId, msg.on);
            send(socket, { type: 'recording', on: world.recording(userId) });
            break;
          }

          case 'funnel': {
            // How far a join should carry from now on. Existing memberships
            // are left alone — widening is something you choose to do next,
            // not something that reaches back and changes what you already
            // joined.
            world.setFunnel(userId, msg.reach);
            pushDiagrams();
            break;
          }

          case 'overview': {
            // Every subject there is, at its place in the hierarchy. Sent once
            // and cached client-side; it only changes when a subject gains or
            // loses its first member.
            send(socket, { type: 'overview', ...world.overview() });
            break;
          }

          case 'poke': {
            // Poked: something from the databank — a question made from the
            // interests of the room they have open, see `lib/questions.js` —
            // said back to whoever poked and to nobody else. Nothing is
            // posted. What to do with it is theirs to decide; a room is not
            // prompted because one person in it pressed a button.
            //
            // Made from names alone, so it says nothing about the room that
            // the name they sent did not: not who is in it, not what has been
            // said. Never from a portal's name, which is not a name at all,
            // or from a group's own conversation, which is the group and not
            // an interest. Without a room, from something they hold; holding
            // nothing, from anything in the catalogue.
            const usable = (subjects) => subjects.filter((s) => !isPortal(s) && !isGroupRoom(s) && world.subjects.has(s));
            let about = usable(parse(String(msg.room ?? '')));
            if (!about.length) {
              const held = usable([...world.subscription(userId)]);
              const open = held.length ? held : usable([...world.subjects]).filter((s) => !s.includes('/'));
              about = open.length ? [open[Math.floor(Math.random() * open.length)]] : [];
            }
            send(socket, {
              type: 'poked',
              room: typeof msg.room === 'string' ? msg.room : null,
              about: named(about),
              text: about.length ? ask(named(about)) : 'The databank is empty: there is nothing here to ask about yet.',
              machine: true,
            });
            break;
          }

          case 'chart': {
            // The whole catalogue laid flat, for exploring; see `World.chart`.
            // Asked for when the explorer opens rather than pushed, since it is
            // a hundred-odd kilobytes that most visits never look at. Asked
            // again every ten seconds while it is open, by a page that already
            // has it: then only how lively each interest is, unless who holds
            // what has changed since.
            const chart = world.chart();
            if (msg.have && msg.have === chart.shape) {
              send(socket, {
                type: 'chart',
                only: 'activity',
                shape: chart.shape,
                activity: chart.subjects.filter((s) => s.a).map((s) => [s.id, s.a]),
              });
            } else {
              send(socket, { type: 'chart', ...chart });
            }
            break;
          }

          case 'readers': {
            // Who is present in a room, and their public keys, so a sender can
            // wrap a message key for each of them.
            const room = parse(String(msg.room ?? ''));
            const here = sessions
              .reaching(world.audienceFor(room, sessions.present()))
              .filter((s) => s.publicKey)
              .map((s) => ({ keyId: s.keyId, publicKey: s.publicKey }));
            send(socket, { type: 'readers', room: msg.room, readers: here });
            break;
          }

          case 'atlas': {
            const want = Math.min(14, Math.max(2, Number(msg.subjects) || 5));
            const view = world.atlasFor(userId, want);
            // How many are lurking in each room; see `lurkers`.
            for (const room of view.rooms) room.lurkers = lurkers.get(room.key) ?? 0;
            // Asked again every ten seconds by a page that has the drawing
            // already: then only the rooms, which are what have changed. A
            // drawing is a couple of hundred kilobytes; the rooms, a couple.
            if (msg.have && msg.have === view.shape) {
              send(socket, { type: 'atlas', only: 'rooms', shape: view.shape, subscription: view.subscription, rooms: view.rooms });
            } else {
              send(socket, { type: 'atlas', ...view });
            }
            break;
          }

          case 'notifications': {
            const settings = msg.settings
              ? notifications.configure(userId, msg.settings)
              : notifications.settings(userId);
            send(socket, { type: 'notifications', settings, counts: notifications.counts(userId) });
            break;
          }

          case 'seen': {
            // Reading a room is better than being told about it.
            notifications.looking(userId, msg.room ?? null);
            if (msg.clear) notifications.clear(userId, msg.room ?? undefined);
            send(socket, { type: 'unread', counts: notifications.counts(userId) });
            break;
          }

          case 'search': {
            send(socket, {
              type: 'results',
              query: String(msg.query ?? ''),
              // Inside a group, the group's copies; see `World.searchSubjects`.
              subjects: world.searchSubjects(msg.query, undefined, { group: world.groupOf(userId) }),
            });
            break;
          }

          case 'browse': {
            send(socket, { type: 'browse', ...world.browse(msg.at ?? null, { group: world.groupOf(userId) }) });
            break;
          }

          case 'createSubject': {
            const subject = world.addSubject(msg.name);
            world.join(userId, subject);
            pushDiagrams();
            break;
          }

          case 'post': {
            const message = world.post(userId, msg.tags ?? [], msg.body, {
              envelope: msg.envelope ?? null,
              replyTo: msg.replyTo ?? null,
              // Written beside their name, and only ever a key they have shown.
              authorKey: session.proven ? session.keyId : null,
            });
            deliver(message);
            break;
          }

          default:
            send(socket, { type: 'error', message: `unknown frame: ${msg.type}` });
        }
      } catch (err) {
        send(socket, { type: 'error', message: err.message });
      }
    };
    socket.on('message', hear);

    socket.on('close', () => {
      sessions.close(sessionId);
      if (closed) return; // shutting down; nobody is coming back to reclaim it
      // A lurker that goes is one fewer watching, and the room is told so.
      if (session.watching) watchRoom(session, null);

      const leaving = userId;
      // Another tab, or their phone: one of their connections has gone and
      // they have not. Starting the clock here would remove somebody from
      // every room a minute later, while they sat reading in the other window.
      if (sessions.forUser(leaving).length) return;

      const timer = setTimeout(() => {
        orphans.delete(leaving);
        retire(leaving);
        pushDiagrams();
      }, GRACE_MS);
      // Somebody's minute of grace is not a reason to keep a process running.
      timer.unref?.();
      orphans.set(leaving, timer);
      pushDiagrams();
    });

    return hear;
  };

  /**
   * How many frames are held for a connection the host has not answered for
   * yet. A client says a handful of things on arrival; one that says a great
   * many before it has been let in is not one to keep a list for.
   */
  const EARLY_MOST = 32;

  wss.on('connection', (socket, req) => {
    // An EventEmitter with no 'error' listener rethrows, so a single client with
    // a reset connection would take the process down and every other person in
    // every other room with it. `ws` requires this listener; without it the
    // server is one bad network away from stopping.
    socket.on('error', () => {
      // Nothing to do but let it close — 'close' always follows.
    });

    if (!authenticate) {
      begin(socket, null);
      return;
    }

    // The host may need to look somebody up, and frames do not wait for it:
    // a client says who it is the moment the socket opens. They are held and
    // replayed rather than dropped, because a dropped first frame is a client
    // that waits for ever for an answer to a question nobody heard.
    const early = [];
    const hold = (raw) => {
      if (early.length < EARLY_MOST) early.push(raw);
    };
    socket.on('message', hold);

    Promise.resolve()
      .then(() => authenticate(req))
      .then(
        (account) => {
          socket.off('message', hold);
          if (socket.readyState !== socket.OPEN) return;
          const hear = begin(socket, account && typeof account === 'object' ? account : null);
          for (const raw of early) hear(raw);
        },
        (err) => {
          // Somebody else's function, and the safe direction for an answer
          // that could not be obtained is no.
          console.error('eulerchat: authenticate threw, refusing the connection —', err?.message ?? err);
          socket.close(1008, 'not allowed');
        },
      );
  });

  return {
    world,
    sessions,
    notifications,
    /**
     * Reports, for a host that would rather read them from its own admin
     * pages than over a socket. No permission check here — reaching this means
     * you are already running the server, and a second opinion about whether
     * the process may read its own memory would be theatre.
     */
    moderation: {
      concerns: (options) => world.concerns(options),
      concern: (roomKey) => world.concern(roomKey),
      clear: (roomKey, by) => world.clear(roomKey, by),
      onReport: (listener) => world.onReport(listener),
      watchWords: (words) => world.watchWords(words),
    },

    /** The open read API: rooms, logs, scrape, receipts, firehose. */
    api,

    /** Serve the bundled client from wherever the host prefers. */
    handleRequest,
    server,
    wss,
    close() {
      closed = true;
      api.close();
      notifications.close();
      clearInterval(sweeper);
      clearInterval(heartbeat);
      asking?.stop();
      for (const pending of orphans.values()) clearTimeout(pending);
      orphans.clear();
      wss.close();
      if (!options.server) server.close();
    },
  };
}
