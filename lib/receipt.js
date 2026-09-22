/**
 * Evidence that the server deleted what it said it deleted.
 *
 * Read the next paragraph before believing anything this produces.
 *
 * NOBODY CAN PROVE A DELETION. A server that has copied your message
 * elsewhere, or whose disk is imaged, or whose operator simply remembers what
 * you said, can publish a perfect receipt for a deletion that never happened.
 * There is no cryptography for "and then I forgot", and anyone selling you
 * some is selling you something else. What is here is narrower and real:
 *
 *   - a record of every deletion, in order, that cannot be quietly rewritten
 *     later, because each entry is bound to the one before it by a hash;
 *   - a way for somebody who kept their own copy of a message to check that
 *     that exact message is named in a receipt, at a stated time;
 *   - and therefore a way to catch a server that says it deletes on a
 *     schedule and does not, or that goes back and edits its own history.
 *
 * So: tamper-evident deletion receipts. They make dishonesty detectable rather
 * than impossible, which is the most that any log can do. The word "proof" is
 * avoided throughout on purpose.
 *
 * A message is named by a commitment - a hash of its identity and contents -
 * rather than by its text, so a receipt can be published to everybody without
 * republishing the conversation it is about. Anybody holding the original can
 * recompute the commitment and find it; nobody else learns anything from it.
 */

const ENCODE = new TextEncoder();

const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256, wherever this is running. */
export async function digest(text) {
  const bytes = ENCODE.encode(String(text));
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/**
 * What a message is called in a receipt.
 *
 * Built from the parts that make it that message and no other. A sealed
 * message commits to its ciphertext, which is all the server ever had; the
 * person who can read it can still recompute this, because they hold the
 * envelope too.
 */
export function commitmentInput(message) {
  const body = message.sealed ? `sealed:${message.envelope?.body ?? ''}` : `plain:${message.body ?? ''}`;
  if (message.v === 2) return commitmentInputV2(message, body);
  return [message.id, message.room, message.at, message.authorId ?? '', body].join('\u0000');
}

/**
 * The second form, which every message posted from now on is named by.
 *
 * The first form left two things out. It did not cover the name a message is
 * shown under - only `authorId`, a random string nobody ever sees - so a copy
 * handed back after a restart could put genuine words under any name at all
 * and still match. And it joins its fields with a character that a message
 * body is free to contain, so the boundary between one field and the next was
 * a matter of trust.
 *
 * Neither mattered much while a name was only a label anybody could type. A
 * name with a key beside it is a claim about who spoke, and that has to be
 * part of what is committed to or a restart becomes a way of forging it. So
 * this form covers the name and the key, and is written as JSON, which escapes
 * what it carries: two different messages cannot produce the same string.
 *
 * The first form stays, unchanged, for whatever is already in a ledger. The
 * two cannot be confused with each other - a first-form string always contains
 * a raw NUL and a JSON string never does - and a message says which it is, so
 * claiming the old form for a new message gets a hash the server never wrote.
 */
function commitmentInputV2(message, body) {
  const fields = [
    2,
    String(message.id ?? ''),
    String(message.room ?? ''),
    Number(message.at),
    String(message.authorId ?? ''),
    String(message.author ?? ''),
    String(message.authorKey ?? ''),
    body,
  ];
  // Written by the server rather than by a person, said in the hash too, so a
  // copy handed back after a restart cannot drop the label and pass as a
  // person's words — or add it to a person's. Only when true, so that every
  // message written before this names itself by the same string it always did.
  if (message.machine) fields.push('machine');
  return JSON.stringify(fields);
}

/** The commitment for one message. */
export const commitment = (message) => digest(commitmentInput(message));

/**
 * What an entry's hash is computed over: the entry, and the entry before it.
 *
 * Including the previous hash is the whole mechanism. Changing anything in any
 * past entry changes its hash, which changes every hash after it, so a chain
 * that still verifies has not been edited since it was written.
 */
export function entryInput(entry) {
  return [
    entry.seq,
    entry.at,
    entry.reason ?? 'expired',
    entry.count,
    [...(entry.commitments ?? [])].join(','),
    entry.previous ?? '',
  ].join('\u0000');
}

/**
 * Check a chain from the beginning: every hash recomputed, every link
 * followed, every sequence number where it should be.
 *
 * Returns what is wrong rather than merely that something is, because "your
 * deletion log does not verify" is not an actionable sentence.
 */
export async function verify(chain) {
  const entries = [...(chain ?? [])];
  const problems = [];
  let previous = '';

  for (const [i, entry] of entries.entries()) {
    if (entry.seq !== i) {
      problems.push(`entry ${i} claims to be number ${entry.seq}`);
    }
    if ((entry.previous ?? '') !== previous) {
      problems.push(`entry ${i} does not follow the one before it`);
    }
    const expected = await digest(entryInput({ ...entry, previous }));
    if (entry.hash !== expected) {
      problems.push(`entry ${i} has been changed since it was written`);
    }
    if (entry.count !== (entry.commitments?.length ?? 0)) {
      problems.push(`entry ${i} says ${entry.count} messages but names ${entry.commitments?.length ?? 0}`);
    }
    previous = entry.hash;
  }

  return { ok: problems.length === 0, problems, head: previous, length: entries.length };
}

/**
 * Whether a message you kept is named in a receipt, and which one.
 *
 * For somebody checking a claim about their own conversation: they hold the
 * message, so they can compute what it would be called and look for it.
 */
export async function findDeletion(message, chain) {
  const want = await commitment(message);
  for (const entry of chain ?? []) {
    if (entry.commitments?.includes(want)) {
      return { deleted: true, at: entry.at, seq: entry.seq, reason: entry.reason ?? 'expired' };
    }
  }
  return { deleted: false, at: null, seq: null, reason: null };
}
