/**
 * Words only.
 *
 * No pictures and no pictographs: not an image, not a link that is really an
 * image, not a smiling face. This is a place for saying things, and the rule
 * is easier to hold to than to argue about at the edges, so it is enforced in
 * one place and tested rather than left to everybody's good intentions.
 *
 * Two reasons it is written as *removal* rather than *refusal*. Rejecting a
 * message because one character in it was a pictograph loses the whole message
 * over a rounding error in somebody's keyboard. And silently changing what a
 * person said is worse than either, so the client cleans the box before
 * anything is sent, showing exactly what will go, and the server cleans again
 * on arrival because a client is only ever a suggestion.
 */

/**
 * The invisible pieces emoji are assembled from, by number rather than by
 * character.
 *
 * The variation selector that makes a character render as emoji, the combining
 * keycap that turns a digit into a button, and the joiner that welds two emoji
 * into a third. Written as codepoints deliberately: a file that forbids
 * pictographs should not itself need to contain three of them, and the check
 * that none appear anywhere in the product would otherwise have to carve out
 * an exception for the rule.
 */
const ASSEMBLY = [0xfe0f, 0x20e3, 0x200d].map((c) => String.fromCodePoint(c)).join('');

/**
 * Pictographs, in all the forms they arrive in. `Extended_Pictographic` is the
 * broad category and covers the great majority; the rest are the assembly
 * pieces above, and the paired regional indicators that make a flag.
 */
const CATEGORIES = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}/u;
const PICTOGRAPH = new RegExp(`${CATEGORIES.source}|[${ASSEMBLY}]`, 'gu');

/** Markdown images, HTML images, and links that are an image by another name. */
const IMAGE_MARKUP = [
  /!\[[^\]]*\]\([^)]*\)/g,
  /<img\b[^>]*>/gi,
  /<picture\b[\s\S]*?<\/picture>/gi,
  /<svg\b[\s\S]*?<\/svg>/gi,
  /\bdata:image\/[^\s"'<>]+/gi,
  /\bhttps?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)\b\S*/gi,
];

/** Whether there is anything here that is not words. */
export const hasPictographs = (text) => {
  PICTOGRAPH.lastIndex = 0;
  return PICTOGRAPH.test(String(text ?? ''));
};

/**
 * Take out everything that is not words, and say what was taken.
 *
 * Returns the cleaned text along with counts, so an interface can tell
 * somebody what happened to their message rather than quietly editing it.
 */
export function plain(text) {
  const before = String(text ?? '');
  let images = 0;
  let working = before;

  for (const pattern of IMAGE_MARKUP) {
    working = working.replace(pattern, () => {
      images += 1;
      return '';
    });
  }

  let emoji = 0;
  PICTOGRAPH.lastIndex = 0;
  working = working.replace(PICTOGRAPH, () => {
    emoji += 1;
    return '';
  });

  // Taking something out of the middle of a sentence leaves the gap behind.
  const cleaned = working.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/gm, '').trim();

  return {
    text: cleaned,
    emoji,
    images,
    changed: cleaned !== before.trim(),
    /** Nothing but pictures: there is no message left to send. */
    empty: cleaned.length === 0,
  };
}

/** What to tell somebody whose message was cleaned, or null if it was not. */
export function saidAbout({ emoji, images, empty }) {
  if (empty && (emoji || images)) return 'That is only pictures, and this place is words only.';
  const parts = [];
  if (emoji) parts.push(`${emoji} emoji`);
  if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`);
  if (!parts.length) return null;
  return `${parts.join(' and ')} removed: this place is words only.`;
}
