# eulerchat

A chat room shaped like an Euler diagram. Subjects are regions on a plane, the
places where they overlap are rooms, and a coordinate is an address.

```
npm i eulerchat      # the layout engine, or
npx eulerchat        # the chat server
```

The layout engine stands on its own and has no server or DOM in it, so it will
draw area-proportional Euler diagrams for anything; the chat app is one caller.

```js
import { census, layout, zones, atlas } from 'eulerchat';
```

```
npm install
npm start          # http://localhost:8787 — three hand-written subjects
npm run start:large # 1000 interests, 4000 people
npm test

node server/index.js --interests 300 --people 2000
```

## The two decisions everything else follows from

### 1. Delivery is containment, not partition

A message tagged with a set of subjects **T** reaches every reader whose
subscription **S** satisfies `T ⊆ S`.

The tempting alternative is to treat each Venn region as a sealed room: a post
in the art-only lune goes only to people who are in art and *not* philosophy.
That is backwards. The person who loves both is the most engaged reader you
have, and strict lunes hide half the platform from them. Containment means:

| Post in | Reaches |
|---|---|
| `art` | everyone in art, including the art+philosophy crowd |
| `art+philosophy` | only people holding both, because it assumes both contexts |

Nobody is structurally hidden from anybody, and a subscriber to *n* subjects
sees exactly `2ⁿ − 1` rooms. See `receives()` in [lib/regions.js](lib/regions.js).

A single subject is a room like any other — hold one interest and you can talk
in it with everyone else who holds it, overlap or no overlap. Two consequences
follow, and both are load-bearing:

- **The lit area on the map is the audience.** Regions are *drawn* exclusively
  (the fill for `art` is art minus everything else) but *routed* by
  containment, so selecting `art` lights the whole art circle rather than the
  art-only sliver. The same `receives` predicate decides both, so the picture
  cannot promise an audience the router will not deliver.
- **Every room is listed, not only clicked.** A room whose exclusive area is
  covered over by its neighbours has no ground to click, which happens most
  often to single-subject rooms since those are what the overlaps eat into.
  The chips under the diagram reach every room regardless of geometry.

### 2. Euler, not Venn

A Venn diagram insists every intersection exists. An Euler diagram draws only
the non-empty ones. Real subject spaces are Euler-shaped — most combinations of
subjects have nobody in them — and a Venn build would manufacture `2ⁿ − 1`
rooms, nearly all of them dead. Empty rooms are what kill chat platforms, and
exponentially many empty rooms kill them faster.

So regions are derived from membership rather than enumerated from the
catalogue. A region nobody occupies never acquires a key, is never drawn, and
cannot be walked into. In the seeded world nobody holds both music and
philosophy, so `music+philosophy` does not exist — not empty, *absent*. Join
both and it comes into being.

## Positions are derived, never authored

If someone places the circles by hand the map lies: two circles can visually
overlap while sharing no members. Instead:

- a circle's **area** is its population
- a lens **area** is the shared membership of those two subjects
- positions are solved from the census, deterministically — the same census
  always produces the same picture

So the diagram is a live picture of the social graph, and adjacency means
something. That is also the discovery mechanism: a circle you are not in is
visible precisely because it overlaps one you are.

## The diagram reports its own dishonesty

Three circles give you three distances. Those three distances fix three
pairwise overlaps **and** the triple intersection — four quantities from three
knobs, so something must be wrong. Left alone, a spring solver satisfies the
pairs perfectly and dumps the entire error on the triple, which is the worst
possible outcome: the triple is the region this product exists for. Measured on
a symmetric three-subject world, that is a **39%** overshoot.

`layout()` re-solves for least total relative error instead, trading a few
percent on each pair to pull the triple back to ~13%, and then audits every
region by sampling and reports what it could not achieve:

```js
fit.regions   // every region: true population vs drawn area, worst first
fit.worst     // the region the picture is least honest about
fit.faithful  // false when any region is materially misdrawn
fit.drawable  // false past three circles
```

