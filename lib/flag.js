/**
 * Which conversations are worth a moderator's attention, and why.
 *
 * Two sources, deliberately unequal.
 *
 * People are the first and the better one. Someone in the room read the
 * message, understood who it was aimed at and what it meant, and said it was
 * wrong. No amount of pattern matching gets near that, and — since a sealed
 * message is unreadable to the server by design — for a great many messages a
 * report is the *only* thing that can exist. A scanner that quietly sees
 * nothing in every encrypted room would be worse than no scanner, because it
 * would look like coverage.
 *
 * Words are the second, and they are advisory. A list of words cannot tell
 * abuse from a quotation, a diagnosis, a song lyric or a joke between friends,
 * and this place is full of rooms — criminology, linguistics, medicine — where
 * the flagged word is the subject. So scanning is off unless asked for, its
 * contribution to a room's score is capped, and nothing it finds is ever a
 * verdict. It answers "is this worth a human looking", never "is this bad".
 *
 * What comes out is a ranking of rooms, because the question being asked is
 * which channels have a problem — not which messages. One nasty message in a
 * thousand is a person to talk to; twenty reports from twelve people in one
 * room is a room that has gone wrong.
 */

/** Why somebody reported something, and how much weight that carries. */
export const REASONS = {
  hate: { weight: 3, says: 'slurs or hatred towards a group' },
  threat: { weight: 3, says: 'threats or intimidation' },
  abuse: { weight: 2, says: 'abuse aimed at a person' },
  sexual: { weight: 2, says: 'unwanted sexual content' },
  language: { weight: 1, says: 'bad language' },
  spam: { weight: 1, says: 'spam or flooding' },
  other: { weight: 1, says: 'something else' },
};

export const REASON_NAMES = Object.keys(REASONS);

/**
 * The words the scanner knows, by default: a short list of ordinary English
 * profanity and nothing else.
 *
 * There are no slurs in it, which is a decision rather than an oversight. What
 * counts as a slur is specific to a community, a language and a moment, so any
 * list shipped in a general library would be wrong everywhere and complete
 * nowhere — and a library that ships a slur list is a library that ships a
 * slur list, which people reasonably do not want in their dependencies. The
 * machinery takes whatever vocabulary an operator brings; `hate` is the
 * heaviest reason a person can choose, and that is the route that works.
 */
export const DEFAULT_WORDS = {
  language: ['fuck', 'shit', 'piss', 'crap', 'arse', 'ass', 'bollocks', 'bastard', 'wank'],
  abuse: ['bitch', 'cunt', 'prick', 'twat', 'slut', 'whore'],
};

// Characters people substitute to get past exactly this kind of check. Mapped
// before anything is split up, so `a$$` is one word rather than three.
const LEET = {
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b',
  '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't',
};

/**
 * One word, reduced to the form the list is held in.
 *
 * Runs of three or more of the same letter collapse to one, so `fuuuuck` and
 * `shiiit` are caught. Runs of two are left alone, and that is load-bearing:
 * collapsing doubles would turn `ass` into `as`, and `as` is a word people use
 * roughly constantly.
 */
const reduce = (word) =>
  word
    .toLowerCase()
    .replace(/[0-9@$!|+]/g, (c) => LEET[c] ?? c)
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/[^a-z]/g, '');

/**
 * Build a matcher from `{category: [words]}`.
 *
 * Whole words only, and that is the whole trick. Checking whether a message
 * *contains* a bad word is the classic way to build something that flags
 * `classic`, `assassin`, `Scunthorpe`, `analysis` and — in a place with a
 * mycology channel — `shiitake`. Comparing complete words instead makes that
 * entire family of mistakes impossible rather than merely unlikely.
 */
export function vocabulary(words = DEFAULT_WORDS) {
  const byWord = new Map();
  for (const [category, list] of Object.entries(words ?? {})) {
    for (const word of list ?? []) {
      const reduced = reduce(word);
      if (reduced) byWord.set(reduced, category);
    }
  }
  return byWord;
}

const DEFAULT_VOCABULARY = vocabulary();

/**
 * Look through a message for words an operator has asked to know about.
 *
 * Returns what it found and a weight, never a judgement. A sealed message has
 * no text here to look at, which is the point of sealing it.
 *
 * It misses things, and it should be relied on accordingly: `f*ck` is not
 * caught, because a self-censored word has already been softened by the person
 * writing it and chasing it costs more in false alarms than it returns; and
 * anything spaced out letter by letter is not caught, because the rule that
 * finds it also finds a great deal of ordinary text.
 */
export function scan(text, { words } = {}) {
  const vocab = words ? vocabulary(words) : DEFAULT_VOCABULARY;
  const found = [];

  // Split on anything that is not a letter or a stand-in for one, so that
  // punctuation separates words but `a$$` survives as a single token.
  for (const token of String(text ?? '').split(/[^a-zA-Z0-9@$!|+]+/)) {
    if (!token) continue;
    const reduced = reduce(token);
    const category = vocab.get(reduced);
    if (category) found.push({ word: reduced, as: token, category });
  }

  const weight = found.reduce((sum, m) => sum + (REASONS[m.category]?.weight ?? 1), 0);
  return { found, weight, clean: found.length === 0 };
}

