import { costOf, computeMetrics } from '../core/cost';
import { placedGeometry } from '../core/footprints';
import type { Problem } from '../core/problem';
import { Rng } from '../core/rng';
import { routeFromSolution } from '../core/solution';
import type { CostWeights, Cut, CutMode, Layout, Link, Metrics, RouteResult } from '../core/types';
import { verify } from '../core/verify';
import { decode, decodeFull, encode, paperModelObstacles, type AspEncoding, type AspOptions } from './encode';

export type AspOutcome = 'optimum' | 'timeout' | 'unsat' | 'infeasible-model' | 'error' | 'unknown';

export interface AspResult {
  outcome: AspOutcome;
  layout: Layout | null;
  /** Full mode only: the solver's own track cuts and wire links. */
  cuts?: Cut[];
  links?: Link[];
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
  cuts?: Cut[];
  links?: Link[];
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

type Found = { layout: Layout; cuts?: Cut[]; links?: Link[]; costs: number[] };

/**
 * Solve with clingo (within a time limit). Streams improving models via `onProgress`; on
 * timeout the best model found so far is returned. In `full` mode the result includes the
 * solver's own cuts and links.
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
  const decodeAny = (atoms: string[]): Found | null => {
    if (opts.mode === 'full') {
      const d = decodeFull(enc, atoms, n, opts.cutMode);
      return d ? { ...d, costs: [] } : null;
    }
    const layout = decode(enc, atoms, n);
    return layout ? { layout, costs: [] } : null;
  };
  let best: Found | null = null;
  let models = 0;
  const args = ['--opt-mode=opt'];
  if (opts.mode === 'full' && opts.hint) args.push('--heuristic=Domain');
  if (opts.threads && opts.threads > 1) args.push(`-t ${opts.threads}`);
  // clingo-wasm does not honour --time-limit, so enforce it here: abort the worker and keep
  // the best model streamed so far.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void clingo.restart();
  }, Math.max(0.2, opts.timeLimit) * 1000);
  let raw: unknown;
  try {
    raw = await clingo.run(enc.program, 0, args, (w: Witness) => {
      const d = decodeAny(w.Value);
      if (!d) return;
      models++;
      best = { ...d, costs: w.Costs ?? [] };
      onProgress?.({ models, costs: best.costs, layout: d.layout, cuts: d.cuts, links: d.links, seconds: secs() });
    });
  } catch (e) {
    raw = { Error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
  const pack = (outcome: AspOutcome, f: Found | null, messages: string[], costs?: number[]): AspResult => ({
    outcome,
    layout: f?.layout ?? null,
    cuts: f?.cuts,
    links: f?.links,
    costs: f?.costs ?? costs ?? [],
    models,
    seconds: secs(),
    messages,
    encoding: enc,
  });
  if (timedOut) {
    const f = best as Found | null;
    return pack(f ? 'timeout' : 'unknown', f, f ? [] : ['Time limit reached before any solution was found.']);
  }

  const r = raw as { Result?: string; Error?: string; Models?: { Optimum?: string; Costs?: number[] }; Call?: { Witnesses?: Witness[] }[] };
  if (r?.Error) return { ...base, outcome: 'error', seconds: secs(), messages: [r.Error], encoding: enc };

  // Fall back to the final result's witnesses if streaming delivered nothing.
  if (!best) {
    const ws = r?.Call?.flatMap((c) => c.Witnesses ?? []) ?? [];
    const last = ws[ws.length - 1];
    const d = last ? decodeAny(last.Value) : null;
    if (d) best = { ...d, costs: last.Costs ?? [] };
    models = ws.length;
  }
  const f = best as Found | null;
  const result = r?.Result ?? '';
  let outcome: AspOutcome;
  if (result === 'UNSATISFIABLE') outcome = 'unsat';
  else if (r?.Models?.Optimum === 'yes') outcome = 'optimum';
  else if (f) outcome = 'timeout';
  else outcome = 'unknown';
  const messages: string[] = [];
  if (outcome === 'unsat') {
    messages.push(
      opts.mode === 'paper'
        ? 'No placement satisfies the paper model on this board (try a larger board or the relaxed model).'
        : opts.mode === 'full'
          ? 'No buildable layout exists on this board with these constraints (try a larger board or longer links).'
          : 'No placement fits this board (try a larger board).',
    );
  }
  if (outcome === 'unknown') messages.push('Time limit reached before any solution was found.');
  return pack(outcome, f, messages, r?.Models?.Costs);
}

// ---------------------------------------------------------------------------------------
// Window search (large-neighbourhood search): keep most parts fixed, let clingo re-place a
// few of them exactly together with every cut and link, keep improvements, repeat.

export interface FullSolution {
  layout: Layout;
  cuts: Cut[];
  links: Link[];
  route: RouteResult;
  metrics: Metrics;
  cost: number;
  /** Passes the independent verifier. */
  ok: boolean;
}

