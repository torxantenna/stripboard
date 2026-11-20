import { costOf, computeMetrics, evaluate, type Evaluation } from './cost';
import { clampToBoard, geometry } from './footprints';
import { cloneLayout, type Problem } from './problem';
import { Rng } from './rng';
import { route } from './route';
import type { CostWeights, Layout, Placement, RouteOptions } from './types';

export interface AnnealSettings {
  /** Iterations per restart. */
  iterations: number;
  restarts: number;
  seed: number;
  weights: CostWeights;
  route: RouteOptions;
  /** Optional starting layout for the first restart (e.g. a hand-edited one). */
  initial?: Layout;
  /** Final temperature (in cost units). */
  tEnd?: number;
}

export interface AnnealStatus {
  restart: number;
  iteration: number;
  /** Overall progress 0..1 across all restarts. */
  progress: number;
  temperature: number;
  currentCost: number;
  bestCost: number;
  done: boolean;
}

export interface AnnealBest extends Evaluation {
  layout: Layout;
}

/** Random placement that avoids overlaps where it easily can; biggest parts first. */
export function randomLayout(problem: Problem, rng: Rng): Layout {
  const { holes: W, strips: H } = problem.board;
  const used = new Uint8Array(W * H);
  const n = problem.fps.length;
  const order = [...Array(n).keys()].sort((a, b) => problem.fps[b].pinCount - problem.fps[a].pinCount);
  const layout: Layout = new Array(n);
  for (const ci of order) {
    const fp = problem.fps[ci];
    let best: Placement | null = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const rot = rng.pick(fp.rotations);
      const span = rng.pick(fp.spans);
      const g = geometry(fp, rot, span);
      if (g.w > W || g.h > H) continue;
      const pl: Placement = { x: rng.int(0, W - g.w), y: rng.int(0, H - g.h), rot, span };
      best = pl;
      const cells = [...g.pins, ...g.body];
      // Keep one hole of clearance around parts to leave room for cuts and links.
      const free = cells.every((c) => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = c.x + pl.x + dx;
            const y = c.y + pl.y + dy;
            if (x >= 0 && y >= 0 && x < W && y < H && used[y * W + x]) return false;
          }
        return true;
      });
      if (free) break;
    }
    if (!best) {
      // Part doesn't fit in any allowed orientation; park it at the origin (reported as off-board).
      best = { x: 0, y: 0, rot: fp.rotations[0], span: fp.spans[0] };
    }
    const g = geometry(fp, best.rot, best.span);
    for (const c of [...g.pins, ...g.body]) {
      const x = c.x + best.x;
      const y = c.y + best.y;
      if (x < W && y < H) used[y * W + x] = 1;
    }
    layout[ci] = best;
  }
  return layout;
}

/** Shift everything so the used area starts at hole (0,0), keeping it if it is no worse. */
export function normalizeLayout(problem: Problem, layout: Layout, opts: RouteOptions, weights: CostWeights): AnnealBest {
  const before = evaluate(problem, layout, opts, weights);
  const { x0, y0 } = before.metrics.bbox;
  if (x0 === 0 && y0 === 0) return { ...before, layout };
  const shifted = layout.map((p) => ({ ...p, x: p.x - x0, y: p.y - y0 }));
  const after = evaluate(problem, shifted, opts, weights);
  return after.cost <= before.cost ? { ...after, layout: shifted } : { ...before, layout };
}

/**
 * Simulated annealing over component placements. Each state is a full placement; its cost
 * comes from routing it (cuts + links) and scoring the result, so penalties for shorts,
 * overlaps and unrouted nets steer the search towards buildable layouts.
 *
 * Use `step(n)` to advance in chunks so a caller (e.g. a Web Worker) can report progress
 * and handle stop requests between chunks.
 */
export class Annealer {
  readonly problem: Problem;
  readonly settings: AnnealSettings;
  private rng: Rng;
  private restart = 0;
  private iter = 0;
  private cur!: Layout;
  private curCost = Infinity;
  private t = 1;
  private t0 = 1;
  private alpha = 1;
  private maxR: number;
  best: AnnealBest | null = null;
  done = false;

  constructor(problem: Problem, settings: AnnealSettings) {
    this.problem = problem;
    this.settings = settings;
    this.rng = new Rng(settings.seed);
    this.maxR = Math.max(problem.board.holes, problem.board.strips) / 2;
    this.startRestart();
  }

  private cost(layout: Layout): number {
    const r = route(this.problem, layout, this.settings.route);
    return costOf(computeMetrics(this.problem, layout, r), this.settings.weights);
  }