The UI prints this under the diagram. A picture that cannot be accurate says so.

## Nobody sees more than three circles

Four sets cannot be drawn as a Venn diagram with circles. This is a geometric
fact, not a rendering budget — ellipses reach five, and arbitrary closed curves
manage any number at the cost of looking like nothing at all. Rather than
degrade past that point, each person gets their own local view: the subjects
they hold, plus the neighbouring subjects that share the most members with
them, capped at three. Region arity is capped to match, so every room that
exists is a room that can be drawn.

### Circles are the reason for the residual error

Three circles give three distances, and three distances have to satisfy three
pairwise overlaps *and* the triple — four targets, three knobs. The leftover
shows up as the few percent `fit` reports.

An ellipse adds an aspect ratio and a rotation, which is enough freedom to
satisfy everything. Measured against the same three worlds:

| world | circles | ellipses | aspect needed |
|---|---|---|---|
| symmetric, small triple | 11.9% | 0.7% | 1.34 |
| symmetric, fat triple | 6.6% | 0.4% | 1.25 |
| lopsided | 2.1% | 0.9% | 1.05 |

The last column is the surprise: allowed aspect ratios up to 3.0, the solver
never wanted more than 1.34. Accuracy does not cost roundness — a 5–34%
ovalling is barely visible and removes nearly all the error.

Not yet adopted, because it is not free. Circle pairs have a closed-form lens
area, which is what makes the audit nearly instant; ellipse pairs have no such
formula, so every region would go back to being sampled. The solver would need
re-tuning against the same budget before this is a straight win.

### Circles get the regions wrong too, not just their sizes

Sizing is the smaller problem. A convex shape cannot always produce *exactly*
the set of regions the data calls for, and it fails in both directions.
Measured over 400 real views of the 1000-interest world:

| | |
|---|---|
| views where a region is drawn that nobody occupies | 5.7% |
| triple rooms drawn too small to click (<20px²) | 22.0% |
| triple rooms drawn as a speck (<300px²) | 24.9% |
| triple rooms drawn well (within 25%) | 33.6% |

Three circles overlapping pairwise tend to share a common patch whether or not
anyone holds all three — and when the overlaps are large, avoiding it is not
merely hard but geometrically impossible. `fit.phantoms` reports any such
region, and their presence makes a diagram unfaithful; removal is attempted but
only kept when it costs no accuracy, because a solver told to remove an
unavoidable phantom will flatten every area in the diagram trying.

Note the second half of that table is a *dynamic range* problem, not a shape
problem. The rooms that come out as specks almost all hold one person, inside
circles holding thirty to ninety. No choice of outline fixes that: a region
carved out big enough to click would no longer have an area proportional to its
population. Flexible boundaries would fix which regions exist; they would not
fix one person being a thousandth of the picture.

## Scale

Measured on a synthetic world of 1000 interests and 4000 people (45,683
occupied regions), which is what `npm run start:large` builds:

| | |
|---|---|
| building a view (`diagramFor`) | 3.7ms median, 6.1ms p95 |
| join round-trip, over a socket | 15.6ms median |
| broadcast after a join, 1000 sessions | 122ms, 27 of 1000 redrawn |
| people whose view contains an overlap room | 100% |

Three things make that hold, and all three are the same idea applied at a
different layer — **never touch the whole world to answer a local question**:

1. **The solver never sees more than three circles.** Because each person is
   projected to their own neighbourhood, the cost of a view is bounded by the
   view rather than by the catalogue. This is the load-bearing claim: a view
   costs about the same at a thousand interests as at three.
2. **A join updates the census in place.** Rebuilding meant re-expanding 4000
   people into 45,683 regions because one person clicked join — about 300ms.
   Joining a subject can only affect regions containing that subject, of which
   there are a handful. That alone took a join from ~300ms to ~15ms.
