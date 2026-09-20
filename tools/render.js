/**
 * Render a diagram to PNG without a browser.
 *
 * The rendering code was written to run in a page, and for a long time nothing
 * had ever looked at its output — the tests could confirm that clip paths
 * resolved and that every room owned clickable ground, but not whether the
 * result was legible. This drives the same render functions through a DOM
 * shim, applies the stylesheet as presentation attributes (the rasteriser's
 * CSS support is thinner than a browser's), and rasterises.
 *
 *   node tools/render.js [out-dir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { Resvg } from '@resvg/resvg-js';
import { World, seed } from '../server/store.js';
import { populate } from '../server/populate.js';
import { renderDiagram } from '../public/diagram.js';
import { renderAtlas } from '../public/atlasview.js';

const NS = 'http://www.w3.org/2000/svg';
const OUT = process.argv[2] ?? path.join(process.cwd(), 'renders');
const SIZE = 900;

const INK = '#1c1b19';
const MUTED = '#6b6862';
const PANEL = '#ffffff';

/** The stylesheet, as attributes — one place, so it cannot drift silently. */
const STYLES = {
  ring: { fill: 'none', 'stroke-width': 1.5 },
  'ring mine': { fill: 'none', 'stroke-width': 2.5 },
  'ring suggested': { fill: 'none', 'stroke-width': 1.5, 'stroke-dasharray': '5 4', opacity: 0.75 },
  'region-fill': {},
  label: { 'font-size': 15, 'font-weight': 600, 'text-anchor': 'middle', fill: INK },
  'label-count': { 'font-size': 12, 'text-anchor': 'middle', fill: MUTED },
  territory: { 'fill-opacity': 0.13, 'stroke-width': 2.5, 'stroke-linejoin': 'round' },
  'territory mine': { 'fill-opacity': 0.2, 'stroke-width': 4, 'stroke-linejoin': 'round' },
  'atlas-label': {
    'font-size': 20,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    fill: INK,
    'paint-order': 'stroke',
    stroke: PANEL,
    'stroke-width': 4,
    'stroke-linejoin': 'round',
  },
  'zone-label': {},
  'atlas-label mine': {
    'font-size': 20,
    'font-weight': 700,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    fill: INK,
    'paint-order': 'stroke',
    stroke: PANEL,
    'stroke-width': 4,
    'stroke-linejoin': 'round',
  },
};

function applyStyles(svg) {
  for (const node of svg.querySelectorAll('[class]')) {
    const rules = STYLES[node.getAttribute('class')];
    if (!rules) continue;
    for (const [prop, value] of Object.entries(rules)) {
      if (!node.hasAttribute(prop)) node.setAttribute(prop, String(value));
    }
  }
  // Overlap labels are styled by a descendant selector, which the attribute
  // pass above cannot express.
  for (const text of svg.querySelectorAll('.zone-label text')) {
    for (const [prop, value] of Object.entries({
      'font-size': 15,
      'font-weight': 700,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      fill: INK,
      'paint-order': 'stroke',
      stroke: PANEL,
      'stroke-width': 3.5,
      'stroke-linejoin': 'round',
    })) {
      text.setAttribute(prop, String(value));
    }
  }
}

function rasterise(svg, file, label) {
  applyStyles(svg);
  svg.setAttribute('width', SIZE);
  svg.setAttribute('height', SIZE);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const png = new Resvg(svg.outerHTML, {
    background: PANEL,
    fitTo: { mode: 'width', value: SIZE },
    font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' },
  })
    .render()
    .asPng();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  console.log(`${label} -> ${path.relative(process.cwd(), file)} (${(png.length / 1024).toFixed(0)}KB)`);
}

const blank = () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  document.body.append(svg);
  return svg;
};

// --- the pictures ---------------------------------------------------------

const small = seed(new World());
const guest = small.addUser('guest');
const joiner = small.addUser('joiner');
small.join(joiner, 'art');
small.join(joiner, 'philosophy');

{
  const svg = blank();
  renderDiagram(svg, small.diagramFor(guest));
  rasterise(svg, path.join(OUT, 'map-guest.png'), 'circle map, newcomer');
}
{
  const svg = blank();
  renderDiagram(svg, small.diagramFor(joiner));
  rasterise(svg, path.join(OUT, 'map-member.png'), 'circle map, holding two');
}
{
  const svg = blank();
  renderAtlas(svg, small.atlasFor(joiner, 3));
  rasterise(svg, path.join(OUT, 'atlas-3.png'), 'atlas, 3 subjects');
}

const big = populate(new World(), { subjects: 1000, users: 4000, chatter: 0 });
const visitor = big.addUser('visitor');

for (const n of [5, 8]) {
  const svg = blank();
  const view = big.atlasFor(visitor, n);
  renderAtlas(svg, view);
  rasterise(svg, path.join(OUT, `atlas-${n}.png`), `atlas, ${n} subjects (${view.zones.length} rooms)`);
}

