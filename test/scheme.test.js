import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import {
  FACES, HOUSE, PROPERTIES, ROUNDEST, SCHEMES, paperOf, readChoice, schemeNamed, styleOf, tidy,
  tokensOf, wheelOf,
} from '../lib/scheme.js';
import { DARKEST_PAPER, contrast, luminance, setPaper, stroke } from '../lib/palette.js';
import { knowledge } from '../lib/knowledge.js';

/**
 * Whether a scheme can be trusted with somebody's eyesight.
 *
 * The claim `scheme.js` makes is a strong one: that no recipe is a mistake.
 * Not "the twenty we shipped look fine" but "every position of every slider is
 * legible", which is the only version of the claim that makes it safe to hand
 * somebody the sliders. A claim like that is either measured or it is a hope,
 * so the bars below are measured on the hex that reaches the screen — after
 * rounding to eight bits, which is where a solved colour quietly stops being
 * the colour that was solved for.
 */

const SURFACES = ['panel', 'bg', 'raised'];

/** The bars, in one place. WCAG's, and the ones the stylesheet's own comments set. */
function legible(tokens, label) {
  for (const on of SURFACES) {
    assert.ok(contrast(tokens.ink, tokens[on]) >= 7, `${label}: ink on ${on} is ${contrast(tokens.ink, tokens[on]).toFixed(2)}`);
    for (const text of ['muted', 'accent', 'warn']) {
      const ratio = contrast(tokens[text], tokens[on]);
      assert.ok(ratio >= 4.5, `${label}: ${text} on ${on} is ${ratio.toFixed(2)}`);
    }
    // The border of a control is the only thing saying where the control is.
    const edge = contrast(tokens.edge, tokens[on]);
    assert.ok(edge >= 3, `${label}: edge on ${on} is ${edge.toFixed(2)}`);
  }
  // A divider has to be there, and has to stay quieter than a control's edge.
  const line = contrast(tokens.line, tokens.panel);
  assert.ok(line >= 1.2, `${label}: a divider at ${line.toFixed(2)} is not there`);
  assert.ok(line < contrast(tokens.edge, tokens.panel), `${label}: a divider louder than a control`);
  // The three surfaces are three surfaces.
  assert.notEqual(tokens.bg, tokens.panel, `${label}: the page and the panel are one colour`);
  assert.notEqual(tokens.raised, tokens.panel, `${label}: raised is not raised`);
}

test('there are twenty, ten of each, and no two alike', () => {
  assert.equal(SCHEMES.length, 20);
  assert.equal(SCHEMES.filter((s) => s.recipe.mode === 'light').length, 10);
  assert.equal(SCHEMES.filter((s) => s.recipe.mode === 'dark').length, 10);

  assert.equal(new Set(SCHEMES.map((s) => s.id)).size, 20, 'an id is used twice');
  assert.equal(new Set(SCHEMES.map((s) => s.name)).size, 20, 'a name is used twice');
  for (const { id, name } of SCHEMES) {
    assert.match(id, /^[a-z]+$/);
    assert.ok(name.length > 0 && name.length <= 12, `${name} will not fit on its card`);
    assert.notEqual(id, 'system');
    assert.notEqual(id, 'custom');
    assert.equal(schemeNamed(id).name, name);
  }

  // Different to look at, not only different on paper: no two of them put the
  // same colours on the screen in the same lettering with the same corners.
  const looks = new Set(SCHEMES.map(({ recipe }) => JSON.stringify(styleOf(recipe))));
  assert.equal(looks.size, 20);
  const papers = new Set(SCHEMES.map(({ recipe }) => `${tokensOf(recipe).panel}/${tokensOf(recipe).accent}`));
  assert.equal(papers.size, 20, 'two schemes share a panel and a highlight');

  // A seed is there to show what a control does by having already moved it.
  const used = (key) => new Set(SCHEMES.map((s) => s.recipe[key]));
  assert.deepEqual([...used('face')].sort(), Object.keys(FACES).sort(), 'a lettering nobody seeded');
  assert.ok(used('corners').has(0) && used('corners').has(ROUNDEST), 'corners never reach both ends');
  assert.ok(used('strong').has(true));
});

