/**
 * How the place looks, as something a person can choose.
 *
 * The obvious way to build this is nine colour pickers, one per token, and it
 * is the way that lets somebody make their own interface unreadable in four
 * clicks: pale grey text on a pale grey panel is a perfectly valid pair of hex
 * codes. `palette.js` already met this problem with subject colours and its
 * answer was to hand over the hue and keep the lightness — "the one control
 * that can make their map illegible". This is the same answer, one level up.
 *
 * A scheme is a RECIPE, not a list of colours: light or dark, what the
 * surfaces are tinted with and how strongly, how bright the paper is, what hue
 * the highlights are, what the lettering and the corners are like. Every
 * colour on the page is then SOLVED from that — each one placed at a stated
 * contrast against the panel it will be read on, by the same search that
 * places a subject colour. The contrasts are the ones the two built-in themes
 * were measured at, so a scheme nobody has tried yet is as legible as the ones
 * somebody tuned by hand, and no position of any slider is a mistake.
 *
 * The twenty below are recipes like any other. They are a place to start from,
 * which is why they are here: a panel of sliders with nothing to compare
 * against is a chore, and a wall of presets with no sliders is a catalogue.
 *
 * Nothing in here touches a document. What to do with the answer — write it on
 * the root element, remember it in this browser — belongs to the page.
 */

import { DARKEST_PAPER, colourAt, luminance } from './palette.js';

// --- what a recipe may say --------------------------------------------------

/** The lettering, as stacks of what is already on the machine. Nothing is fetched. */
export const FACES = {
  standard: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  soft: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
  book: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, Cambria, serif',
  typewriter: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace',
};

/** Roundest corner on offer, in pixels. Nought is square. */
export const ROUNDEST = 16;

const DEFAULTS = {
  mode: 'light',
  tint: 80,
  wash: 0.25,
  paper: 0.9,
  accent: 255,
  face: 'standard',
  corners: 10,
  strong: false,
};

const wheel = (degrees) => (((Number(degrees) % 360) + 360) % 360);
const unit = (n) => Math.min(1, Math.max(0, Number(n)));
const round = (n) => Math.round(n * 100) / 100;

/**
 * A recipe with every field present and in range.
 *
 * Read back one field at a time and clamped, because a recipe comes out of
 * storage — put there by an earlier version of this code, or by hand, and
 * neither of those is a promise. Anything unusable is replaced by the default
 * for that field alone, so one bad number does not cost somebody the rest of
 * what they chose.
 */
export function tidy(recipe) {
  const given = recipe && typeof recipe === 'object' ? recipe : {};
  const number = (key, clamp) =>
    (Number.isFinite(Number(given[key])) && given[key] !== null && given[key] !== ''
      ? clamp(given[key])
      : DEFAULTS[key]);

  return {
    mode: given.mode === 'dark' ? 'dark' : given.mode === 'light' ? 'light' : DEFAULTS.mode,
    tint: round(number('tint', wheel)),
    wash: round(number('wash', unit)),
    paper: round(number('paper', unit)),
    accent: round(number('accent', wheel)),
    face: Object.hasOwn(FACES, given.face) ? given.face : DEFAULTS.face,
    corners: Math.round(number('corners', (n) => Math.min(ROUNDEST, Math.max(0, Number(n))))),
    strong: given.strong === true,
  };
}

// --- solving it -------------------------------------------------------------

/**
 * How bright the paper may be, at each end of the slider.
 *
 * Light paper stops at 0.8 because the subject colours have to stay readable
 * on it: `setPaper` brings them down to clear 3:1, and much below this they
 * run out of room to come down into and turn to mud. Dark paper stops short of
 * `DARKEST_PAPER` for the opposite reason, and short of it rather than at it
 * because a colour is rounded to eight bits per channel on the way out — down
 * there one step of green is a twentieth of the whole range, and a ceiling
 * set exactly at the limit is a ceiling some hues round over.
 */
const PAPER = {
  light: { from: 0.8, to: 1 },
  dark: { from: 0.002, to: DARKEST_PAPER * 0.92 },
};

