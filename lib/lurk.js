/**
 * Quick join: a link, or the square beside it, that opens one conversation to
 * lurk in.
 *
 * Somebody who scans it is shown that conversation and nothing else. They are
 * not a member of it: not in its head count, not on anybody's list of who is
 * here, not among the people an encrypted message is locked for. The room is
 * told how many are lurking — a number, never who — since somebody
 * talking deserves to know how big the audience is. Nothing is written on
 * their device, and no key is made or shown, so the visit leaves nothing
 * behind and ties them to nothing. It is the walk past an open door before
 * deciding whether to go in, and it lasts until they decide: joining in, or
 * going to look at anything else, ends it.
 *
 * A query parameter, like a group's invitation, so it works wherever the chat
 * is mounted. It names a room by its key, which is already public — every room
 * but a portal is listed by the open side of this place — and a portal is
 * refused here, since the whole point of one is that it is not found.
 */

import { ROOM_ARITY, key, parse } from './regions.js';
import { isPortalRoom } from './portal.js';

const SUBJECT = /^(?:[a-z0-9]+(?:-[a-z0-9]+){1,3}\/)?[a-z0-9][a-z0-9 -]{0,30}$/;

/**
 * The room a key names, written the one way it is written everywhere else, or
 * null for anything that could not be a room somebody can watch.
 */
export function watchable(roomKey) {
  const subjects = parse(String(roomKey ?? ''));
  if (!subjects.length || subjects.length > ROOM_ARITY) return null;
  if (!subjects.every((s) => SUBJECT.test(s))) return null;
  const room = key(subjects);
  return isPortalRoom(room) ? null : room;
}

/** The link that opens a room to watch. */
export function watchLink(origin, roomKey) {
  const base = String(origin ?? '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return `${base}/?watch=${encodeURIComponent(roomKey)}`;
}

/** The room a link opens to watch, or null if it names none. */
export function watchedFrom(href) {
  try {
    const value = new URL(String(href), 'http://x').searchParams.get('watch');
    return value ? watchable(value) : null;
  } catch {
    return null;
  }
}
