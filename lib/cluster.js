/**
 * Small private groups, made by putting a name in front.
 *
 * A subject is `art`. A subject inside a cluster is `kite-fox-9/art`. That is
 * the whole mechanism: the prefix travels with the name, so everything that
 * already works on subjects — containment, the census, overlaps, routing —
 * works on clustered ones without knowing they are clustered. `kite-fox-9/art`
 * and `art` are simply two different subjects, and people in one do not
 * receive the other.
 *
 * A group is also a copy of everything outside it. `kite-fox-9/art` is art:
 * it wears art's colour and emblem, sits where art sits on the map, is
 * suggested beside what art is suggested beside, and widens into
 * `kite-fox-9/visual art` the way art widens into visual art. Only the people
 * are different. So whatever is worked out from a subject's name is worked
 * out from its `label`, and the prefix decides only who is in the room.
 *
 * It is a room key, not a password. Anyone holding the name is in; there is
 * nothing here that resists guessing beyond the name being long enough not to
 * be stumbled into, and a cluster shared once is shared onward by whoever has
 * it. That makes it the right tool for "the six of us at this table" and the
 * wrong one for anything that matters if a stranger reads it.
 */

/** Words that make a name somebody can read out loud down a phone. */
const WORDS = [
  'kite', 'fox', 'moss', 'lark', 'pine', 'wren', 'reed', 'fern', 'owl', 'hare',
  'silt', 'dune', 'cove', 'birch', 'elm', 'rook', 'teal', 'sage', 'flint', 'yew',
];

/** A cluster name: two words and a number, which is enough to be unguessable
 *  by accident and short enough to say out loud. */
export function newCluster(random = Math.random) {
  const word = () => WORDS[Math.floor(random() * WORDS.length)];
  return `${word()}-${word()}-${Math.floor(random() * 90) + 10}`;
}

/** Valid as a cluster name: lowercase words and digits joined by hyphens. */
export const isCluster = (name) => /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/.test(String(name ?? ''));

/**
 * Split a subject into the cluster it belongs to and the subject itself.
 * Everything outside any cluster reports a cluster of null, which is the
 * ordinary open case.
 */
export function split(subject) {
  const text = String(subject ?? '');
  const slash = text.indexOf('/');
  if (slash < 0) return { cluster: null, subject: text };
  return { cluster: text.slice(0, slash), subject: text.slice(slash + 1) };
}

/** Put a subject inside a cluster. Joining twice does not nest it twice. */
export function within(cluster, subject) {
  const inner = split(subject).subject;
  return cluster ? `${cluster}/${inner}` : inner;
}

/** The cluster a subject belongs to, or null. */
export const clusterOf = (subject) => split(subject).cluster;

/** What to show somebody: the subject without the cluster in front of it. */
export const label = (subject) => split(subject).subject;

/**
 * The group's own conversation: `kite-fox-9/everyone`.
 *
 * It wraps the group. Everybody who holds anything inside a group holds this
 * too, so every room in the group is inside it — which makes its ground on
 * the map exactly the outline round the group's rooms, and makes a message
 * posted to it reach the whole group.
 */
export const GROUP_ROOM = 'everyone';

/** The group's own conversation, for a group. */
export const groupRoom = (cluster) => within(cluster, GROUP_ROOM);

/** Whether a subject is some group's own conversation. */
export function isGroupRoom(subject) {
  const { cluster, subject: bare } = split(subject);
  return Boolean(cluster) && bare === GROUP_ROOM;
}

/**
 * What a room is about, with the group it sits in taken out.
 *
 * Inside a group every room also holds the group's own conversation, since
 * that is what wraps them; `kite-fox-9/art` is held alongside
 * `kite-fox-9/everyone`. Said out loud, that room is art — so the group comes
 * out wherever a room is named or coloured, unless it is the whole of the room.
 */
export function inner(subjects) {
  const list = [...subjects];
  const rest = list.filter((s) => !isGroupRoom(s));
  return rest.length ? rest : list;
}

/** A room's subjects as somebody reads them: inside the group, as outside it. */
export const named = (subjects) => inner(subjects).map(label);

/**
 * The link that puts somebody in a cluster, for sharing or for a QR code.
 *
 * A query parameter rather than a path, so this works wherever the chat is
 * mounted without the host having to route anything new.
 */
export function inviteLink(origin, cluster) {
  const base = String(origin ?? '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return `${base}/?cluster=${encodeURIComponent(cluster)}`;
}

/** The cluster named by a link, or null if it names none. */
export function clusterFromLink(href) {
  try {
    const value = new URL(String(href), 'http://x').searchParams.get('cluster');
    return value && isCluster(value) ? value : null;
  } catch {
    return null;
  }
}
