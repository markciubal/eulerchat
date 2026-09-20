/**
 * Colour, with no DOM in it.
 *
 * Lived in the browser bundle until the SVG writer needed the same hues; two
 * copies of "what colour is philosophy" is two answers waiting to disagree.
 */

/** Stable hue per subject, so a subject keeps its colour across reloads. */
export function hue(subject) {
  let h = 2166136261;
  for (let i = 0; i < subject.length; i++) {
    h ^= subject.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

/** Circular mean, so an overlap is tinted by everything that forms it. */
export function blend(subjects) {
  let x = 0;
  let y = 0;
  for (const s of subjects) {
    const a = (hue(s) * Math.PI) / 180;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const stroke = (subject) => `hsl(${hue(subject)} 58% 47%)`;

export const regionFill = (subjects) =>
  `hsl(${blend(subjects)} ${48 + subjects.length * 9}% ${58 - subjects.length * 7}%)`;

/** SVG ids have to survive subject names like "film noir". */
export const cssId = (s) => String(s).replace(/[^a-z0-9]/gi, '_');

/** Text going into markup rather than into a DOM node. */
export const escape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
