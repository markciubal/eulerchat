/**
 * Questions to start a quiet room with, written by the server and said to be.
 *
 * Offline and deterministic for a given random source: a question is made from
 * the room's own interests and from what the catalogue knows about where they
 * sit — the field above an interest, the interests beside it — dropped into a
 * sentence that works for any name. Nothing is fetched and nothing leaves the
 * server. It reads a little like a form; that is the price of it being honest
 * about what it is, which a model would pay for differently.
 *
 * On topic by construction: every question names the room's own interests,
 * and a question about an overlap names both halves of it. Nothing here claims
 * an experience, an opinion or a history — the sentences are questions to the
 * room, never statements by somebody pretending to have been somewhere — so
 * that the label saying a machine wrote them is the whole truth and not the
 * polite half of it.
 */

import { childrenOf, knowledge } from './knowledge.js';

const UNDER = childrenOf(knowledge);

/** One interest. `{s}` the interest, `{field}` what it sits in, `{beside}` a neighbour. */
const ONE = [
  'What got you into {s}?',
  'Where would you tell somebody to start with {s} this week?',
  'What is something about {s} that surprised you when you first came to it?',
  'Which open question in {s} would you most like to see answered?',
  'What is a good first book, video or project for {s}?',
  'What do beginners in {s} usually get wrong?',
  'Which part of {s} do you keep coming back to?',
  'Who should everyone here be reading, watching or listening to on {s}?',
  'What would you change about how {s} is usually taught?',
  'What is one thing you learned about {s} recently?',
  'What is the most overrated idea in {s}?',
  'What is the hardest thing to explain about {s} to somebody new?',
];

/** One interest the catalogue can place: it has a field, and perhaps neighbours. */
const PLACED = [
  'What drew you to {s} rather than somewhere else in {field}?',
  'What do people outside {field} most often get wrong about {s}?',
  'Where does {s} sit in {field} for you: at the centre, or out at the edge?',
];

const BESIDE = [
  'For anyone who has tried both: how does {s} compare with {beside}?',
  'Does {s} have anything to teach {beside}, or the other way round?',
];

/** Two interests, `{a}` and `{b}`. */
const TWO = [
  'Where do {a} and {b} actually meet for you?',
  'What does {a} have to teach {b}, or the other way round?',
  'Did you come to {b} through {a}, or the other way?',
  'What is a question in {b} that somebody from {a} would ask differently?',
  'Who is doing interesting work where {a} and {b} overlap?',
  'Is there a book, piece or project that belongs to both {a} and {b}?',
  'If you had to explain {a} to somebody who only knows {b}, where would you start?',
  'What surprised you most about how {a} and {b} fit together?',
];

/** Three interests, `{a}`, `{b}` and `{c}`. */
const THREE = [
  'What brought you to {a}, {b} and {c} all at once?',
  'Of {a}, {b} and {c}, which two sit closest together for you?',
  'Is there one thing that ties {a}, {b} and {c} together?',
  'Where do {a}, {b} and {c} all meet in something you have done or read?',
];

const pick = (list, random) => list[Math.floor(random() * list.length) % list.length];
const fill = (template, words) => template.replace(/\{(\w+)\}/g, (_, name) => words[name] ?? '');

/** Where the catalogue puts an interest: the field above it, and the interests beside it. */
export function placeOf(subject) {
  const field = knowledge[subject];
  if (!field || !knowledge[field]) return { field: null, beside: [] };
  const beside = (UNDER.get(field) ?? []).filter((s) => s !== subject);
  return { field, beside };
}

/**
 * A question for a room, from the names of its interests.
 *
 * @param {string[]} subjects  the room's interests, as they are read (`named`)
 * @param {{random?: () => number}} [options]
 * @returns {string}
 */
export function ask(subjects, { random = Math.random } = {}) {
  const [a, b, c] = [...subjects].sort();
  if (c) return fill(pick(THREE, random), { a, b, c });
  if (b) {
    // Either way round, so neither interest is always the one being explained.
    const [x, y] = random() < 0.5 ? [a, b] : [b, a];
    return fill(pick(TWO, random), { a: x, b: y });
  }

  const { field, beside } = placeOf(a);
  const choices = [...ONE];
  if (field) choices.push(...PLACED);
  if (beside.length) choices.push(...BESIDE);
  return fill(pick(choices, random), { s: a, field, beside: beside.length ? pick(beside, random) : '' });
}