  private startRestart() {
    const init =
      this.restart === 0 && this.settings.initial
        ? cloneLayout(this.settings.initial)
        : randomLayout(this.problem, this.rng);
    this.cur = init.map((p, i) => clampToBoard(this.problem.fps[i], p, this.problem.board.holes, this.problem.board.strips));
    this.curCost = this.cost(this.cur);
    this.iter = 0;
    this.considerBest(this.cur, this.curCost);

    // Initial temperature: accept a typical uphill move with probability ~0.8.
    let up = 0;
    let nUp = 0;
    for (let i = 0; i < 60; i++) {
      const cand = this.propose(this.cur, 1);
      const d = this.cost(cand) - this.curCost;
      if (d > 0) {
        up += d;
        nUp++;
      }
    }
    const meanUp = nUp ? up / nUp : 10;
    this.t0 = Math.max(1, -meanUp / Math.log(0.8));
    // Start cooler on a hand-made layout so we refine rather than scramble it.
    if (this.restart === 0 && this.settings.initial) this.t0 = Math.max(1, this.t0 * 0.05);
    const tEnd = this.settings.tEnd ?? 0.05;
    this.t = this.t0;
    this.alpha = Math.pow(tEnd / this.t0, 1 / Math.max(1, this.settings.iterations));
  }

  private considerBest(layout: Layout, cost: number) {
    if (!this.best || cost < this.best.cost) {
      const ev = evaluate(this.problem, layout, this.settings.route, this.settings.weights);
      this.best = { ...ev, layout: cloneLayout(layout) };
    }
  }

  /** Propose a neighbour. `heat` in 0..1 scales the move radius. */
  private propose(from: Layout, heat: number): Layout {
    const rng = this.rng;
    const { holes: W, strips: H } = this.problem.board;
    const n = from.length;
    const next = from.slice();
    const i = rng.int(0, n - 1);
    const fp = this.problem.fps[i];
    const p = { ...from[i] };
    const roll = rng.next();
    const r = Math.max(1, Math.round(this.maxR * heat));

    if (roll < 0.5 || n === 1) {
      do {
        p.x += rng.int(-r, r);
        p.y += rng.int(-r, r);
      } while (p.x === from[i].x && p.y === from[i].y && r > 0 && rng.next() < 0.9);
    } else if (roll < 0.65) {
      if (fp.rotations.length > 1) {
        const others = fp.rotations.filter((x) => x !== p.rot);
        // Rotate about the part's centre so small moves stay local.
        const g0 = geometry(fp, p.rot, p.span);
        p.rot = rng.pick(others);
        const g1 = geometry(fp, p.rot, p.span);
        p.x += Math.round((g0.w - g1.w) / 2);
        p.y += Math.round((g0.h - g1.h) / 2);
      } else {
        p.x += rng.int(-1, 1);
        p.y += rng.int(-1, 1);
      }
    } else if (roll < 0.75 && fp.spans.length > 1) {
      const idx = fp.spans.indexOf(p.span);
      const ni = Math.max(0, Math.min(fp.spans.length - 1, idx + (rng.next() < 0.5 ? -1 : 1)));
      p.span = fp.spans[ni];
    } else if (roll < 0.92) {
      // Swap positions with another part.
      let j = rng.int(0, n - 2);
      if (j >= i) j++;
      const q = { ...from[j] };
      const tmp = { x: p.x, y: p.y };
      p.x = q.x;
      p.y = q.y;
      q.x = tmp.x;
      q.y = tmp.y;
      next[j] = clampToBoard(this.problem.fps[j], q, W, H);
    } else {
      p.rot = rng.pick(fp.rotations);
      p.span = rng.pick(fp.spans);
      const g = geometry(fp, p.rot, p.span);
      p.x = rng.int(0, Math.max(0, W - g.w));
      p.y = rng.int(0, Math.max(0, H - g.h));
    }
    next[i] = clampToBoard(fp, p, W, H);
    return next;
  }

  /** Advance up to `n` iterations. Returns the status after the chunk. */
  step(n: number): AnnealStatus {
    const total = this.settings.iterations;
    for (let k = 0; k < n && !this.done; k++) {
      if (this.iter >= total) {
        this.restart++;
        if (this.restart >= this.settings.restarts) {
          this.done = true;
          break;
        }
        this.startRestart();
      }
      const heat = 1 - this.iter / total;
      const cand = this.propose(this.cur, heat);
      const c = this.cost(cand);
      const d = c - this.curCost;
      if (d <= 0 || this.rng.next() < Math.exp(-d / this.t)) {
        this.cur = cand;
        this.curCost = c;
        if (c < this.best!.cost) this.considerBest(cand, c);
      }
      this.t *= this.alpha;
      this.iter++;
    }
    if (this.done && this.best) {
      this.best = normalizeLayout(this.problem, this.best.layout, this.settings.route, this.settings.weights);
    }
    return this.status();
  }

  status(): AnnealStatus {
    const total = this.settings.iterations * this.settings.restarts;
    const doneIters = Math.min(total, this.restart * this.settings.iterations + this.iter);
    return {
      restart: Math.min(this.restart, this.settings.restarts - 1),
      iteration: this.iter,
      progress: this.done ? 1 : doneIters / total,
      temperature: this.t,
      currentCost: this.curCost,
      bestCost: this.best?.cost ?? Infinity,
      done: this.done,
    };
  }

  /** Run to completion synchronously. */
  run(): AnnealBest {
    while (!this.done) this.step(10000);
    return this.best!;
  }
}

export const DEFAULT_ANNEAL = { iterations: 60000, restarts: 3, seed: 1 };
