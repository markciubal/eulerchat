/**
 * Who is connected, and on what.
 *
 * This is the half of the old `World` that was about wires rather than
 * membership. Keeping them together meant the domain state held live sockets,
 * so using the routing over any other transport meant faking one. They are
 * separate now: the World answers *who should hear this*, and this answers
 * *where those people currently are*.
 *
 * A user may have several connections at once — two tabs, a phone and a laptop
 * — so the mapping is one to many in both directions of use.
 */

export class Sessions {
  constructor() {
    /** @type {Map<string, {id: string, userId: string, socket: any, lastView: string|null}>} */
    this.byId = new Map();
    /** @type {Map<string, Set<string>>} */
    this.byUser = new Map();
  }

  get size() {
    return this.byId.size;
  }

  /** Iterating a Sessions iterates its sessions, not its entries. */
  [Symbol.iterator]() {
    return this.byId.values();
  }

  open(id, userId, socket) {
    const session = { id, userId, socket, lastView: null };
    this.byId.set(id, session);
    this.#link(userId, id);
    return session;
  }

  get(id) {
    return this.byId.get(id);
  }

  close(id) {
    const session = this.byId.get(id);
    if (!session) return null;
    this.byId.delete(id);
    this.#unlink(session.userId, id);
    return session;
  }

  /** On resume, a live connection is handed a different identity. */
  reassign(id, userId) {
    const session = this.byId.get(id);
    if (!session) return null;
    this.#unlink(session.userId, id);
    session.userId = userId;
    session.lastView = null;
    this.#link(userId, id);
    return session;
  }

  /** Every connection belonging to one person. */
  forUser(userId) {
    const ids = this.byUser.get(userId);
    return ids ? [...ids].map((id) => this.byId.get(id)) : [];
  }

  /** Every user with a connection open — what to narrow a delivery search to. */
  present() {
    return this.byUser.keys();
  }

  /** The connections belonging to any of `userIds`. */
  reaching(userIds) {
    const out = [];
    for (const userId of userIds) out.push(...this.forUser(userId));
    return out;
  }

  #link(userId, id) {
    let ids = this.byUser.get(userId);
    if (!ids) this.byUser.set(userId, (ids = new Set()));
    ids.add(id);
  }

  #unlink(userId, id) {
    const ids = this.byUser.get(userId);
    if (!ids) return;
    ids.delete(id);
    if (!ids.size) this.byUser.delete(userId);
  }
}
