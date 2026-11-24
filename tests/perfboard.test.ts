import { describe, expect, it } from 'vitest';
import { Annealer, randomLayout } from '../src/core/anneal';
import { evaluate, isClean } from '../src/core/cost';
import { getFootprint, rotationsFor } from '../src/core/footprints';
import { parseNetlist } from '../src/core/netlist/parse';
import { makeProblem } from '../src/core/problem';
import { Rng } from '../src/core/rng';
import { route } from '../src/core/route';
import { DEFAULT_PERF, DEFAULT_WEIGHTS, type Layout, type PerfOptions, type RouteOptions } from '../src/core/types';
import { verifyPerfboard, verifyRoute } from '../src/core/verify';
import { EXAMPLES } from '../src/examples';

const perfOpts = (perf: Partial<PerfOptions> = {}): RouteOptions => ({
  cutMode: 'hole',
  board: 'perfboard',
  perf: { ...DEFAULT_PERF, ...perf },
});
const PERF = perfOpts();
const P2P = perfOpts({ traces: false, jumpers: 'angled' });

function problem(src: string) {
  const r = parseNetlist(src);
  expect(r.errors).toEqual([]);
  return makeProblem(r.netlist!);
}

/** Net A on pads (1,0) and (1,4); net B on pads (0,2) and (2,2), whose trace walls A off. */
const WALL = 'board 5x3\nPA1 pad 1=A\nPA2 pad 1=A\nPB1 pad 1=B\nPB2 pad 1=B\n';
const WALL_LAYOUT: Layout = [
  { x: 1, y: 0, rot: 0, span: 1 },
  { x: 1, y: 4, rot: 0, span: 1 },
  { x: 0, y: 2, rot: 0, span: 1 },
  { x: 2, y: 2, rot: 0, span: 1 },
];

