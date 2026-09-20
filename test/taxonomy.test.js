import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorsFor, radialLayout, resolve } from '../lib/taxonomy.js';
import { knowledge } from '../lib/knowledge.js';
import { weave } from '../lib/mold.js';
import { atlas } from '../lib/atlas.js';
import { zones } from '../lib/regions.js';

const people = (n, subjects) => Array.from({ length: n }, () => new Set(subjects));

test('siblings land near each other and strangers far apart', () => {
  const at = radialLayout(knowledge);
  const gap = (a, b) => Math.hypot(at.get(a).x - at.get(b).x, at.get(a).y - at.get(b).y);

  // Both under music; both under biology. Nothing bridges them in any data —
  // this is what the subject *is*, which is the whole point of a prior.
  assert.ok(gap('jazz', 'opera') < gap('jazz', 'botany'), 'two musics beat music and botany');
  assert.ok(gap('botany', 'mycology') < gap('botany', 'chess'));
  assert.ok(gap('ethics', 'logic') < gap('ethics', 'baking'));
});

test('subjects fill the disc rather than ringing it', () => {
  // Depth alone put every leaf on the rim, maximally far apart around an empty
  // middle — which wasted the space and left nothing able to grow between them.
  const at = radialLayout(knowledge);
  const leaves = ['jazz', 'botany', 'chess', 'baking', 'poetry', 'topology'];
  const radii = leaves.map((s) => Math.hypot(at.get(s).x, at.get(s).y));

  assert.ok(Math.max(...radii) < 500, 'nothing should sit on the rim');
  assert.ok(Math.max(...radii) - Math.min(...radii) > 20, 'nor should they share one arc');
});

test('a facet lands where its subject is', () => {
  const at = radialLayout(knowledge);
  // Real catalogues are full of these, and leaving them unplaced would mean
  // anchoring almost nothing.
  assert.deepEqual(resolve('modern jazz', at), at.get('jazz'));
  assert.deepEqual(resolve('early nordic weaving', at), at.get('weaving'));
  assert.deepEqual(resolve('history of philosophy', at), at.get('philosophy'));

  // And something genuinely unknown is left alone rather than guessed at.
  assert.equal(resolve('competitive yodelling', at), null);
  assert.equal(anchorsFor(['jazz', 'competitive yodelling'], at).size, 1);
});

test('the same hierarchy always gives the same map', () => {
  const a = radialLayout(knowledge);
  const b = radialLayout(knowledge);
  for (const [name, at] of a) assert.deepEqual(b.get(name), at);
});

test('a hierarchy with a cycle does not hang', () => {
  const at = radialLayout({ a: 'b', b: 'c', c: 'a', d: 'a' });
  assert.ok(at.size > 0);
});

test('anchoring holds the map still while the population churns', () => {
  // The atlas is regrown from scratch each time, so without a prior a little
  // churn rearranges it completely — which destroys the spatial memory a map
  // depends on. This is the measurement that justifies the whole file.
  const subjects = ['painting', 'philosophy', 'jazz', 'chess', 'botany'];
  const anchors = anchorsFor(subjects, radialLayout(knowledge));

  const before = [
    ...people(20, ['painting']), ...people(16, ['philosophy']), ...people(14, ['jazz']),
    ...people(12, ['chess']), ...people(10, ['botany']),
    ...people(6, ['painting', 'philosophy']), ...people(4, ['jazz', 'painting']),
  ];
  const after = [...before.slice(3), ...people(5, ['chess', 'botany']), ...people(4, ['philosophy', 'jazz'])];

  const drift = (options) => {
    const a = atlas(zones(before, subjects), options);
    const b = atlas(zones(after, subjects), options);
    const moved = new Map(b.curves.map((c) => [c.subject, c.anchor]));
    const shifts = a.curves.map((c) => {
      const then = moved.get(c.subject);
      return then ? Math.hypot(then.x - c.anchor.x, then.y - c.anchor.y) : 0;
    });
    return shifts.reduce((s, v) => s + v, 0) / shifts.length;
  };

  const loose = drift({});
  const held = drift({ anchors });

  assert.ok(held < loose / 3, `anchored drift ${held.toFixed(0)} vs free ${loose.toFixed(0)}`);
  assert.ok(held < 120, `anchored map still moved ${held.toFixed(0)} units of 1000`);
});

// --- the mould -------------------------------------------------------------

test('the mould network follows who bridges what', () => {
  // The claim this feature stands on. It is not free: with the parameters a
  // general Physarum model uses, agents merge into one mass shaped by geometry
  // and the correlation goes *negative*.
  const subjects = ['botany', 'astronomy', 'genetics', 'topology', 'geology'];
  const anchors = anchorsFor(subjects, radialLayout(knowledge));
  const crowd = [
    ...people(18, ['botany']), ...people(15, ['astronomy']), ...people(12, ['genetics']),
    ...people(11, ['topology']), ...people(9, ['geology']),
    ...people(8, ['botany', 'genetics']), ...people(6, ['astronomy', 'geology']),
  ];

  const counts = zones(crowd, subjects);
  const affinity = [...counts]
    .filter(([k]) => k.includes('+'))
    .map(([k, n]) => [...k.split('+'), n]);

  const mould = weave({
    anchors,
    weight: new Map(subjects.map((s) => [s, counts.get(s) ?? 1])),
    affinity,
    generations: 140,
    agents: 2200,
  });

  const strength = new Map(mould.network({ threshold: 0 }).map((e) => [e.subjects.join('~'), e.strength]));
  const bridged = (a, b) => strength.get([a, b].sort().join('~')) ?? 0;

  // The two pairs people actually hold together should be the strong channels.
  assert.ok(
    bridged('botany', 'genetics') > bridged('botany', 'topology'),
    'a bridged pair should beat an unbridged one',
  );
  assert.ok(bridged('astronomy', 'geology') > bridged('topology', 'geology'));
});

test('the same population always weaves the same network', () => {
  const anchors = new Map([
    ['a', { x: -200, y: 0 }],
    ['b', { x: 200, y: 0 }],
  ]);
  const affinity = [['a', 'b', 5]];
  const one = weave({ anchors, affinity, generations: 40, agents: 300 });
  const two = weave({ anchors, affinity, generations: 40, agents: 300 });

  assert.deepEqual(one.network({ threshold: 0 }), two.network({ threshold: 0 }));
  assert.deepEqual([...one.field()], [...two.field()]);
});

test('growing along the mould does not cost exactness', () => {
  // The mould decides which way the ground runs; the quotas still decide how
  // much of it each zone gets. That separation is the whole reason the atlas
  // can take an organic shape without giving up what it exists to guarantee.
  const subjects = ['painting', 'philosophy', 'jazz'];
  const anchors = anchorsFor(subjects, radialLayout(knowledge));
  const crowd = [
    ...people(18, ['painting']), ...people(14, ['philosophy']), ...people(12, ['jazz']),
    ...people(6, ['painting', 'philosophy']), ...people(4, ['jazz', 'painting']),
    ...people(2, subjects),
  ];
  const counts = zones(crowd, subjects);

  const plain = atlas(counts, { anchors });
  const grown = atlas(counts, { anchors, mold: { generations: 60, agents: 800 } });

  for (const view of [plain, grown]) {
    assert.equal(view.report.phantoms, 0);
    assert.equal(view.report.vanished, 0);
    assert.ok(view.report.exact);
    assert.ok(view.report.worstError < 0.08, `area error ${view.report.worstError}`);
  }
  assert.deepEqual(
    grown.zones.map((z) => z.key).sort(),
    plain.zones.map((z) => z.key).sort(),
    'the same rooms either way',
  );
});
