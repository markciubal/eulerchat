import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { World } from '../server/store.js';
import { populate } from '../server/populate.js';
import { createEulerChat } from '../server/app.js';
import { MODES, REPLIES, paceOf, productionSigns, startTraffic } from '../server/traffic.js';
import { groupRoom, newCluster, within } from '../lib/cluster.js';

/**
 * The demo's made-up traffic: how busy rooms are, who talks, and that none of
 * it can reach a deployment.
 */

const WebSocket = createRequire(import.meta.url)('ws');
const here = path.dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('how busy a room is falls in three humps, apart from each other, in the shares asked for', () => {
  const rooms = Array.from({ length: 20_000 }, (_, i) => `interest ${i}+interest ${i * 7 + 3}`);
  const paces = rooms.map(paceOf);
  const shares = Object.fromEntries(MODES.map((m) => [m.name, paces.filter((p) => p.mode === m.name).length / rooms.length]));
  for (const m of MODES) assert.ok(Math.abs(shares[m.name] - m.share) < 0.02, `${m.name}: ${shares[m.name].toFixed(3)}`);

  // Each hump spans a factor of four; between one and the next there is
  // nothing at all, which is what makes it three kinds of room and not one.
  const band = (name) => {
    const values = paces.filter((p) => p.mode === name).map((p) => p.perMinute);
    return [Math.min(...values), Math.max(...values)];
  };
  const [quiet, steady, busy] = MODES.map((m) => band(m.name));
  assert.ok(quiet[1] < steady[0], `quiet tops out at ${quiet[1].toFixed(3)} a minute, below steady's ${steady[0].toFixed(3)}`);
  assert.ok(steady[1] < busy[0], `steady tops out at ${steady[1].toFixed(2)} a minute, below busy's ${busy[0].toFixed(2)}`);
  assert.ok(busy[1] / quiet[0] > 100, 'the busiest talk over a hundred times as often as the quietest');

  // The same room is always the same kind.
  assert.deepEqual(paceOf('chess+go'), paceOf('chess+go'));
});

test('anywhere that looks like a deployment is recognised as one', () => {
  assert.deepEqual(productionSigns({}), [], "somebody's own machine");
  assert.deepEqual(productionSigns({ NODE_ENV: 'development' }), []);
  assert.deepEqual(productionSigns({ NODE_ENV: 'production' }), ['NODE_ENV is production']);
  assert.deepEqual(productionSigns({ DYNO: 'web.1' }), ['running on a Heroku dyno']);
  for (const name of ['RENDER', 'FLY_APP_NAME', 'RAILWAY_ENVIRONMENT', 'VERCEL', 'K_SERVICE', 'KUBERNETES_SERVICE_HOST']) {
    assert.equal(productionSigns({ [name]: 'x' }).length, 1, name);
  }
});

/** A small made-up world, with one real person in it. */
function world() {
  const w = populate(new World(), { subjects: 150, users: 600, chatter: 0 });
  const me = w.addUser('a real person');
  for (const s of [...w.index().popular].slice(0, 3)) w.join(me, s);
  return { w, me };
}

test('only made-up people talk, every word is a system message, and always in a room they are in', async () => {
  const { w, me } = world();
  // A group, with made-up people in it too: nobody made-up talks there.
  const g = newCluster();
  w.addSubject(groupRoom(g));
  const inside = within(g, 'chess');
  w.addSubject(inside);
  for (const u of [...w.members.keys()].slice(0, 5)) {
    w.join(u, groupRoom(g));
    w.join(u, inside);
  }

  const said = [];
  // Busy enough nearby that the five asked for below are some twenty-five
  // expected, not six: at six, a quiet draw fell short one run in four.
  const traffic = startTraffic({ world: w, deliver: (m) => said.push(m), present: () => [me], warm: 300, rate: 40, near: 80, tick: 20, churn: 0 });
  await wait(400);
  traffic.stop();

  assert.ok(said.length > 300, `${said.length} said`);
  for (const m of said) {
    assert.equal(m.machine, true, 'a system message');
    assert.equal(w.profiles.get(m.authorId)?.synthetic, true, 'said by somebody made up');
    assert.notEqual(m.authorId, me, 'never by the real person');
    assert.ok([...m.subjects].every((s) => w.subscription(m.authorId).has(s)), 'in a room they are in');
    assert.ok(!m.room.includes('/'), 'and never in a group');
  }
  // Words in the rooms the real person is in, which are the only ones that
  // reach them, and words round about, which they see as heights.
  const held = w.subscription(me);
  const heard = said.filter((m) => m.subjects.every((s) => held.has(s)));
  assert.ok(heard.length >= 5, `${heard.length} said where they can hear it`);

  // A reaction answers something said, never another reaction.
  const byId = new Map(said.map((m) => [m.id, m]));
  for (const m of said) {
    if (!REPLIES.includes(m.body) || !m.replyTo) continue;
    const to = byId.get(m.replyTo.id);
    if (to) assert.ok(!REPLIES.includes(to.body), `"${m.body}" answered "${to.body}"`);
  }
});

