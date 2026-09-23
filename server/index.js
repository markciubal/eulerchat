/**
 * The command-line server: argv, a port, and the crash reporting that a
 * long-running process needs. Everything else lives in `app.js`, which can be
 * mounted into somebody else's application instead.
 */

import { createEulerChat, World, seed, stock, populate } from './app.js';
import { productionSigns } from './traffic.js';
import { FileLedger } from './ledger.js';

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? Number(process.argv[at + 1]) : fallback;
};

// `--port` first, then the environment, then the default. The flag is
// documented on the command line and was being ignored, which is worse than
// not offering it: somebody who passes it watches the server start, reports
// the wrong address, and has no reason to suspect the flag.
const PORT = flag('port', Number(process.env.PORT ?? 8787));

/**
 * What the world starts with.
 *
 * With no flag, the catalogue and nothing else: every interest there is, with
 * nobody in it and nothing said. That is what a deployment runs — the
 * `Procfile` passes no flags — and the only honest start for one. This used
 * to be the sample world instead, so every deployment, and every restart of
 * one, opened on two dozen made-up people and six things none of them said,
 * and anybody arriving saw rooms that looked lived in and were not.
 *
 * `--sample` is that sample world, for trying it out on your own: a few
 * made-up people in three corners, so the map has something on it.
 * `--interests 1000` builds a synthetic world at scale, for the same reason
 * and for measuring.
 */
const interests = flag('interests', 0);
const sample = process.argv.includes('--sample');
const world = new World();

/**
 * Where the anchor is written, so a restart is survivable.
 *
 * On by default, because a chat server that forgets everything it ever saw the
 * moment it is restarted is not one anybody should have to discover the
 * properties of in production. It is a single append-only file and it holds no
 * conversations - only a hash of each message and the record of deletions -
 * so it stays small and can be read with any text editor.
 *
 * `--ledger <path>` moves it. `--no-ledger` turns it off and goes back to
 * keeping nothing, which is the right thing for a throwaway demo and the wrong
 * thing for anything else.
 */
const wantsLedger = !process.argv.includes('--no-ledger');
let ledger = null;
if (wantsLedger) {
  const at = process.argv.indexOf('--ledger');
  const file = at > -1 ? process.argv[at + 1] : process.env.EULERCHAT_LEDGER ?? 'eulerchat-ledger.jsonl';
  ledger = new FileLedger(file);
  const held = world.useLedger(ledger);
  if (held.messages) {
    console.log(
      `eulerchat: ${held.messages} messages and ${held.deletions} deletions remembered from ${file}.
` +
        '  The conversations themselves come back from whoever kept a copy.',
    );
  }
}

if (interests > 0) populate(world, { subjects: interests, users: flag('people', 4000) });
else if (sample) seed(world);
else stock(world);

/**
 * Who may read reports, by the key they hold.
 *
 * `--moderator <fingerprint>`, as many times as there are moderators, or
 * `EULERCHAT_MODERATORS` with commas between them. The fingerprint is the one
 * the interface shows a person for their own key, in full. Nobody by default:
 * there are no accounts here, so a key is the only thing anybody can be
 * recognised by, and it counts only once the connection has shown it holds it.
 */
const moderators = (process.env.EULERCHAT_MODERATORS ?? '').split(',');
for (const [i, arg] of process.argv.entries()) {
  if (arg === '--moderator' && process.argv[i + 1]) moderators.push(process.argv[i + 1]);
}

/**
 * `--questions [seconds]`: now and then, one of the sample people asks an
 * on-topic question in a quiet room, labelled as a system message. Every
 * minute or so by default; a number after the flag sets the interval. Only
 * ever as a sample person, so in a world of real people it does nothing.
 */
const asked = process.argv.indexOf('--questions');
const every = asked > -1 ? Number(process.argv[asked + 1]) : NaN;
const questions = asked < 0 ? false : { every: (Number.isFinite(every) && every > 0 ? every : 60) * 1000 };

// This server is the public one: it is the deployment that decided everything
// said here is readable by anybody. A library consumer gets the opposite
// default and has to ask for it.
// Filling the place with made-up people from a button is for somebody's own
// machine, and the same signs that stop the demo starting stop this being
// offered at all; see `productionSigns` and the `machines` frame.
const signs = productionSigns(process.env);
const chat = createEulerChat({
  world,
  publicApi: true,
  moderators: moderators.map((m) => m.trim()).filter(Boolean),
  questions,
  machines: signs.length === 0,
});
if (signs.length) {
  console.log(`eulerchat: made-up people cannot be added from a page here — ${signs.join(', ')}.`);
}
if (questions) {
  console.log(`eulerchat: sample people will ask a question, labelled as a system message, about every ${questions.every / 1000}s`);
  // Only ever as one of the sample people, so without any it never asks.
  if (!sample && !(interests > 0)) {
    console.log('  There are no sample people without --sample or --interests, so no question will be asked.');
  }
}

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
        `  ${chat.sessions.size} sessions, ${world.subjects.size} subjects, ` +
        `${world.members.size} members at the time`,
    );
    process.exit(1);
  });
}

/**
 * A server that cannot take the port has not started, whatever else is true.
 *
 * The socket server's error handler exists so one bad connection cannot end
 * the process — but it also caught `EADDRINUSE` from the listen itself and
 * merely logged it, leaving a process alive and serving nothing. Failing to
 * bind is not a connection problem and must not be survivable.
 */
chat.server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `eulerchat: port ${PORT} is already in use — stop the other one, or set PORT`
      : `eulerchat: ${err.message}`,
  );
  process.exit(1);
});

chat.server.listen(PORT, () => {
  const counts = world.census();
  console.log(
    `eulerchat listening on http://localhost:${PORT}\n` +
      `  ${world.subjects.size} interests · ${world.members.size} people · ` +
      `${counts.size.toLocaleString()} occupied regions` +
      (sample || interests > 0 ? ' · made-up people, for trying it out' : ''),
  );
});