/**
 * Where each colour sits against the panel, as a contrast ratio.
 *
 * Measured off the two built-in themes and then nudged up, never down. The
 * nudges are all for the same reason: text is read on `--raised` and `--bg` as
 * well as on `--panel`, and those sit a step away from it, so a colour placed
 * at exactly 4.5:1 against the panel is under 4.5:1 on one of the others. The
 * figure here is what it takes to clear the bar on all three.
 *
 * `edge` is the border of a field, and a field is `--bg` on a `--panel` — two
 * surfaces about 1.05:1 apart — so the border is the only thing saying where
 * the control is and has to clear 3:1 by itself.
 */
const AGAINST_PANEL = {
  normal: { line: 1.32, edge: 3.5, muted: 5.6, ink: { light: 15, dark: 13 }, accent: { light: 5.3, dark: 6.5 }, warn: { light: 5.6, dark: 7 } },
  strong: { line: 2, edge: 4.6, muted: 8.2, ink: { light: 19, dark: 18 }, accent: { light: 7.6, dark: 9 }, warn: { light: 7.6, dark: 9 } },
};

/** How far the other two surfaces sit from the panel, and on which side. */
const SURFACES = {
  // The page is a shade under the panels in both themes; a raised card is a
  // shade under white and a shade over black, since "raised" has to read as
  // nearer in both and nothing is nearer than white.
  light: { bg: -1.045, raised: -1.13 },
  dark: { bg: -1.09, raised: 1.1 },
};

/** The amber of a warning. Not a choice: it means something. */
const WARN_HUE = 65;

/** The luminance that stands at `ratio` to `paper`, towards ink or away from it. */
function apart(paper, ratio, brighter) {
  const at = brighter ? (paper + 0.05) * ratio - 0.05 : (paper + 0.05) / ratio - 0.05;
  return Math.min(1, Math.max(0, at));
}

/**
 * The nine colours of a recipe, as hex.
 *
 * The panel is solved first and then MEASURED, and everything else is placed
 * against the measurement rather than against what was asked for. The two are
 * not the same number — eight bits per channel is coarse at the dark end — and
 * a contrast ratio is only true of the colours that actually reach the screen.
 */
export function tokensOf(recipe) {
  const r = tidy(recipe);
  const dark = r.mode === 'dark';
  const want = AGAINST_PANEL[r.strong ? 'strong' : 'normal'];
  const range = PAPER[r.mode];

  // A tint is a small chroma, and near white the most a screen can show is
  // smaller still, so it is given way in small steps or it goes in one.
  const surface = (target, chroma) => colourAt(r.tint, target, chroma * r.wash, 0.0025);

  const panel = surface(range.from + (range.to - range.from) * r.paper, dark ? 0.04 : 0.05);
  const paper = luminance(panel);

  const step = (ratio) => apart(paper, Math.abs(ratio), ratio > 0);
  // Towards the ink: darker on light paper, brighter on dark.
  const towards = (ratio) => apart(paper, ratio, dark);

  return {
    bg: surface(step(SURFACES[r.mode].bg), dark ? 0.05 : 0.06),
    panel,
    raised: surface(step(SURFACES[r.mode].raised), dark ? 0.05 : 0.06),
    line: surface(towards(want.line), 0.035),
    edge: surface(towards(want.edge), 0.03),
    muted: surface(towards(want.muted), 0.025),
    ink: surface(towards(want.ink[r.mode]), 0.02),
    accent: colourAt(r.accent, towards(want.accent[r.mode]), 0.15),
    warn: colourAt(WARN_HUE, towards(want.warn[r.mode]), 0.12),
  };
}

/**
 * A recipe as the custom properties the stylesheet is written against.
 *
 * Small controls are rounded less than the panels they sit in, in proportion,
 * and a pill is a pill until the corners are nearly square — at which point a
 * fully round button in a square-cornered room is the one thing out of place,
 * so it squares off with everything else.
 */
