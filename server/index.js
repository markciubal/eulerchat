import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { World, seed } from './store.js';
import { populate } from './populate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const PORT = Number(process.env.PORT ?? 8787);

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? Number(process.argv[at + 1]) : fallback;
};

// `--interests 1000` builds a synthetic world at scale; with no flag you get
// the small hand-written one, which is the better thing to read the code by.
const interests = flag('interests', 0);
const world = new World();
if (interests > 0) populate(world, { subjects: interests, users: flag('people', 4000) });
else seed(world);

// --- static ---------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const libDir = path.join(here, '..', 'lib');
const projectRoot = path.join(here, '..');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Client modules are served at the same relative depth they sit at on disk,
  // so `../lib/regions.js` resolves the same way in the browser as it does in
  // Node. The browser then runs the very same region algebra as the server —
  // a second copy of the address format is a second copy that can drift.
  const file =
    url.pathname === '/'
      ? path.join(publicDir, 'index.html')
      : path.join(projectRoot, url.pathname.slice(1));

  if (!file.startsWith(publicDir) && !file.startsWith(libDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
});

// --- live -----------------------------------------------------------------

const wss = new WebSocketServer({ server });

// Same reasoning as the per-socket handler: an unheard 'error' on either of
// these is an uncaught exception, and an uncaught exception is every room in
// the place going down at once.
wss.on('error', (err) => console.error('websocket server:', err.message));
server.on('clientError', (err, socket) => {
  socket.destroy();
  void err;
});

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
  for (const session of world.sessions.values()) {
    const signature = world.viewSignature(session.userId);
    if (signature === session.lastView) continue;
    session.lastView = signature;
    send(session.socket, { type: 'diagram', ...world.diagramFor(session.userId) });
  }
};

/**
 * Platform routers close a connection that carries no data for a while —
 * Heroku's cuts off at 55 seconds — and a quiet room carries none. Without
 * this, someone reading rather than typing is disconnected on a timer.
 */
const HEARTBEAT_MS = 25_000;
const heartbeat = setInterval(() => {
  for (const session of world.sessions.values()) {
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
wss.on('close', () => clearInterval(heartbeat));

/**
 * A dropped connection should not cost someone every interest they joined, so
 * their membership outlives the socket for a short while and a reconnect can
 * reclaim it. They stay in the census meanwhile, which is right: they have not
 * left the rooms, their connection blinked.
 */
const GRACE_MS = 60_000;
const orphans = new Map();

wss.on('connection', (socket) => {
  const sessionId = crypto.randomUUID().slice(0, 8);
  let userId = world.addUser(`guest-${sessionId.slice(0, 4)}`);
  const session = { id: sessionId, userId, socket };
  world.sessions.set(sessionId, session);

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
  const PRICE = { createSubject: 10, atlas: 8, post: 2, search: 1, join: 1, leave: 1 };

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
          session.userId = claimed;
          session.lastView = null;

          send(socket, { type: 'welcome', you: { ...world.profiles.get(userId) }, maxArity: 3 });
          send(socket, { type: 'history', rooms: world.historyFor(userId) });
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

        case 'atlas': {
          const want = Math.min(14, Math.max(2, Number(msg.subjects) || 5));
          send(socket, { type: 'atlas', ...world.atlasFor(userId, want) });
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
          const message = world.post(userId, msg.tags ?? [], msg.body);
          for (const session of world.recipientsOf(message.subjects)) {
            send(session.socket, { type: 'message', message });
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
    world.sessions.delete(sessionId);

    const leaving = userId;
    orphans.set(
      leaving,
      setTimeout(() => {
        orphans.delete(leaving);
        world.removeUser(leaving);
        pushDiagrams();
      }, GRACE_MS),
    );
    pushDiagrams();
  });
});

/**
 * Say why, on the way down.
 *
 * A long-running server exited here with code 1 and left nothing behind — no
 * stack, no message, nothing to work from, so the cause is still unknown. An
 * uncaught exception inside a timer or an event handler dies outside every
 * try/catch in the file, and Node's default is to print to a stderr that may
 * already be gone. These do not make the server survive anything it should
 * not: it still exits. It exits having said what happened.
 */
for (const [event, label] of [
  ['uncaughtException', 'uncaught exception'],
  ['unhandledRejection', 'unhandled rejection'],
]) {
  process.on(event, (err) => {
    console.error(
      `eulerchat: ${label} — ${err?.stack ?? err}\n` +
        `  ${world.sessions.size} sessions, ${world.subjects.size} subjects, ` +
        `${world.members.size} members at the time`,
    );
    process.exit(1);
  });
}

server.listen(PORT, () => {
  const counts = world.census();
  console.log(
    `eulerchat listening on http://localhost:${PORT}\n` +
      `  ${world.subjects.size} interests · ${world.members.size} people · ` +
      `${counts.size.toLocaleString()} occupied regions`,
  );
});
