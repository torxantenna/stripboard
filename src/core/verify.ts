import { placedGeometry } from './footprints';
import type { Problem } from './problem';
import { holeName, UnionFind } from './route';
import { DEFAULT_PERF, type Cut, type Layout, type Link, type PerfOptions, type RouteOptions, type RouteResult, type Wire } from './types';

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

/**
 * Independent ground-truth check of a finished layout. It shares no logic with the router:
 * it simulates the copper directly (strips split by cuts, joined by links) and compares the
 * resulting electrical connectivity with the netlist. Mirrors the paper's post-hoc checks:
 * connectivity preserved, no shorts, no overlaps, everything on the board.
 */
export function verify(problem: Problem, layout: Layout, cuts: Cut[], links: Link[]): VerifyResult {
  const { holes: W, strips: H } = problem.board;
  const errors: string[] = [];
  const inBoard = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const owner = new Map<number, string>(); // hole -> what occupies it on the component side
  const claim = (x: number, y: number, what: string) => {
    if (!inBoard(x, y)) {
      errors.push(`${what} is off the board at (${x},${y})`);
      return;
    }
    const h = y * W + x;
    const prev = owner.get(h);
    if (prev !== undefined) errors.push(`${what} overlaps ${prev} at ${holeName(x, y)}`);
    else owner.set(h, what);
  };

  // Component pins and bodies.
  const pinHoles: { net: string | null; h: number; label: string }[] = [];
  problem.netlist.components.forEach((c, ci) => {
    const g = placedGeometry(problem.fps[ci], layout[ci]);
    g.pins.forEach((p, pi) => {
      claim(p.x, p.y, `${c.ref} pin ${pi + 1}`);
      if (inBoard(p.x, p.y)) pinHoles.push({ net: c.pins[pi], h: p.y * W + p.x, label: `${c.ref}.${pi + 1}` });
    });
    g.body.forEach((b) => claim(b.x, b.y, `${c.ref} body`));
  });

  // Links occupy every hole along their path on the component side.
  links.forEach((l, i) => {
    if (l.y1 === l.y2) errors.push(`link ${i + 1} has zero length`);
    const ya = Math.min(l.y1, l.y2);
    const yb = Math.max(l.y1, l.y2);
    for (let y = ya; y <= yb; y++) claim(l.x, y, `link ${holeName(l.x, l.y1)}–${holeName(l.x, l.y2)}`);
  });

  // Copper connectivity.
  const blocked = new Set<number>(); // edge (x,y)-(x+1,y) keyed by y*W+x
  const cutHoles = new Set<number>();
  for (const c of cuts) {
    if (!inBoard(c.x, c.y)) {
      errors.push(`cut off the board at (${c.x},${c.y})`);
      continue;
    }
    if (c.kind === 'hole') {
      cutHoles.add(c.y * W + c.x);
      if (c.x > 0) blocked.add(c.y * W + c.x - 1);
      blocked.add(c.y * W + c.x);
    } else {
      if (c.x >= W - 1) errors.push(`between-hole cut past the strip end at ${holeName(c.x, c.y)}`);
      blocked.add(c.y * W + c.x);
    }
  }
  const uf = new UnionFind(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const h = y * W + x;
      if (!blocked.has(h)) uf.union(h, h + 1);
    }
  }
  for (const l of links) {
    if (inBoard(l.x, l.y1) && inBoard(l.x, l.y2)) uf.union(l.y1 * W + l.x, l.y2 * W + l.x);
  }

  // Pins / links soldered to a drilled-out hole lose their copper.
  for (const p of pinHoles) {
    if (cutHoles.has(p.h)) errors.push(`cut drilled through pin ${p.label}`);
  }
  for (const l of links) {
    for (const y of [l.y1, l.y2]) {
      if (cutHoles.has(y * W + l.x)) errors.push(`cut drilled through link end ${holeName(l.x, y)}`);
    }
  }

  // Every net connected; distinct nets isolated.
  const rootNet = new Map<number, string>();
  const netRoots = new Map<string, Set<number>>();
  for (const p of pinHoles) {
    if (p.net === null) continue;
    const r = uf.find(p.h);
    if (!netRoots.has(p.net)) netRoots.set(p.net, new Set());
    netRoots.get(p.net)!.add(r);
    const other = rootNet.get(r);
    if (other === undefined) rootNet.set(r, p.net);
    else if (other !== p.net) errors.push(`short: ${other} and ${p.net} are connected (at ${p.label})`);
  }
  for (const [net, roots] of netRoots) {
    if (roots.size > 1) errors.push(`open: net ${net} is split into ${roots.size} pieces`);
  }

  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique };
}

/** Most extra wires soldered to one component pad (matches the router's limit). */
const PAD_WIRES = 2;

/**
 * Independent check of a perfboard layout. Every hole is an isolated pad; holes are joined
 * only by solder-side traces (each hole along a trace is soldered) and by jumper wires
 * (joined at their two ends). Checks connectivity against the netlist and the physical
 * rules of the chosen wiring options.
 */
