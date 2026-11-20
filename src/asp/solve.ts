import type { Problem } from '../core/problem';
import type { Layout } from '../core/types';
import { decode, encode, paperModelObstacles, type AspEncoding, type AspOptions } from './encode';

export type AspOutcome = 'optimum' | 'timeout' | 'unsat' | 'infeasible-model' | 'error' | 'unknown';

export interface AspResult {
  outcome: AspOutcome;
  layout: Layout | null;
  /** Clingo's cost vector of the best model (highest priority first). */
  costs: number[];
  models: number;
  seconds: number;
  messages: string[];
  encoding: AspEncoding | null;
}

export interface AspProgress {
  models: number;
  costs: number[];
  layout: Layout;
  seconds: number;
}

interface Witness {
  Value: string[];
  Costs?: number[];
}

type ClingoModule = {
  run: (program: string, models?: number, options?: string[], onModel?: (w: Witness) => void) => Promise<unknown>;
  restart: () => Promise<void>;
};

let clingoPromise: Promise<ClingoModule> | null = null;
/** Lazily load clingo-wasm (≈1 MB of wasm) only when the exact solver is used. */
function loadClingo(): Promise<ClingoModule> {
  clingoPromise ??= import('clingo-wasm').then((m) => (m.default ?? m) as unknown as ClingoModule);
  return clingoPromise;
}

/** Abort a running solve. */
export async function abortAsp(): Promise<void> {
  if (clingoPromise) await (await clingoPromise).restart();
}

export const MAX_CANDIDATES = 60000;

/**
 * Solve placement exactly (within a time limit) with clingo. Streams improving models via
 * `onProgress`; on timeout the best model found so far is returned.
 */
export async function solveAsp(
  problem: Problem,
  opts: AspOptions & { timeLimit: number; threads?: number },
  onProgress?: (p: AspProgress) => void,
): Promise<AspResult> {
  const t0 = performance.now();
  const secs = () => (performance.now() - t0) / 1000;
  const base = { costs: [], models: 0, layout: null };

  if (opts.mode === 'paper') {
    const obstacles = paperModelObstacles(problem);
    if (obstacles.length) {
      return { ...base, outcome: 'infeasible-model', seconds: secs(), messages: obstacles, encoding: null };
    }
  }

  const enc = encode(problem, opts);
  if (enc.stats.candidates > MAX_CANDIDATES) {
    return {
      ...base,
      outcome: 'error',
      seconds: secs(),
      messages: [`${enc.stats.candidates.toLocaleString()} candidate placements is too many to ground; use a smaller board.`],
      encoding: enc,
    };
  }

  const clingo = await loadClingo();
  const n = problem.netlist.components.length;
  let best: { layout: Layout; costs: number[] } | null = null;
  let models = 0;
  // clingo-wasm does not honour --time-limit, so enforce it here: abort the worker and keep
  // the best model streamed so far.
  const args = ['--opt-mode=opt'];
  if (opts.threads && opts.threads > 1) args.push(`-t ${opts.threads}`);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void clingo.restart();
  }, Math.max(1, opts.timeLimit) * 1000);
  let raw: unknown;
  try {
    raw = await clingo.run(enc.program, 0, args, (w: Witness) => {
      const layout = decode(enc, w.Value, n);
      if (!layout) return;
      models++;
      best = { layout, costs: w.Costs ?? [] };
      onProgress?.({ models, costs: best.costs, layout, seconds: secs() });
    });
  } catch (e) {
    raw = { Error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    const found = best as { layout: Layout; costs: number[] } | null;
    return {
      outcome: found ? 'timeout' : 'unknown',
      layout: found?.layout ?? null,
      costs: found?.costs ?? [],
      models,
      seconds: secs(),
      messages: found ? [] : ['Time limit reached before any placement was found.'],
      encoding: enc,
    };
  }

  const r = raw as { Result?: string; Error?: string; Models?: { Optimum?: string; Costs?: number[] }; Call?: { Witnesses?: Witness[] }[] };
  if (r?.Error) return { ...base, outcome: 'error', seconds: secs(), messages: [r.Error], encoding: enc };

  // Fall back to the final result's witnesses if streaming delivered nothing.
  if (!best) {
    const ws = r?.Call?.flatMap((c) => c.Witnesses ?? []) ?? [];
    const last = ws[ws.length - 1];
    const layout = last ? decode(enc, last.Value, n) : null;
    if (layout) best = { layout, costs: last.Costs ?? [] };
    models = ws.length;
  }
  const found = best as { layout: Layout; costs: number[] } | null;
  const result = r?.Result ?? '';
  let outcome: AspOutcome;
  if (result === 'UNSATISFIABLE') outcome = 'unsat';
  else if (r?.Models?.Optimum === 'yes') outcome = 'optimum';
  else if (found) outcome = 'timeout';
  else outcome = 'unknown';
  const messages: string[] = [];
  if (outcome === 'unsat') {
    messages.push(
      opts.mode === 'paper'
        ? 'No placement satisfies the paper model on this board (try a larger board or the relaxed model).'
        : 'No placement fits this board (try a larger board).',
    );
  }
  if (outcome === 'unknown') messages.push('Time limit reached before any placement was found.');
  return {
    outcome,
    layout: found?.layout ?? null,
    costs: found?.costs ?? r?.Models?.Costs ?? [],
    models,
    seconds: secs(),
    messages,
    encoding: enc,
  };
}
