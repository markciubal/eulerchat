/**
 * What is worth interrupting someone for.
 *
 * Delivery and notification are different questions. Delivery is settled:
 * `T ⊆ S` says a message reaches you, and in a busy subject that is a great
 * many messages. Notification asks which of the things already reaching you
 * deserve attention, and answering it with "all of them" is how a chat
 * application becomes something people mute.
 *
 * The diagram answers it better than a generic rule could, because the shape
 * of a room says how much it is *for you*:
 *
 *   - A post in `art` reaches everyone holding art. You are one of a crowd.
 *   - A post in `art+philosophy` reaches only people holding both. Fewer
 *     people, more specific context, and your presence is more conspicuous.
 *   - A post in a room of three people is very nearly addressed to you.
 *
 * So the signal is how few people a message reaches, not how recently it
 * arrived — narrow rooms are loud and broad rooms are quiet, which is the
 * opposite of what volume alone would give you.
 *
 * And two events no flat chat model has at all: a region that nobody occupied
 * becoming occupied, and the last person leaving one. Rooms here are derived
 * from membership, so they genuinely come into and go out of existence, and
 * being told that the place you and two others just brought into being now
 * exists is worth more than most messages in it.
 */

import { parse, receives } from './regions.js';

/** Counted, never shown. */
export const QUIET = 'quiet';
/** Badged, and offered to the desktop if they allowed it. */
export const NOTIFY = 'notify';
/** Worth interrupting for: someone said their name, or the room is tiny. */
export const ALERT = 'alert';

export const RANK = { [QUIET]: 0, [NOTIFY]: 1, [ALERT]: 2 };

export const defaults = {
  /** At or below this many people, a room is small enough to be conspicuous in. */
  intimate: 8,
  /** Being named always interrupts. */
  mentions: true,
  /** Rooms opening and closing around you. */
  lifecycle: true,
  /** Room keys to stay silent about. */
  muted: [],
};

/**
 * Does `body` name this person?
 *
 * Bare names match too many ordinary words — somebody called Art in a room
 * about art would never know peace — so this wants the `@`.
 */
export function mentions(body, name) {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${escaped}\\b`, 'i').test(String(body));
}

/**
 * Turn a world event into a notification for one person, or into nothing.
 *
 * @param {object} event    a `message`, `room-opened` or `room-closed` event
 * @param {object} watcher  { userId, name, subscription, muted?, intimate?,
 *                            mentions?, lifecycle?, viewing? }
 * @returns {object|null}
 */
export function classify(event, watcher) {
  const prefs = { ...defaults, ...watcher };
  const subscription = watcher.subscription ?? [];
  const room = event.room ?? event.message?.room;
  if (!room) return null;

  const subjects = parse(room);

  // The rule that must hold whatever else changes: a notification can only
  // ever concern a room this person could already read. Anything else would
  // leak the existence of a conversation they are not part of.
  if (!receives(subscription, subjects)) return null;

  const muted = prefs.muted instanceof Set ? prefs.muted : new Set(prefs.muted);
  if (muted.has(room)) return null;

  if (event.type === 'message') return forMessage(event.message, subjects, prefs, muted);
  if (event.type === 'room-opened' || event.type === 'room-closed') {
    return forLifecycle(event, subjects, prefs);
  }
  return null;
}

function forMessage(message, subjects, prefs, muted) {
  if (!message || message.authorId === prefs.userId) return null; // not your own

  const named = prefs.mentions && mentions(message.body, prefs.name);
  const reach = message.reach ?? Infinity;

  let level = QUIET;
  if (named) level = ALERT;
  else if (reach <= Math.max(2, Math.floor(prefs.intimate / 3))) level = ALERT;
  else if (subjects.length > 1 || reach <= prefs.intimate) level = NOTIFY;

  // Looking at a room is better than being told about it. Still counted, so
  // the badge is right the moment they look away.
  if (prefs.viewing === message.room && level !== ALERT) level = QUIET;
  void muted;

  return {
    kind: named ? 'mention' : 'message',
    level,
    room: message.room,
    subjects,
    at: message.at,
    from: message.author,
    messageId: message.id,
    title: named ? `${message.author} mentioned you in ${subjects.join(' ∩ ')}` : subjects.join(' ∩ '),
    // Events may be hand-built by a caller driving this from another source,
    // so nothing here assumes a field is present.
    body: String(message.body ?? '').slice(0, 140),
  };
}

function forLifecycle(event, subjects, prefs) {
  if (!prefs.lifecycle) return null;
  // A single subject appearing is just somebody joining it; the news is an
  // *overlap* existing, which is a place that was not there before.
  if (subjects.length < 2) return null;

  const opened = event.type === 'room-opened';
  return {
    kind: opened ? 'room-opened' : 'room-closed',
    level: NOTIFY,
    room: event.room,
    subjects,
    at: event.at,
    title: opened
      ? `${subjects.join(' ∩ ')} now exists`
      : `${subjects.join(' ∩ ')} is empty`,
    body: opened
      ? event.population <= 1
        ? 'Nobody held all of these before. You are the only one here so far.'
        : `You and ${event.population - 1} other${event.population === 2 ? '' : 's'} hold all of these. Nobody did before.`
      : 'The last person holding all of these left, so the room is gone.',
  };
}

/** Highest level first, then newest, so a list reads in order of urgency. */
export const byUrgency = (a, b) => RANK[b.level] - RANK[a.level] || b.at - a.at;
