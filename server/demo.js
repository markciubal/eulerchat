/**
 * The demo: fifty thousand made-up people, some of them talking at any
 * moment, for trying the place out among company. Never a deployment.
 *
 *   npm run demo
 *   node server/demo.js --people 50000 --interests 1200 --rate 2 --port 8790
 *
 * Kept away from production four ways. It is its own entry point, which the
 * `Procfile` and `npm start` never reach. It checks where it is and refuses to
 * start anywhere that looks like a deployment (see `productionSigns`). It
 * writes nothing: there is no ledger, so a restart forgets it all, and nothing
 * it says can be handed back to a real server. And it says what it is — every
 * page it serves wears a "Demo" label, every word its people say is a system
 * message, and the open read API, its firehose and its dumps all say "demo"
 * in what they serve, so nothing taken from them reads as real.
 */

import { createEulerChat, World } from './app.js';
import { populate } from './populate.js';
import { productionSigns } from './traffic.js';

const signs = productionSigns(process.env);
if (signs.length) {
  console.error(
    `eulerchat demo: refusing to start — ${signs.join(', ')}.\n` +
      '  The demo fills the place with made-up people and must never run where real people are.\n' +
      '  Run it on your own machine: npm run demo',
  );
  process.exit(1);
}

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at > -1 ? Number(process.argv[at + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};

// Its own port, and not the one in PORT: a real server started from the same
// shell is on that one, and the demo must not take its place.
const PORT = flag('port', Number(process.env.DEMO_PORT ?? 8790));
const people = flag('people', 50_000);
const interests = flag('interests', 1200);

const started = Date.now();
const world = populate(new World(), { subjects: interests, users: people, chatter: 0 });
world.census();
world.index();

const chat = createEulerChat({
  world,
  demo: true,
  // Open, so the firehose and its dumps can be watched at /streams with
  // something in them. Only on this machine, and marked as made up in the
  // index, in every dump's first line and in every dump's file name.
  publicApi: true,
  traffic: {
    rate: flag('rate', 2),
    near: flag('near', 0.6),
    churn: flag('churn', 0.4),
    reply: Math.min(1, Math.max(0, flag('reply', 0.6))),
    warm: flag('warm', 2000),
  },
});

chat.server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `eulerchat demo: port ${PORT} is already in use — pass --port, or set DEMO_PORT`
      : `eulerchat demo: ${err.message}`,
  );
  process.exit(1);
});

chat.server.listen(PORT, () => {
  const counts = world.census();
  console.log(
    `eulerchat DEMO listening on http://localhost:${PORT} — everyone else here is made up\n` +
      `  ${world.subjects.size} interests · ${world.members.size.toLocaleString()} made-up people · ` +
      `${counts.size.toLocaleString()} occupied regions · ready in ${((Date.now() - started) / 1000).toFixed(1)}s\n` +
      `  The firehose and its dumps: http://localhost:${PORT}/streams\n` +
      '  Nothing is kept: no ledger, and a restart forgets everything.',
  );
});
