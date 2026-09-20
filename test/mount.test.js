import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEulerChat, World, seed } from '../server/app.js';

// Bound and addressed as 127.0.0.1 throughout. Listening on port 0 takes the
// v6 wildcard, and `localhost` then resolves to v4 first on some machines, so
// the request goes somewhere nothing is listening and simply hangs — which
// reads exactly like a server that has stopped answering.
const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * Wait for a frame rather than for the clock. A fixed sleep passes alone and
 * fails in a full run, where the handshake competes with everything else — and
 * a test that fails only when busy teaches people to re-run rather than look.
 */
const awaitFrame = (url, type, limitMs = 8000) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    const seen = [];
    const done = (result) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(() => done({ seen, got: false }), limitMs);

    ws.addEventListener('message', (e) => {
      seen.push(JSON.parse(e.data).type);
      if (seen.includes(type)) done({ seen, got: true });
    });
    ws.addEventListener('error', () => done({ seen, got: false }));
  });

const get = async (port, path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(2000),
  }).catch((err) => ({ status: err.name, text: async () => '' }));
  return { status: res.status, body: await res.text() };
};

test('a mounted server answers for its own paths and no others', async () => {
  // Attached to somebody else's server it used to answer everything, writing a
  // second set of headers over a host route that had already replied and
  // killing the process with ERR_HTTP_HEADERS_SENT. A library gets its own
  // paths and stays silent on the rest.
  const host = http.createServer((req, res) => {
    if (req.url === '/api/me') res.writeHead(200).end('host');
    else if (!res.headersSent) res.writeHead(404).end('host says no');
  });
  const chat = createEulerChat({ world: seed(new World()), server: host });
  const port = await listen(host);

  try {
    assert.equal((await get(port, '/api/me')).body, 'host', 'the host keeps its routes');
    assert.equal((await get(port, '/nope')).body, 'host says no', 'and its own 404');

    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>eulerchat<\/title>/);
  } finally {
    chat.close();
    host.close();
  }
});

test('it can live under a path', async () => {
  const host = http.createServer((req, res) => {
    if (req.url === '/') res.writeHead(200).end('host home');
    else if (!res.headersSent) res.writeHead(404).end('host says no');
  });
  const chat = createEulerChat({ world: seed(new World()), server: host, mount: '/chat' });
  const port = await listen(host);

  try {
    assert.equal((await get(port, '/')).body, 'host home', 'the root is still theirs');
    assert.match((await get(port, '/chat/')).body, /<title>eulerchat<\/title>/);
    assert.match((await get(port, '/chat/public/app.js')).body, /renderAtlas/);
    assert.match((await get(port, '/chat/lib/regions.js')).body, /Region algebra/);

    // And the socket comes up at the mount point.
    const { seen, got } = await awaitFrame(`ws://127.0.0.1:${port}/chat`, 'welcome');
    assert.ok(got, `frames: ${seen.join(', ') || 'none'}`);
  } finally {
    chat.close();
    host.close();
  }
});

test('a server of its own still answers everything', async () => {
  // Standalone it owns the port, so an unmatched path is its to refuse.
  const chat = createEulerChat({ world: seed(new World()) });
  const port = await listen(chat.server);

  try {
    assert.equal((await get(port, '/')).status, 200);
    assert.equal((await get(port, '/nope')).status, 404);
    // Nothing outside the two directories it serves, however it is asked for.
    // These come back 404 rather than 403 because `..` never survives URL
    // parsing to reach the guard — which is worth knowing rather than
    // asserting the guard's status code and believing the guard is what ran.
    for (const path of [
      '/server/store.js',
      '/package.json',
      '/public/../server/store.js',
      '/lib/../package.json',
    ]) {
      const res = await get(port, path);
      assert.notEqual(res.status, 200, `${path} was served`);
      assert.ok(!res.body.includes('audienceFor'), `${path} leaked source`);
    }
  } finally {
    chat.close();
  }
});

test('the client can be left out entirely', async () => {
  // Somebody bringing their own interface wants the sockets and none of ours.
  const chat = createEulerChat({ world: seed(new World()), serveClient: false });
  const port = await listen(chat.server);

  try {
    assert.equal((await get(port, '/')).status, 404);

    const { seen, got } = await awaitFrame(`ws://127.0.0.1:${port}`, 'state');
    assert.ok(got, `but the rooms should still work; frames: ${seen.join(', ') || 'none'}`);
  } finally {
    chat.close();
  }
});
