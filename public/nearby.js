/**
 * What is going on near you, worked out while you are not doing anything.
 *
 * Somebody who stops moving is either reading or deciding what to read, and
 * the second of those is the one this can help with. Three seconds after the
 * last thing anybody did (`public/app.js`), the page looks at the map it
 * already has and picks out the chats that are both **lively** and **near what
 * this person holds** — nothing is fetched, and nothing is asked of anybody.
 *
 * Near means one of two things, in this order:
 *
 *   - **beside you**: the chat is about an interest you hold, so it is a room
 *     you are already entitled to walk into, or one you are in;
 *   - **one along**: the chat is about an interest in the same community as
 *     something you hold — what the same people turn up to — which is the
 *     shortest honest hop from where you are. See `lib/communities.js`.
 *
 * Anything further than that is not nearby, and is left for All interests,
 * which is the place for looking further afield on purpose.
 *
 * Lively means said-in recently, not big: a room of nine hundred that nobody
 * has spoken in since this morning is not where anything is happening, and
 * saying otherwise would send people to an empty room with a large number over
 * the door.
 */

/** How lively a chat has to be before it is worth interrupting nobody for. */
const LIVELY = 0.08;

/** How long ago something must have been said for the room to count as awake. */
const RECENTLY = 15 * 60 * 1000;

/** How many are offered. Three is a glance; ten is a list to be read. */
export const OFFERED = 3;

/**
 * @param {object} seen
 * @param {Array<object>} seen.rooms  the map's rooms, as the `atlas` frame has them
 * @param {string[]} seen.held  the interests this person holds
 * @param {Iterable<string>} [seen.alongside]  interests a hop away: everything in the
 *   communities of what they hold. Worked out by the caller, which is the only
 *   part of the page that knows whether All interests has ever been opened.
 * @param {number} [seen.now]
 * @returns {Array<{key: string, subjects: string[], why: string, activity: number, population: number, member: boolean}>}
 */
export function livelyNearby({ rooms = [], held = [], alongside = [], now = Date.now() } = {}) {
  const mine = new Set(held);
  const near = new Set(alongside);

  const awake = (room) => {
    const said = room.stats?.last?.at ?? room.stats?.last ?? 0;
    return (room.activity ?? 0) >= LIVELY || (said && now - said <= RECENTLY);
  };

  const found = [];
  for (const room of rooms) {
    if (!room?.key || !awake(room)) continue;
    // A chat of one is not a chat, and a chat nobody has ever said anything in
    // is not a thing that is happening.
    if ((room.population ?? 0) < 2 || !(room.messages ?? room.stats?.messages ?? 0)) continue;
    const subjects = room.subjects ?? [];
    const beside = subjects.some((subject) => mine.has(subject));
    const along = !beside && subjects.some((subject) => near.has(subject));
    if (!beside && !along) continue;
    const shared = subjects.filter((subject) => mine.has(subject));
    found.push({
      key: room.key,
      subjects,
      member: Boolean(room.member),
      activity: room.activity ?? 0,
      population: room.population ?? 0,
      why: room.member
        ? 'yours, and busy'
        : beside
          ? `next to ${shared[0]}`
          : 'one along, through what the same people hold',
    });
  }

  found.sort(
    (a, b) =>
      b.activity - a.activity ||
      b.population - a.population ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return found.slice(0, OFFERED);
}