test('every one of the twenty is legible', () => {
  for (const { id, recipe } of SCHEMES) legible(tokensOf(recipe), id);
});

test('the built-in themes are held to the stylesheet, not to memory', () => {
  // `HOUSE` repeats what `styles.css` says so the chooser can draw "match
  // system". Two copies of what colour the panel is are two answers waiting
  // to disagree, so this is where they are made to agree.
  const css = fs.readFileSync('public/styles.css', 'utf8');
  const light = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('* {'));
  for (const [stated, block] of [[HOUSE.light, light], [HOUSE.dark, dark]]) {
    for (const [name, value] of Object.entries(stated)) {
      const found = block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
      assert.ok(found, `the stylesheet no longer states --${name}`);
      assert.equal(found[1].toLowerCase(), value);
    }
  }
});

test('no position of any slider is a mistake', () => {
  // The surfaces and the greys on them: every tint, at every strength, on
  // every brightness of paper, both ways up, with and without the contrast.
  let tried = 0;
  for (const mode of ['light', 'dark']) {
    for (const strong of [false, true]) {
      for (let tint = 0; tint < 360; tint += 30) {
        for (const wash of [0, 0.5, 1]) {
          for (const paper of [0, 0.25, 0.5, 0.75, 1]) {
            const recipe = { mode, strong, tint, wash, paper, accent: (tint + 150) % 360 };
            legible(tokensOf(recipe), JSON.stringify(recipe));
            tried++;
          }
        }
      }
    }
  }
  // And the highlight, which is the one colour vivid enough to run out of
  // gamut: round the whole wheel, on the papers at both ends.
  for (const mode of ['light', 'dark']) {
    for (const strong of [false, true]) {
      for (let accent = 0; accent < 360; accent += 10) {
        for (const paper of [0, 1]) {
          const recipe = { mode, strong, accent, paper, tint: 75, wash: 1 };
          legible(tokensOf(recipe), JSON.stringify(recipe));
          tried++;
        }
      }
    }
  }
  assert.ok(tried > 900, `only ${tried} recipes tried`);
});

test('the subject colours stay readable on whatever paper is chosen', () => {
  const subjects = Object.keys(knowledge).slice(0, 120);
  try {
    for (const mode of ['light', 'dark']) {
      for (let tint = 0; tint < 360; tint += 45) {
        for (const paper of [0, 0.5, 1]) {
          const recipe = { mode, tint, wash: 1, paper };
          const panel = tokensOf(recipe).panel;

          // Dark paper is held under the limit rather than the colours moved,
          // because moving them up would cost the white drawn on them its 3:1.
          if (mode === 'dark') {
            assert.ok(luminance(panel) <= DARKEST_PAPER, `${panel} is too bright a dark for the map`);
          }

          const tiers = setPaper(paperOf(recipe));
          if (mode === 'dark') assert.deepEqual(tiers, setPaper(null), 'dark paper moved the colours');

          for (const subject of subjects) {
            const colour = stroke(subject);
            const onPaper = contrast(colour, panel);
            assert.ok(onPaper >= 2.95, `${subject} ${colour} on ${panel}: ${onPaper.toFixed(2)}`);
            // The emblem on a swatch is white on the subject's colour.
            assert.ok(contrast('#ffffff', colour) >= 2.95, `white on ${colour}`);
          }
        }
      }
    }

    // White paper is the paper the colours were designed on: nothing moves.
    assert.deepEqual(setPaper(1), setPaper(null));
    // Tinted paper brings every tier down by the same amount, and keeps them apart.
    const cream = setPaper(0.85);
    const white = setPaper(null);
    assert.ok(cream.every((tier, i) => tier < white[i]));
    assert.ok(cream[0] < cream[1] && cream[1] < cream[2]);
    assert.ok(Math.abs((white[2] - white[0]) - (cream[2] - cream[0])) < 1e-3);
  } finally {
    // Module state. Leaving it set would change colours in every test after this.
    setPaper(null);
  }
});