export function verifyPerfboard(problem: Problem, layout: Layout, traces: Wire[], jumpers: Wire[], perf: PerfOptions): VerifyResult {
  const { holes: W, strips: H } = problem.board;
  const errors: string[] = [];
  const inBoard = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const owner = new Map<number, string>(); // component-side occupancy
  const claim = (x: number, y: number, what: string) => {
    if (!inBoard(x, y)) {
      errors.push(`${what} is off the board at (${x},${y})`);
      return;
    }
    const h = y * W + x;
    const prev = owner.get(h);
    if (prev !== undefined) errors.push(`${what} overlaps ${prev} at ${holeName(x, y)}`);
    else owner.set(h, what);
  };

  const pinHoles: { net: string | null; h: number; label: string }[] = [];
  const pinAt = new Map<number, string | null>();
  problem.netlist.components.forEach((c, ci) => {
    const g = placedGeometry(problem.fps[ci], layout[ci]);
    g.pins.forEach((p, pi) => {
      claim(p.x, p.y, `${c.ref} pin ${pi + 1}`);
      if (inBoard(p.x, p.y)) {
        const h = p.y * W + p.x;
        pinHoles.push({ net: c.pins[pi], h, label: `${c.ref}.${pi + 1}` });
        if (!pinAt.has(h)) pinAt.set(h, c.pins[pi]);
      }
    });
    g.body.forEach((b) => claim(b.x, b.y, `${c.ref} body`));
  });

  const uf = new UnionFind(W * H);
  /** Holes with wiring soldered to them (to catch wires on unconnected pins). */
  const wired = new Set<number>();

  if (!perf.traces && traces.length) errors.push('solder-side traces are not allowed');
  for (const t of traces) {
    const name = `trace ${holeName(t.x1, t.y1)}–${holeName(t.x2, t.y2)}`;
    if (t.x1 !== t.x2 && t.y1 !== t.y2) {
      errors.push(`${name} is not horizontal or vertical`);
      continue;
    }
    if (t.x1 === t.x2 && t.y1 === t.y2) errors.push(`${name} has zero length`);
    if (!inBoard(t.x1, t.y1) || !inBoard(t.x2, t.y2)) {
      errors.push(`${name} is off the board`);
      continue;
    }
    const n = Math.abs(t.x2 - t.x1) + Math.abs(t.y2 - t.y1);
    const sx = Math.sign(t.x2 - t.x1);
    const sy = Math.sign(t.y2 - t.y1);
    for (let i = 0; i <= n; i++) {
      const h = (t.y1 + sy * i) * W + t.x1 + sx * i;
      wired.add(h);
      if (i > 0) uf.union(h, h - sy * W - sx);
    }
  }

  const ends = new Map<number, number>();
  jumpers.forEach((j) => {
    const name = `jumper ${holeName(j.x1, j.y1)}–${holeName(j.x2, j.y2)}`;
    if (perf.jumpers === 'none') {
      errors.push(`${name}: jumpers are not allowed`);
      return;
    }
    if (!inBoard(j.x1, j.y1) || !inBoard(j.x2, j.y2)) {
      errors.push(`${name} is off the board`);
      return;
    }
    if (j.x1 === j.x2 && j.y1 === j.y2) errors.push(`${name} has zero length`);
    const len = Math.hypot(j.x2 - j.x1, j.y2 - j.y1);
    if (len > perf.maxJumper + 1e-9) errors.push(`${name} is longer than ${perf.maxJumper} holes`);
    if (perf.jumpers === 'straight') {
      if (j.x1 !== j.x2 && j.y1 !== j.y2) errors.push(`${name} is not straight`);
      else {
        // A bare jumper lies on the component side over every hole along it.
        const n = Math.abs(j.x2 - j.x1) + Math.abs(j.y2 - j.y1);
        for (let i = 0; i <= n; i++) claim(j.x1 + Math.sign(j.x2 - j.x1) * i, j.y1 + Math.sign(j.y2 - j.y1) * i, name);
      }
    }
    for (const [x, y] of [
      [j.x1, j.y1],
      [j.x2, j.y2],
    ]) {
      const h = y * W + x;
      wired.add(h);
      ends.set(h, (ends.get(h) ?? 0) + 1);
    }
    uf.union(j.y1 * W + j.x1, j.y2 * W + j.x2);
  });
  for (const [h, n] of ends) {
    const isPin = pinAt.has(h);
    if (n > (isPin ? PAD_WIRES : 1)) errors.push(`${n} jumper ends in hole ${holeName(h % W, (h / W) | 0)}`);
  }

  for (const h of wired) {
    if (pinAt.has(h) && pinAt.get(h) === null) errors.push(`wire soldered to unconnected pin at ${holeName(h % W, (h / W) | 0)}`);
  }

  const rootNet = new Map<number, string>();
  const netRoots = new Map<string, Set<number>>();
  for (const p of pinHoles) {
    if (p.net === null) continue;
    const r = uf.find(p.h);
    if (!netRoots.has(p.net)) netRoots.set(p.net, new Set());
    netRoots.get(p.net)!.add(r);
    const other = rootNet.get(r);
    if (other === undefined) rootNet.set(r, p.net);
    else if (other !== p.net) errors.push(`short: ${other} and ${p.net} are connected (at ${p.label})`);
  }
  for (const [net, roots] of netRoots) {
    if (roots.size > 1) errors.push(`open: net ${net} is split into ${roots.size} pieces`);
  }

  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique };
}

/** Verify a routed layout on whichever board type `opts` names. */
export function verifyRoute(problem: Problem, layout: Layout, r: RouteResult, opts: RouteOptions): VerifyResult {
  if (opts.board === 'perfboard') return verifyPerfboard(problem, layout, r.traces ?? [], r.jumpers ?? [], opts.perf ?? DEFAULT_PERF);
  return verify(problem, layout, r.cuts, r.links);
}
