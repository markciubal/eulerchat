/**
 * Diagrams as SVG text.
 *
 * The geometry was usable by anyone from the start; the drawing was not — it
 * only existed as DOM calls inside the browser bundle, so getting a picture
 * out of this package meant supplying a DOM. Most callers want the picture.
 *
 * Everything here is string building with no dependencies and no document, so
 * the output can go to a file, an `<img>`, an HTTP response or a rasteriser.
 * Styling is inlined as presentation attributes rather than a stylesheet, for
 * the same reason: a fragment that needs a CSS file to look right is not
 * self-contained.
 */

import { blend, cssId, escape, hue, regionFill, stroke } from './palette.js';

const fixed = (n) => Number(n.toFixed(2));

const THEMES = {
  light: { ink: '#1c1b19', muted: '#6b6862', paper: '#ffffff' },
  dark: { ink: '#e8e6e2', muted: '#979390', paper: '#1f2023' },
};

/**
 * Render a diagram from `layout()` or `atlas()` to a standalone SVG string.
 *
 * @param {object} diagram  a layout result (has `circles`) or an atlas (has `curves`)
 * @param {object} [options]
 * @param {number} [options.size=800]        pixel width and height of the root element
 * @param {boolean} [options.labels=true]    draw subject names and populations
 * @param {boolean} [options.background=false] paint the paper colour behind it
 * @param {'light'|'dark'} [options.theme='light']
 * @param {string} [options.title]           an accessible name for the figure
 * @returns {string}
 */
export function toSVG(diagram, options = {}) {
  if (diagram?.curves) return atlasSVG(diagram, options);
  if (diagram?.circles) return circlesSVG(diagram, options);
  throw new TypeError('toSVG expects the result of layout() or atlas()');
}

function open({ view, size, background, theme, title }) {
  const paper = THEMES[theme].paper;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" ` +
    `width="${size}" height="${size}" role="img"` +
    (title ? ` aria-label="${escape(title)}"` : '') +
    `>` +
    (title ? `<title>${escape(title)}</title>` : '') +
    (background ? `<rect x="-99999" y="-99999" width="199998" height="199998" fill="${paper}"/>` : '')
  );
}

const label = (text, x, y, { size, fill, weight = 600, halo }) =>
  `<text x="${fixed(x)}" y="${fixed(y)}" text-anchor="middle" font-size="${size}" ` +
  `font-weight="${weight}" font-family="ui-sans-serif, system-ui, sans-serif" fill="${fill}"` +
  (halo ? ` paint-order="stroke" stroke="${halo}" stroke-width="4" stroke-linejoin="round"` : '') +
  `>${escape(text)}</text>`;

// --- circles ---------------------------------------------------------------

