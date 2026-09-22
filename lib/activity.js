import { parse } from './regions.js';

/**
 * How lively each room and each interest has been lately, against the
 * liveliest on the platform — the height the map raises it to.
 *
 * Messages per minute over the last five minutes, which is what a room's card
 * shows, is the wrong measure for this. It is zero everywhere five minutes
 * after the last word, and a map whose relief sank flat every time the place
 * went quiet for a coffee would say nothing about where the talk is. So each
 * message counts for less as it ages, halving every `HALF_LIFE`, and a room's
 * activity is the sum of what its messages still count for.
 *
 * Only ever relative. Everything is divided by the liveliest open room (or
 * interest), so it runs from 0 to 1 and the busiest is always the tallest.
 * That also makes it hold still: every message ages at the same rate, so
 * while nobody is saying anything the ratios between rooms do not change at
 * all, and the answer only needs working out again when a message comes or
 * goes.
 *
 * Every message counts, system messages included. They are marked as what
 * they are wherever they are read, and a room the server has been asking
 * questions in is a room things are happening in; leaving them out left a
 * freshly stocked world, whose every word is a system message, dead flat.
 * A portal is not counted at all — it is on nobody's map, and its busyness
 * is nobody's business. Groups are counted but do not set the scale: their
 * rooms are measured against the open world, so nothing outside a group can
 * tell from the heights that it is lively.
 */
export const HALF_LIFE = 60 * 60 * 1000;

/**
 * @param {Map<string, Array<{at: number}>>} logs  messages by room
 * @param {object} [options]
 * @param {number} [options.halfLife]
 * @param {(room: string) => boolean} [options.skip]  rooms not counted at all
 * @param {(subject: string) => boolean} [options.open]  subjects that set the scale
 * @returns {{rooms: Map<string, number>, subjects: Map<string, number>}}  each 0..1
 */
export function activity(logs, { halfLife = HALF_LIFE, skip = () => false, open = () => true } = {}) {
  const rooms = new Map();
  const subjects = new Map();

  // Measured back from the newest message rather than from now: the ratios
  // are the same either way, and this way nothing underflows however long
  // the place has been quiet.
  let latest = -Infinity;
  for (const [room, log] of logs) {
    if (skip(room)) continue;
    for (const message of log) if (message.at > latest) latest = message.at;
  }
  if (!Number.isFinite(latest)) return { rooms, subjects };

  for (const [room, log] of logs) {
    if (skip(room)) continue;
    let sum = 0;
    for (const message of log) sum += 2 ** ((message.at - latest) / halfLife);
    if (!(sum > 0)) continue;
    rooms.set(room, sum);
    // A message in a room is a message about each thing the room is about.
    for (const subject of parse(room)) subjects.set(subject, (subjects.get(subject) ?? 0) + sum);
  }

  scale(rooms, (room) => parse(room).every(open));
  scale(subjects, open);
  return { rooms, subjects };
}

/**
 * Divide through by the largest of those that set the scale, to three places.
 * With nothing open to measure against — the open world silent, a group
 * talking — the largest of all of them does instead, which tells nobody
 * outside anything: their own rooms are nought either way.
 */
function scale(values, sets) {
  let peak = 0;
  for (const [id, value] of values) if (sets(id) && value > peak) peak = value;
  if (!peak) for (const value of values.values()) if (value > peak) peak = value;
  for (const [id, value] of values) {
    values.set(id, peak > 0 ? Math.round(Math.min(1, value / peak) * 1000) / 1000 : 0);
  }
}
