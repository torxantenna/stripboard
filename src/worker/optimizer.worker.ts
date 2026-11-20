/// <reference lib="webworker" />
import { Annealer } from '../core/anneal';
import { makeProblem } from '../core/problem';
import type { BestSnapshot, StartMessage, WorkerMessage } from './protocol';

const post = (m: WorkerMessage) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<StartMessage>) => {
  const msg = e.data;
  if (msg.type !== 'start') return;
  try {
    const problem = makeProblem(msg.netlist, msg.board);
    const annealer = new Annealer(problem, {
      iterations: msg.iterations,
      restarts: msg.restarts,
      seed: msg.seed,
      weights: msg.weights,
      route: msg.route,
      initial: msg.initial,
    });
    let lastBest = Infinity;
    let lastPost = 0;
    const snapshot = (): BestSnapshot => {
      const b = annealer.best!;
      return { layout: b.layout, cost: b.cost, metrics: b.metrics };
    };
    // Run in chunks so progress streams out; the main thread stops us with terminate().
    while (!annealer.done) {
      const t0 = performance.now();
      let status = annealer.step(500);
      while (!annealer.done && performance.now() - t0 < 60) status = annealer.step(500);
      const now = performance.now();
      if (annealer.done) break;
      if (now - lastPost > 50) {
        const improved = annealer.best!.cost < lastBest;
        if (improved) lastBest = annealer.best!.cost;
        post({ type: 'progress', status, best: improved ? snapshot() : undefined });
        lastPost = now;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    post({ type: 'done', status: annealer.status(), best: snapshot() });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
