/**
 * The atlas: many subjects, exactly the occupied regions, drawn to scale.
 *
 * Anchored to a knowledge hierarchy so it keeps its shape as people come and
 * go, and optionally grown along a Physarum model so the ground runs the way
 * the community does.
 *
 *   node examples/4-the-atlas.mjs
 */
import { writeFileSync } from 'node:fs';
import { atlas, zones, toSVG, radialLayout, anchorsFor, knowledge } from 'eulerchat';

const people = (n, subjects) => Array.from({ length: n }, () => new Set(subjects));
const subjects = ['entomology', 'mycology', 'topology'];

const crowd = [
  ...people(20, ['entomology']), ...people(16, ['mycology']), ...people(12, ['topology']),
  ...people(8, ['entomology', 'mycology']), ...people(3, ['mycology', 'topology']),
];

const map = atlas(zones(crowd, subjects), {
  anchors: anchorsFor(subjects, radialLayout(knowledge)),
  mold: { generations: 120, agents: 2000 },
});

writeFileSync('atlas.svg', toSVG(map, { title: 'an atlas', background: true, size: 1200 }));

console.log('rooms:', map.zones.length);
console.log('exact:', map.report.exact, '(no region drawn that nobody occupies, none lost)');
console.log('every subject in one piece:', map.report.wellFormed);
console.log('the mould joined:', map.network.map((e) => e.subjects.join('~')).join(', ') || 'nothing');