3. **A session is only redrawn when its own picture moves.** Someone joining an
   obscure interest cannot change a diagram that does not contain it, so each
   session is asked a cheap question first and only the few that answer yes pay
   for a solve. At 1000 sessions a join redraws 27 of them.

The rail follows the same rule: it lists what you hold, what is being suggested
and a few busy rooms, never the catalogue. A thousand rows rebuilt on every
push is the same mistake as a thousand-circle diagram.

### What the numbers do not cover

**First paint is still linear.** A thousand sessions connecting at once costs
~3.3s of solving, because each one is a genuinely different neighbourhood and
the cache cannot help (398 distinct views per 400 people). Spread over real
arrivals this is ~4ms each and invisible; as a thundering herd after a restart
it is not. Solving off the event loop would fix it.

**Density is a product assumption, not a guarantee.** The 100% figure above
holds because the generator clusters people into themes. Spread the same 4000
people uniformly over 1000 interests and essentially no pair would share a
member — every circle drawn disjoint, no overlap rooms, and the product has
nothing to offer. Whether a real population clusters is the question the
prototype cannot answer.

## Layout

```
lib/index.js      the public API (`import { layout, atlas } from 'eulerchat'`)
lib/regions.js    region algebra — addresses, containment, census, zones
lib/euler.js      circle solver, refinement, and the honesty audit
lib/atlas.js      routed-boundary layout: growth, tracing, smoothing
server/store.js   world state, the T ⊆ S routing rule, incremental census
server/populate.js synthetic worlds at scale
server/index.js   static files + WebSocket
public/diagram.js circle rendering and the coordinate → room lookup
public/atlasview.js atlas rendering and its point-in-territory lookup
public/app.js     state and wiring
```

`lib/` is served to the browser as well as imported by the server, so the
client and server share one definition of what a region address is.

## Two views, two bargains

The map and the atlas answer the same question with opposite trade-offs, and
both are in the UI because neither dominates.

| | **map** (circles) | **atlas** (routed boundaries) |
|---|---|---|
| subjects at once | 3 | any; legible to about 5 |
| zone arity | 3 | any — a six-subject zone draws fine |
| regions drawn that nobody occupies | 5.7% of views | none, by construction |
| rooms too small to click | 22% of three-way rooms | none, by construction |
| area error | a few %, sometimes 12% | ~1% |
| stability | continuous — a join nudges a radius | regrown; a different population grows differently |
| cost | ~4ms, per viewer, live | ~180ms, on request |

The atlas exists because convex shapes cannot produce an arbitrary set of
regions. Three circles overlapping pairwise share a common patch whether or not
anyone holds all three, and at realistic overlaps avoiding it is not merely
hard but geometrically impossible. So the atlas stops drawing shapes and
intersecting them, and instead gives every zone its ground first — grown
outward from a seed until it holds its share — then traces the outline of each
subject's territory afterwards. Exactness is then a property of the
construction rather than something a solver fits toward.

What it gives up is continuity. The boundaries come out of a growth process, so
a small change in the population does not make a small change in the picture —
which destroys the spatial memory a live map depends on, and is why the map is
still the thing you sit in and the atlas is something you ask for.

**Where it stops working.** Legibility, not accuracy, is the limit:

| subjects | rooms | subjects split across patches | verdict |
|---|---|---|---|
| 3 | 7 | 0 | clean |
| 4 | 14 | 2 | workable |
| 5 | 20 | 4 | cluttered |
| 6 | 30 | 6 | fragmented |
| 8 | 41 | 8 | fragmented |

Those verdicts come from looking at renders (`npm run render`), not from the
numbers. Five was called readable until somebody looked at it: the big
territories are fine but the middle fills with slivers, and a subject arriving
in three pieces reads as three subjects that happen to share a colour.

Areas stay exact at every size; what degrades is that a subject's territory
arrives in several pieces instead of one. That is the known hard part of Euler
layout — realising an arbitrary region structure with every subject connected
is not always possible at all — and it does not respond to more space or a
finer grid, so it is reported (`report.disconnected`, `report.worstSplit`)
rather than papered over. The default is five.

