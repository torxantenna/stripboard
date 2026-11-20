import { describe, expect, it } from 'vitest';
import { Annealer, randomLayout } from '../src/core/anneal';
import { evaluate, isClean } from '../src/core/cost';
import { geometry, getFootprint, parseFootprint } from '../src/core/footprints';
import { formatNetlist, parseNetlist } from '../src/core/netlist/parse';
import { makeProblem } from '../src/core/problem';
import { Rng } from '../src/core/rng';
import { holeName, route, stripName } from '../src/core/route';
import { DEFAULT_WEIGHTS, type Layout, type RouteOptions } from '../src/core/types';
import { verify } from '../src/core/verify';
import { EXAMPLES } from '../src/examples';

const HOLE: RouteOptions = { cutMode: 'hole' };

function parseOk(src: string) {
  const r = parseNetlist(src);
  expect(r.errors).toEqual([]);
  return r.netlist!;
}

describe('netlist parser', () => {
  it('parses text with board, values and comments', () => {
    const n = parseOk(`# hi\nboard 10x20\nR1 axial(4-8) 10k 1=A 2=B # trailing\nC1 radial(2) 2=B 1=A\n`);
    expect(n.board).toEqual({ strips: 10, holes: 20 });
    expect(n.components).toHaveLength(2);
    expect(n.components[0]).toMatchObject({ ref: 'R1', footprint: 'axial(4-8)', value: '10k', pins: ['A', 'B'] });
    expect(n.components[1].pins).toEqual(['A', 'B']);
    expect(n.nets).toEqual(['A', 'B']);
  });

  it('parses JSON', () => {
    const n = parseOk(
      JSON.stringify({ components: [{ ref: 'U1', footprint: 'dip8', pins: { '1': 'GND', '8': 'VCC' } }, { ref: 'J1', footprint: 'header2', pins: { '1': 'VCC', '2': 'GND' } }] }),
    );
    expect(n.components[0].pins).toEqual(['GND', null, null, null, null, null, null, 'VCC']);
  });

  it('reports errors with line numbers', () => {
    const r = parseNetlist(`R1 axial 1=A 2=B\nR1 axial 1=A\nU1 dip7\nX1 nonsense 1=A\nR2 axial 3=A\n`);
    expect(r.netlist).toBeNull();
    const lines = r.errors.map((e) => e.line);
    expect(lines).toEqual([2, 3, 4, 5]);
    expect(r.errors[0].message).toMatch(/duplicate/);
  });

  it('warns about single-pin nets', () => {
    const r = parseNetlist(`R1 axial 1=A 2=B\nR2 axial 1=A 2=C\n`);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/B.*C|C.*B/);
  });

  it('round-trips through formatNetlist', () => {
    for (const ex of EXAMPLES) {
      const n = parseOk(ex.source);
      const again = parseOk(formatNetlist(n));
      expect(again.components).toEqual(n.components.map((c) => ({ ...c, line: expect.any(Number) })));
    }
  });
});

