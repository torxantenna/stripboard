import { it } from 'vitest';
import { Annealer } from '../src/core/anneal';
import { parseNetlist } from '../src/core/netlist/parse';
import { makeProblem } from '../src/core/problem';
import { DEFAULT_WEIGHTS } from '../src/core/types';
import { EXAMPLES } from '../src/examples';
import { verify } from '../src/core/verify';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
it.runIf(env.BENCH)('bench: anneal all examples', () => {
  for (const ex of EXAMPLES) {
    const p = makeProblem(parseNetlist(ex.source).netlist!);
    const t = performance.now();
    const iters = Number(env.ITERS ?? 60000), restarts = Number(env.RESTARTS ?? 3);
    const b = new Annealer(p, { iterations: iters, restarts, seed: Number(env.SEED ?? 1), weights: { ...DEFAULT_WEIGHTS, link: Number(env.WLINK ?? DEFAULT_WEIGHTS.link), area: Number(env.WAREA ?? DEFAULT_WEIGHTS.area), linkLength: Number(env.WLEN ?? DEFAULT_WEIGHTS.linkLength), cut: Number(env.WCUT ?? DEFAULT_WEIGHTS.cut) }, route: { cutMode: 'hole' } }).run();
    const ms = performance.now() - t;
    const m = b.metrics;
    const v = verify(p, b.layout, b.route.cuts, b.route.links);
    console.log(`${ex.name.padEnd(22)} board ${p.board.strips}x${p.board.holes} -> ${m.height}x${m.width}=${m.area} cuts ${m.cuts} links ${m.links} (len ${m.linkLength}) TD ${m.paperTD} cost ${b.cost.toFixed(1)} verify ${v.ok} ${(ms/1000).toFixed(1)}s ${(ms*1000/(iters*restarts)).toFixed(1)}us/it`);
  }
});

it.runIf(env.BENCH && env.ASP)('bench: ASP (relaxed) + router vs annealing on the same board', async () => {
  const { solveAsp } = await import('../src/asp/solve');
  const { compactBoard } = await import('../src/asp/encode');
  const { evaluate, isClean } = await import('../src/core/cost');
  for (const ex of EXAMPLES) {
    const p = makeProblem(parseNetlist(ex.source).netlist!);
    const sa = new Annealer(p, { iterations: 60000, restarts: 3, seed: 1, weights: DEFAULT_WEIGHTS, route: { cutMode: 'hole' } }).run();
    const board = compactBoard(sa.metrics, p.board, 2);
    const pb = makeProblem(p.netlist, board);
    const r = await solveAsp(pb, { mode: 'relaxed', board, cutMode: 'hole', timeLimit: Number(env.TL ?? 20), linkWeight: 6 });
    const ev = r.layout ? evaluate(pb, r.layout, { cutMode: 'hole' }, DEFAULT_WEIGHTS) : null;
    const fmt = (m: any, c: number) => `${m.height}x${m.width}=${m.area} cuts ${m.cuts} links ${m.links} unrouted ${m.unrouted} cost ${c.toFixed(0)}${isClean(m) ? ' ✓' : ' ✗'}`;
    const hy = r.layout ? new Annealer(pb, { iterations: 60000, restarts: 1, seed: 1, weights: DEFAULT_WEIGHTS, route: { cutMode: 'hole' }, initial: r.layout }).run() : null;
    console.log(`${ex.name.padEnd(22)} board ${board.strips}x${board.holes}\n   SA : ${fmt(sa.metrics, sa.cost)}\n   ASP: ${r.outcome} ${r.models} models ${r.seconds.toFixed(1)}s ${ev ? fmt(ev.metrics, ev.cost) : '-'}\n   ASP→SA refine: ${hy ? fmt(hy.metrics, hy.cost) : '-'}`);
  }
}, 600000);

it.runIf(env.BENCH && env.FULL)('bench: annealing then clingo window search (full model)', async () => {
  const { polishWithClingo } = await import('../src/asp/solve');
  for (const ex of EXAMPLES) {
    if (env.EX && env.EX !== ex.id) continue;
    const p = makeProblem(parseNetlist(ex.source).netlist!);
    const sa = new Annealer(p, { iterations: 60000, restarts: 3, seed: Number(env.SEED ?? 1), weights: DEFAULT_WEIGHTS, route: { cutMode: 'hole' } }).run();
    const m = Number(env.MARGIN ?? 1);
    const board = { strips: sa.metrics.height + m, holes: sa.metrics.width + m };
    const pb = makeProblem(p.netlist, board);
    const r = await polishWithClingo(pb, { layout: sa.layout, cuts: sa.route.cuts, links: sa.route.links }, {
      cutMode: 'hole', weights: DEFAULT_WEIGHTS, timeLimit: Number(env.TL ?? 30), windowTime: Number(env.WT ?? 4), windowSize: Number(env.K ?? 3), regionMargin: Number(env.RM ?? 2),
    });
    const b = r.best;
    const fmt = (m: any) => `${m.height}x${m.width}=${m.area} cuts ${m.cuts} links ${m.links} (len ${m.linkLength})`;
    console.log(`${ex.name.padEnd(22)} SA cost ${sa.cost.toFixed(0)} [${fmt(sa.metrics)}] -> clingo ${b.cost.toFixed(0)} [${fmt(b.metrics)}] verified ${b.ok} · ${r.windows} windows, ${r.improvements} improvements, ${r.seconds.toFixed(0)}s${r.provenOptimal ? ' (proven optimal)' : ''}`);
  }
}, 900000);