describe('perfboard router + verifier', () => {
  it('joins two pins of a net with one solder-side trace and no cuts', () => {
    const p = problem('board 4x10\nR1 axial(3) 1=A 2=B\nR2 axial(3) 1=A 2=C\n');
    const layout: Layout = [
      { x: 0, y: 0, rot: 0, span: 3 },
      { x: 0, y: 2, rot: 0, span: 3 },
    ];
    const r = route(p, layout, PERF);
    expect(r.cuts).toEqual([]);
    expect(r.links).toEqual([]);
    expect(r.jumpers).toEqual([]);
    expect(r.traces).toEqual([{ net: 'A', x1: 0, y1: 0, x2: 0, y2: 2 }]);
    expect(r.unrouted).toEqual([]);
    expect(verifyRoute(p, layout, r, PERF).errors).toEqual([]);
    const ev = evaluate(p, layout, PERF, DEFAULT_WEIGHTS);
    expect(ev.metrics.traceLength).toBe(2);
    expect(ev.metrics.cuts).toBe(0);
  });

  it('bridges a net walled off by another net with a straight jumper', () => {
    const p = problem(WALL);
    const r = route(p, WALL_LAYOUT, PERF);
    expect(r.unrouted).toEqual([]);
    expect(r.jumpers).toEqual([{ net: 'A', x1: 1, y1: 1, x2: 1, y2: 3 }]);
    expect(r.traces).toContainEqual({ net: 'B', x1: 0, y1: 2, x2: 2, y2: 2 });
    expect(verifyRoute(p, WALL_LAYOUT, r, PERF).errors).toEqual([]);
  });

  it('leaves the walled-off net unrouted when jumpers are not allowed', () => {
    const p = problem(WALL);
    const opts = perfOpts({ jumpers: 'none' });
    const r = route(p, WALL_LAYOUT, opts);
    expect(r.jumpers).toEqual([]);
    expect(r.unrouted).toHaveLength(1);
    expect(r.unrouted[0].net).toBe('A');
    expect(verifyRoute(p, WALL_LAYOUT, r, opts).errors.join()).toMatch(/open: net A/);
  });

  it('uses an insulated jumper pad to pad when jumpers may be angled', () => {
    const p = problem(WALL);
    const opts = perfOpts({ jumpers: 'angled' });
    const r = route(p, WALL_LAYOUT, opts);
    expect(r.unrouted).toEqual([]);
    expect(r.jumpers).toEqual([{ net: 'A', x1: 1, y1: 0, x2: 1, y2: 4 }]);
    expect(verifyRoute(p, WALL_LAYOUT, r, opts).errors).toEqual([]);
  });

  it('wires every net point to point when traces are off', () => {
    const p = problem(EXAMPLES.find((e) => e.id === '555')!.source);
    const rng = new Rng(5);
    // Random layouts are spread out, so allow long wires.
    const opts = perfOpts({ traces: false, jumpers: 'angled', maxJumper: 100 });
    let clean = 0;
    for (let i = 0; i < 50; i++) {
      const layout = randomLayout(p, rng, 'perfboard');
      const r = route(p, layout, opts);
      expect(r.traces).toEqual([]);
      if (r.violations.length || r.unrouted.length) continue;
      clean++;
      expect(verifyRoute(p, layout, r, opts).errors).toEqual([]);
    }
    expect(clean).toBeGreaterThan(0);
  });

  it('verifier catches crossing traces (short) and a missing trace (open)', () => {
    const p = problem('board 3x5\nA1 pad 1=A\nA2 pad 1=A\nB1 pad 1=B\nB2 pad 1=B\n');
    const layout: Layout = [
      { x: 0, y: 1, rot: 0, span: 1 },
      { x: 4, y: 1, rot: 0, span: 1 },
      { x: 2, y: 0, rot: 0, span: 1 },
      { x: 2, y: 2, rot: 0, span: 1 },
    ];
    const a = { net: 'A', x1: 0, y1: 1, x2: 4, y2: 1 };
    const b = { net: 'B', x1: 2, y1: 0, x2: 2, y2: 2 };
    expect(verifyPerfboard(p, layout, [a, b], [], DEFAULT_PERF).errors.join()).toMatch(/short: .*A.*B|short: .*B.*A/);
    const open = verifyPerfboard(p, layout, [a], [], DEFAULT_PERF).errors;
    expect(open.join()).toMatch(/open: net B/);
    // An angled jumper fixes it, but only if angled jumpers are allowed.
    const j = { net: 'B', x1: 2, y1: 0, x2: 2, y2: 2 };
    expect(verifyPerfboard(p, layout, [a], [j], { ...DEFAULT_PERF, jumpers: 'angled' }).errors).toEqual([]);
    expect(verifyPerfboard(p, layout, [a], [j], { ...DEFAULT_PERF, jumpers: 'none' }).ok).toBe(false);
    // A straight jumper may not pass over or end on a pin.
    expect(verifyPerfboard(p, layout, [a], [j], DEFAULT_PERF).ok).toBe(false);
  });

  it('lets DIPs turn all four ways on perfboard only', () => {
    const dip = getFootprint('dip8');
    expect(rotationsFor(dip, 'stripboard')).toEqual([0, 180]);
    expect(rotationsFor(dip, 'perfboard')).toEqual([0, 90, 180, 270]);
    expect(rotationsFor(getFootprint('pad'), 'perfboard')).toEqual([0]);
  });

  it('property: every layout the router calls clean passes the verifier, and it never shorts', () => {
    const variants: PerfOptions[] = [
      DEFAULT_PERF,
      { ...DEFAULT_PERF, jumpers: 'none' },
      { ...DEFAULT_PERF, jumpers: 'angled' },
      { traces: false, jumpers: 'angled', maxJumper: 12 },
    ];
    let clean = 0;
    for (const ex of EXAMPLES) {
      const p = makeProblem(parseNetlist(ex.source).netlist!);
      const rng = new Rng(42);
      for (let i = 0; i < 60; i++) {
        const layout = randomLayout(p, rng, 'perfboard');
        for (const perf of variants) {
          const opts = perfOpts(perf);
          const r = route(p, layout, opts);
          const v = verifyRoute(p, layout, r, opts);
          if (r.violations.length) continue;
          // Wiring never touches another net: the only possible problems are opens, exactly
          // when the router reports unrouted pins.
          expect(v.errors.filter((e) => !e.startsWith('open:'))).toEqual([]);
          expect(v.ok).toBe(r.unrouted.length === 0);
          if (v.ok) clean++;
        }
      }
    }
    expect(clean).toBeGreaterThan(0);
  });
});

describe('perfboard annealing', () => {
  for (const [name, opts] of [
    ['traces + straight jumpers', PERF],
    ['point to point', P2P],
  ] as const) {
    for (const ex of EXAMPLES) {
      it(`finds a clean, verified ${name} layout for "${ex.name}"`, () => {
        const p = makeProblem(parseNetlist(ex.source).netlist!);
        const best = new Annealer(p, { iterations: 8000, restarts: 1, seed: 7, weights: DEFAULT_WEIGHTS, route: opts }).run();
        expect(best.route.violations).toEqual([]);
        expect(best.route.unrouted).toEqual([]);
        expect(isClean(best.metrics)).toBe(true);
        expect(best.metrics.cuts).toBe(0);
        expect(verifyRoute(p, best.layout, best.route, opts).errors).toEqual([]);
        expect(best.metrics.bbox.x0).toBe(0);
        expect(best.metrics.bbox.y0).toBe(0);
      }, 60000);
    }
  }
});
