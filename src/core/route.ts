import { geometry } from './footprints';
import type { Problem } from './problem';
import type { Cut, Hole, Layout, Link, RouteOptions, RouteResult, Segment, Unrouted, Violation } from './types';

const EMPTY = -2;
const NC = -1;

/** Occupancy flags per hole. */
const F_PIN = 1;
const F_BODY = 2;
const F_LINK = 4; // a link wire passes over / ends at this hole
const F_LINK_END = 8; // a link is soldered here

interface Run {
  net: number;
  y: number;
  pinMin: number;
  pinMax: number;
  /** Range a link endpoint may use, before cut placement (inclusive). */
  rangeLo: number;
  rangeHi: number;
  /** Gap index to the left / right on the same strip, or -1 at the strip end. */
  gapL: number;
  gapR: number;
}

interface Gap {
  y: number;
  left: number; // run index
  right: number; // run index
  /** Furthest copper the left run must keep, and nearest the right run must keep. */
  leftMax: number;
  rightMin: number;
  shorted: boolean;
}

class UnionFind {
  parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    const p = this.parent;
    while (p[a] !== a) {
      p[a] = p[p[a]];
      a = p[a];
    }
    return a;
  }
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent[ra] = rb;
    return true;
  }
}

export { UnionFind };

/**
 * Derive track cuts and wire links for a placement.
 *
 * 1. Lay all pins and bodies on an occupancy grid; flag overlaps and out-of-board parts.
 * 2. On each strip, group consecutive pins of the same net into runs. Every change of net
 *    between neighbouring runs needs one cut in the gap between them.
 * 3. For each net with runs on several strips, join the runs with vertical wire links
 *    (Kruskal over run pairs, shortest links first). A link's ends must be free holes in
 *    each run's copper, its path must not cross pins, bodies or other links, and each gap
 *    must keep a cuttable hole between the two sides.
 * 4. Place one cut in each gap.
 */