export function scoreSolution(problem: Problem, layout: Layout, cuts: Cut[], links: Link[], weights: CostWeights): FullSolution {
  const route = routeFromSolution(problem, layout, cuts, links);
  const metrics = computeMetrics(problem, layout, route);
  const ok = verify(problem, layout, cuts, route.links).ok;
  return { layout, cuts, links: route.links, route, metrics, cost: costOf(metrics, weights), ok };
}

export interface PolishOptions {
  cutMode: CutMode;
  weights: CostWeights;
  /** Total time budget in seconds. */
  timeLimit: number;
  /** Time per window in seconds. */
  windowTime?: number;
  /** Parts freed per window (adapts between 2 and 8). */
  windowSize?: number;
  maxLink?: number;
  seed?: number;
  /** Holes around the freed parts that may also change (cuts, links, positions). */
  regionMargin?: number;
}

export interface PolishProgress {
  windows: number;
  improvements: number;
  windowSize: number;
  seconds: number;
  best: FullSolution;
  /** A window covering every part and the whole board was solved to optimality. */
  provenOptimal?: boolean;
}

/** Translate a solution (parts, cuts and links together) so its used area starts at hole (0,0). */
export function anchorSolution<T extends { layout: Layout; cuts: Cut[]; links: Link[] }>(problem: Problem, sol: T): T {
  let x0 = Infinity;
  let y0 = Infinity;
  sol.layout.forEach((p, i) => {
    const g = placedGeometry(problem.fps[i], p);
    for (const h of [...g.pins, ...g.body]) {
      x0 = Math.min(x0, h.x);
      y0 = Math.min(y0, h.y);
    }
  });
  for (const l of sol.links) {
    x0 = Math.min(x0, l.x);
    y0 = Math.min(y0, l.y1, l.y2);
  }
  if (!Number.isFinite(x0) || (x0 === 0 && y0 === 0)) return sol;
  return {
    ...sol,
    layout: sol.layout.map((p) => ({ ...p, x: p.x - x0, y: p.y - y0 })),
    // A hole cut left of everything (x < x0) would be useless anyway; drop it.
    cuts: sol.cuts.filter((c) => c.x - x0 >= 0).map((c) => ({ ...c, x: c.x - x0, y: c.y - y0 })),
    links: sol.links.map((l) => ({ ...l, x: l.x - x0, y1: l.y1 - y0, y2: l.y2 - y0 })),
  };
}

/** Parts near a randomly chosen part (by centre distance), `k` in total. */
function pickWindow(problem: Problem, layout: Layout, k: number, rng: Rng): number[] {
  const centres = layout.map((p, i) => {
    const g = placedGeometry(problem.fps[i], p);
    const all = [...g.pins, ...g.body];
    return { x: all.reduce((a, h) => a + h.x, 0) / all.length, y: all.reduce((a, h) => a + h.y, 0) / all.length };
  });
  const seed = rng.int(0, layout.length - 1);
  return layout
    .map((_, i) => i)
    .sort((a, b) => {
      const da = Math.hypot(centres[a].x - centres[seed].x, centres[a].y - centres[seed].y);
      const db = Math.hypot(centres[b].x - centres[seed].x, centres[b].y - centres[seed].y);
      return da - db || a - b;
    })
    .slice(0, Math.min(k, layout.length));
}