## Deploying

There is a `Procfile` and the port comes from `process.env.PORT`, so it boots
on a single dyno. Memory is not the constraint — a world of 1000 interests and
50,000 people is 36.5MB of heap, a connected session about 4.8KB, and a diagram
push 3.1KB on the wire. A 512MB dyno has room to spare.

What it does **not** survive is being scaled out:

- **Two dynos are two separate chat rooms.** All state is one in-memory
  `World`, so `ps:scale web=2` splits the population in half with no error and
  no symptom beyond people not hearing each other. This is the blocker, and it
  is the only one that needs architecture rather than code.
- **A dyno restart empties the world.** Heroku cycles dynos at least daily, and
  every deploy does the same. Every message and membership is gone.
- **Solving blocks the event loop.** Layouts run on the main thread, so a burst
  of first paints stalls all other traffic — worse on a shared-CPU dyno than on
  a laptop.
- **One long run ended in an unexplained exit.** A server left up for hours
  exited with code 1 and left no stack behind, and the cause is still not
  known. The obvious gaps were closed afterwards — sockets, the socket server
  and the HTTP server all have error listeners now, and the heartbeat skips
  anything not open — but none of those reproduce it, so the fix is unproven.
  What was certainly missing was the evidence: uncaught exceptions and
  rejections now print a stack and the session counts before exiting.

Idle timeouts are handled: the server pings every 25s, inside Heroku's 55s
cutoff, and the client reconnects with backoff and resumes its identity and
memberships within a 60s grace window.

### What sharing state would take

The pure algebra in `lib/` is already independent of where state lives; only
`World` would be replaced.

- **Census → Redis hash.** `#touch` already does nothing but increment and
  decrement a handful of counters per join, and deletes on zero. That is
  `HINCRBY` plus a conditional `HDEL`, and the Euler property survives the
  translation unchanged.
- **Fan-out → Redis pub/sub.** Publish per subject; each dyno subscribes to the
  subjects its own connections hold and applies `T ⊆ S` locally.
- **Layout cache → Redis, keyed by `censusSignature`.** The key already exists
  and is already content-addressed, so it is shareable as-is.
- **Messages and memberships → Postgres**, with Redis as the hot index.

## Known limits

- **State is in memory.** Restarting resets the world.
- **Solving blocks the event loop.** Every layout runs on the main thread, so a
  burst of first paints stalls all other traffic. Fine at prototype
  concurrency, not at a thundering herd.
- **Abuse is bounded, not solved.** A subscription is capped at 32 because the
  census enumerates subsets up to arity three and is therefore cubic in what
  one person holds — uncapped, a single client holding 300 subjects built 4.5
  million regions and pushed *everyone's* view past a second. The catalogue is
  capped, and each connection gets a leaky bucket priced by how expensive each
  frame is. None of that is authentication.
- **No moderation, no auth.** Derived rooms have a real unsolved question
  behind them: neither parent circle's moderators obviously own the
  intersection, and rooms grow exponentially while moderators do not.
- **Anyone can create a subject.** Whoever controls circle creation controls
  whether the map stays legible; this prototype does not control it at all.
- **Rendering is verified by rasteriser, not by browser.** `npm run render`
  draws the real components through a DOM shim and rasterises them, which is
  what caught the labels sitting on boundaries, the enclosed white holes, and
  the overlap that came out grey. It does not exercise CSS, layout, blend
  modes or any interaction — no browser has run this yet.
- **The atlas can leave a lake.** Growth stops when zones reach their quota, so
  a gap fully enclosed by territories can survive. Small ones are absorbed by
  whichever neighbours are still short of their share; a large one stays, and
  reads as a hole in the middle of the map.
- **Subject colours can collide.** Hues come from a hash of the name, which is
  stable across reloads but says nothing about what else is on screen, so a
  view can come up with three neighbouring blues.
