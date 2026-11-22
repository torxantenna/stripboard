import { placedGeometry } from './footprints';
import type { Problem } from './problem';
import { UnionFind } from './route';
import type { Cut, Hole, Layout, Link, RouteResult, Segment, Unrouted, Violation } from './types';
import { verify } from './verify';

/**
 * Build a RouteResult (for drawing, metrics and the build sheet) from a solution whose cuts
 * and links were chosen elsewhere — e.g. by the exact ASP solver — instead of by `route()`.
 * Copper segments, link nets and problems are all derived by simulating the copper, and any
 * problem the independent verifier finds is reported as a violation.
 */
export function routeFromSolution(problem: Problem, layout: Layout, cuts: Cut[], links: Link[]): RouteResult {
  const { holes: W, strips: H } = problem.board;
  const blocked = new Set<number>();
  const cutHole = new Set<number>();
  for (const c of cuts) {
    if (c.kind === 'hole') {
      cutHole.add(c.y * W + c.x);
      if (c.x > 0) blocked.add(c.y * W + c.x - 1);
      blocked.add(c.y * W + c.x);
    } else blocked.add(c.y * W + c.x);
  }
  const uf = new UnionFind(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W - 1; x++) if (!blocked.has(y * W + x)) uf.union(y * W + x, y * W + x + 1);
  for (const l of links) uf.union(l.y1 * W + l.x, l.y2 * W + l.x);

  // Net of each electrical piece, from the pins on it.
  const rootNet = new Map<number, string>();
  const pinsByNet = new Map<string, Hole[]>();
  problem.netlist.components.forEach((c, ci) => {
    placedGeometry(problem.fps[ci], layout[ci]).pins.forEach((p, pi) => {
      const net = c.pins[pi];
      if (!net || p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
      const r = uf.find(p.y * W + p.x);
      if (!rootNet.has(r)) rootNet.set(r, net);
      if (!pinsByNet.has(net)) pinsByNet.set(net, []);
      pinsByNet.get(net)!.push(p);
    });
  });

  // Copper segments that carry a net (including otherwise-empty strips used as buses).
  const segments: Segment[] = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (cutHole.has(y * W + x)) {
        x++;
        continue;
      }
      const lo = x;
      while (x < W - 1 && !blocked.has(y * W + x)) x++;
      const hi = x;
      x++;
      const net = rootNet.get(uf.find(y * W + lo));
      if (net) segments.push({ net, y, pinMin: lo, pinMax: hi, lo, hi });
    }
  }

  const namedLinks = links.map((l) => ({ ...l, net: rootNet.get(uf.find(l.y1 * W + l.x)) ?? '' }));

  // Opens: chain the separate pieces of each net for ratsnest drawing.
  const unrouted: Unrouted[] = [];
  for (const [net, pins] of pinsByNet) {
    const pieces = new Map<number, Hole>();
    for (const p of pins) {
      const r = uf.find(p.y * W + p.x);
      if (!pieces.has(r)) pieces.set(r, p);
    }
    const reps = [...pieces.values()];
    for (let i = 1; i < reps.length; i++) unrouted.push({ net, from: reps[0], to: reps[i] });
  }

  const violations: Violation[] = verify(problem, layout, cuts, namedLinks)
    .errors.filter((e) => !e.startsWith('open:'))
    .map((message) => ({
      type: /short/.test(message) ? 'short' : /off the board|past the strip/.test(message) ? 'bounds' : 'overlap',
      message,
      holes: [],
    }));

  return { cuts, links: namedLinks, segments, unrouted, violations };
}