export function styleOf(recipe) {
  const r = tidy(recipe);
  const tokens = tokensOf(r);
  const style = { 'color-scheme': r.mode };
  for (const [name, value] of Object.entries(tokens)) style[`--${name}`] = value;

  style['--radius'] = `${r.corners}px`;
  style['--radius-small'] = `${Math.round(r.corners * 0.7)}px`;
  style['--pill'] = r.corners < 4 ? `${r.corners}px` : '999px';
  style['--face'] = FACES[r.face];
  return style;
}

/** Every property `styleOf` sets, for taking a scheme off again. */
export const PROPERTIES = [
  'color-scheme', '--bg', '--panel', '--raised', '--line', '--edge', '--muted', '--ink',
  '--accent', '--warn', '--radius', '--radius-small', '--pill', '--face',
];

/** What the map is drawn on, for `setPaper`. */
export const paperOf = (recipe) => luminance(tokensOf(recipe).panel);

/**
 * A hue slider's track: the colours the slider actually chooses between.
 *
 * Solved at the brightness the highlight has in this recipe, so the track is
 * a row of the real answers rather than a generic rainbow that promises a
 * yellow the contrast rules will never hand over.
 */
export function wheelOf(recipe, stops = 12) {
  const { accent } = tokensOf(recipe);
  const at = luminance(accent);
  return Array.from({ length: stops + 1 }, (_, i) => colourAt((i * 360) / stops, at, 0.15));
}

// --- twenty to start from ---------------------------------------------------

/**
 * The built-in themes, as the stylesheet states them.
 *
 * Not recipes: these two were tuned by hand, they are what the page wears when
 * nobody has chosen anything, and they stay in the stylesheet where a page
 * with no script still gets them. They are repeated here only so that the
 * chooser can show what "match my system" looks like, and a test holds this
 * copy to the stylesheet so the two cannot drift.
 */
export const HOUSE = {
  light: {
    bg: '#fbfaf8', panel: '#ffffff', ink: '#1c1b19', muted: '#6b6862', line: '#e4e0d9',
    accent: '#3a6ea5', warn: '#9a5b18', raised: '#f4f1ec', edge: '#979084',
  },
  dark: {
    bg: '#17181a', panel: '#1f2023', ink: '#e8e6e2', muted: '#979390', line: '#32343a',
    accent: '#7aa7d9', warn: '#d8a15e', raised: '#26282c', edge: '#666a72',
  },
};

/**
 * Ten light and ten dark.
 *
 * Chosen to be far apart rather than to be complete: the point of a seed is to
 * show what a control does by having already moved it, so between them these
 * take every slider to both of its ends. Hues are OKLCH degrees, as they are
 * everywhere else here — 30 is red, 110 yellow, 145 green, 195 cyan, 265 blue,
 * 330 magenta.
 */
