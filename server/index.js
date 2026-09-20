/**
 * The command-line server: argv, a port, and the crash reporting that a
 * long-running process needs. Everything else lives in `app.js`, which can be
 * mounted into somebody else's application instead.
 */

import { createEulerChat, World, seed, populate } from './app.js';
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

// `--interests 1000` builds a synthetic world at scale; with no flag you get
// the small hand-written one, which is the better thing to read the code by.
const interests = flag('interests', 0);
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
else seed(world);

const chat = createEulerChat({ world });

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
      `${counts.size.toLocaleString()} occupied regions`,
  );
});
