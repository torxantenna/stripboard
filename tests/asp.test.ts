import { describe, expect, it } from 'vitest';
import { compactBoard, encode, paperModelObstacles } from '../src/asp/encode';
import { solveAsp } from '../src/asp/solve';
import { Annealer } from '../src/core/anneal';
import { evaluate } from '../src/core/cost';
import { parseNetlist } from '../src/core/netlist/parse';
import { makeProblem } from '../src/core/problem';
import { DEFAULT_WEIGHTS, type RouteOptions } from '../src/core/types';
import { verify } from '../src/core/verify';
import { EXAMPLES } from '../src/examples';

const HOLE: RouteOptions = { cutMode: 'hole' };
const ex = (id: string) => makeProblem(parseNetlist(EXAMPLES.find((e) => e.id === id)!.source).netlist!);

describe('ASP encoding', () => {
  it('flags circuits the paper model cannot express', () => {
    expect(paperModelObstacles(ex('led'))).toEqual([]);
    expect(paperModelObstacles(ex('astable'))).toEqual([]);
    expect(paperModelObstacles(ex('555')).join()).toMatch(/U1 pins 4 and 8 are both on VCC/);
    expect(paperModelObstacles(ex('lm386')).join()).toMatch(/U1 pins 2 and 4 are both on GND/);
    expect(paperModelObstacles(ex('sallen-key')).length).toBeGreaterThan(0);
  });

  it('emits compact per-variant shape facts', () => {
    const p = ex('led');
    const enc = encode(p, { mode: 'paper', board: { strips: 4, holes: 8 }, cutMode: 'hole' });
    expect(enc.stats.candidates).toBeGreaterThan(10);
    expect(enc.program).toMatch(/#minimize \{ D@3,C : strip_distance\(C,D\) \}/);
    expect(enc.program).toContain('1 { place(C,V,X,Y) : cand(C,V,X,Y) } 1 :- comp(C).');
    // shapes are emitted per variant, not per position, so programs stay small
    const big = encode(ex('lm386'), { mode: 'relaxed', board: { strips: 15, holes: 20 }, cutMode: 'hole' });
    expect(big.stats.bytes).toBeLessThan(20000);
  });
});

describe('ASP solving with clingo-wasm', () => {
  it('proves the LED circuit infeasible under the paper model with flat resistors', async () => {
    // J1 and D1 force VCC, GND and A onto consecutive strips, but R1 needs its leads 4+ strips apart.
    const r = await solveAsp(ex('led'), { mode: 'paper', board: { strips: 6, holes: 9 }, cutMode: 'hole', timeLimit: 20 });
    expect(r.outcome).toBe('unsat');
  });

  it('solves a standing-resistor LED circuit to optimality under the paper model', async () => {
    const p = makeProblem(parseNetlist('J1 header2 PWR 1=VCC 2=GND\nR1 axial(1-6) 330R 1=VCC 2=A\nD1 radial(1) LED 1=A 2=GND\n').netlist!);
    const board = { strips: 5, holes: 9 };
    const r = await solveAsp(p, { mode: 'paper', board, cutMode: 'hole', timeLimit: 20 });
    expect(r.outcome).toBe('optimum');
    expect(r.layout).not.toBeNull();
    // paper objective vector: [TD, area, width]
    expect(r.costs).toHaveLength(3);
    const pb = makeProblem(p.netlist, board);
    const ev = evaluate(pb, r.layout!, HOLE, DEFAULT_WEIGHTS);
    // every net on one strip => no links needed
    expect(ev.route.links).toEqual([]);
    expect(verify(pb, r.layout!, ev.route.cuts, ev.route.links).ok).toBe(true);
  });

  it('reports the 555 as inexpressible in the paper model without solving', async () => {
    const r = await solveAsp(ex('555'), { mode: 'paper', board: { strips: 10, holes: 12 }, cutMode: 'hole', timeLimit: 5 });
    expect(r.outcome).toBe('infeasible-model');
    expect(r.encoding).toBeNull();
  });

  it('relaxed model gives an overlap- and short-free 555 placement', async () => {
    const p = ex('555');
    const sa = new Annealer(p, { iterations: 20000, restarts: 1, seed: 3, weights: DEFAULT_WEIGHTS, route: HOLE }).run();
    const board = compactBoard(sa.metrics, p.board, 2);
    const r = await solveAsp(p, { mode: 'relaxed', board, cutMode: 'hole', timeLimit: 8, linkWeight: 6 });
    expect(['optimum', 'timeout']).toContain(r.outcome);
    expect(r.layout).not.toBeNull();
    const pb = makeProblem(p.netlist, board);
    const ev = evaluate(pb, r.layout!, HOLE, DEFAULT_WEIGHTS);
    // The relaxed model can't see link-routing conflicts, so just require a valid, short-free placement.
    expect(ev.metrics.overlaps).toBe(0);
    expect(ev.metrics.shorts).toBe(0);
  }, 60000);
});

describe('full ASP model (placement + cuts + links)', () => {
  const sa = (id: string, seed = 1) => {
    const p = ex(id);
    const best = new Annealer(p, { iterations: 20000, restarts: 1, seed, weights: DEFAULT_WEIGHTS, route: HOLE }).run();
    return { p, best };
  };

  it('canonical cuts are electrically identical to the router cuts', async () => {
    const { canonicalCuts } = await import('../src/asp/encode');
    for (const id of ['555', 'astable', 'lm386']) {
      const { p, best } = sa(id);
      const cuts = canonicalCuts(p, best.layout, best.route.cuts, best.route.links, 'hole');
      expect(cuts.length).toBeLessThanOrEqual(best.route.cuts.length);
      expect(verify(p, best.layout, cuts, best.route.links).errors).toEqual([]);
    }
  });

  it('centring cuts for display keeps the circuit identical', async () => {
    const { canonicalCuts, centreCuts } = await import('../src/asp/encode');
    for (const id of ['555', 'astable', 'lm386']) {
      const { p, best } = sa(id);
      for (const mode of ['hole'] as const) {
        const canon = canonicalCuts(p, best.layout, best.route.cuts, best.route.links, mode);
        const centred = centreCuts(p, best.layout, canon, best.route.links, mode, p.board.holes);
        expect(centred).toHaveLength(canon.length);
        expect(verify(p, best.layout, centred, best.route.links).errors).toEqual([]);
      }
    }
  });

  it('routeFromSolution reproduces the router result', async () => {
    const { routeFromSolution } = await import('../src/core/solution');
    const { p, best } = sa('555');
    const r = routeFromSolution(p, best.layout, best.route.cuts, best.route.links);
    expect(r.violations).toEqual([]);
    expect(r.unrouted).toEqual([]);
    expect(r.links.every((l) => l.net !== '')).toBe(true);
    expect(new Set(r.segments.map((s) => s.net))).toEqual(new Set(best.route.segments.map((s) => s.net)));
  });

  it('proves the LED layout optimal, with its own cuts and links', async () => {
    const { polishWithClingo } = await import('../src/asp/solve');
    const { p, best } = sa('led');
    const board = { strips: best.metrics.height + 1, holes: best.metrics.width + 1 };
    const r = await polishWithClingo(makeProblem(p.netlist, board), { layout: best.layout, cuts: best.route.cuts, links: best.route.links }, {
      cutMode: 'hole',
      weights: DEFAULT_WEIGHTS,
      timeLimit: 20,
    });
    expect(r.provenOptimal).toBe(true);
    expect(r.best.ok).toBe(true);
    expect(r.best.cost).toBeLessThanOrEqual(best.cost);
  });

  it('window search never makes a layout worse and every answer verifies', async () => {
    const { polishWithClingo } = await import('../src/asp/solve');
    const { p, best } = sa('astable', 2);
    const board = { strips: best.metrics.height + 1, holes: best.metrics.width + 1 };
    const pb = makeProblem(p.netlist, board);
    const seen: boolean[] = [];
    const r = await polishWithClingo(
      pb,
      { layout: best.layout, cuts: best.route.cuts, links: best.route.links },
      { cutMode: 'hole', weights: DEFAULT_WEIGHTS, timeLimit: 8, seed: 3 },
      (pr) => seen.push(pr.best.ok),
    );
    expect(r.windows).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(r.best.ok).toBe(true);
    expect(r.best.cost).toBeLessThanOrEqual(best.cost + 1e-9);
    // and the full-board verifier agrees on the main (larger) board too
    const v = verify(p, r.best.layout, r.best.cuts, r.best.links);
    expect(v.errors).toEqual([]);
  }, 60000);

  it('window search works on a layout that is not anchored at the corner', async () => {
    const { polishWithClingo } = await import('../src/asp/solve');
    const { p, best } = sa('led');
    // shift the whole solution away from (0,0), as a hand-moved layout would be
    const dx = 2, dy = 3;
    const shifted = {
      layout: best.layout.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy })),
      cuts: best.route.cuts.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy })),
      links: best.route.links.map((l) => ({ ...l, x: l.x + dx, y1: l.y1 + dy, y2: l.y2 + dy })),
    };
    const board = { strips: best.metrics.height + 2, holes: best.metrics.width + 2 };
    const r = await polishWithClingo(makeProblem(p.netlist, board), shifted, { cutMode: 'hole', weights: DEFAULT_WEIGHTS, timeLimit: 10 });
    expect(r.provenOptimal).toBe(true);
    expect(r.best.ok).toBe(true);
  });

  it('the full model also works with between-hole cuts', async () => {
    const { polishWithClingo } = await import('../src/asp/solve');
    const p = ex('555');
    const best = new Annealer(p, { iterations: 20000, restarts: 1, seed: 1, weights: DEFAULT_WEIGHTS, route: { cutMode: 'between' } }).run();
    const board = { strips: best.metrics.height + 1, holes: best.metrics.width + 1 };
    const r = await polishWithClingo(makeProblem(p.netlist, board), { layout: best.layout, cuts: best.route.cuts, links: best.route.links }, {
      cutMode: 'between',
      weights: DEFAULT_WEIGHTS,
      timeLimit: 6,
    });
    expect(r.best.ok).toBe(true);
    expect(r.best.cost).toBeLessThanOrEqual(best.cost + 1e-9);
  }, 60000);
});
