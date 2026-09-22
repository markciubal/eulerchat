import { parse } from './regions.js';

/**
 * Which interests go together: pairs that people hold both of, strongest
 * first.
 *
 * The census already knows this. It counts every region up to the highest
 * arity, and a region of two is the number of people who hold both of its
 * interests. So nothing is counted again here; the pairs are read off and
 * ranked.
 *
 * Ranked by the share of everybody holding either who holds both: people
 * holding both, over people holding one or the other. A raw count would say
 * only that two big interests are big, since some people in any crowd hold
 * both of any two things. As a share, two small interests held by the same
 * handful of people are as strongly linked as two big ones that always go
 * together.
 *
 * The share is worked out as if a few more people held one of the two and not
 * the other. Two people out of five holding both is a coincidence of two
 * people as often as it is a pattern, and taken at face value it put pairs
 * like that above organic and inorganic chemistry, which twenty-seven people
 * hold together. The few extra barely move a share made of dozens, and halve
 * one made of two.
 *
 * Every interest keeps its own strongest two, whatever else happens, and only
 * then do the rest compete for what room is left. Otherwise the busiest corner
 * of the catalogue would take all of it, and an interest that is only ever
 * held with one other would be drawn with nothing. The cap is on the rest, not
 * on those: an interest's strongest link is usually weak beside the crowd's,
 * so a cap over everything cut exactly the links this is here to keep. What
 * is kept that way is at most two for every interest; at a thousand
 * interests, about twelve hundred links.
 *
 * A pair nobody but one person holds is never a link. That is not an
 * association but one person's choice of two interests. Drawn on a sheet
 * everyone can open, it would say what that one person holds, and this place
 * does not say what anybody holds.
 *
 * @param {Map<string, number>} counts  the census: region key to how many hold all of it
 * @param {object} [options]
 * @param {(subject: string) => boolean} [options.open]  which interests may be linked at all
 * @param {number} [options.least]  the fewest people who must hold both
 * @param {number} [options.each]  how many of its strongest each interest keeps, whatever the cap
 * @param {number} [options.most]  how many links to make up to with the strongest of the rest
 * @param {number} [options.doubt]  the few more people the share is taken as if it had
 * @returns {Array<[string, string, number, number]>}  both interests, how many hold both, and the
 *   share; strongest first
 */
export function associations(
  counts,
  { open = () => true, least = 2, each = 2, most = 1500, doubt = 5 } = {},
) {
  const holders = new Map();
  for (const [k, n] of counts) {
    const tags = parse(k);
    if (tags.length === 1) holders.set(tags[0], n);
  }

  const pairs = [];
  for (const [k, both] of counts) {
    if (both < least) continue;
    const tags = parse(k);
    if (tags.length !== 2) continue;
    const [a, b] = tags;
    if (!open(a) || !open(b)) continue;
    const either = (holders.get(a) ?? both) + (holders.get(b) ?? both) - both;
    pairs.push({ a, b, both, share: both / (either + doubt) });
  }
  pairs.sort(
    (p, q) => q.share - p.share || q.both - p.both || p.a.localeCompare(q.a) || p.b.localeCompare(q.b),
  );

  // Each interest's own strongest, uncapped; then the best of what is left,
  // up to the cap.
  const kept = new Set();
  const taken = new Map();
  for (const pair of pairs) {
    if ((taken.get(pair.a) ?? 0) >= each && (taken.get(pair.b) ?? 0) >= each) continue;
    kept.add(pair);
    taken.set(pair.a, (taken.get(pair.a) ?? 0) + 1);
    taken.set(pair.b, (taken.get(pair.b) ?? 0) + 1);
  }
  for (const pair of pairs) {
    if (kept.size >= most) break;
    kept.add(pair);
  }

  return pairs
    .filter((pair) => kept.has(pair))
    .map(({ a, b, both, share }) => [a, b, both, Math.round(share * 1000) / 1000]);
}