{
  // The case circles cannot draw honestly: every pair meets, nobody holds all
  // three, so a phantom room appears where the three overlap.
  const awkward = new World();
  for (const s of ['art', 'philosophy', 'music']) awkward.addSubject(s);
  const add = (n, subjects) => {
    for (let i = 0; i < n; i++) {
      const u = awkward.addUser(`p${i}${subjects.join()}`);
      for (const s of subjects) awkward.join(u, s);
    }
  };
  add(12, ['art']); add(12, ['philosophy']); add(12, ['music']);
  add(6, ['art', 'philosophy']); add(6, ['art', 'music']); add(6, ['music', 'philosophy']);

  const watcher = awkward.addUser('watcher');
  const svg = blank();
  const view = awkward.diagramFor(watcher);
  renderDiagram(svg, view);
  rasterise(svg, path.join(OUT, 'map-phantom.png'), `circle map with a phantom (${view.fit.phantoms.length})`);
}

// --- the knowledge hierarchy and the mould --------------------------------

{
  const { radialLayout, anchorsFor } = await import('../lib/taxonomy.js');
  const { knowledge } = await import('../lib/knowledge.js');
  const { zones } = await import('../lib/regions.js');
  const { atlas } = await import('../lib/atlas.js');

  const positions = radialLayout(knowledge);
  const subjects = ['entomology', 'mycology', 'topology', 'jazz', 'ethics'];
  const anchors = anchorsFor(subjects, positions);

  const people = (n, s) => Array.from({ length: n }, () => new Set(s));
  const crowd = [
    ...people(20, ['entomology']), ...people(16, ['mycology']), ...people(14, ['topology']),
    ...people(12, ['jazz']), ...people(10, ['ethics']),
    ...people(9, ['entomology', 'mycology']), ...people(5, ['topology', 'ethics']),
    ...people(4, ['jazz', 'ethics']), ...people(3, ['entomology', 'topology']),
  ];
  const counts = zones(crowd, subjects);

  {
    const svg = blank();
    renderAtlas(svg, { ...atlas(counts, { anchors }), subscription: [] });
    rasterise(svg, path.join(OUT, 'atlas-anchored.png'), 'atlas, anchored to hierarchy');
  }

  const grown = atlas(counts, { anchors, mold: { generations: 140, agents: 2600 } });
  {
    const svg = blank();
    renderAtlas(svg, { ...grown, subscription: [] });
    rasterise(svg, path.join(OUT, 'atlas-mold.png'), 'atlas, grown along the mould');
  }
  console.log(`  mould joined: ${grown.network.map((e) => e.subjects.join('~')).join(', ')}`);

  // And the trail field itself, so the network is visible rather than inferred.
  {
    const { weave } = await import('../lib/mold.js');
    const weight = new Map(subjects.map((s) => [s, counts.get(s) ?? 1]));
    const affinity = [...counts]
      .filter(([k]) => k.includes('+'))
      .map(([k, n]) => [...k.split('+'), n]);

    const mould = weave({ anchors, weight, affinity, generations: 140, agents: 2600, extent: 1000 });
    const field = mould.field();
    const g = mould.grid;
    const cell = 1000 / g;

    const svg = blank();
    svg.setAttribute('viewBox', '-500 -500 1000 1000');
    for (let y = 0; y < g; y++) {
      for (let x = 0; x < g; x++) {
        const v = field[y * g + x];
        if (v < 0.015) continue;
        const r = doc(svg).createElementNS(NS, 'rect');
        r.setAttribute('x', (x * cell - 500).toFixed(1));
        r.setAttribute('y', (y * cell - 500).toFixed(1));
        r.setAttribute('width', cell.toFixed(2));
        r.setAttribute('height', cell.toFixed(2));
        const shade = Math.pow(v, 0.4);
        r.setAttribute('fill', `hsl(${188 - shade * 160} 72% ${92 - shade * 58}%)`);
        svg.append(r);
      }
    }
    for (const [name, at] of anchors) {
      const t = doc(svg).createElementNS(NS, 'text');
      t.setAttribute('x', at.x);
      t.setAttribute('y', at.y);
      t.setAttribute('class', 'atlas-label');
      t.textContent = name;
      svg.append(t);
    }
    rasterise(svg, path.join(OUT, 'mold-field.png'), 'the mould network itself');
  }
}

function doc(node) {
  return node.ownerDocument;
}

// --- the minimap ----------------------------------------------------------

{
  const { renderMinimap } = await import('../public/minimap.js');
  const wide = populate(new World(), { subjects: 209, users: 2500, chatter: 0 });
  const me = wide.addUser('me');
  const picked = [...wide.index().popular].slice(0, 3);
  for (const s of picked) wide.join(me, s);

  const svg = blank();
  renderMinimap(svg, wide.overview(), { mine: picked });
  for (const dot of svg.querySelectorAll('.dot.mine')) {
    dot.setAttribute('stroke', INK);
    dot.setAttribute('stroke-width', 6);
  }
  for (const frame of svg.querySelectorAll('.here')) {
    frame.setAttribute('fill', 'none');
    frame.setAttribute('stroke', '#3a6ea5');
    frame.setAttribute('stroke-width', 8);
    frame.setAttribute('stroke-dasharray', '18 12');
  }
  rasterise(svg, path.join(OUT, 'minimap.png'), `minimap (${wide.overview().subjects.length} subjects)`);
}
