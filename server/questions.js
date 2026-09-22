/**
 * Machine questions, now and then, in rooms people are in.
 *
 * An option for a sample world, so that walking into it is walking into
 * something rather than into a room nobody has spoken in since it was made.
 * Every question is labelled as written by a machine — on the message itself,
 * in its hash, in the open API — and the browser says so beside the name. It
 * is never said to be anything else.
 *
 * Asked only as the sample people a demo world is filled with, and only in a
 * room one of them already stands in. Never as a real person, whether or not
 * they are online: a label saying a machine wrote it does not make it all
 * right to put a question in the mouth of somebody who did not ask it. So a
 * world with nobody synthetic in it gets no questions at all, which is the
 * right answer for a real deployment that turns this on by mistake.
 *
 * And only where it will not get in the way: in a room somebody online can
 * read, that nobody has spoken in for a while, never inside a group (the
 * people at a table did not ask to be prompted) or a portal (two people, and
 * nobody else is meant to find it), and never twice in a row in one place.
 */

import { parse, reachableRooms } from '../lib/regions.js';
import { clusterOf, named } from '../lib/cluster.js';
import { isPortalRoom } from '../lib/portal.js';
import { ask } from '../lib/questions.js';

/** How long a room must have been quiet before a question is put to it. */
export const QUIET_FOR = 3 * 60 * 1000;

/**
 * The questions this has asked, by message id, per world. Other system
 * messages are the lines a sample world is made with, and a room whose last
 * word is one of those has not been asked anything yet.
 */
const asked = new WeakMap();

/**
 * Put one question to one room, if there is a room it belongs in.
 *
 * @param {import('./store.js').World} world
 * @param {object} options
 * @param {Iterable<string>} options.present  who is online: user ids
 * @param {() => number} [options.random]
 * @param {number} [options.quiet]  how long a room must have been quiet
 * @param {number} [options.now]
 * @param {number} [options.tries]  how many people online to try, at most
 * @returns {object|null}  the message posted, or null if nowhere suited
 */
export function askSomewhere(world, options = {}) {
  const { random = Math.random, quiet = QUIET_FOR, now = Date.now(), tries = 6 } = options;
  const online = [...new Set(options.present ?? [])].filter((u) => world.members.has(u));
  if (!online.length) return null;

  const counts = world.census();
  const here = new Set(online);
  const synthetic = (userId) => world.profiles.get(userId)?.synthetic === true && !here.has(userId);

  for (let t = 0; t < tries; t++) {
    // Somebody online, and a room they can read — so the question lands
    // where there is at least one person to read it.
    const reader = online[Math.floor(random() * online.length)];
    const rooms = reachableRooms([...world.subscription(reader)])
      .filter((room) => counts.has(room) && suits(world, room, quiet, now))
      .sort();
    if (!rooms.length) continue;

    // Rooms in a random order, and the first with somebody synthetic in it.
    for (let left = rooms.length; left > 0; left--) {
      const at = Math.floor(random() * left);
      const room = rooms[at];
      rooms[at] = rooms[left - 1];

      const subjects = parse(room);
      const authors = world.audienceFor(subjects).filter(synthetic).sort();
      if (!authors.length) continue;

      const author = authors[Math.floor(random() * authors.length)];
      const message = world.post(author, subjects, ask(named(subjects), { random }), { machine: true });
      if (!asked.has(world)) asked.set(world, new Set());
      asked.get(world).add(message.id);
      return message;
    }
  }
  return null;
}

/** Whether a room is one to put a question to at all, and now. */
function suits(world, room, quiet, now) {
  const subjects = parse(room);
  if (subjects.some((s) => clusterOf(s) !== null) || isPortalRoom(room)) return false;
  const last = world.messages.get(room)?.at(-1);
  if (!last) return true;
  // Never ask twice running: a room whose last word was a question from here
  // is waiting for an answer, not another one.
  if (asked.get(world)?.has(last.id)) return false;
  // And never talk over a person. Any other system message — the lines a
  // sample world is made with — is not a conversation anybody is in, and
  // waiting it out would leave a freshly started demo silent for minutes.
  if (last.machine) return true;
  return now - last.at >= quiet;
}

/**
 * Ask on a timer, until stopped.
 *
 * @param {object} options
 * @param {import('./store.js').World} options.world
 * @param {() => Iterable<string>} options.present  who is online now
 * @param {(message: object) => void} options.deliver  hand a message to its room
 * @param {number} [options.every]  milliseconds between questions, before jitter
 * @param {number} [options.quiet]
 * @param {() => number} [options.random]
 */
export function startQuestions({ world, present, deliver, every = 60_000, quiet = QUIET_FOR, random = Math.random }) {
  let timer = null;
  let stopped = false;

  const next = () => {
    if (stopped) return;
    // Jittered, so a room does not learn to expect them on the minute.
    timer = setTimeout(tick, every * (0.6 + random() * 0.8));
    timer.unref?.();
  };

  const tick = () => {
    try {
      const message = askSomewhere(world, { present: present(), random, quiet });
      if (message) deliver(message);
    } catch {
      /* a question not asked is nothing lost; the next one will be */
    }
    next();
  };

  next();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