/**
 * Improve a complete solution window by window. `problem.board` should be the board to work
 * on (typically the used area plus a margin). Returns the best solution found; each accepted
 * step passes the independent verifier.
 */
export async function polishWithClingo(
  problem: Problem,
  start: { layout: Layout; cuts: Cut[]; links: Link[] },
  opts: PolishOptions,
  onProgress?: (p: PolishProgress) => void,
  shouldStop?: () => boolean,
): Promise<{ best: FullSolution; windows: number; improvements: number; seconds: number; provenOptimal: boolean }> {
  const t0 = performance.now();
  const secs = () => (performance.now() - t0) / 1000;
  const rng = new Rng(opts.seed ?? 1);
  // Work with the solution anchored at hole (0,0) so it fits a compact board.
  start = anchorSolution(problem, start);
  let best = scoreSolution(problem, start.layout, start.cuts, start.links, opts.weights);
  let k = Math.max(2, Math.min(8, opts.windowSize ?? 3));
  const windowTime = opts.windowTime ?? 3;
  let windows = 0;
  let improvements = 0;
  const n = problem.netlist.components.length;

  while (secs() < opts.timeLimit && !shouldStop?.()) {
    const free = pickWindow(problem, best.layout, k, rng);
    const fixed = [...Array(n).keys()].filter((i) => !free.includes(i));
    // Only a region around the freed parts may change: their positions, cuts and links.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of free) {
      const g = placedGeometry(problem.fps[i], best.layout[i]);
      for (const h of [...g.pins, ...g.body]) {
        x0 = Math.min(x0, h.x); y0 = Math.min(y0, h.y); x1 = Math.max(x1, h.x); y1 = Math.max(y1, h.y);
      }
    }
    const m = opts.regionMargin ?? 2;
    const region = {
      x0: Math.max(0, x0 - m),
      y0: Math.max(0, y0 - m),
      x1: Math.min(problem.board.holes - 1, x1 + m),
      y1: Math.min(problem.board.strips - 1, y1 + m),
    };
    const remaining = opts.timeLimit - secs();
    const r = await solveAsp(problem, {
      mode: 'full',
      board: problem.board,
      cutMode: opts.cutMode,
      weights: opts.weights,
      maxLink: opts.maxLink,
      hint: { layout: best.layout, cuts: best.cuts, links: best.links },
      fixed,
      region,
      timeLimit: Math.min(windowTime, Math.max(0.5, remaining)),
    });
    windows++;
    if (r.layout && r.cuts && r.links) {
      const cand = scoreSolution(problem, r.layout, r.cuts, r.links, opts.weights);
      if (cand.ok && cand.cost < best.cost - 1e-9) {
        best = cand;
        improvements++;
      }
    }
    // The whole circuit was free and solved to optimality: nothing left to improve.
    if (free.length === n && r.outcome === 'optimum' && region.x0 === 0 && region.y0 === 0 && region.x1 === problem.board.holes - 1 && region.y1 === problem.board.strips - 1) {
      onProgress?.({ windows, improvements, windowSize: k, seconds: secs(), best, provenOptimal: true });
      return { best, windows, improvements, seconds: secs(), provenOptimal: true };
    }
    // Solved to optimality quickly: the window is easy, so widen it; timeouts: narrow it.
    if (r.outcome === 'optimum' && r.seconds < windowTime / 2) k = Math.min(8, n, k + 1);
    else if (r.outcome === 'timeout' || r.outcome === 'unknown') k = Math.max(2, k - 1);
    onProgress?.({ windows, improvements, windowSize: k, seconds: secs(), best });
  }
  return { best, windows, improvements, seconds: secs(), provenOptimal: false };
}
