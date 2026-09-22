/**
 * The whole catalogue as one list to pick from: choose something and it is
 * joined.
 *
 * The search finds what somebody can already name, and browsing goes a level
 * at a time. This is for somebody who wants to see what there is, laid out,
 * and add from it: every interest there is, under the dozen divisions they
 * belong to, each field under its division and each interest under its field,
 * indented as far as it is from the top.
 *
 * A native `select`, on purpose. It is the one list every browser, phone and
 * screen reader already knows how to open, search by typing and scroll, and
 * it is the platform's own grouping — each division an `optgroup` — that says
 * which division the options under it belong to, to anybody listening.
 */

const INDENT = '   ';

/** "social sciences" to "Social sciences", for a group's heading. */
const heading = (name) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The options, grouped and in order.
 *
 * @param {Array<{id: string, n: number, up?: string[], known?: boolean}>} subjects  as the chart sends them
 * @param {Set<string>} held  what is held already, which is shown but cannot be picked again
 * @returns {Array<{label: string, options: Array<{value: string, text: string, depth: number, held: boolean}>}>}
 */
export function catalogueOptions(subjects, held = new Set()) {
  const byId = new Map(subjects.map((s) => [s.id, s]));
  const children = new Map();
  const roots = [];
  const strays = [];
  for (const s of subjects) {
    const parent = s.up?.[0];
    if (parent && byId.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(s);
    } else if (s.known === false || parent) {
      // Nothing above it that is here: made by somebody, or under a
      // category nobody has made. Kept together at the end rather than lost.
      strays.push(s);
    } else {
      roots.push(s);
    }
  }
  const alphabetical = (a, b) => a.id.localeCompare(b.id);

  const option = (s, depth) => {
    const mine = held.has(s.id);
    const count = s.n ? ` (${s.n})` : '';
    return {
      value: s.id,
      // The indent is the hierarchy, as text, since an option can hold
      // nothing else: a division's own name at the top of its group, its
      // fields under it, and so on down.
      text: `${INDENT.repeat(depth)}${depth ? '› ' : ''}${s.id}${count}${mine ? ' ✓ joined' : ''}`,
      depth,
      held: mine,
    };
  };

  const walk = (s, depth, out) => {
    out.push(option(s, depth));
    for (const child of (children.get(s.id) ?? []).sort(alphabetical)) walk(child, depth + 1, out);
    return out;
  };

  const groups = roots.sort(alphabetical).map((root) => ({ label: heading(root.id), options: walk(root, 0, []) }));
  if (strays.length) {
    groups.push({ label: 'Not in the catalogue yet', options: strays.sort(alphabetical).map((s) => option(s, 0)) });
  }
  return groups;
}

/**
 * Fill a `select` with the catalogue, keeping its first option (the prompt)
 * and nothing else from before.
 */
export function fillCatalogue(select, subjects, held) {
  const doc = select.ownerDocument;
  const prompt = select.querySelector('option[value=""]');
  select.textContent = '';
  if (prompt) select.append(prompt);
  for (const group of catalogueOptions(subjects, held)) {
    const node = doc.createElement('optgroup');
    node.setAttribute('label', group.label);
    for (const entry of group.options) {
      const option = doc.createElement('option');
      option.setAttribute('value', entry.value);
      option.textContent = entry.text;
      // Held already: there, so the list is the whole catalogue, but not
      // something to add twice.
      if (entry.held) option.setAttribute('disabled', '');
      node.append(option);
    }
    select.append(node);
  }
  showPrompt(select);
}

/** Back to the prompt, the option with no value, and nothing else chosen. */
export function showPrompt(select) {
  for (const option of select.querySelectorAll('option')) option.selected = option.value === '';
}
