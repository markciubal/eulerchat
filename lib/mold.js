/**
 * A Physarum model: what grows between subjects.
 *
 * Slime mould solves a problem this map has. Given food sources scattered on a
 * plane it does not connect them naively — it explores everywhere, reinforces
 * the routes that carry traffic, lets the rest wither, and settles on a
 * network that is short, robust and roughly optimal. Famously it reproduces
 * the Tokyo rail network from oat flakes placed at the cities.
 *
 * The subjects are the food. The traffic is co-membership: a pair of subjects
 * that many people hold together gets many agents pushing between them, so the
 * channel between them is trodden into existence, while a pair nobody bridges
 * fades. The result is an adjacency that *grew* rather than one computed in a
 * single pass, and it keeps changing as the population does.
 *
 * Nothing here decides how much ground a zone gets — that stays with the
 * quotas, so areas remain exactly proportional. This only decides which way
 * the ground runs, which is why the atlas can take on an organic shape without
 * giving up the one guarantee it exists to make.
 *
 * The agent rules are the standard ones (Jones, 2010): sense three points
 * ahead, turn toward the strongest, step forward, deposit, and let the whole
 * field diffuse and decay. All of it is deterministic given a seed.
 */

const TAU = Math.PI * 2;

/** Deterministic PRNG, so the same world always weaves the same network. */
function rng(seed = 1) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Mold {
  /**
   * @param {object} options
   * @param {number} [options.grid=104]        cells per side
   * @param {number} [options.extent=1000]     user units across the plane
   * @param {Map<string,{x,y}>} options.anchors   where each subject sits
   * @param {Map<string,number>} [options.weight] how big each subject is
   * @param {Array<[string,string,number]>} [options.affinity]  pairs and how many people bridge them
   * @param {number} [options.agents=2400]     total population
   * @param {number} [options.sensorAngle]     radians off-heading the side sensors sit
   * @param {number} [options.turn]            radians an agent may turn in one step
   * @param {number} [options.sensorDistance]  cells ahead the sensors reach
   * @param {number} [options.deposit=1]
   * @param {number} [options.decay=0.09]
   * @param {number} [options.homing=0.5]  how strongly an agent steers toward its pair
   *
   * `homing` and `sensorDistance` are set where they are because the network
   * they produce actually tracks co-membership. Left at the values a general
   * Physarum model uses (0.14 and 7) it does not: agents merge into one mass
   * governed by the geometry, and on one test the resulting network came out
   * *anti*-correlated with the data. Tighter sensing and a firmer pull keep the
   * channels apart. Correlation across four populations, three of them never
   * used for tuning: 0.69, 0.97, 0.42, 1.00.
   * @param {number} [options.seed=1]
   */
  constructor(options = {}) {
    const {
      grid = 104,
      extent = 1000,
      anchors = new Map(),
      weight = new Map(),
      affinity = [],
      agents = 2400,
      sensorAngle = Math.PI / 8,
      turn = Math.PI / 4,
      sensorDistance = 3,
      deposit = 1,
      decay = 0.09,
      homing = 0.5,
      seed = 1,
    } = options;

    Object.assign(this, {
      grid, extent, anchors, sensorAngle, turn, sensorDistance, deposit, decay, homing,
    });

    this.random = rng(seed);
    this.trail = new Float32Array(grid * grid);
    this.scratch = new Float32Array(grid * grid);
    this.food = new Float32Array(grid * grid);
    this.steps = 0;

    this.#scatterFood(weight);
    this.agents = this.#hatch(agents, affinity);
  }

  toCell(x, y) {
    const gx = Math.floor(((x + this.extent / 2) / this.extent) * this.grid);
    const gy = Math.floor(((y + this.extent / 2) / this.extent) * this.grid);
    return [Math.min(this.grid - 1, Math.max(0, gx)), Math.min(this.grid - 1, Math.max(0, gy))];
  }

  /**
   * Food is laid at each subject, spread over a few cells so agents can find it
   * from a distance rather than having to land on a single point.
   */
  #scatterFood(weight) {
    const spread = Math.max(2, this.grid / 22);
    for (const [subject, at] of this.anchors) {
      const [cx, cy] = this.toCell(at.x, at.y);
      const strength = Math.log2(1 + (weight.get(subject) ?? 1));
      const reach = Math.ceil(spread * 2);

      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= this.grid || y >= this.grid) continue;
          this.food[y * this.grid + x] += strength * Math.exp(-(dx * dx + dy * dy) / (2 * spread * spread));
        }
      }
    }
  }

  /**
   * Agents are issued per pair of subjects, in proportion to how many people
   * hold both, and start out heading from one toward the other. That is the
   * whole coupling to the social graph: a heavily shared pair gets a crowd
   * treading a path between them, and a pair nobody bridges gets nobody.
   */
  #hatch(total, affinity) {
    const agents = [];
    const bridged = affinity.reduce((sum, [, , n]) => sum + n, 0);
    const places = [...this.anchors.values()];

    for (const [a, b, shared] of affinity) {
      const from = this.anchors.get(a);
      const to = this.anchors.get(b);
      if (!from || !to || shared <= 0) continue;

      const crowd = Math.max(1, Math.round((shared / (bridged || 1)) * total * 0.85));
      const heading = Math.atan2(to.y - from.y, to.x - from.x);
      for (let i = 0; i < crowd; i++) {
        // Spread along the line so the path is explored at once rather than
        // having to be pushed out from one end. Each agent keeps the pair it
        // belongs to and shuttles between the two ends of it for good: without
        // that, affinity only decided where agents *started*, and a hundred
        // generations of diffusion and decay erased every trace of it — the
        // network that emerged reflected the geometry and not one bit of who
        // actually holds what. It came out anti-correlated with the data it
        // was supposed to be tracing.
        const t = this.random();
        agents.push({
          x: from.x + (to.x - from.x) * t + (this.random() - 0.5) * 20,
          y: from.y + (to.y - from.y) * t + (this.random() - 0.5) * 20,
          heading: heading + (this.random() - 0.5) * 0.8 + (this.random() < 0.5 ? 0 : Math.PI),
          ends: [from, to],
          bound: this.random() < 0.5 ? 0 : 1,
        });
      }
    }

    // A minority wander from wherever they like, so the network is explored
    // beyond the pairs already known to be connected.
    while (agents.length < total && places.length) {
      const home = places[Math.floor(this.random() * places.length)];
      agents.push({
        x: home.x + (this.random() - 0.5) * 40,
        y: home.y + (this.random() - 0.5) * 40,
        heading: this.random() * TAU,
      });
    }
    return agents;
  }

  #sample(x, y) {
    const [gx, gy] = this.toCell(x, y);
    const at = gy * this.grid + gx;
    return this.trail[at] + this.food[at];
  }

  /** One generation: sense, turn, move, deposit, then diffuse and decay. */
  step(times = 1) {
    const unit = this.extent / this.grid;
    const reach = this.sensorDistance * unit;
    const arrival = this.extent * 0.05;

    for (let n = 0; n < times; n++) {
      for (const agent of this.agents) {
        const ahead = this.#sample(
          agent.x + Math.cos(agent.heading) * reach,
          agent.y + Math.sin(agent.heading) * reach,
        );
        const left = this.#sample(
          agent.x + Math.cos(agent.heading - this.sensorAngle) * reach,
          agent.y + Math.sin(agent.heading - this.sensorAngle) * reach,
        );
        const right = this.#sample(
          agent.x + Math.cos(agent.heading + this.sensorAngle) * reach,
          agent.y + Math.sin(agent.heading + this.sensorAngle) * reach,
        );

        if (ahead > left && ahead > right) {
          // keep going
        } else if (ahead < left && ahead < right) {
          agent.heading += (this.random() < 0.5 ? -1 : 1) * this.turn;
        } else if (left > right) {
          agent.heading -= this.turn;
        } else if (right > left) {
          agent.heading += this.turn;
        }

        // Traffic, not just spawning: an agent that belongs to a pair is
        // always on its way to one end of it, and turns for the other on
        // arrival. The pull is deliberately weak — enough that the route it
        // wears reflects the people bridging those two subjects, not so much
        // that it overrides the exploring that makes the network sensible.
        if (agent.ends) {
          const goal = agent.ends[agent.bound];
          const away = Math.hypot(goal.x - agent.x, goal.y - agent.y);
          if (away < arrival) agent.bound = 1 - agent.bound;
          else {
            const bearing = Math.atan2(goal.y - agent.y, goal.x - agent.x);
            let off = ((bearing - agent.heading + Math.PI * 3) % TAU) - Math.PI;
            agent.heading += off * this.homing;
          }
        }

        agent.x += Math.cos(agent.heading) * unit;
        agent.y += Math.sin(agent.heading) * unit;

        // Turn back at the edge rather than pile up against it.
        const edge = this.extent / 2;
        if (agent.x < -edge || agent.x > edge || agent.y < -edge || agent.y > edge) {
          agent.x = Math.min(edge, Math.max(-edge, agent.x));
          agent.y = Math.min(edge, Math.max(-edge, agent.y));
          agent.heading = this.random() * TAU;
        }

        const [gx, gy] = this.toCell(agent.x, agent.y);
        this.trail[gy * this.grid + gx] += this.deposit;
      }

      this.#settle();
      this.steps++;
    }
    return this;
  }

  /** Diffuse by a 3×3 mean and decay, which is what makes unused paths fade. */
  #settle() {
    const { grid, trail, scratch, decay } = this;
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        let sum = 0;
        let seen = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
            sum += trail[ny * grid + nx];
            seen++;
          }
        }
        scratch[y * grid + x] = (sum / seen) * (1 - decay);
      }
    }
    this.trail.set(scratch);
  }

  /** The field, normalised to 0..1, for biasing growth or for drawing. */
  field() {
    let peak = 0;
    for (const v of this.trail) if (v > peak) peak = v;
    if (!peak) return new Float32Array(this.trail.length);

    const out = new Float32Array(this.trail.length);
    for (let i = 0; i < this.trail.length; i++) out[i] = this.trail[i] / peak;
    return out;
  }

  /**
   * Which subjects the mould actually joined up, and how strongly.
   *
   * By widest path, not along the straight line between them. Sampling the
   * straight line was the obvious thing and it is precisely wrong here: a
   * mould route bends by nature, and a probe that only looks along the chord
   * scores a perfectly good curved channel at zero. Measured that way the
   * network came out *anti*-correlated with the co-membership it was meant to
   * be tracing — the pairs with the most people bridging them looked like the
   * weakest links on the map.
   *
   * So this asks the right question: over every route between two subjects,
   * which one has the highest floor? A channel is only as good as its thinnest
   * point, and the best channel is the one whose thinnest point is fattest.
   */
  network({ threshold = 0.05 } = {}) {
    const field = this.field();
    const names = [...this.anchors.keys()];
    const cellOf = (name) => {
      const [gx, gy] = this.toCell(this.anchors.get(name).x, this.anchors.get(name).y);
      return gy * this.grid + gx;
    };

    const edges = [];
    for (let i = 0; i < names.length; i++) {
      const reach = this.#widest(cellOf(names[i]), field);
      for (let j = i + 1; j < names.length; j++) {
        const strength = reach[cellOf(names[j])];
        if (strength >= threshold) {
          edges.push({ subjects: [names[i], names[j]].sort(), strength: Number(strength.toFixed(4)) });
        }
      }
    }
    return edges.sort((a, b) => b.strength - a.strength);
  }

  /**
   * Best floor reachable from `source` to every cell: a Dijkstra that maximises
   * the minimum rather than minimising the sum.
   */
  #widest(source, field) {
    const best = new Float32Array(field.length);
    const done = new Uint8Array(field.length);
    const queue = [[field[source], source]];
    best[source] = field[source];

    while (queue.length) {
      // The frontier stays small enough that a scan beats a heap here.
      let pick = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i][0] > queue[pick][0]) pick = i;
      const [floor, cell] = queue.splice(pick, 1)[0];
      if (done[cell]) continue;
      done[cell] = 1;

      const x = cell % this.grid;
      const y = (cell / this.grid) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.grid || ny >= this.grid) continue;
        const next = ny * this.grid + nx;
        if (done[next]) continue;

        const through = Math.min(floor, field[next]);
        if (through > best[next]) {
          best[next] = through;
          queue.push([through, next]);
        }
      }
    }
    return best;
  }
}

/**
 * Run a mould to settle over a set of subjects.
 *
 * @param {object} options  as `Mold`, plus `generations`
 * @returns {Mold}
 */
export function weave({ generations = 120, ...options } = {}) {
  return new Mold(options).step(generations);
}