function circlesSVG(diagram, options) {
  const { size = 800, labels = true, background = false, theme = 'light', title } = options;
  const { circles, bounds, subscription = [] } = diagram;

  // `rooms` is added by the chat server; a bare `layout()` result carries the
  // same list as `fit.regions`. Reading only the first meant the natural call —
  // toSVG(layout(census(data))) — drew outlines with no overlaps shaded and
  // said nothing about why.
  const rooms = diagram.rooms ?? diagram.fit?.regions ?? [];
  const colours = THEMES[theme];
  if (!circles.length) return open({ view: '0 0 1 1', size, background, theme, title }) + '</svg>';

  const pad = 34;
  const vb = {
    x: bounds.minX - pad,
    y: bounds.minY - pad,
    w: Math.max(bounds.width + pad * 2, 1),
    h: Math.max(bounds.height + pad * 2, 1),
  };

  const out = [open({ view: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`, size, background, theme, title })];
  const box = `x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}"`;

  out.push('<defs>');
  for (const c of circles) {
    out.push(
      `<clipPath id="c-${cssId(c.id)}"><circle cx="${c.x}" cy="${c.y}" r="${c.r}"/></clipPath>`,
    );
  }
  // A region is its own circles intersected, minus every circle it excludes.
  for (const room of rooms) {
    const outsiders = circles.filter((c) => !room.subjects.includes(c.id));
    out.push(`<mask id="m-${cssId(room.key)}" maskUnits="userSpaceOnUse" ${box}>`);
    out.push(`<rect ${box} fill="white"/>`);
    for (const c of outsiders) out.push(`<circle cx="${c.x}" cy="${c.y}" r="${c.r}" fill="black"/>`);
    out.push('</mask>');
  }
  out.push('</defs>');

  for (const room of rooms) {
    const clips = room.subjects.map((s) => `<g clip-path="url(#c-${cssId(s)})">`).join('');
    out.push(
      `<g mask="url(#m-${cssId(room.key)})">${clips}` +
        `<rect ${box} fill="${regionFill(room.subjects)}" opacity="0.18"/>` +
        `</g>`.repeat(room.subjects.length) +
        `</g>`,
    );
  }

  const held = new Set(subscription);
  for (const c of circles) {
    out.push(
      `<circle cx="${c.x}" cy="${c.y}" r="${c.r}" fill="none" stroke="${stroke(c.id)}" ` +
        `stroke-width="${held.size && held.has(c.id) ? 2.5 : 1.5}"/>`,
    );
  }

  if (labels) {
    const cx = circles.reduce((s, c) => s + c.x, 0) / circles.length;
    const cy = circles.reduce((s, c) => s + c.y, 0) / circles.length;
    for (const c of circles) {
      let dx = c.x - cx;
      let dy = c.y - cy;
      const len = Math.hypot(dx, dy);
      if (circles.length === 1 || len < 1e-6) {
        dx = 0;
        dy = -1;
      } else {
        dx /= len;
        dy /= len;
      }
      const lx = c.x + dx * c.r * 0.66;
      const ly = c.y + dy * c.r * 0.66;
      out.push(label(c.id, lx, ly, { size: 15, fill: colours.ink }));
      out.push(label(String(c.population), lx, ly + 15, { size: 12, fill: colours.muted, weight: 400 }));
    }
  }

  out.push('</svg>');
  return out.join('');
}

// --- atlas -----------------------------------------------------------------

function atlasSVG(diagram, options) {
  const { size = 800, labels = true, background = false, theme = 'light', title } = options;
  const { curves, extent, subscription = [] } = diagram;
  const colours = THEMES[theme];
  if (!curves.length) return open({ view: '0 0 1 1', size, background, theme, title }) + '</svg>';

  const pad = extent * 0.05;
  const view = `${-extent / 2 - pad} ${-extent / 2 - pad} ${extent + pad * 2} ${extent + pad * 2}`;
  const out = [open({ view, size, background, theme, title })];
  const held = new Set(subscription);

  for (const curve of curves) {
    const d = curve.loops
      .map((loop) => `M${loop.map(([x, y]) => `${fixed(x)},${fixed(y)}`).join('L')}Z`)
      .join('');
    out.push(
      `<path d="${d}" fill-rule="evenodd" fill="${stroke(curve.subject)}" ` +
        `fill-opacity="${held.has(curve.subject) ? 0.2 : 0.13}" ` +
        `stroke="${stroke(curve.subject)}" stroke-width="${held.has(curve.subject) ? 4 : 2.5}" ` +
        // Plain alpha averages two opposite hues into grey, so the ground where
        // two subjects meet ends up looking switched off rather than shared.
        `stroke-linejoin="round" style="mix-blend-mode:multiply"/>`,
    );
  }

  if (labels) {
    for (const curve of curves) {
      const name = curve.components > 1 ? `${curve.subject} (${curve.components} parts)` : curve.subject;
      out.push(
        label(name, curve.anchor.x, curve.anchor.y, {
          size: 20,
          fill: colours.ink,
          weight: held.has(curve.subject) ? 700 : 600,
          halo: colours.paper,
        }),
      );
    }
  }

  out.push('</svg>');
  return out.join('');
}

export { blend, hue, regionFill, stroke };
