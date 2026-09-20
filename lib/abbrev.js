/**
 * Short names for subjects, for labelling the overlaps.
 *
 * An overlap is where two or three subjects meet, and writing all their names
 * in that space does not fit — but leaving it blank makes the most interesting
 * ground on the map the only unlabelled part of it. So each subject gets the
 * shortest prefix that cannot be confused with any other subject in view:
 * `music`, `philosophy` and `math` become `mu`, `p`, `ma`, because `p` is
 * unambiguous on its own while `m` is not.
 *
 * Which means these are only meaningful relative to a particular set. Adding a
 * subject can lengthen another's label, and that is correct — the label's whole
 * job is to be unmistakable among what is actually on screen.
 */

/** How a name might be shortened, shortest first. */
function candidates(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ['?'];

  const out = [];
  // A phrase reads better as initials than as a prefix of its first word:
  // `amateur running` is `ar`, not `am`.
  if (words.length > 1) {
    for (let n = 2; n <= words.length; n++) out.push(words.slice(0, n).map((w) => w[0]).join(''));
  }
  for (let n = 1; n <= words[0].length; n++) out.push(words[0].slice(0, n));
  out.push(words.join(' '));
  return out;
}

/**
 * The shortest unambiguous label for each subject.
 *
 * @param {Iterable<string>} subjects
 * @returns {Map<string, string>}
 */
export function shortLabels(subjects) {
  const names = [...new Set(subjects)].sort();
  const options = new Map(names.map((n) => [n, candidates(n)]));
  const at = new Map(names.map((n) => [n, 0]));

  const labelOf = (name) => {
    const list = options.get(name);
    return list[Math.min(at.get(name), list.length - 1)];
  };

  // Advance whoever collides, repeatedly, until nobody does. Bounded because
  // the last candidate is the full name and those are unique by construction.
  for (let pass = 0; pass < 64; pass++) {
    const taken = new Map();
    for (const name of names) {
      const label = labelOf(name);
      if (!taken.has(label)) taken.set(label, []);
      taken.get(label).push(name);
    }

    let clashed = false;
    for (const [, sharing] of taken) {
      if (sharing.length < 2) continue;
      clashed = true;
      for (const name of sharing) {
        const list = options.get(name);
        if (at.get(name) < list.length - 1) at.set(name, at.get(name) + 1);
      }
    }
    if (!clashed) break;
  }

  return new Map(names.map((n) => [n, labelOf(n)]));
}

/** `mu + p + ma` — how an overlap is written on the map. */
export const abbreviate = (subjects, labels) =>
  subjects.map((s) => labels.get(s) ?? s).join(' + ');