export const SCHEMES = [
  // --- light ---------------------------------------------------------------
  { id: 'paper', name: 'Paper', recipe: { mode: 'light', tint: 85, wash: 0.3, paper: 0.92, accent: 255, face: 'standard', corners: 10 } },
  { id: 'sepia', name: 'Sepia', recipe: { mode: 'light', tint: 75, wash: 1, paper: 0.3, accent: 40, face: 'book', corners: 6 } },
  { id: 'mint', name: 'Mint', recipe: { mode: 'light', tint: 160, wash: 0.8, paper: 0.6, accent: 165, face: 'standard', corners: 12 } },
  { id: 'rose', name: 'Rose', recipe: { mode: 'light', tint: 5, wash: 0.75, paper: 0.6, accent: 0, face: 'soft', corners: 16 } },
  { id: 'sky', name: 'Sky', recipe: { mode: 'light', tint: 235, wash: 0.8, paper: 0.65, accent: 250, face: 'standard', corners: 10 } },
  { id: 'lavender', name: 'Lavender', recipe: { mode: 'light', tint: 300, wash: 0.8, paper: 0.6, accent: 300, face: 'soft', corners: 14 } },
  { id: 'sand', name: 'Sand', recipe: { mode: 'light', tint: 95, wash: 0.9, paper: 0.45, accent: 140, face: 'standard', corners: 8 } },
  { id: 'newsprint', name: 'Newsprint', recipe: { mode: 'light', tint: 90, wash: 0.1, paper: 0.4, accent: 28, face: 'book', corners: 0 } },
  { id: 'ledger', name: 'Ledger', recipe: { mode: 'light', tint: 135, wash: 0.7, paper: 0.5, accent: 150, face: 'typewriter', corners: 2 } },
  { id: 'daylight', name: 'Daylight', recipe: { mode: 'light', tint: 0, wash: 0, paper: 1, accent: 262, face: 'standard', corners: 8, strong: true } },

  // --- dark ----------------------------------------------------------------
  { id: 'ink', name: 'Ink', recipe: { mode: 'dark', tint: 265, wash: 0.15, paper: 0.85, accent: 250, face: 'standard', corners: 10 } },
  { id: 'midnight', name: 'Midnight', recipe: { mode: 'dark', tint: 265, wash: 1, paper: 0.8, accent: 230, face: 'standard', corners: 12 } },
  { id: 'forest', name: 'Forest', recipe: { mode: 'dark', tint: 150, wash: 0.9, paper: 0.8, accent: 140, face: 'soft', corners: 12 } },
  { id: 'plum', name: 'Plum', recipe: { mode: 'dark', tint: 320, wash: 0.9, paper: 0.8, accent: 345, face: 'soft', corners: 16 } },
  { id: 'ember', name: 'Ember', recipe: { mode: 'dark', tint: 50, wash: 0.9, paper: 0.8, accent: 55, face: 'book', corners: 6 } },
  { id: 'slate', name: 'Slate', recipe: { mode: 'dark', tint: 240, wash: 0.4, paper: 1, accent: 195, face: 'standard', corners: 8 } },
  { id: 'terminal', name: 'Terminal', recipe: { mode: 'dark', tint: 145, wash: 0.6, paper: 0.3, accent: 145, face: 'typewriter', corners: 0 } },
  { id: 'blueprint', name: 'Blueprint', recipe: { mode: 'dark', tint: 255, wash: 1, paper: 1, accent: 215, face: 'typewriter', corners: 2 } },
  { id: 'black', name: 'Black', recipe: { mode: 'dark', tint: 0, wash: 0, paper: 0, accent: 250, face: 'standard', corners: 10 } },
  { id: 'starlight', name: 'Starlight', recipe: { mode: 'dark', tint: 270, wash: 0.2, paper: 0.25, accent: 100, face: 'standard', corners: 8, strong: true } },
].map((scheme) => ({ ...scheme, recipe: tidy(scheme.recipe) }));

/** A seeded scheme by id, or null. */
export const schemeNamed = (id) => SCHEMES.find((scheme) => scheme.id === id) ?? null;

// --- what is kept -----------------------------------------------------------

/**
 * What a browser remembers, read back into something that can be trusted.
 *
 * Three answers and no others: nothing chosen (`system`), one of the twenty by
 * name, or a recipe somebody made (`custom`). A seeded scheme is kept by name
 * rather than by value so that retuning `Sepia` retunes it for the people
 * already wearing it; a name that no longer exists falls back to the system
 * rather than to a guess.
 *
 * The recipe somebody made is kept whatever they are wearing. Trying `Plum` on
 * for a minute should not cost anybody the scheme they spent ten adjusting.
 *
 * @returns {{scheme: string, recipe: object|null, custom: object|null}}
 */
export function readChoice(saved) {
  const given = saved && typeof saved === 'object' ? saved : {};
  const custom = given.custom && typeof given.custom === 'object' ? tidy(given.custom) : null;

  if (given.scheme === 'custom' && custom) return { scheme: 'custom', recipe: custom, custom };
  const seeded = typeof given.scheme === 'string' ? schemeNamed(given.scheme) : null;
  if (seeded) return { scheme: seeded.id, recipe: seeded.recipe, custom };
  return { scheme: 'system', recipe: null, custom };
}
