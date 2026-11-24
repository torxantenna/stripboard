import type { Problem } from './problem';
import { EMPTY, F_BODY, F_PIN, occupancy } from './route';
import type { CostWeights, Hole, Layout, PerfOptions, RouteResult, Unrouted, Wire } from './types';

/** Most extra wire ends soldered to one component pad (beyond the part's own lead). */
export const MAX_PAD_WIRES = 2;

/** Directions: 0 right, 1 left, 2 down, 3 up; 4 = none (a start hole or a jumper end). */
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];
const NO_DIR = 4;

/** Trace path detour (in steps) beyond which a route with straight jumpers is also tried. */
const detourLimit = (manhattan: number) => 2 * manhattan + 4;

/** Small binary min-heap of integer items keyed by float priorities. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.vals.length;
  }
  clear() {
    this.keys.length = 0;
    this.vals.length = 0;
  }
  push(key: number, val: number) {
    const k = this.keys;
    const v = this.vals;
    let i = v.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  /** Remove and return the item with the smallest key. */
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const key = k.pop()!;
    const val = v.pop()!;
    const n = v.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= key) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = key;
      v[i] = val;
    }
    return top;
  }
}

/** One hop of a found path: a trace step between neighbouring holes, or a straight jumper. */
interface Hop {
  a: number;
  b: number;
  jumper: boolean;
}

class Scratch {
  g: Float64Array;
  seen: Uint32Array;
  done: Uint32Array;
  prev: Int32Array;
  dirIn: Uint8Array;
  viaJumper: Uint8Array;
  /** Holes finished by the latest search, in order; `count` of them are valid. */
  order: Int32Array;
  count = 0;
  stamp = 0;
  constructor(n: number) {
    this.order = new Int32Array(n);
    this.g = new Float64Array(n);
    this.seen = new Uint32Array(n);
    this.done = new Uint32Array(n);
    this.prev = new Int32Array(n);
    this.dirIn = new Uint8Array(n);
    this.viaJumper = new Uint8Array(n);
  }
  /** Hops of the search tree's path from a source to hole h, in order. */
  hopsTo(h: number): Hop[] {
    const hops: Hop[] = [];
    for (let t = h; this.prev[t] >= 0; t = this.prev[t]) hops.push({ a: this.prev[t], b: t, jumper: this.viaJumper[t] === 1 });
    return hops.reverse();
  }
}

interface PathResult {
  cost: number;
  hops: Hop[];
}

/**
 * Route a placement on perfboard (an isolated pad per hole).
 *
 * Nets are routed one at a time, shortest first. Each net grows a tree from one pin and
 * joins its nearest unconnected pin at each step, choosing the cheapest of:
 * - a solder-side trace: A* over orthogonal hole-to-hole steps through holes that are free
 *   (or under a part body) or already on this net;
 * - the same search with straight jumper edges added (rows and columns, over holes that are
 *   free on the component side), tried only when the trace alone fails or detours a lot;
 * - one angled (insulated) jumper straight from the tree to the pin.
 * Wiring never touches another net, so the result has no shorts; pins that cannot be
 * reached are reported as unrouted (ratsnest lines).
 */
