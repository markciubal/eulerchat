/**
 * Point this at the tables you already have.
 *
 * Every application that would want this already knows who its people are and
 * what they are interested in — in a users table, a join table, a JSON blob, a
 * GraphQL response. Making it work should not mean writing a loop that calls
 * `addUser` and `join`, learning our names for things along the way, and
 * keeping that loop in step with the schema afterwards.
 *
 * So: hand over the rows and say which columns mean what. Nothing here is
 * async, nothing here fetches, and nothing here assumes a server — it turns
 * rows into the shapes `census`, `zones` and `layout` already take.
 */

import { normalise } from './taxonomy.js';

/** A column name, a path like `profile.name`, or a function. */
function reader(spec, fallbacks = []) {
  if (typeof spec === 'function') return spec;
  const path = spec ?? fallbacks.find((f) => f);
  if (!path) return () => undefined;

  const steps = String(path).split('.');
  return (row) => {
    let at = row;
    for (const step of steps) {
      if (at == null) return undefined;
      at = at[step];
    }
    return at;
  };
}

/** The first of `names` that the row actually has. */
const firstOf = (row, names) => names.find((n) => row?.[n] !== undefined);

/**
 * @param {object} tables
 * @param {Array<object>} tables.users     one row per person
 * @param {Array<object>} [tables.interests]  one row per person-and-interest
 * @param {object} [mapping]  which columns mean what; guessed if omitted
 * @param {object} [options]
 * @param {Map|object} [options.hierarchy]  normalise subject names against it
 * @returns {{people: Array, subscriptions: Array<Set<string>>, subjects: string[]}}
 */
export function fromRows(tables = {}, mapping = {}, options = {}) {
  const users = [...(tables.users ?? [])];
  const interests = tables.interests ? [...tables.interests] : null;
  const { hierarchy } = options;

  const sample = users[0] ?? {};
  const idOf = reader(mapping.id, [firstOf(sample, ['id', 'userId', 'user_id', 'uid'])]);
  const nameOf = reader(mapping.name, [
    firstOf(sample, ['name', 'username', 'displayName', 'display_name', 'handle', 'email']),
  ]);
  const noveltyOf = reader(mapping.novelty, [
    firstOf(sample, ['novelty', 'exploration', 'curiosity']),
  ]);
  const reachOf = reader(mapping.reach, [firstOf(sample, ['reach', 'funnel', 'breadth'])]);

  // Interests either hang off the person, or live in their own table.
  const inline = reader(mapping.subjects, [
    firstOf(sample, ['subjects', 'interests', 'tags', 'topics']),
  ]);

  const held = new Map();
  if (interests) {
    const link = interests[0] ?? {};
    const ofUser = reader(mapping.interestUser, [
      firstOf(link, ['userId', 'user_id', 'user', 'uid', 'id']),
    ]);
    const ofSubject = reader(mapping.interestSubject, [
      firstOf(link, ['subject', 'interest', 'topic', 'tag', 'name']),
    ]);

    for (const row of interests) {
      const who = String(ofUser(row) ?? '');
      const what = clean(ofSubject(row), hierarchy);
      if (!who || !what) continue;
      if (!held.has(who)) held.set(who, new Set());
      held.get(who).add(what);
    }
  }

  const people = [];
  const everySubject = new Set();

  for (const row of users) {
    const id = String(idOf(row) ?? people.length);
    const own = held.get(id) ?? new Set();

    for (const raw of toList(inline(row))) {
      const what = clean(raw, hierarchy);
      if (what) own.add(what);
    }
    for (const subject of own) everySubject.add(subject);

    people.push({
      id,
      name: String(nameOf(row) ?? id),
      subjects: [...own].sort(),
      // How far somebody wants to be pushed from what they already hold. Left
      // out, they get the middle, which suggests neighbours over strangers
      // without refusing to mention a stranger.
      novelty: clamp(noveltyOf(row), 0.35),
      reach: Math.max(0, Math.min(2, Math.round(Number(reachOf(row)) || 0))),
      row,
    });
  }

  return {
    people,
    // Ready for `census()` and `zones()` without further ceremony.
    subscriptions: people.map((p) => new Set(p.subjects)),
    subjects: [...everySubject].sort(),
  };
}

function clean(value, hierarchy) {
  if (value == null) return '';
  const known = hierarchy instanceof Map ? hierarchy : hierarchy ? new Map(Object.entries(hierarchy)) : null;
  const name = known ? normalise(value, known) : String(value).trim().toLowerCase();
  return name;
}

const toList = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  // A comma-separated column is common enough to be worth handling.
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
};

const clamp = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  // Accept 0..1 or 0..100, since both are how people store a dial.
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
};

/**
 * Fill a `World` from the same rows, for the chat server rather than a drawing.
 * Kept separate so that `fromRows` itself never touches server code.
 */
export function populate(world, tables, mapping, options) {
  const { people } = fromRows(tables, mapping, options);

  for (const person of people) {
    const userId = world.addUser(person.name);
    world.setFunnel?.(userId, person.reach);
    person.userId = userId;

    for (const subject of person.subjects) {
      world.addSubject(subject);
      try {
        world.join(userId, subject);
      } catch {
        // The subscription cap; the rest of their interests simply do not fit.
        break;
      }
    }
  }
  return people;
}