export function route(problem: Problem, layout: Layout, opts: RouteOptions): RouteResult {
  const { holes: W, strips: H } = problem.board;
  const N = W * H;
  const flags = new Uint8Array(N);
  const pinNet = new Int32Array(N).fill(EMPTY);
  const pinCount = new Uint8Array(N);
  const bodyCount = new Uint8Array(N);
  const violations: Violation[] = [];

  // --- 1. occupancy -------------------------------------------------------
  for (let ci = 0; ci < layout.length; ci++) {
    const pl = layout[ci];
    const g = geometry(problem.fps[ci], pl.rot, pl.span);
    if (pl.x < 0 || pl.y < 0 || pl.x + g.w > W || pl.y + g.h > H) {
      violations.push({
        type: 'bounds',
        message: `${problem.netlist.components[ci].ref} is off the board`,
        holes: [{ x: pl.x, y: pl.y }],
      });
    }
    const nets = problem.pinNets[ci];
    for (let pi = 0; pi < g.pins.length; pi++) {
      const x = g.pins[pi].x + pl.x;
      const y = g.pins[pi].y + pl.y;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const h = y * W + x;
      flags[h] |= F_PIN;
      pinCount[h]++;
      // If two pins land in one hole keep the first; overlap is reported below.
      if (pinNet[h] === EMPTY) pinNet[h] = nets[pi];
    }
    for (const b of g.body) {
      const x = b.x + pl.x;
      const y = b.y + pl.y;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const h = y * W + x;
      flags[h] |= F_BODY;
      bodyCount[h]++;
    }
  }
  for (let h = 0; h < N; h++) {
    const p = pinCount[h];
    const b = bodyCount[h];
    if (p > 1 || b > 1 || (p >= 1 && b >= 1)) {
      violations.push({
        type: 'overlap',
        message: `parts overlap at ${holeName(h % W, (h / W) | 0)}`,
        holes: [{ x: h % W, y: (h / W) | 0 }],
      });
    }
  }

  // --- 2. runs and gaps -----------------------------------------------------
  const runs: Run[] = [];
  const gaps: Gap[] = [];
  for (let y = 0; y < H; y++) {
    let cur: Run | null = null;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const net = pinNet[row + x];
      if (net === EMPTY || net === NC) continue;
      if (cur && cur.net === net) {
        cur.pinMax = x;
        continue;
      }
      const run: Run = { net, y, pinMin: x, pinMax: x, rangeLo: 0, rangeHi: W - 1, gapL: -1, gapR: -1 };
      if (cur) {
        const gi = gaps.length;
        gaps.push({ y, left: runs.length - 1, right: runs.length, leftMax: cur.pinMax, rightMin: x, shorted: false });
        cur.gapR = gi;
        run.gapL = gi;
        cur.rangeHi = x - 1;
        run.rangeLo = cur.pinMax + 1;
      }
      runs.push(run);
      cur = run;
    }
  }

  const cuttable = (g: Gap, leftMax: number, rightMin: number): boolean => {
    if (rightMin <= leftMax) return false;
    if (opts.cutMode === 'between') return true;
    const row = g.y * W;
    for (let x = leftMax + 1; x < rightMin; x++) {
      if (!(flags[row + x] & (F_PIN | F_LINK_END))) return true;
    }
    return false;
  };

  for (const g of gaps) {
    if (!cuttable(g, g.leftMax, g.rightMin)) {
      g.shorted = true;
      const a = problem.nets[runs[g.left].net];
      const b = problem.nets[runs[g.right].net];
      violations.push({
        type: 'short',
        message: `no room to cut between ${a} and ${b} on strip ${stripName(g.y)}`,
        holes: [
          { x: g.leftMax, y: g.y },
          { x: g.rightMin, y: g.y },
        ],
      });
    }
  }

  /** Can run r take a link endpoint at column x (ignoring path checks)? */
  const endpointOk = (r: Run, x: number): boolean => {
    if (x < r.rangeLo || x > r.rangeHi) return false;
    if (flags[r.y * W + x] & (F_PIN | F_BODY | F_LINK)) return false;
    if (x > r.pinMax && r.gapR >= 0) {
      const g = gaps[r.gapR];
      if (!g.shorted && !cuttable(g, Math.max(g.leftMax, x), g.rightMin)) return false;
    } else if (x < r.pinMin && r.gapL >= 0) {
      const g = gaps[r.gapL];
      if (!g.shorted && !cuttable(g, g.leftMax, Math.min(g.rightMin, x))) return false;
    }
    return true;
  };

  const claimEndpoint = (r: Run, x: number) => {
    flags[r.y * W + x] |= F_LINK_END;
    if (x > r.pinMax && r.gapR >= 0) gaps[r.gapR].leftMax = Math.max(gaps[r.gapR].leftMax, x);
    else if (x < r.pinMin && r.gapL >= 0) gaps[r.gapL].rightMin = Math.min(gaps[r.gapL].rightMin, x);
  };

  const pathClear = (x: number, ya: number, yb: number): boolean => {
    for (let y = ya + 1; y < yb; y++) {
      if (flags[y * W + x] & (F_PIN | F_BODY | F_LINK)) return false;
    }
    return true;
  };

  // --- 3. links -------------------------------------------------------------
  const runsByNet: number[][] = problem.nets.map(() => []);
  runs.forEach((r, i) => runsByNet[r.net].push(i));
  const netOrder = runsByNet
    .map((rs, net) => ({ net, n: rs.length }))
    .filter((e) => e.n > 1)
    .sort((a, b) => b.n - a.n || a.net - b.net);

  const links: Link[] = [];
  const unrouted: Unrouted[] = [];

  for (const { net } of netOrder) {
    const rs = runsByNet[net];
    const k = rs.length;
    const uf = new UnionFind(k);
    const pairs: { i: number; j: number; d: number }[] = [];
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const a = runs[rs[i]];
        const b = runs[rs[j]];
        if (a.y === b.y) continue;
        const gapX = Math.max(0, Math.max(a.pinMin, b.pinMin) - Math.min(a.pinMax, b.pinMax));
        pairs.push({ i, j, d: Math.abs(a.y - b.y) * 4 + gapX });
      }
    }
    pairs.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j);

    let joined = 1;
    for (const { i, j } of pairs) {
      if (joined === k) break;
      if (uf.find(i) === uf.find(j)) continue;
      let a = runs[rs[i]];
      let b = runs[rs[j]];
      if (a.y > b.y) [a, b] = [b, a];
      const lo = Math.max(a.rangeLo, b.rangeLo);
      const hi = Math.min(a.rangeHi, b.rangeHi);
      if (lo > hi) continue;
      // Prefer columns inside both runs' pin spans (no pressure on cuts), then nearest to them.
      const outside = (r: Run, x: number) => (x < r.pinMin ? r.pinMin - x : x > r.pinMax ? x - r.pinMax : 0);
      let bestX = -1;
      let bestScore = Infinity;
      for (let x = lo; x <= hi; x++) {
        const score = outside(a, x) + outside(b, x);
        if (score >= bestScore) continue;
        if (!endpointOk(a, x) || !endpointOk(b, x) || !pathClear(x, a.y, b.y)) continue;
        bestScore = score;
        bestX = x;
        if (score === 0) break;
      }
      if (bestX < 0) continue;
      claimEndpoint(a, bestX);
      claimEndpoint(b, bestX);
      for (let y = a.y; y <= b.y; y++) flags[y * W + bestX] |= F_LINK;
      links.push({ net: problem.nets[net], x: bestX, y1: a.y, y2: b.y });
      uf.union(i, j);
      joined++;
    }

    if (joined < k) {
      // Ratsnest: chain the disconnected groups with nearest-pin lines.
      const groups = new Map<number, number[]>();
      for (let i = 0; i < k; i++) {
        const root = uf.find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root)!.push(rs[i]);
      }
      const gl = [...groups.values()];
      const holesOf = (g: number[]): Hole[] =>
        g.flatMap((ri) => [
          { x: runs[ri].pinMin, y: runs[ri].y },
          { x: runs[ri].pinMax, y: runs[ri].y },
        ]);
      for (let gi = 1; gi < gl.length; gi++) {
        const prev = gl.slice(0, gi).flatMap(holesOf);
        const cur = holesOf(gl[gi]);
        let best: [Hole, Hole] = [prev[0], cur[0]];
        let bd = Infinity;
        for (const p of prev)
          for (const c of cur) {
            const d = Math.abs(p.x - c.x) + Math.abs(p.y - c.y);
            if (d < bd) {
              bd = d;
              best = [p, c];
            }
          }
        unrouted.push({ net: problem.nets[net], from: best[0], to: best[1] });
      }
    }
  }

  // --- 4. cuts ----------------------------------------------------------------
  const cuts: Cut[] = [];
  const cutAt = new Map<number, Cut>(); // gap index -> cut
  gaps.forEach((g, gi) => {
    if (g.shorted) return;
    if (opts.cutMode === 'between') {
      const x = (g.leftMax + g.rightMin - 1) >> 1;
      const c: Cut = { x, y: g.y, kind: 'between' };
      cuts.push(c);
      cutAt.set(gi, c);
      return;
    }
    const row = g.y * W;
    const mid = (g.leftMax + g.rightMin) / 2;
    let best = -1;
    let bd = Infinity;
    for (let x = g.leftMax + 1; x < g.rightMin; x++) {
      if (flags[row + x] & (F_PIN | F_LINK_END)) continue;
      const d = Math.abs(x - mid);
      if (d < bd) {
        bd = d;
        best = x;
      }
    }
    if (best < 0) {
      // Links reserved holes so this cannot happen; treat defensively as a short.
      g.shorted = true;
      violations.push({ type: 'short', message: `no room to cut on strip ${stripName(g.y)}`, holes: [{ x: g.leftMax, y: g.y }] });
      return;
    }
    const c: Cut = { x: best, y: g.y, kind: 'hole' };
    cuts.push(c);
    cutAt.set(gi, c);
  });

  const segments: Segment[] = runs.map((r) => {
    let lo = 0;
    let hi = W - 1;
    if (r.gapL >= 0) {
      const c = cutAt.get(r.gapL);
      lo = c ? (c.kind === 'hole' ? c.x + 1 : c.x + 1) : r.rangeLo;
    }
    if (r.gapR >= 0) {
      const c = cutAt.get(r.gapR);
      hi = c ? (c.kind === 'hole' ? c.x - 1 : c.x) : r.rangeHi;
    }
    return { net: problem.nets[r.net], y: r.y, pinMin: r.pinMin, pinMax: r.pinMax, lo, hi };
  });

  return { cuts, links, segments, unrouted, violations };
}

/** Strip letters: A..Z, then AA, AB, ... */
export function stripName(y: number): string {
  let s = '';
  let n = y;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Hole name as used on the build sheet, e.g. "C12" (strip C, hole 12; holes are 1-based). */
export function holeName(x: number, y: number): string {
  return `${stripName(y)}${x + 1}`;
}