export function routePerfboard(problem: Problem, layout: Layout, perf: PerfOptions, weights: CostWeights): RouteResult {
  const { holes: W, strips: H } = problem.board;
  const N = W * H;
  const { flags, pinNet, violations } = occupancy(problem, layout);

  /** Net owning each hole on the solder side: a pin's net, NC for unconnected pins, or a trace / jumper end. */
  const owner = Int32Array.from(pinNet);
  /** Component side taken by pins, bodies and straight jumpers (which lie flat over holes). */
  const compBusy = new Uint8Array(N);
  for (let h = 0; h < N; h++) if (flags[h] & (F_PIN | F_BODY)) compBusy[h] = 1;
  /** Jumper ends soldered into each hole. */
  const wireEnds = new Uint8Array(N);
  /** Trace step to the right (h*2) and downward (h*2+1) of each hole: net index, or -1. */
  const step = new Int32Array(N * 2).fill(-1);

  // Holes outside the parts' bounding box: wiring there grows the board, so it costs extra.
  let bx0 = W;
  let by0 = H;
  let bx1 = -1;
  let by1 = -1;
  for (let h = 0; h < N; h++) {
    if (!(flags[h] & (F_PIN | F_BODY))) continue;
    const x = h % W;
    const y = (h / W) | 0;
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
  }
  const outsideCost = Math.max(weights.area, 0) * 2;
  const outside = new Float64Array(N);
  for (let h = 0; h < N; h++) {
    const x = h % W;
    const y = (h / W) | 0;
    if (x < bx0 || x > bx1 || y < by0 || y > by1) outside[h] = outsideCost;
  }

  const traceCost = Math.max(weights.trace, 0.01);
  // A tiny tie-break against bends, so equal-length traces come out as few straight runs.
  const bendCost = traceCost * 0.01;
  const jumperCost = (len: number) => Math.max(weights.link, 0.01) + Math.max(weights.linkLength, 0) * len;
  const maxJ = Math.max(1, Math.floor(perf.maxJumper));
  // Cheapest cost per hole of distance covered, for an admissible A* heuristic.
  const perHole = (withJumpers: boolean) => (withJumpers ? Math.min(traceCost, jumperCost(maxJ) / maxJ) : traceCost);

  // Terminals per net: on-board pin holes, deduplicated.
  const terms: number[][] = problem.nets.map(() => []);
  for (let h = 0; h < N; h++) if (pinNet[h] >= 0) terms[pinNet[h]].push(h);

  const hpwl = (hs: number[]) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const h of hs) {
      const x = h % W;
      const y = (h / W) | 0;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    return x1 - x0 + (y1 - y0);
  };
  const order = terms
    .map((t, net) => ({ net, n: t.length, d: hpwl(t) }))
    .filter((e) => e.n > 1)
    .sort((a, b) => a.d - b.d || a.n - b.n || a.net - b.net);

  // Search scratch, reused between searches via a stamp. `fwd` grows from the net's tree,
  // `bwd` floods back from a target pin when a single bridging jumper is needed.
  const fwd = new Scratch(N);
  const bwd = new Scratch(N);
  const heap = new MinHeap();
  const inTree = new Uint8Array(N);
  const jumpers: Wire[] = [];
  const unrouted: Unrouted[] = [];

  const hole = (h: number): Hole => ({ x: h % W, y: (h / W) | 0 });
  const isPad = (h: number) => (flags[h] & F_PIN) !== 0;
  /** Can a straight jumper end in hole h for this net? */
  const straightEndOk = (h: number, net: number) =>
    !isPad(h) && !compBusy[h] && wireEnds[h] === 0 && (owner[h] === EMPTY || owner[h] === net);

  /**
   * A* from `sources` to `target` over trace steps, plus straight jumper edges when
   * `withJumpers`. Paths costing `bound` or more are not explored. With `target` -1 it
   * floods every reachable hole (Dijkstra) and returns null.
   */
  const search = (sc: Scratch, net: number, sources: number[], target: number, withJumpers: boolean, bound = Infinity): PathResult | null => {
    const stamp = ++sc.stamp;
    const { g, seen, done, prev, dirIn, viaJumper, order } = sc;
    sc.count = 0;
    heap.clear();
    const tx = target % W;
    const ty = (target / W) | 0;
    const k = target < 0 ? 0 : perHole(withJumpers);
    const hcost = (h: number) => (Math.abs((h % W) - tx) + Math.abs(((h / W) | 0) - ty)) * k;
    const relax = (h: number, cost: number, from: number, dir: number, jumper: boolean) => {
      if (seen[h] === stamp && g[h] <= cost) return;
      const hh = hcost(h);
      const f = cost + hh;
      if (f >= bound) return;
      seen[h] = stamp;
      g[h] = cost;
      prev[h] = from;
      dirIn[h] = dir;
      viaJumper[h] = jumper ? 1 : 0;
      // Among equal f, expand the hole nearest the target first (far fewer expansions on
      // an open grid, where many paths tie).
      heap.push(f + hh * 1e-3, h);
    };
    for (const h of sources) relax(h, 0, -1, NO_DIR, false);
    while (heap.size) {
      const h = heap.pop();
      if (done[h] === stamp) continue; // stale entry
      done[h] = stamp;
      order[sc.count++] = h;
      const cost = g[h];
      if (h === target) return { cost, hops: sc.hopsTo(h) };
      const x = h % W;
      const y = (h / W) | 0;
      const dir = dirIn[h];
      if (perf.traces) {
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nh = ny * W + nx;
          if (done[nh] === stamp) continue;
          const o = owner[nh];
          if (o !== EMPTY && o !== net) continue;
          relax(nh, cost + traceCost + outside[nh] + (dir !== NO_DIR && dir !== d ? bendCost : 0), h, d, false);
        }
      }
      // A hole takes at most one jumper end, so a jumper cannot start where one just ended.
      if (withJumpers && !viaJumper[h] && straightEndOk(h, net)) {
        for (let d = 0; d < 4; d++) {
          for (let len = 1; len <= maxJ; len++) {
            const nx = x + DX[d] * len;
            const ny = y + DY[d] * len;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
            const nh = ny * W + nx;
            if (compBusy[nh]) break; // a straight jumper cannot pass over this hole
            if (len < 2 || done[nh] === stamp || !straightEndOk(nh, net)) continue; // one-hole jumpers never beat a trace step
            relax(nh, cost + jumperCost(len) + outside[nh], h, NO_DIR, true);
          }
        }
      }
    }
    return null;
  };

  /**
   * After a trace search from the tree failed (so `fwd` holds every hole traces reach from
   * it, with exact costs), find the cheapest path that crosses the gap with one straight
   * jumper: flood back from the target with traces, then try every jumper between the two
   * regions.
   */
  const bridge = (net: number, target: number): PathResult | null => {
    search(bwd, net, [target], -1, false);
    // Scan jumpers from the smaller region; a jumper is the same either way round.
    const [from, to] = fwd.count <= bwd.count ? [fwd, bwd] : [bwd, fwd];
    const minJ = jumperCost(2);
    let bestCost = Infinity;
    let bestA = -1;
    let bestB = -1;
    for (let i = 0; i < from.count; i++) {
      const a = from.order[i];
      const ga = from.g[a];
      if (ga + minJ >= bestCost) continue;
      if (!straightEndOk(a, net)) continue;
      const x = a % W;
      const y = (a / W) | 0;
      for (let d = 0; d < 4; d++) {
        for (let len = 1; len <= maxJ; len++) {
          const nx = x + DX[d] * len;
          const ny = y + DY[d] * len;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
          const b = ny * W + nx;
          if (compBusy[b]) break;
          if (len < 2 || to.done[b] !== to.stamp) continue;
          // Each end's off-bbox cost is already in its g value.
          const cost = ga + jumperCost(len) + to.g[b];
          if (cost < bestCost && straightEndOk(b, net)) {
            bestCost = cost;
            bestA = a;
            bestB = b;
          }
        }
      }
    }
    if (bestA < 0) return null;
    // Orient tree-side end first.
    const [ta, tb] = from === fwd ? [bestA, bestB] : [bestB, bestA];
    const hops = [...fwd.hopsTo(ta), { a: ta, b: tb, jumper: true }];
    for (let t = tb; bwd.prev[t] >= 0; t = bwd.prev[t]) hops.push({ a: t, b: bwd.prev[t], jumper: false });
    return { cost: bestCost, hops };
  };

  /** Lay down a found path, adding its holes to the tree. */
  const commit = (net: number, hops: Hop[], tree: number[]) => {
    const name = problem.nets[net];
    const claim = (h: number) => {
      if (!isPad(h)) owner[h] = net;
      if (!inTree[h]) {
        inTree[h] = 1;
        tree.push(h);
      }
    };
    for (const { a, b, jumper } of hops) {
      if (jumper) {
        const ax = a % W;
        const ay = (a / W) | 0;
        const bx = b % W;
        const by = (b / W) | 0;
        const n = Math.abs(bx - ax) + Math.abs(by - ay);
        for (let i = 0; i <= n; i++) {
          compBusy[(ay + Math.sign(by - ay) * i) * W + ax + Math.sign(bx - ax) * i] = 1;
        }
        wireEnds[a]++;
        wireEnds[b]++;
        jumpers.push({ net: name, x1: ax, y1: ay, x2: bx, y2: by });
      } else {
        const lo = Math.min(a, b);
        step[lo * 2 + (Math.abs(a - b) === 1 ? 0 : 1)] = net;
      }
      claim(a);
      claim(b);
    }
  };

  /** True when no two straight jumpers of a path share a hole on the component side. */
  const jumpersDisjoint = (hops: Hop[]) => {
    const used = new Set<number>();
    for (const { a, b, jumper } of hops) {
      if (!jumper) continue;
      const stepH = Math.abs(b - a) < W ? Math.sign(b - a) : Math.sign(b - a) * W;
      for (let h = a; ; h += stepH) {
        if (used.has(h)) return false;
        used.add(h);
        if (h === b) break;
      }
    }
    return true;
  };

  /** True when every orthogonal neighbour of hole h is off the board or taken by another net. */
  const enclosed = (h: number, net: number) => {
    const x = h % W;
    const y = (h / W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const o = owner[ny * W + nx];
      if (o === EMPTY || o === net) return false;
    }
    return true;
  };

  /** Cheapest angled jumper from the tree straight to the target pad, or null. */
  const angledFrom = (tree: number[], target: number): { from: number; cost: number } | null => {
    if (!isPad(target) || wireEnds[target] >= MAX_PAD_WIRES) return null;
    const tx = target % W;
    const ty = (target / W) | 0;
    let best = -1;
    let bestD = Infinity;
    for (const h of tree) {
      const lim = isPad(h) ? MAX_PAD_WIRES : 1;
      if (wireEnds[h] >= lim) continue;
      const d = Math.hypot((h % W) - tx, ((h / W) | 0) - ty);
      if (d > 0 && d <= perf.maxJumper + 1e-9 && d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best < 0 ? null : { from: best, cost: jumperCost(bestD) };
  };

  for (const { net } of order) {
    const ts = terms[net];
    const tree: number[] = [ts[0]];
    inTree[ts[0]] = 1;
    const failed = new Set<number>();
    for (;;) {
      // Nearest pin not yet connected (Manhattan distance to the tree).
      let target = -1;
      let td = Infinity;
      for (const t of ts) {
        if (inTree[t] || failed.has(t)) continue;
        const tx = t % W;
        const ty = (t / W) | 0;
        for (const h of tree) {
          const d = Math.abs((h % W) - tx) + Math.abs(((h / W) | 0) - ty);
          if (d < td) {
            td = d;
            target = t;
          }
        }
      }
      if (target < 0) break;

      let best: { cost: number; kind: 'path'; hops: Hop[] } | { cost: number; kind: 'angled'; from: number } | null = null;
      // No trace or straight jumper can reach a pin whose four neighbours all belong to other
      // nets (straight jumpers never end on pads), so skip the searches for one.
      if (perf.traces && !enclosed(target, net)) {
        const p = search(fwd, net, tree, target, false);
        if (p) best = { cost: p.cost, kind: 'path', hops: p.hops };
        if (perf.jumpers === 'straight') {
          // Unreachable by traces: bridge the gap with one jumper. A long detour: look for a
          // cheaper route using jumpers, bounded by the detour's cost.
          let q = !p ? bridge(net, target) : p.cost > detourLimit(td) * traceCost ? search(fwd, net, tree, target, true, p.cost) : null;
          // The search only sees committed jumpers, so two jumpers of one new path could cross.
          if (q && p && !jumpersDisjoint(q.hops)) q = null;
          if (q && (!best || q.cost < best.cost - 1e-9)) best = { cost: q.cost, kind: 'path', hops: q.hops };
        }
      }
      if (perf.jumpers === 'angled') {
        const a = angledFrom(tree, target);
        if (a && (!best || a.cost < best.cost - 1e-9)) best = { cost: a.cost, kind: 'angled', from: a.from };
      }

      if (!best) {
        failed.add(target);
        let near = tree[0];
        let nd = Infinity;
        for (const h of tree) {
          const d = Math.abs((h % W) - (target % W)) + Math.abs(((h / W) | 0) - ((target / W) | 0));
          if (d < nd) {
            nd = d;
            near = h;
          }
        }
        unrouted.push({ net: problem.nets[net], from: hole(near), to: hole(target) });
        continue;
      }
      if (best.kind === 'path') {
        commit(net, best.hops, tree);
      } else {
        const f = best.from;
        wireEnds[f]++;
        wireEnds[target]++;
        jumpers.push({ net: problem.nets[net], x1: f % W, y1: (f / W) | 0, x2: target % W, y2: (target / W) | 0 });
        inTree[target] = 1;
        tree.push(target);
      }
    }
  }

  // Merge unit trace steps into straight runs.
  const traces: Wire[] = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W - 1) {
      const n = step[(y * W + x) * 2];
      if (n < 0) {
        x++;
        continue;
      }
      const x1 = x;
      while (x < W - 1 && step[(y * W + x) * 2] === n) x++;
      traces.push({ net: problem.nets[n], x1, y1: y, x2: x, y2: y });
    }
  }
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H - 1) {
      const n = step[(y * W + x) * 2 + 1];
      if (n < 0) {
        y++;
        continue;
      }
      const y1 = y;
      while (y < H - 1 && step[(y * W + x) * 2 + 1] === n) y++;
      traces.push({ net: problem.nets[n], x1: x, y1, x2: x, y2: y });
    }
  }

  return { cuts: [], links: [], traces, jumpers, segments: [], unrouted, violations };
}