test('busy rooms get most of what is said, quiet ones the least', async () => {
  const { w } = world();
  const said = [];
  const traffic = startTraffic({ world: w, deliver: (m) => said.push(m), warm: 4000, rate: 0, near: 0, churn: 0 });
  traffic.stop();
  const by = { quiet: 0, steady: 0, busy: 0 };
  for (const m of said) by[paceOf(m.room).mode] += 1;
  assert.ok(by.busy > by.steady && by.steady > by.quiet, JSON.stringify(by));
});

test('a real person is answered now and then, a moment later, and a system message never is', async () => {
  const { w, me } = world();
  const said = [];
  const traffic = startTraffic({ world: w, deliver: (m) => said.push(m), warm: 0, rate: 0, near: 0, churn: 0, reply: 1, answerAfter: [10, 30] });
  const room = [...w.subscription(me)].slice(0, 1);
  const mine = w.post(me, room, 'anyone else just starting out?');
  traffic.heard(mine);
  traffic.heard({ ...mine, id: 'other', machine: true });
  assert.equal(said.length, 0, 'not at once');
  await wait(80);
  traffic.stop();
  assert.equal(said.length, 1, 'one answer, to the person and not to the machine');
  assert.equal(said[0].replyTo?.id, mine.id);
  assert.equal(said[0].machine, true);
  assert.notEqual(said[0].authorId, me);
});

test('made-up people come and go, and whoever is online is told', async () => {
  const { w } = world();
  let told = 0;
  const before = JSON.stringify([...w.members.values()].map((s) => [...s].sort()));
  const traffic = startTraffic({ world: w, deliver: () => {}, changed: () => (told += 1), warm: 0, rate: 0, near: 0, churn: 200, tick: 20 });
  await wait(1200);
  traffic.stop();
  assert.notEqual(JSON.stringify([...w.members.values()].map((s) => [...s].sort())), before, 'somebody joined or left');
  assert.ok(told >= 1 && told <= 2, `told ${told} times: at most once a second, however many came and went`);
  for (const held of w.members.values()) assert.ok(held.size <= 8, 'nobody made up holds more than eight');
});

test('the demo says it is the demo to every page, and an ordinary server does not', async () => {
  for (const demo of [true, false]) {
    const chat = createEulerChat({ world: new World(), serveClient: false, demo });
    await new Promise((resolve) => chat.server.listen(0, resolve));
    const ws = new WebSocket(`ws://127.0.0.1:${chat.server.address().port}/`);
    const welcome = await new Promise((resolve) => {
      ws.on('message', (raw) => {
        const f = JSON.parse(raw);
        if (f.type === 'welcome') resolve(f);
      });
    });
    ws.close();
    chat.close();
    assert.equal(welcome.demo, demo);
  }
});

/** Run the demo's own entry point, and read what it says, then stop it. */
function runDemo(env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, '..', 'server', 'demo.js'), '--people', '1500', '--interests', '200', '--port', '0', '--warm', '50'], {
      env: { ...process.env, NODE_ENV: '', DYNO: '', ...env },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let said = '';
    const done = (code) => resolve({ code, said });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on('data', (chunk) => {
      said += chunk;
      if (/listening/.test(said)) {
        clearTimeout(timer);
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => {
      said += chunk;
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
}

test('the demo will not start anywhere that looks like production', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { DYNO: 'web.1' }, { FLY_APP_NAME: 'eulerchat' }]) {
    const { code, said } = await runDemo(env);
    assert.equal(code, 1, `refused with ${JSON.stringify(env)}`);
    assert.match(said, /refusing to start/);
    assert.doesNotMatch(said, /listening/);
  }
});

test('on its own machine the demo starts, says it is made up, and writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eulerchat-demo-'));
  try {
    // The variables that mark a deployment, emptied, as on a laptop.
    const clean = Object.fromEntries(['NODE_ENV', 'DYNO', 'RENDER', 'FLY_APP_NAME', 'RAILWAY_ENVIRONMENT', 'VERCEL', 'K_SERVICE', 'AWS_EXECUTION_ENV', 'WEBSITE_SITE_NAME', 'KUBERNETES_SERVICE_HOST'].map((k) => [k, undefined]));
    const env = { ...process.env };
    for (const k of Object.keys(clean)) delete env[k];
    const child = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [path.join(here, '..', 'server', 'demo.js'), '--people', '1500', '--interests', '200', '--port', '0', '--warm', '50'], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let said = '';
      const timer = setTimeout(() => proc.kill(), 20_000);
      proc.stdout.on('data', (c) => {
        said += c;
        if (/listening/.test(said)) {
          clearTimeout(timer);
          proc.kill();
        }
      });
      proc.stderr.on('data', (c) => (said += c));
      proc.on('exit', () => resolve(said));
    });
    assert.match(child, /DEMO listening/);
    assert.match(child, /made-up people/);
    assert.deepEqual(fs.readdirSync(dir), [], 'no ledger, nothing at all written where it ran');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