// How long a report keeps counting. Long enough that a pattern over days is
// visible, short enough that a room is not condemned by its distant past.
const WINDOW = 14 * 24 * 60 * 60 * 1000;
// Recent trouble matters more than old trouble, halving over this long.
const HALF_LIFE = 3 * 24 * 60 * 60 * 1000;
// The most any one person can contribute to one room, so that a single
// determined reporter cannot manufacture a crisis.
const PER_REPORTER_CAP = 3;
// The most the automatic scanner can contribute, however many words it finds.
const SCANNER_CAP = 0.25;

const decay = (age) => 2 ** (-Math.max(0, age) / HALF_LIFE);

/**
 * Turn reports into an ordered answer to "which rooms need looking at".
 *
 * Counting reports would rank the busiest rooms, since a room with a hundred
 * times the traffic gets something like a hundred times the reports while
 * being no worse a place to be. So what is measured is concentration — how
 * much of what is said here gets reported, by how many different people —
 * rather than volume.
 *
 * Distinct reporters carry the most weight. Twelve people who each reported
 * once is a room with a problem; one person who reported twelve times is one
 * upset person, and may be a person using reports as a weapon against someone
 * they dislike. Those two must not produce the same number, so each reporter's
 * contribution is capped.
 *
 * @param {Array<{room, subjects?, reports: Array, messages?: number, flags?: number}>} rooms
 * @returns {Array<{room, score, level, why, reporters, reports, ...}>} worst first
 */
export function rank(rooms, { now = Date.now(), window = WINDOW } = {}) {
  const out = [];

  for (const entry of rooms ?? []) {
    const fresh = (entry.reports ?? []).filter((r) => now - r.at <= window);
    if (!fresh.length && !entry.flags) continue;

    // Each person's reports, so that one voice is one voice.
    const byReporter = new Map();
    const reasons = new Map();
    for (const report of fresh) {
      const list = byReporter.get(report.by) ?? [];
      list.push(report);
      byReporter.set(report.by, list);
      reasons.set(report.reason, (reasons.get(report.reason) ?? 0) + 1);
    }

    let weighted = 0;
    let worst = 0;
    for (const list of byReporter.values()) {
      // Their most serious reports count first, then the cap bites.
      const ordered = [...list].sort(
        (a, b) => (REASONS[b.reason]?.weight ?? 1) - (REASONS[a.reason]?.weight ?? 1),
      );
      for (const report of ordered.slice(0, PER_REPORTER_CAP)) {
        const weight = REASONS[report.reason]?.weight ?? 1;
        weighted += weight * decay(now - report.at);
        worst = Math.max(worst, weight);
      }
    }

    const messages = Math.max(entry.messages ?? 0, 1);
    const reporters = byReporter.size;

    // Concentration, not volume: what share of what was said here drew a
    // complaint, with several different people worth more than several
    // complaints. The square root keeps a very busy room from being able to
    // dilute real trouble away entirely.
    const density = weighted / Math.sqrt(messages);
    const voices = Math.min(1, reporters / 4);
    const scanner = Math.min(SCANNER_CAP, (entry.flags ?? 0) / Math.max(messages, 20));

    // Bounded, so that scores are comparable between rooms and over time
    // rather than growing without limit in whichever room is oldest.
    const core = 1 - Math.exp(-density * (0.45 + 0.55 * voices));
    const score = Math.min(1, core * (1 - SCANNER_CAP) + scanner);

    out.push({
      room: entry.room,
      subjects: entry.subjects ?? null,
      score: Number(score.toFixed(3)),
      level: score >= 0.6 || worst >= 3 ? 'urgent' : score >= 0.25 ? 'look' : 'watch',
      reporters,
      reports: fresh.length,
      messages: entry.messages ?? 0,
      flags: entry.flags ?? 0,
      worst,
      reasons: [...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count, says: REASONS[reason]?.says ?? reason })),
      why: explain({ reporters, reports: fresh.length, messages: entry.messages ?? 0, reasons, worst, flags: entry.flags ?? 0 }),
      last: fresh.reduce((latest, r) => Math.max(latest, r.at), 0),
    });
  }

  return out.sort((a, b) => b.score - a.score || b.worst - a.worst || b.last - a.last);
}

/**
 * Why a room is on the list, in a sentence.
 *
 * A ranking nobody can check is a ranking nobody should act on — and somebody
 * is about to make a decision about other people's conversations on the
 * strength of this. The number is not the point; the reason is.
 */
function explain({ reporters, reports, messages, reasons, worst, flags }) {
  if (!reports) {
    return `nobody has reported this room; ${flags} message${flags === 1 ? '' : 's'} matched the word list, which is only a hint`;
  }

  const people = reporters === 1 ? 'one person' : `${reporters} different people`;
  const count = reports === 1 ? 'once' : `${reports} times`;
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const about = REASONS[top]?.says ?? top;

  let sentence = `${people} reported this ${count}, mostly about ${about}`;
  if (messages) sentence += `, out of ${messages} message${messages === 1 ? '' : 's'}`;
  if (reporters === 1 && reports > 2) {
    sentence += ' — all from the same person, which can mean a problem or a grudge';
  }
  if (worst >= 3) sentence += '. At least one report is of the most serious kind';
  return `${sentence}.`;
}
