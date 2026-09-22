import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The command-line server, started as a deployment starts it: the `Procfile`
 * runs it with no flags at all. What it has in it then is what the first
 * person to arrive sees, so it has to be nothing that is not real.
 */

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js');

/** Start it, read what it says it has, and stop it. */
function started(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '--no-ledger', ...args], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let said = '';
    const done = (value) => {
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`it never said what it had: ${said}`));
    }, 20_000);
    child.stdout.on('data', (chunk) => {
      said += chunk;
      if (/people/.test(said)) {
        clearTimeout(timer);
        done(said);
      }
    });
    child.stderr.on('data', (chunk) => {
      said += chunk;
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!/people/.test(said)) reject(new Error(`it exited (${code}) saying: ${said}`));
    });
  });
}

test('started as a deployment starts it, it has every interest and nobody made up', async () => {
  const said = await started([]);
  const [, interests, people, regions] = /(\d+) interests · (\d+) people · (\d+) occupied regions/.exec(said) ?? [];
  assert.ok(Number(interests) > 1000, `the whole catalogue (${interests})`);
  assert.equal(Number(people), 0, 'nobody in it that nobody is');
  assert.equal(Number(regions), 0, 'and so no rooms that look lived in');
  assert.doesNotMatch(said, /made-up/);
});

test('the made-up people are there only when asked for, and say so', async () => {
  const said = await started(['--sample']);
  const [, people] = /· (\d+) people ·/.exec(said) ?? [];
  assert.ok(Number(people) > 0, 'a few, for trying it out');
  assert.match(said, /made-up people/);
});
