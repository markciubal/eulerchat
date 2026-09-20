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

const send = (socket, payload) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
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
    if (session.socket.alive === false) {
      session.socket.terminate();
      continue;
    }
    session.socket.alive = false;
    session.socket.ping();
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

  send(socket, {
    type: 'welcome',
    you: { id: userId, name: world.profiles.get(userId).name },
    maxArity: 3,
  });
  send(socket, { type: 'history', rooms: world.historyFor(userId) });
  pushDiagrams();

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(socket, { type: 'error', message: 'malformed frame' });
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

server.listen(PORT, () => {
  const counts = world.census();
  console.log(
    `eulerchat listening on http://localhost:${PORT}\n` +
      `  ${world.subjects.size} interests · ${world.members.size} people · ` +
      `${counts.size.toLocaleString()} occupied regions`,
  );
});
