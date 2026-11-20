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
    const iters = 60000, restarts = 3;
    const b = new Annealer(p, { iterations: iters, restarts, seed: 1, weights: DEFAULT_WEIGHTS, route: { cutMode: 'hole' } }).run();
    const ms = performance.now() - t;
    const m = b.metrics;
    const v = verify(p, b.layout, b.route.cuts, b.route.links);
    console.log(`${ex.name.padEnd(22)} board ${p.board.strips}x${p.board.holes} -> ${m.height}x${m.width}=${m.area} cuts ${m.cuts} links ${m.links} (len ${m.linkLength}) TD ${m.paperTD} cost ${b.cost.toFixed(1)} verify ${v.ok} ${(ms/1000).toFixed(1)}s ${(ms*1000/(iters*restarts)).toFixed(1)}us/it`);
  }
});
