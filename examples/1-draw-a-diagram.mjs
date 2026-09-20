/**
 * Draw an area-proportional Euler diagram from set data.
 *
 * No server, no DOM, no dependencies. The chat application is one caller of
 * this; anything with sets is another.
 *
 *   node examples/1-draw-a-diagram.mjs
 */
import { writeFileSync } from 'node:fs';
import { census, layout, toSVG } from 'eulerchat';

// Whatever your sets are. Here, who reads which journals.
const readers = [
  new Set(['nature']), new Set(['nature']), new Set(['nature', 'cell']),
  new Set(['cell']), new Set(['cell', 'lancet']), new Set(['lancet']),
  new Set(['nature', 'cell', 'lancet']),
];

const drawn = layout(census(readers));
writeFileSync('journals.svg', toSVG(drawn, { title: 'who reads what', background: true }));

// It also says how far it can be trusted, which most layout engines will not.
console.log('faithful:', drawn.fit.faithful);
console.log('worst region:', drawn.fit.worst?.key, `off by ${(drawn.fit.worstError * 100).toFixed(1)}%`);
console.log('regions drawn that nobody occupies:', drawn.fit.phantoms.length);
