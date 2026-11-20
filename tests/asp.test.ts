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
