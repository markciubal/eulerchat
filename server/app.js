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
import { World, seed } from './store.js';
import { populate } from './populate.js';
import { Sessions } from './sessions.js';
import { Notifications } from './notifications.js';
import { parse } from '../lib/regions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const libDir = path.join(here, '..', 'lib');
const projectRoot = path.join(here, '..');

export { World, seed, populate, Sessions, Notifications };

/**
 * @param {object} [options]
 * @param {World}  [options.world]   the world to serve; a seeded one by default
 * @param {http.Server} [options.server]  an existing server to attach to
 * @param {boolean} [options.serveClient=true]  also serve the bundled UI
 * @returns {{world: World, server: http.Server, wss: WebSocketServer, close: () => void}}
 */
export function createEulerChat(options = {}) {
  const { world = seed(new World()), serveClient = true } = options;
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
   *   createEulerChat({ isModerator: (userId, session) => session.staff === true })
   *
   * Defaulting to nobody means reports are collected and unreadable until
   * somebody decides who should read them, which is the right way round: the
   * failure is that moderation does not happen, not that it happens to the
   * wrong person.
   */
  const isModerator =
    typeof options.isModerator === 'function' ? options.isModerator : () => false;

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
    // tick is what makes the ordering mean anything. These are a handful of
    // small files and they are cached after the first read.
    let body = cache.get(file);
    if (body === undefined) {
      try {
        body = fs.readFileSync(file);
      } catch {
        body = null;
      }
      cache.set(file, body);
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

  wss.on('connection', (socket) => {
    const sessionId = crypto.randomUUID().slice(0, 8);
    let userId = world.addUser(`guest-${sessionId.slice(0, 4)}`);
    const session = sessions.open(sessionId, userId, socket);

    socket.alive = true;
    socket.on('pong', () => {
      socket.alive = true;
    });

    // An EventEmitter with no 'error' listener rethrows, so a single client with
    // a reset connection would take the process down and every other person in
    // every other room with it. `ws` requires this listener; without it the
    // server is one bad network away from stopping.
    socket.on('error', () => {
      // Nothing to do but let it close — 'close' always follows.
    });

    send(socket, {
      type: 'welcome',
      you: { id: userId, name: world.profiles.get(userId).name },
      maxArity: 3,
    });
    send(socket, { type: 'history', rooms: world.historyFor(userId) });
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
    const PRICE = { createSubject: 10, atlas: 8, overview: 6, post: 2, search: 1, join: 1, leave: 1, funnel: 2, keys: 3, readers: 2, record: 1, report: 4, concerns: 3, concern: 2, clear: 2 };

    socket.on('message', (raw) => {
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
            const pending = orphans.get(claimed);
            if (!pending) {
              // Grace expired or never theirs; they stay the guest they are.
              send(socket, { type: 'expired' });
              break;
            }
            clearTimeout(pending);
            orphans.delete(claimed);

            world.removeUser(userId); // discard the guest made a moment ago
            userId = claimed;
            sessions.reassign(sessionId, claimed);

            send(socket, { type: 'welcome', you: { ...world.profiles.get(userId) }, maxArity: 3 });
            send(socket, { type: 'history', rooms: world.historyFor(userId) });
            sendBacklog(socket, userId);
            pushDiagrams();
            break;
          }

          case 'identify': {
            const profile = world.profiles.get(userId);
            profile.name = String(msg.name ?? '').slice(0, 40) || profile.name;
            send(socket, { type: 'welcome', you: { ...profile }, maxArity: 3 });
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

          case 'keys': {
            // A public key, so others can seal to this person. The server
            // relays these and holds no private key of anybody's — but it does
            // decide whose keys go in the list, which is the limit of what
            // this protects against and is said plainly in the interface.
            session.publicKey = msg.publicKey ?? null;
            session.keyId = String(msg.keyId ?? '');
            for (const other of sessions) {
              if (other === session) continue;
              send(other.socket, { type: 'key', keyId: session.keyId, publicKey: session.publicKey });
              send(session.socket, { type: 'key', keyId: other.keyId, publicKey: other.publicKey });
            }
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
            send(socket, { type: 'atlas', ...world.atlasFor(userId, want) });
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
              subjects: world.searchSubjects(msg.query),
            });
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
            });
            // Only people with a connection open can be sent anything, so the
            // audience search is narrowed to them rather than to every member.
            const audience = world.audienceFor(message.subjects, sessions.present());
            for (const listener of sessions.reaching(audience)) {
              send(listener.socket, { type: 'message', message });
            }
            break;
          }

          default:
            send(socket, { type: 'error', message: `unknown frame: ${msg.type}` });
        }
      } catch (err) {
        send(socket, { type: 'error', message: err.message });
      }
    });

    socket.on('close', () => {
      sessions.close(sessionId);
      if (closed) return; // shutting down; nobody is coming back to reclaim it

      const leaving = userId;
      const timer = setTimeout(() => {
        orphans.delete(leaving);
        world.removeUser(leaving);
        pushDiagrams();
      }, GRACE_MS);
      // Somebody's minute of grace is not a reason to keep a process running.
      timer.unref?.();
      orphans.set(leaving, timer);
      pushDiagrams();
    });
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

    /** Serve the bundled client from wherever the host prefers. */
    handleRequest,
    server,
    wss,
    close() {
      closed = true;
      notifications.close();
      clearInterval(sweeper);
      clearInterval(heartbeat);
      for (const pending of orphans.values()) clearTimeout(pending);
      orphans.clear();
      wss.close();
      if (!options.server) server.close();
    },
  };
}
