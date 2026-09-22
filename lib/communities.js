/**
 * Communities: interests that the same people turn up to together.
 *
 * The hierarchy says what an interest is. This says who comes with it: the
 * links All interests already draws — pairs of interests that people hold
 * both of, weighted by how strongly (see `lib/association.js`) — gathered into
 * groups that are held with each other more than with anything else. Guitar,
 * piano and drumming land in one because the same people hold them, and so,
 * in the right crowd, do history, hiking and climbing, which the hierarchy
 * puts in three different places.
 *
 * Found by the Louvain method: every interest starts alone, each in turn goes
 * to whichever neighbouring group gains the most by having it, and when
 * nothing moves any more each group is folded into one node and it starts
 * again, until folding changes nothing. A thousand interests take a few
 * dozen milliseconds. Every order it goes in is fixed, so the same links give
 * the same communities every time, on every server.
 *
 * Built from nothing but the links, so it says nothing the links do not. A
 * link needs two people holding both, and only the open world is linked; a
 * community is only ever a way of reading those. They are called communities
 * because "cluster" here already means a private group; see `lib/cluster.js`.
 */

/** How many rounds of folding at most; it settles in four or five. */
const LEVELS = 12;

/** How many interests a community is named by. */
const NAMED_BY = 3;

/**
 * Group the links into communities.
 *
 * @param {Array<[string, string, number, number]>} links  from `associations`: both
 *   interests, how many hold both, and the share, which is the weight
 * @param {Map<string, number>} [population]  how many hold each interest, for naming
 * @returns {{
 *   list: Array<{lead: string, name: string[], members: string[], near: number[]}>,
 *   of: Map<string, number>,
 * }}  the communities, largest first, each named by its most-held interests and
 *   with the others nearest it, nearest first; and which one each interest is in
 */
export function communities(links, population = new Map()) {
  // Who is linked to whom, and how strongly, both ways round.
  let graph = new Map();
  const tie = (g, a, b, w) => {
    if (!g.has(a)) g.set(a, new Map());
    g.get(a).set(b, (g.get(a).get(b) ?? 0) + w);
  };
  for (const [a, b, , share] of links) {
    if (a === b || !(share > 0)) continue;
    tie(graph, a, b, share);
    tie(graph, b, a, share);
  }

  // Which interests each node of the graph stands for: itself, to start with.
  let holds = new Map([...graph.keys()].map((n) => [n, [n]]));

  for (let level = 0; level < LEVELS; level++) {
    const { groupOf, changed } = settle(graph);
    if (!changed) break;

    // Each group, folded into one node standing for everything it held.
    const folded = new Map();
    const held = new Map();
    for (const node of [...graph.keys()].sort()) {
      const group = groupOf.get(node);
      held.set(group, [...(held.get(group) ?? []), ...holds.get(node)]);
      if (!folded.has(group)) folded.set(group, new Map());
      for (const [other, w] of graph.get(node)) tie(folded, group, groupOf.get(other), w);
    }
    graph = folded;
    holds = held;
  }

  const size = (s) => population.get(s) ?? 0;
  const byHolding = (a, b) => size(b) - size(a) || (a < b ? -1 : a > b ? 1 : 0);
  const list = [...holds.values()]
    .map((members) => members.sort(byHolding))
    .sort((a, b) => b.length - a.length || byHolding(a[0], b[0]))
    .map((members) => ({ lead: members[0], name: members.slice(0, NAMED_BY), members, near: [] }));

  const of = new Map();
  list.forEach((c, i) => {
    for (const s of c.members) of.set(s, i);
  });

  // The others each is most linked with, by everything that links them.
  const between = list.map(() => new Map());
  for (const [a, b, , share] of links) {
    const [i, j] = [of.get(a), of.get(b)];
    if (i === undefined || j === undefined || i === j) continue;
    between[i].set(j, (between[i].get(j) ?? 0) + share);
    between[j].set(i, (between[j].get(i) ?? 0) + share);
  }
  list.forEach((c, i) => {
    c.near = [...between[i]].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([j]) => j);
  });

  return { list, of };
}

/**
 * One pass of moving nodes between groups until none gains by moving.
 *
 * The gain is modularity's: how much more a node is linked into a group than
 * the group's share of all the linking would give it by chance. Nodes are
 * visited in a fixed order and a tie keeps a node where it is, so a pass on
 * the same graph always ends the same way.
 */
function settle(graph) {
  const nodes = [...graph.keys()].sort();
  const degree = new Map(nodes.map((n) => [n, sum(graph.get(n).values())]));
  const total = sum(degree.values());
  const groupOf = new Map(nodes.map((n) => [n, n]));
  const weightOf = new Map(degree);
  let changed = false;
  if (!total) return { groupOf, changed };

  for (let moved = true; moved; ) {
    moved = false;
    for (const node of nodes) {
      const own = groupOf.get(node);
      const k = degree.get(node);
      weightOf.set(own, weightOf.get(own) - k);

      const into = new Map();
      for (const [other, w] of graph.get(node)) {
        if (other === node) continue;
        const group = groupOf.get(other);
        into.set(group, (into.get(group) ?? 0) + w);
      }
      let best = own;
      let gain = (into.get(own) ?? 0) - (weightOf.get(own) * k) / total;
      for (const [group, w] of into) {
        const g = w - (weightOf.get(group) * k) / total;
        if (g > gain + 1e-12) {
          gain = g;
          best = group;
        }
      }
      weightOf.set(best, weightOf.get(best) + k);
      if (best !== own) {
        groupOf.set(node, best);
        moved = true;
        changed = true;
      }
    }
  }
  return { groupOf, changed };
}

function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
