/**
 * The small durable thing the server keeps, so that everything else can live
 * in other people's browsers.
 *
 * Not the conversations. Only a hash of each message as it was posted, and the
 * record of what has been deleted. A commitment is sixty-four characters
 * whatever the message was, so this stays roughly thirty times smaller than
 * keeping the text, and it is append-only, which means it can be a file rather
 * than a database.
 *
 * What it buys is the whole point: when the server comes back with nothing,
 * clients can hand back what they kept, and the server can tell whether each
 * one is genuinely a message it saw. Without this anchor, restoring from
 * clients means rebuilding state from unauthenticated input - anybody could
 * attribute words to somebody who never said them, and anybody could bring
 * back a message that was deleted on purpose.
 *
 * WHAT IT DOES NOT GIVE YOU:
 *
 *   - Completeness. Clients hand back what they happened to keep. A room
 *     nobody was recording comes back empty, and a restored room may have
 *     holes. What is there is genuine; that is a different claim from all of
 *     it being there.
 *   - Protection from whoever runs the server. The ledger is a file on their
 *     disk. An operator who edits it can authorise anything they like. The
 *     chaining makes that detectable to somebody who noted an earlier head,
 *     not impossible.
 *   - Any privacy. These are hashes of public messages; anybody holding a
 *     message can confirm it is in here. That is what makes restoring work,
 *     and it means the ledger should be treated as public too.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * A ledger that writes one JSON object per line and never rewrites a line.
 *
 * Append-only on purpose. A format where the only operation is "add to the
 * end" cannot lose earlier records to a partial write, is trivial to inspect
 * with the tools everybody already has, and survives being copied while it is
 * being written to.
 *
 * Writes are synchronous. A message is acknowledged to the room once it is in
 * here, and doing that asynchronously would mean telling people something was
 * recorded slightly before it was - which is the one lie this file exists to
 * prevent. At the volume a single chat server handles, the cost is a few
 * microseconds per message.
 */
export class FileLedger {
  constructor(file = 'eulerchat-ledger.jsonl') {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.handle = fs.openSync(this.file, 'a');
  }

  append(record) {
    fs.writeSync(this.handle, `${JSON.stringify(record)}\n`);
    return record;
  }

  /**
   * Every record, in the order they were written.
   *
   * A truncated last line is dropped rather than thrown over: the one way this
   * file gets damaged is a process dying mid-write, which damages exactly the
   * final line, and refusing to start because of it would turn a lost message
   * into a lost server.
   */
  load() {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n');
    const out = [];

    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        const last = i >= lines.length - 2;
        if (!last) throw new Error(`ledger damaged at line ${i + 1} of ${this.file}`);
        console.warn('eulerchat: ignoring an incomplete final ledger line');
      }
    }
    return out;
  }

  close() {
    try {
      fs.closeSync(this.handle);
    } catch {
      /* already closed */
    }
  }
}

/** The same thing in memory, for tests and for anybody who wants no file. */
export class MemoryLedger {
  constructor(records = []) {
    this.records = [...records];
  }

  append(record) {
    this.records.push(record);
    return record;
  }

  load() {
    return [...this.records];
  }

  close() {}
}

/**
 * Anything with `append` and `load` will do.
 *
 * Kept this small deliberately. Somebody putting this behind Postgres, Redis
 * or a queue should not have to implement a storage engine to do it - two
 * methods, one of which only runs at boot.
 */
export const isLedger = (thing) =>
  Boolean(thing) && typeof thing.append === 'function' && typeof thing.load === 'function';
