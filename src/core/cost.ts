import { geometry } from './footprints';
import type { Problem } from './problem';
import { route } from './route';
import type { CostWeights, Layout, Metrics, RouteOptions, RouteResult } from './types';

export function computeMetrics(problem: Problem, layout: Layout, r: RouteResult): Metrics {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let paperTD = 0;
  layout.forEach((pl, ci) => {
    const g = geometry(problem.fps[ci], pl.rot, pl.span);
    x0 = Math.min(x0, pl.x);
    y0 = Math.min(y0, pl.y);
    x1 = Math.max(x1, pl.x + g.w - 1);
    y1 = Math.max(y1, pl.y + g.h - 1);
    if (g.pins.length >= 2) paperTD += Math.abs(g.pins[0].y - g.pins[1].y);
  });
  let linkLength = 0;
  for (const l of r.links) {
    linkLength += Math.abs(l.y2 - l.y1);
    x0 = Math.min(x0, l.x);
    x1 = Math.max(x1, l.x);
    y0 = Math.min(y0, l.y1, l.y2);
    y1 = Math.max(y1, l.y1, l.y2);
  }
  if (!Number.isFinite(x0)) x0 = y0 = x1 = y1 = 0;
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  let shorts = 0;
  let overlaps = 0;
  let outOfBounds = 0;
  for (const v of r.violations) {
    if (v.type === 'short') shorts++;
    else if (v.type === 'overlap') overlaps++;
    else outOfBounds++;
  }
  return {
    cuts: r.cuts.length,
    links: r.links.length,
    linkLength,
    unrouted: r.unrouted.length,
    shorts,
    overlaps,
    outOfBounds,
    bbox: { x0, y0, x1, y1 },
    width,
    height,
    area: width * height,
    paperTD,
  };
}

export function costOf(m: Metrics, w: CostWeights): number {
  return (
    w.unrouted * m.unrouted +
    w.short * m.shorts +
    w.overlap * m.overlaps +
    w.bounds * m.outOfBounds +
    w.area * m.area +
    w.cut * m.cuts +
    w.link * m.links +
    w.linkLength * m.linkLength +
    w.paperTD * m.paperTD
  );
}

export interface Evaluation {
  route: RouteResult;
  metrics: Metrics;
  cost: number;
}

export function evaluate(problem: Problem, layout: Layout, opts: RouteOptions, weights: CostWeights): Evaluation {
  const r = route(problem, layout, opts);
  const metrics = computeMetrics(problem, layout, r);
  return { route: r, metrics, cost: costOf(metrics, weights) };
}

/** True when the layout is electrically complete and physically valid. */
export function isClean(m: Metrics): boolean {
  return m.unrouted === 0 && m.shorts === 0 && m.overlaps === 0 && m.outOfBounds === 0;
}