describe('footprints', () => {
  it('rotates and normalises geometry', () => {
    const ax = getFootprint('axial(3-5)');
    expect(ax.spans).toEqual([3, 4, 5]);
    const g0 = geometry(ax, 0, 4);
    expect(g0.pins).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
    expect(g0.body).toHaveLength(3);
    expect([g0.w, g0.h]).toEqual([5, 1]);
    const g90 = geometry(ax, 90, 4);
    expect([g90.w, g90.h]).toEqual([1, 5]);
    expect(g90.pins[0].x).toBe(0);
    for (const rot of [0, 90, 180, 270] as const) {
      const g = geometry(ax, rot, 4);
      for (const p of [...g.pins, ...g.body]) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('places DIP rows across the strips', () => {
    const dip = getFootprint('dip8');
    expect(dip.rotations).toEqual([0, 180]);
    const g = geometry(dip, 0, 3);
    expect([g.w, g.h]).toEqual([4, 4]);
    // pin 1 and pin 8 share a strip on opposite sides
    expect(g.pins[0]).toEqual({ x: 0, y: 0 });
    expect(g.pins[7]).toEqual({ x: 3, y: 0 });
    expect(g.pins[3]).toEqual({ x: 0, y: 3 });
    expect(g.pins[4]).toEqual({ x: 3, y: 3 });
  });

  it('rejects bad specs', () => {
    expect(() => parseFootprint('dip7')).toThrow(/even/);
    expect(() => parseFootprint('axial(9-3)')).toThrow();
    expect(() => parseFootprint('blob')).toThrow(/unknown/);
    expect(parseFootprint('to92').pinCount).toBe(3);
    expect(parseFootprint('header(4)').pinCount).toBe(4);
  });
});

describe('router + verifier', () => {
  it('names holes like a build sheet', () => {
    expect(stripName(0)).toBe('A');
    expect(stripName(25)).toBe('Z');
    expect(stripName(26)).toBe('AA');
    expect(holeName(11, 3)).toBe('D12');
  });

  it('needs no cuts or links when every net is on its own strip', () => {
    const n = parseOk('board 6x10\nR1 axial(3) 1=A 2=B\nR2 axial(3) 1=A 2=B\n');
    const p = makeProblem(n);
    const layout: Layout = [
      { x: 1, y: 0, rot: 90, span: 3 },
      { x: 4, y: 0, rot: 90, span: 3 },
    ];
    const r = route(p, layout, HOLE);
    expect(r.cuts).toEqual([]);
    expect(r.links).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(verify(p, layout, r.cuts, r.links).ok).toBe(true);
  });

  it('cuts between different nets on one strip', () => {
    const n = parseOk('board 4x12\nR1 axial(3) 1=A 2=B\nR2 axial(3) 1=C 2=D\n');
    const p = makeProblem(n);
    // R1 vertical at x=1 (A on strip 0, B on strip 3); R2 vertical at x=5 (C on 0, D on 3)
    const layout: Layout = [
      { x: 1, y: 0, rot: 90, span: 3 },
      { x: 5, y: 0, rot: 90, span: 3 },
    ];
    const r = route(p, layout, HOLE);
    expect(r.cuts).toHaveLength(2);
    for (const c of r.cuts) expect(c.x).toBeGreaterThan(1);
    for (const c of r.cuts) expect(c.x).toBeLessThan(5);
    expect(verify(p, layout, r.cuts, r.links).ok).toBe(true);
  });

  it('reports a short when adjacent pins of different nets leave no room for a hole cut', () => {
    const n = parseOk('board 4x12\nR1 axial(3) 1=A 2=B\nR2 axial(3) 1=C 2=D\n');
    const p = makeProblem(n);
    const layout: Layout = [
      { x: 1, y: 0, rot: 90, span: 3 },
      { x: 2, y: 0, rot: 90, span: 3 },
    ];
    const r = route(p, layout, HOLE);
    expect(r.violations.filter((v) => v.type === 'short')).toHaveLength(2);
    // between-hole cuts make it legal
    const r2 = route(p, layout, { cutMode: 'between' });
    expect(r2.violations).toEqual([]);
    expect(verify(p, layout, r2.cuts, r2.links).ok).toBe(true);
  });

  it('links a net that lands on two strips', () => {
    const n = parseOk('board 8x12\nR1 axial(3) 1=A 2=B\nR2 axial(3) 1=B 2=C\n');
    const p = makeProblem(n);
    // R1: A on strip 0, B on strip 3. R2: B on strip 5, C on strip 8? board has 8 strips -> use 4..7
    const layout: Layout = [
      { x: 2, y: 0, rot: 90, span: 3 },
      { x: 6, y: 4, rot: 90, span: 3 },
    ];
    const r = route(p, layout, HOLE);
    expect(r.unrouted).toEqual([]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ net: 'B', y1: 3, y2: 4 });
    const v = verify(p, layout, r.cuts, r.links);
    expect(v.errors).toEqual([]);
  });

  it('detects overlaps and off-board parts', () => {
    const n = parseOk('board 6x6\nR1 axial(3) 1=A 2=B\nR2 axial(3) 1=A 2=B\n');
    const p = makeProblem(n);
    const r = route(p, [
      { x: 0, y: 0, rot: 0, span: 3 },
      { x: 1, y: 0, rot: 0, span: 3 },
    ], HOLE);
    expect(r.violations.some((v) => v.type === 'overlap')).toBe(true);
    const r2 = route(p, [
      { x: 0, y: 0, rot: 0, span: 3 },
      { x: 4, y: 2, rot: 0, span: 3 },
    ], HOLE);
    expect(r2.violations.some((v) => v.type === 'bounds')).toBe(true);
  });

  it('verifier catches a missing cut and a missing link', () => {
    const n = parseOk('board 4x12\nR1 axial(3) 1=A 2=B\nR2 axial(3) 1=C 2=D\n');
    const p = makeProblem(n);
    const layout: Layout = [
      { x: 1, y: 0, rot: 90, span: 3 },
      { x: 5, y: 0, rot: 90, span: 3 },
    ];
    const v = verify(p, layout, [], []);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/short/);
  });

  it('property: every layout the router calls clean passes the verifier', () => {
    let clean = 0;
    for (const ex of EXAMPLES) {
      const n = parseOk(ex.source);
      const p = makeProblem(n);
      const rng = new Rng(42);
      for (let i = 0; i < 300; i++) {
        const layout = randomLayout(p, rng);
        for (const cutMode of ['hole', 'between'] as const) {
          const r = route(p, layout, { cutMode });
          const v = verify(p, layout, r.cuts, r.links);
          const routerClean = r.violations.length === 0 && r.unrouted.length === 0;
          if (routerClean) {
            clean++;
            expect(v.errors).toEqual([]);
          }
          // Verifier must flag anything the router flags as a short/overlap/unrouted.
          if (!routerClean && r.violations.length === 0) expect(v.ok).toBe(false);
        }
      }
    }
    expect(clean).toBeGreaterThan(0);
  });
});

describe('simulated annealing', () => {
  for (const ex of EXAMPLES) {
    it(`finds a clean, verified layout for "${ex.name}"`, () => {
      const n = parseOk(ex.source);
      const p = makeProblem(n);
      const best = new Annealer(p, {
        iterations: 25000,
        restarts: 2,
        seed: 7,
        weights: DEFAULT_WEIGHTS,
        route: HOLE,
      }).run();
      expect(best.route.violations).toEqual([]);
      expect(best.route.unrouted).toEqual([]);
      expect(isClean(best.metrics)).toBe(true);
      expect(verify(p, best.layout, best.route.cuts, best.route.links).errors).toEqual([]);
      // normalised to the corner
      expect(best.metrics.bbox.x0).toBe(0);
      expect(best.metrics.bbox.y0).toBe(0);
      const again = evaluate(p, best.layout, HOLE, DEFAULT_WEIGHTS);
      expect(again.cost).toBeCloseTo(best.cost);
    });
  }

  it('is deterministic for a given seed', () => {
    const p = makeProblem(parseOk(EXAMPLES[1].source));
    const s = { iterations: 3000, restarts: 1, seed: 3, weights: DEFAULT_WEIGHTS, route: HOLE };
    expect(new Annealer(p, s).run().layout).toEqual(new Annealer(p, s).run().layout);
  });
});
