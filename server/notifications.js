/**
 * Notifications: preferences, unread counts, and a small backlog.
 *
 * Follows the same split as everything else here. `lib/notify.js` decides what
 * is worth someone's attention and knows nothing about connections; this keeps
 * the per-person state and hands finished notifications to whatever is
 * listening. Nothing in either reaches for a socket, so the same rules can
 * drive a WebSocket frame, a push notification, a webhook or an email digest.
 */

import { RANK, QUIET, byUrgency, classify, defaults } from '../lib/notify.js';

const HELD = 50;

export class Notifications {
  /**
   * @param {import('./store.js').World} world
   * @param {object} [options]
   * @param {number} [options.hold=50]  backlog kept per person while away
   */
  constructor(world, options = {}) {
    this.world = world;
    this.hold = options.hold ?? HELD;

    /** @type {Map<string, object>} userId -> preference overrides */
    this.prefs = new Map();
    /** @type {Map<string, Map<string, number>>} userId -> room -> unread */
    this.unread = new Map();
    /** @type {Map<string, object[]>} userId -> notifications not yet delivered */
    this.backlog = new Map();
    /** @type {Map<string, string|null>} userId -> the room they are looking at */
    this.viewing = new Map();
    /** @type {Set<(userId: string, notification: object) => void>} */
    this.listeners = new Set();

    this.stop = world.watch((event) => this.#consider(event));
  }

  /** Called with (userId, notification) for anything worth showing. */
  onNotify(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  settings(userId) {
    return { ...defaults, ...(this.prefs.get(userId) ?? {}) };
  }

  configure(userId, changes = {}) {
    const next = { ...this.settings(userId), ...changes };
    // Muted rooms arrive as an array over the wire and are used as a set.
    next.muted = [...new Set(next.muted ?? [])];
    next.intimate = Math.max(1, Math.min(500, Number(next.intimate) || defaults.intimate));
    this.prefs.set(userId, next);
    return next;
  }

  mute(userId, room) {
    const { muted } = this.settings(userId);
    return this.configure(userId, { muted: [...muted, room] });
  }

  unmute(userId, room) {
    const { muted } = this.settings(userId);
    return this.configure(userId, { muted: muted.filter((r) => r !== room) });
  }

  /** Which room someone is looking at; that room stops interrupting them. */
  looking(userId, room) {
    this.viewing.set(userId, room ?? null);
    if (room) this.clear(userId, room);
  }

  counts(userId) {
    return Object.fromEntries(this.unread.get(userId) ?? []);
  }

  total(userId) {
    let sum = 0;
    for (const n of (this.unread.get(userId) ?? new Map()).values()) sum += n;
    return sum;
  }

  /** Mark a room read, or everything if no room is given. */
  clear(userId, room) {
    const counts = this.unread.get(userId);
    if (!counts) return;
    if (room) counts.delete(room);
    else counts.clear();
  }

  /**
   * Everything that happened while they were away, most urgent first, and
   * emptied by the reading of it.
   */
  drain(userId) {
    const held = this.backlog.get(userId) ?? [];
    this.backlog.delete(userId);
    return held.sort(byUrgency);
  }

  /** Stop listening to the world. */
  close() {
    this.stop();
    this.listeners.clear();
  }

  #consider(event) {
    // Only people who could already read the room are candidates, and
    // `classify` checks containment again for each of them — the rule that a
    // notification never mentions a room somebody is not in is worth enforcing
    // in both places, because it is the one that leaks conversations.
    const room = event.room;
    if (!room) return;

    for (const [userId] of this.world.members) {
      const note = classify(event, {
        ...this.settings(userId),
        userId,
        name: this.world.profiles.get(userId)?.name,
        subscription: this.world.subscription(userId),
        viewing: this.viewing.get(userId) ?? null,
      });
      if (!note) continue;

      const counts = this.unread.get(userId) ?? new Map();
      counts.set(note.room, (counts.get(note.room) ?? 0) + 1);
      this.unread.set(userId, counts);

      if (RANK[note.level] <= RANK[QUIET]) continue;

      let delivered = false;
      for (const listener of this.listeners) {
        try {
          delivered = listener(userId, note) || delivered;
        } catch {
          /* a listener's problem is its own */
        }
      }

      // Nobody took it, so they are away: keep it for when they are back.
      if (!delivered) {
        const held = this.backlog.get(userId) ?? [];
        held.push(note);
        if (held.length > this.hold) held.shift();
        this.backlog.set(userId, held);
      }
    }
  }
}
