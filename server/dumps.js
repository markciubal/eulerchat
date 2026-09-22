/**
 * The firehose, kept a megabyte at a time.
 *
 * Everything the firehose carries is also written here, one line of JSON per
 * event, until the next line would take it past a megabyte. What has gathered
 * then becomes a dump, public at `/api/dumps/{id}`, and the gathering starts
 * again from nothing. So nobody has to hold a stream open to have everything,
 * and nothing sent out from here is ever bigger than a megabyte.
 *
 * A dump is not an archive. The place forgets after twelve hours, and sooner
 * when somebody asks for their words back, and a copy of the firehose kept by
 * the server itself would be the server breaking its own word: the deletion
 * record says a message is gone, and here it would still be. So a dump loses
 * a message when the place does - a dump only ever shrinks - and goes
 * altogether twelve hours after the last thing in it. Dumps are held in
 * memory and nowhere else, so a restart forgets them along with everything.
 */

import { KEEP_FOR } from './store.js';

/** The most a dump, first line included, can ever be: a megabyte. */
export const DUMP_BYTES = 1_000_000;

/**
 * Kept back from every dump for its first line, which says what it is. Far
 * more than that line takes, so that nothing it says can push a dump over.
 */
const HEAD_BYTES = 512;

/**
 * @param {object} [options]
 * @param {number} [options.bytes]  the most a dump can be
 * @param {number} [options.keep]  the most dumps held at once; the oldest go first
 * @param {number} [options.keepFor]  how long after its last event a dump is kept
 * @param {boolean} [options.demo]  the words are made up, and every dump says so
 * @param {(dump: object) => void} [options.onDump]  told of each new dump
 * @param {() => number} [options.now]
 */
export function createDumps({ bytes = DUMP_BYTES, keep = 64, keepFor = KEEP_FOR, demo = false, onDump = () => {}, now = Date.now } = {}) {
  const room = bytes - HEAD_BYTES;
  if (!(room > 0)) throw new Error(`a dump of ${bytes} bytes has no room for anything in it`);

  // Where things are gathering, and the dumps already made. The same shape,
  // so that becoming a dump is a matter of being given a number.
  const gathering = () => ({ id: null, lines: [], bytes: 0 });
  let pending = gathering();
  const dumps = [];
  // Which holder each message is in, so that forgetting one is a lookup.
  const where = new Map();
  let next = 1;
  let tooBig = 0;

  const messagesIn = (holder) => holder.lines.reduce((n, l) => n + (l.id ? 1 : 0), 0);

  /** The first line of a dump: what it is, and what to do with it. */
  const headOf = (dump) =>
    JSON.stringify({
      type: 'dump',
      id: dump.id,
      from: dump.from,
      to: dump.to,
      events: dump.lines.length,
      messages: messagesIn(dump),
      ...(demo ? { demo: true } : {}),
      note: demo
        ? 'A demo: every word here was made up by the server, and none of it was said by anyone.'
        : 'Said in public. A later dump lists what was forgotten since; a copy should forget it too.',
    });

  const summary = (dump) => {
    const head = headOf(dump);
    return {
      id: dump.id,
      from: dump.from,
      to: dump.to,
      events: dump.lines.length,
      messages: messagesIn(dump),
      bytes: Buffer.byteLength(head) + 1 + dump.bytes,
    };
  };

  const drop = (dump) => {
    const at = dumps.indexOf(dump);
    if (at > -1) dumps.splice(at, 1);
    for (const line of dump.lines) if (line.id && where.get(line.id) === dump) where.delete(line.id);
  };

  /** Make a dump of what has gathered, and start again with nothing. */
  const cut = () => {
    if (!pending.lines.length) return;
    const dump = pending;
    dump.id = next++;
    dump.from = dump.lines[0].at;
    dump.to = dump.lines.at(-1).at;
    dumps.push(dump);
    // Deleted, not kept alongside: the dump is now the only copy.
    pending = gathering();
    while (dumps.length > keep) drop(dumps[0]);
    onDump(summary(dump));
  };

  /** Let go of everything past its time, gathered or dumped. */
  const sweep = () => {
    const cutoff = now() - keepFor;
    while (dumps.length && dumps[0].to < cutoff) drop(dumps[0]);
    if (pending.lines.length && pending.lines[0].at < cutoff) {
      const old = pending.lines.filter((l) => l.at < cutoff);
      for (const line of old) if (line.id) where.delete(line.id);
      pending.lines = pending.lines.filter((l) => l.at >= cutoff);
      pending.bytes = pending.lines.reduce((n, l) => n + l.size, 0);
    }
  };

  return {
    /** One event, as the firehose sent it. */
    add(event) {
      const line = JSON.stringify(event);
      const size = Buffer.byteLength(line) + 1;
      // Nothing the place says is anywhere near this big, but a dump that
      // went over the limit because of one would be the limit not meaning it.
      if (size > room) {
        tooBig += 1;
        return;
      }
      sweep();
      if (pending.bytes + size > room) cut();
      const id = event.type === 'message' && event.id ? event.id : null;
      pending.lines.push({ id, line, size, at: Number(event.at) || now() });
      pending.bytes += size;
      if (id) where.set(id, pending);
    },

    /** Take these messages out of wherever they are, gathered or dumped. */
    forget(ids) {
      const by = new Map();
      for (const id of ids) {
        const holder = where.get(id);
        if (!holder) continue;
        where.delete(id);
        if (!by.has(holder)) by.set(holder, new Set());
        by.get(holder).add(id);
      }
      for (const [holder, gone] of by) {
        holder.lines = holder.lines.filter((l) => !gone.has(l.id));
        holder.bytes = holder.lines.reduce((n, l) => n + l.size, 0);
        // A dump with nothing left in it is not a dump.
        if (holder !== pending && !holder.lines.length) drop(holder);
      }
    },

    /** What there is: the dumps, and how full the next one is. */
    list() {
      sweep();
      return {
        bytes,
        pending: {
          bytes: pending.bytes,
          events: pending.lines.length,
          since: pending.lines[0]?.at ?? null,
        },
        dumps: dumps.map(summary),
        ...(tooBig ? { tooBig } : {}),
      };
    },

    /** One dump as it is sent: a line saying what it is, then one per event. */
    body(id) {
      sweep();
      const dump = dumps.find((d) => d.id === Number(id));
      if (!dump) return null;
      return `${headOf(dump)}\n${dump.lines.map((l) => `${l.line}\n`).join('')}`;
    },
  };
}
