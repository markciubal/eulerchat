/**
 * Statistics about this place, worked out here, from what this page can see.
 *
 * Nothing is asked of the server for these: every number below comes out of
 * frames the page already has — the catalogue it drew All interests from, the
 * map it is looking at, and what this browser has written to its own disk. The
 * working is handed back with the answers (`log`), so the numbers can be
 * checked rather than believed, and so it is plain which of them are counts
 * and which are arithmetic on counts.
 *
 * Two kinds of honesty matter more here than any statistic:
 *
 * - **What cannot be known from here is said, not guessed.** The server's disk,
 *   how many people there are, what is in a chat nobody on this page is in:
 *   the page has no way to see any of that, so it reports none of it. A number
 *   invented to fill a row is worse than an empty row.
 * - **People are not holdings.** Adding up how many hold each interest counts
 *   one person once per interest they hold. It is a useful number and it is
 *   not a population, and it is labelled as what it is.
 */

/** A size in bytes, as somebody would say it. */
export const inBytes = (n) =>
  n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1000).toFixed(1)} kB` : `${(n / 1e6).toFixed(2)} MB`;

const tally = (numbers) => numbers.reduce((sum, n) => sum + n, 0);
const most = (list, by) => list.reduce((best, one) => (best === null || by(one) > by(best) ? one : best), null);
const count = (n) => n.toLocaleString();

/**
 * @param {object} seen  what the page has in hand
 * @param {object} [seen.chart]  the last `chart` frame, if All interests was opened
 * @param {object} [seen.atlas]  the last `atlas` frame: the map being looked at
 * @param {object} [seen.branch]  the branch being looked at, if any
 * @param {Record<string, number>} [seen.lurkers]  by room
 * @param {Array<[string, string]>} [seen.storage]  this browser's own keys and values
 * @param {string[]} [seen.subscription]  the interests held here
 * @returns {{rows: Array<{label: string, value: string, note?: string}>, log: string[], missing: string[]}}
 */
export function statistics({ chart = null, atlas = null, branch = null, lurkers = {}, storage = [], subscription = [] } = {}) {
  const rows = [];
  const log = [];
  const missing = [];
  const say = (label, value, note) => rows.push({ label, value, ...(note ? { note } : {}) });

  // --- the catalogue, from the sheet All interests is drawn from -------------
  if (chart?.subjects?.length) {
    const subjects = chart.subjects;
    const held = subjects.filter((s) => s.n > 0);
    const holdings = tally(subjects.map((s) => s.n ?? 0));
    const biggest = most(held, (s) => s.n);
    const liveliest = most(subjects.filter((s) => s.a), (s) => s.a);
    log.push(`chart frame (shape ${chart.shape ?? '?'}) · ${count(subjects.length)} interests`);
    log.push(`  with anybody in them: ${count(held.length)} of ${count(subjects.length)}`);
    log.push(`  holdings added up: ${count(holdings)} = sum of each interest's holders`);
    say('Interests in the catalogue', count(subjects.length));
    say('Interests anybody holds', count(held.length), `${Math.round((held.length / subjects.length) * 100)}% of the catalogue`);
    say('Holdings, added up', count(holdings), 'one person counted once per interest they hold, so not a population');
    if (biggest) say('Most held', biggest.id, `${count(biggest.n)} people`);
    if (liveliest) say('Liveliest interest', liveliest.id, `${liveliest.a.toFixed(2)} against the liveliest anywhere`);
    if (chart.communities?.length) {
      const big = most(chart.communities, (c) => c.size);
      log.push(`  communities: ${count(chart.communities.length)}, biggest ${big.size}`);
      say('Communities', count(chart.communities.length), `biggest: ${big.name.join(', ')} (${big.size} interests)`);
    }
    if (chart.links?.length) say('Pairs held together', count(chart.links.length), 'interests two or more people hold both of');
  } else {
    missing.push('the catalogue: open All interests once and these fill in');
    log.push('chart frame · not fetched yet, so nothing about the catalogue');
  }

  // --- the map in front of this page ----------------------------------------
  const view = branch ?? atlas;
  const rooms = (view?.rooms ?? []).filter((r) => !r.offMap);
  if (rooms.length) {
    const populations = rooms.map((r) => r.population ?? 0);
    const people = tally(populations);
    const average = people / rooms.length;
    const yours = rooms.filter((r) => r.member).length;
    const messages = tally(rooms.map((r) => r.messages ?? 0));
    const busiest = most(rooms, (r) => r.population ?? 0);
    const liveliest = most(rooms, (r) => r.activity ?? 0);
    const watching = tally(Object.values(lurkers ?? {}));
    log.push(`${branch ? 'branch' : 'atlas'} frame (shape ${view.shape ?? '?'}) · ${count(rooms.length)} chats drawn`);
    log.push(`  populations: ${populations.slice(0, 6).join(', ')}${populations.length > 6 ? ', …' : ''}`);
    log.push(`  average per chat: ${count(people)} ÷ ${count(rooms.length)} = ${average.toFixed(1)}`);
    log.push(`  messages held in them: ${count(messages)} (the last twelve hours, and 500 a chat at most)`);
    say('Chats on this map', count(rooms.length), `${count(yours)} of them yours`);
    say('People in them, added up', count(people), 'somebody in two of these chats is counted twice');
    say('Average people per chat', average.toFixed(1), `${count(people)} ÷ ${count(rooms.length)}`);
    say('Busiest chat', busiest.subjects.join(' + '), `${count(busiest.population)} people`);
    if (liveliest?.activity) say('Liveliest chat', liveliest.subjects.join(' + '), `${liveliest.activity.toFixed(2)} against the liveliest anywhere`);
    say('Messages held here', count(messages), 'in the chats on this map, for twelve hours each');
    if (watching) say('Lurking in them', count(watching), 'a count the server keeps; never who');
  } else {
    missing.push('the map: join an interest, or populate the place, and these fill in');
    log.push('atlas frame · no chats drawn, so nothing about a map');
  }
  if (subscription.length) say('Interests you hold', count(subscription.length));

  // --- what this browser keeps on its own disk -------------------------------
  const bytes = tally(storage.map(([key, value]) => (key.length + String(value ?? '').length) * 2));
  const biggest = most(storage, ([key, value]) => (key.length + String(value ?? '').length) * 2);
  log.push(`this browser · ${count(storage.length)} keys, ${inBytes(bytes)} (two bytes a character, as a browser stores them)`);
  if (biggest) log.push(`  the largest: ${biggest[0]}, ${inBytes((biggest[0].length + String(biggest[1] ?? '').length) * 2)}`);
  say('Kept on this device', inBytes(bytes), `${count(storage.length)} keys in this browser's own storage`);
  if (biggest) say('Largest of them', biggest[0], inBytes((biggest[0].length + String(biggest[1] ?? '').length) * 2));

  // --- and what is not visible from here -------------------------------------
  log.push('not visible from here · the server’s disk and memory, how many people there are,');
  log.push('  anything said in a chat this page is not in, and anybody’s interests but your own');

  return { rows, log, missing };
}
