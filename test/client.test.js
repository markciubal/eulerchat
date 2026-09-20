import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

/**
 * Load the browser bundle against the real page, and see whether it survives.
 *
 * Everything else about the client is tested through its pure parts — the
 * layout, the hit testing, the render functions. What was never tested is the
 * thing that goes wrong most often and most visibly: the script throwing while
 * it loads, which leaves a blank page and an error nobody sees unless they
 * happen to have the console open.
 */
test('the client loads against the real page without throwing', async () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const { document, window } = parseHTML(html);

  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    }
    send(payload) {
      this.sent.push(payload);
    }
    close() {}
    emit(type, event) {
      this.listeners.get(type)?.(event);
    }
  }

  const timers = [];
  const previous = { ...globalThis };
  Object.assign(globalThis, {
    document,
    window,
    WebSocket: FakeSocket,
    location: { protocol: 'http:', host: 'localhost:8787' },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    Notification: class {
      static permission = 'default';
      static requestPermission = async () => 'default';
    },
    // Keep the module's reconnect timer from firing after the test ends.
    setTimeout: (fn, ms) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
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
    // Cache-busted so this is a fresh evaluation each run.
    await import(`../public/app.js?loaded=${Date.now()}`);

    assert.equal(sockets.length, 1, 'the client should open exactly one connection');
    assert.match(sockets[0].url, /^ws:\/\/localhost:8787$/);

    // And it should survive the frames a server actually sends on connect.
    const socket = sockets[0];
    socket.readyState = FakeSocket.OPEN;
    const frames = [
      { type: 'welcome', you: { id: 'u1', name: 'guest' }, maxArity: 3 },
      { type: 'history', rooms: {} },
      { type: 'unread', counts: { 'art+philosophy': 3 } },
      {
        type: 'diagram',
        circles: [{ id: 'art', population: 4, x: 0, y: 0, r: 30 }],
        bounds: { minX: -30, minY: -30, maxX: 30, maxY: 30, width: 60, height: 60 },
        rooms: [{ key: 'art', subjects: ['art'], population: 4, member: true, messages: 0 }],
        fit: { regions: [], phantoms: [], worst: null, worstError: 0, faithful: true, drawable: true },
        subscription: ['art'],
        suggested: [],
        hidden: [],
        rail: { held: ['art'], suggested: [], popular: [], total: 1 },
      },
      {
        type: 'notification',
        notification: {
          kind: 'message', level: 'notify', room: 'art', subjects: ['art'],
          at: Date.now(), title: 'art', body: 'hello',
        },
      },
      { type: 'missed', notifications: [] },
      {
        type: 'overview',
        extent: 1000,
        classified: 2,
        subjects: [
          { id: 'art', n: 4, x: 100, y: 0, known: true },
          { id: 'philosophy', n: 3, x: -80, y: 40, known: true },
        ],
      },
      { type: 'error', message: 'something went wrong' },
    ];

    for (const frame of frames) {
      assert.doesNotThrow(
        () => socket.emit('message', { data: JSON.stringify(frame) }),
        `the client should survive a ${frame.type} frame`,
      );
    }

    // The unread badge should have made it onto the room chip.
    const chips = document.querySelectorAll('.room-chip');
    assert.ok(chips.length > 0, 'rooms should be listed after a diagram');

    // And the client should have asked for the whole map, then drawn it.
    const asked = socket.sent.map((p) => JSON.parse(p).type);
    assert.ok(asked.includes('overview'), 'the client should request the overview');
    assert.ok(document.querySelectorAll('#minimap circle').length >= 2, 'minimap should be drawn');
  } finally {
    for (const key of ['document', 'window', 'WebSocket', 'location', 'sessionStorage', 'Notification', 'DOMPoint']) {
      delete globalThis[key];
    }
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
  }
});