test('a recipe out of storage is repaired, one field at a time', () => {
  const fallback = tidy({});
  assert.deepEqual(tidy(null), fallback);
  assert.deepEqual(tidy('sepia'), fallback);
  assert.deepEqual(tidy([]), fallback);

  // One bad number does not cost somebody the rest of what they chose.
  const mostly = tidy({ mode: 'dark', tint: 'purple', wash: 0.5, corners: 4, face: 'book' });
  assert.equal(mostly.mode, 'dark');
  assert.equal(mostly.tint, fallback.tint);
  assert.equal(mostly.wash, 0.5);
  assert.equal(mostly.corners, 4);
  assert.equal(mostly.face, 'book');

  // Clamped, wrapped, and never trusting a name it does not own.
  assert.equal(tidy({ wash: 7 }).wash, 1);
  assert.equal(tidy({ paper: -2 }).paper, 0);
  assert.equal(tidy({ tint: 400 }).tint, 40);
  assert.equal(tidy({ accent: -30 }).accent, 330);
  assert.equal(tidy({ corners: 500 }).corners, ROUNDEST);
  assert.equal(tidy({ corners: 3.6 }).corners, 4);
  assert.equal(tidy({ tint: null }).tint, fallback.tint);
  assert.equal(tidy({ tint: '' }).tint, fallback.tint);
  assert.equal(tidy({ tint: Infinity }).tint, fallback.tint);
  assert.equal(tidy({ mode: 'sepia' }).mode, fallback.mode);
  assert.equal(tidy({ face: 'constructor' }).face, fallback.face);
  assert.equal(tidy({ face: 'toString' }).face, fallback.face);
  assert.equal(tidy({ strong: 'yes' }).strong, false);

  // Tidying twice is tidying once, or a saved recipe drifts every time it is read.
  for (const { recipe } of SCHEMES) assert.deepEqual(tidy(recipe), recipe);

  // Whatever comes out is something that can be drawn.
  for (const junk of [{ tint: NaN, wash: NaN }, { mode: 42, paper: {}, accent: [] }]) {
    for (const value of Object.values(tokensOf(junk))) assert.match(value, /^#[0-9a-f]{6}$/);
  }
});

test('what a browser remembered is read back as one of three answers', () => {
  assert.deepEqual(readChoice(null), { scheme: 'system', recipe: null, custom: null });
  assert.deepEqual(readChoice('{'), { scheme: 'system', recipe: null, custom: null });
  assert.equal(readChoice({ scheme: 'sepia' }).recipe, schemeNamed('sepia').recipe);

  // A scheme that has since been removed or renamed is not guessed at.
  assert.equal(readChoice({ scheme: 'solarised' }).scheme, 'system');
  assert.equal(readChoice({ scheme: 'constructor' }).scheme, 'system');
  // `custom` with nothing to be custom with is nothing chosen.
  assert.equal(readChoice({ scheme: 'custom' }).scheme, 'system');

  const mine = { mode: 'dark', tint: 200, wash: 0.6, paper: 0.4, accent: 20, face: 'soft', corners: 3, strong: true };
  const worn = readChoice({ scheme: 'custom', custom: mine });
  assert.equal(worn.scheme, 'custom');
  assert.deepEqual(worn.recipe, mine);

  // Trying another one on does not cost somebody the one they made.
  const trying = readChoice({ scheme: 'plum', custom: mine });
  assert.equal(trying.scheme, 'plum');
  assert.deepEqual(trying.custom, mine);
  assert.deepEqual(readChoice({ scheme: 'plum', custom: { tint: 'x' } }).custom, tidy({}));
});

test('a scheme sets every property it owns, and nothing else', () => {
  for (const { id, recipe } of SCHEMES) {
    const style = styleOf(recipe);
    assert.deepEqual(Object.keys(style).sort(), [...PROPERTIES].sort(), id);
    assert.equal(style['color-scheme'], recipe.mode);
    assert.equal(style['--face'], FACES[recipe.face]);
  }

  // A pill is a pill until the room is nearly square, and then it is not.
  assert.equal(styleOf({ corners: 12 })['--pill'], '999px');
  assert.equal(styleOf({ corners: 4 })['--pill'], '999px');
  assert.equal(styleOf({ corners: 3 })['--pill'], '3px');
  assert.equal(styleOf({ corners: 0 })['--pill'], '0px');
  assert.equal(styleOf({ corners: 10 })['--radius-small'], '7px');
  assert.equal(styleOf({ corners: 0 })['--radius'], '0px');
});

test('the stylesheet states no colour a scheme cannot reach', () => {
  // A scheme works by setting tokens. A colour written straight into a rule
  // is one that stays the same under all twenty — usually a white card on a
  // dark theme, which is how `--raised` came to exist in the first place.
  const css = fs.readFileSync('public/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.slice(css.indexOf('* {'));

  const stated = [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector, body]) =>
    [...body.matchAll(/#[0-9a-f]{3,8}\b/gi)].map(([colour]) => `${selector.trim()} ${colour}`));
  // The invitation square is black on white under every scheme, because a
  // camera has to read it and a camera has not chosen a scheme.
  const allowed = stated.filter((entry) => /^\.(cluster-qr|qr-on|qr-off)\b/.test(entry));
  assert.deepEqual(stated.filter((entry) => !allowed.includes(entry)), []);

  // And the tokens a scheme sets are ones the stylesheet actually reads.
  for (const property of PROPERTIES.filter((p) => p.startsWith('--'))) {
    assert.ok(rules.includes(`var(${property})`), `nothing in the stylesheet reads ${property}`);
  }
  // No corner is still a number a scheme cannot square off.
  assert.doesNotMatch(rules, /border-radius:\s*(999|10|8|7|6)px/);
});

test('a hue slider is painted with the answers it gives', () => {
  for (const id of ['sepia', 'terminal']) {
    const { recipe } = schemeNamed(id);
    const track = wheelOf(recipe);
    assert.equal(track.length, 13);
    assert.equal(track[0], track[12], 'the wheel does not close');
    assert.ok(new Set(track).size >= 10, 'the track is one colour');
    // Every stop is a highlight this recipe could really have.
    for (const stop of track) {
      assert.ok(contrast(stop, tokensOf(recipe).panel) >= 4.5, `${id}: ${stop} is promised and never given`);
    }
  }
});

// --- the sheet --------------------------------------------------------------

function page() {
  const { document } = parseHTML(fs.readFileSync('public/index.html', 'utf8'));
  const kept = new Map();
  const previous = { document: globalThis.document, localStorage: globalThis.localStorage };
  globalThis.document = document;
  globalThis.localStorage = {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => kept.set(key, String(value)),
    removeItem: (key) => kept.delete(key),
  };
  const restore = () => {
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    setPaper(null);
  };
  return { document, kept, restore };
}

const press = (node, type = 'click') => node.dispatchEvent(new node.ownerDocument.defaultView.Event(type, { bubbles: true }));

test('choosing a scheme puts it on the page and keeps it in this browser', async () => {
  const { document, kept, restore } = page();
  try {
    const { mountAppearance, restoreAppearance } = await import(`../public/appearance.js?choose=${Date.now()}`);
    const root = document.documentElement;
    let redrawn = 0;

    assert.equal(restoreAppearance(), 'system');
    mountAppearance(document, { onChange: () => redrawn++ });
    assert.equal(document.getElementById('appearance-now').textContent, 'System');
    assert.equal(root.style.getPropertyValue('--panel'), '', 'nothing chosen, nothing written');

    press(document.getElementById('appearance-open'));
    const cards = [...document.querySelectorAll('#schemes .scheme')];
    assert.equal(cards.length, 21, 'match system, and the twenty');
    assert.equal(cards[0].getAttribute('aria-pressed'), 'true');

    const sepia = cards.find((c) => c.textContent === 'Sepia');
    press(sepia);
    assert.equal(sepia.getAttribute('aria-pressed'), 'true');
    assert.equal(cards[0].getAttribute('aria-pressed'), 'false');
    assert.equal(root.style.getPropertyValue('--panel'), tokensOf(schemeNamed('sepia').recipe).panel);
    assert.equal(root.style.getPropertyValue('--face'), FACES.book);
    assert.equal(document.getElementById('appearance-now').textContent, 'Sepia');
    assert.equal(JSON.parse(kept.get('eulerchat.appearance')).scheme, 'sepia');
    assert.equal(redrawn, 1);
    // The sliders follow, so adjusting Sepia is adjusting Sepia.
    assert.equal(document.getElementById('adjust-tint').value, String(schemeNamed('sepia').recipe.tint));

    // And off again: back to the stylesheet, with nothing left behind.
    press(cards[0]);
    for (const property of PROPERTIES) assert.equal(root.style.getPropertyValue(property), '', property);
    assert.equal(JSON.parse(kept.get('eulerchat.appearance')).scheme, 'system');
  } finally {
    restore();
  }
});

test('touching a slider makes the scheme your own, and it is still there next time', async () => {
  const { document, kept, restore } = page();
  try {
    const { mountAppearance, restoreAppearance } = await import(`../public/appearance.js?adjust=${Date.now()}`);
    restoreAppearance();
    let redrawn = 0;
    mountAppearance(document, { onChange: () => redrawn++ });
    press(document.getElementById('appearance-open'));
    press([...document.querySelectorAll('#schemes .scheme')].find((c) => c.textContent === 'Plum'));
    redrawn = 0;

    const corners = document.getElementById('adjust-corners');
    corners.value = '0';
    // A drag recolours the page and redraws nothing; letting go does both.
    press(corners, 'input');
    assert.equal(document.documentElement.style.getPropertyValue('--radius'), '0px');
    assert.equal(redrawn, 0);
    press(corners, 'change');
    assert.equal(redrawn, 1);

    const saved = JSON.parse(kept.get('eulerchat.appearance'));
    assert.equal(saved.scheme, 'custom');
    assert.deepEqual(saved.custom, { ...schemeNamed('plum').recipe, corners: 0 });

    const mine = [...document.querySelectorAll('#schemes .scheme')].find((c) => c.textContent === 'Your own');
    assert.ok(mine, 'no card for the scheme somebody just made');
    assert.equal(mine.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelectorAll('#schemes .scheme').length, 22);

    // Trying another on keeps it, and a new visit wears what was worn last.
    press([...document.querySelectorAll('#schemes .scheme')].find((c) => c.textContent === 'Mint'));
    assert.deepEqual(JSON.parse(kept.get('eulerchat.appearance')).custom, saved.custom);

    const again = await import(`../public/appearance.js?again=${Date.now()}`);
    for (const property of PROPERTIES) document.documentElement.style.removeProperty(property);
    assert.equal(again.restoreAppearance(), 'mint');
    assert.equal(
      document.documentElement.style.getPropertyValue('--accent'),
      tokensOf(schemeNamed('mint').recipe).accent,
    );
  } finally {
    restore();
  }
});

test('storage somebody has been at does not stop the page loading', async () => {
  const { document, kept, restore } = page();
  try {
    const { restoreAppearance } = await import(`../public/appearance.js?junk=${Date.now()}`);
    for (const junk of ['{', '"sepia"', '{"scheme":"custom"}', '{"scheme":"custom","custom":"x"}', '[1,2]']) {
      kept.set('eulerchat.appearance', junk);
      assert.equal(restoreAppearance(), 'system', junk);
      assert.equal(document.documentElement.style.getPropertyValue('--panel'), '');
    }
  } finally {
    restore();
  }
});

// --- the first frame, and the other tabs -------------------------------------

/** The script in the page's head, as a function of the two things it touches. */
function headScript() {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const found = head.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(found, 'no script in the head to paint the chosen look before the page loads');
  // Before the stylesheet, or it waits for the stylesheet to arrive.
  assert.ok(head.indexOf('<script>') < head.indexOf('styles.css'), 'the head script waits for the stylesheet');
  return new Function('document', 'localStorage', found[1]);
}

test('the look chosen is on the page before the page\'s own script arrives', async () => {
  const { document, kept, restore } = page();
  try {
    const { KEY, mountAppearance, restoreAppearance } = await import(`../public/appearance.js?head=${Date.now()}`);
    restoreAppearance();
    mountAppearance(document);
    press(document.getElementById('appearance-open'));
    press([...document.querySelectorAll('#schemes .scheme')].find((c) => c.textContent === 'Black'));

    // What the head script reads is what the chooser wrote.
    const saved = JSON.parse(kept.get(KEY));
    assert.deepEqual(saved.worn, styleOf(schemeNamed('black').recipe));

    // A fresh page, before any module has run: the head script alone.
    const fresh = parseHTML(fs.readFileSync('public/index.html', 'utf8')).document;
    headScript()(fresh, globalThis.localStorage);
    const root = fresh.documentElement;
    for (const [property, value] of Object.entries(saved.worn)) {
      assert.equal(root.style.getPropertyValue(property), value, property);
    }
    assert.ok(
      fs.readFileSync('public/index.html', 'utf8').includes(`getItem('${KEY}')`),
      'the head script reads another key',
    );

    // Back to the system: nothing for the head script to put on.
    press([...document.querySelectorAll('#schemes .scheme')].find((c) => c.textContent === 'Match system'));
    assert.equal(JSON.parse(kept.get(KEY)).worn, null);
    const plain = parseHTML(fs.readFileSync('public/index.html', 'utf8')).document;
    headScript()(plain, globalThis.localStorage);
    assert.equal(plain.documentElement.getAttribute('style') ?? '', '');
  } finally {
    restore();
  }
});

test('the head script puts on custom properties and nothing else, and never throws', () => {
  const run = (stored) => {
    const fresh = parseHTML('<!doctype html><html><head></head><body></body></html>').document;
    const storage = { getItem: () => stored };
    headScript()(fresh, storage);
    return fresh.documentElement;
  };

  // Written by hand or by something else on this origin: only tokens get through.
  const root = run(JSON.stringify({ worn: {
    '--panel': '#101010', 'color-scheme': 'dark',
    background: 'url(x)', 'behavior': 'x', '--NOPE': '#fff', '--ink': 12,
  } }));
  assert.equal(root.style.getPropertyValue('--panel'), '#101010');
  assert.equal(root.style.getPropertyValue('color-scheme'), 'dark');
  for (const property of ['background', 'behavior', '--NOPE', '--ink']) {
    assert.equal(root.style.getPropertyValue(property), '', property);
  }

  for (const junk of [null, '', '{', 'null', '"x"', '[1]', '{"worn":null}', '{"worn":[1,2]}', '{"worn":"--a"}']) {
    assert.doesNotThrow(() => run(junk), junk);
  }
  const blocked = parseHTML('<!doctype html><html></html>').document;
  assert.doesNotThrow(() => headScript()(blocked, { getItem() { throw new Error('denied'); } }));
});

test('a snapshot left by an older version is brought up to date, and a current one left alone', async () => {
  const { kept, restore } = page();
  try {
    const { KEY, restoreAppearance } = await import(`../public/appearance.js?stale=${Date.now()}`);

    // Sepia as some earlier version drew it.
    kept.set(KEY, JSON.stringify({ v: 1, scheme: 'sepia', custom: null, worn: { '--panel': '#ffeedd' } }));
    assert.equal(restoreAppearance(), 'sepia');
    assert.deepEqual(JSON.parse(kept.get(KEY)).worn, styleOf(schemeNamed('sepia').recipe));

    // Already current: nothing written.
    let writes = 0;
    const setItem = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (...args) => { writes++; return setItem(...args); };
    restoreAppearance();
    assert.equal(writes, 0);

    // A choice kept before snapshots existed gets one.
    kept.set(KEY, JSON.stringify({ v: 1, scheme: 'forest', custom: null }));
    restoreAppearance();
    assert.deepEqual(JSON.parse(kept.get(KEY)).worn, styleOf(schemeNamed('forest').recipe));
    // Nothing chosen and nothing kept is not written just for having loaded.
    kept.delete(KEY);
    writes = 0;
    restoreAppearance();
    assert.equal(writes, 0);
  } finally {
    restore();
  }
});

test('a choice made in another tab is worn here too, without writing back', async () => {
  const { document, kept, restore } = page();
  try {
    const { KEY, mountAppearance, restoreAppearance } = await import(`../public/appearance.js?tabs=${Date.now()}`);
    restoreAppearance();
    let redrawn = 0;
    mountAppearance(document, { onChange: () => redrawn++ });
    press(document.getElementById('appearance-open'));

    const told = (key) => {
      const window = document.defaultView;
      const evt = new window.Event('storage');
      evt.key = key;
      window.dispatchEvent(evt);
    };

    // The other tab made its own scheme and is wearing it.
    const theirs = { ...schemeNamed('plum').recipe, corners: 0 };
    const written = JSON.stringify({ v: 1, scheme: 'custom', custom: theirs, worn: styleOf(theirs) });
    kept.set(KEY, written);
    told(KEY);

    const root = document.documentElement;
    assert.equal(root.style.getPropertyValue('--panel'), tokensOf(theirs).panel);
    assert.equal(root.style.getPropertyValue('--radius'), '0px');
    assert.equal(redrawn, 1);
    assert.equal(document.getElementById('appearance-now').textContent, 'Your own');
    // The open sheet shows it, card and sliders both.
    const mine = [...document.querySelectorAll('#schemes .scheme')].find((c) => c.textContent === 'Your own');
    assert.equal(mine?.getAttribute('aria-pressed'), 'true');
    assert.equal(document.getElementById('adjust-corners').value, '0');
    assert.equal(kept.get(KEY), written, 'this tab wrote back over what the other one chose');

    // Somebody else's key is none of this.
    told('eulerchat.layout');
    assert.equal(redrawn, 1);

    // Storage cleared everywhere: back to the system.
    kept.clear();
    told(null);
    assert.equal(root.style.getPropertyValue('--panel'), '');
    assert.equal(document.getElementById('appearance-now').textContent, 'System');
  } finally {
    restore();
  }
});

test('the theme is a label in the header, and in Settings where the header has no room', async () => {
  const { document, restore } = page();
  try {
    const { mountAppearance, restoreAppearance } = await import(`../public/appearance.js?labels=${Date.now()}`);
    restoreAppearance();
    mountAppearance(document);

    const header = document.getElementById('appearance-open');
    const menu = document.getElementById('appearance-open-menu');
    assert.ok(document.querySelector('.bar').contains(header), 'the header label is not in the header');
    assert.ok(document.getElementById('settings-pop').contains(menu), 'the narrow-screen label is not in Settings');

    // Words, not a pill: a caption and the theme's name, on both.
    const said = (label) => label.textContent.replace(/\s+/g, ' ').trim();
    assert.equal(said(header), 'Theme System');
    assert.equal(said(menu), 'Theme System');
    for (const label of [header, menu]) assert.ok(label.classList.contains('bar-text'));

    // Either one opens the sheet, and only the one pressed says it is open.
    press(menu);
    assert.equal(menu.getAttribute('aria-expanded'), 'true');
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    press([...document.querySelectorAll('#schemes .scheme')].find((c) => c.textContent === 'Terminal'));
    assert.equal(said(header), 'Theme Terminal', 'the header fell behind');
    assert.equal(said(menu), 'Theme Terminal', 'the menu fell behind');

    press(document.getElementById('appearance-close'));
    assert.equal(menu.getAttribute('aria-expanded'), 'false');
    press(header);
    assert.equal(header.getAttribute('aria-expanded'), 'true');
    assert.equal(menu.getAttribute('aria-expanded'), 'false');

    // Exactly one of the two is shown at any width: the stylesheet hides each
    // on the side of the line where the other one is.
    const css = fs.readFileSync('public/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const wide = css.match(/@media \(min-width: (\d+)px\) \{\s*\.bar \.theme-open \{\s*display: inline-flex;\s*\}\s*\.settings-theme \{\s*display: none;\s*\}/);
    assert.ok(wide, 'no single line where the label moves from Settings to the header');
    assert.match(css, /\.bar \.theme-open \{\s*display: none;\s*\}/);
  } finally {
    restore();
  }
});
