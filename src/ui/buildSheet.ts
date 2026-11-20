import { placedGeometry } from '../core/footprints';
import type { Problem } from '../core/problem';
import { holeName, stripName } from '../core/route';
import type { Layout, RouteResult } from '../core/types';

export interface BuildSheet {
  board: string;
  cuts: string[];
  links: string[];
  parts: { ref: string; value: string; footprint: string; pins: string }[];
}

/** Human build instructions. Holes are named strip-letter + hole-number, e.g. C12. */
export function buildSheet(problem: Problem, layout: Layout, route: RouteResult, used: { width: number; height: number }): BuildSheet {
  const cuts = [...route.cuts]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((c) =>
      c.kind === 'hole'
        ? `Cut ${holeName(c.x, c.y)}`
        : `Cut strip ${stripName(c.y)} between holes ${c.x + 1} and ${c.x + 2}`,
    );
  const links = [...route.links]
    .sort((a, b) => a.x - b.x || a.y1 - b.y1)
    .map((l) => `Link ${holeName(l.x, l.y1)} – ${holeName(l.x, l.y2)}  (${Math.abs(l.y2 - l.y1)} strips, ${l.net})`);
  const parts = problem.netlist.components.map((c, i) => {
    const g = placedGeometry(problem.fps[i], layout[i]);
    return {
      ref: c.ref,
      value: c.value ?? '',
      footprint: problem.fps[i].name,
      pins: g.pins.map((p, pi) => `${pi + 1}:${holeName(p.x, p.y)}`).join('  '),
    };
  });
  return {
    board: `${used.height} strips × ${used.width} holes (strips ${stripName(0)}–${stripName(used.height - 1)}, holes 1–${used.width})`,
    cuts,
    links,
    parts,
  };
}

export function buildSheetText(s: BuildSheet): string {
  const lines = [
    'STRIPBOARD BUILD SHEET',
    '',
    `Board: ${s.board}`,
    '',
    `Track cuts (${s.cuts.length}) — make these from the copper side:`,
    ...s.cuts.map((c) => `  [ ] ${c}`),
    '',
    `Wire links (${s.links.length}):`,
    ...s.links.map((l) => `  [ ] ${l}`),
    '',
    `Components (${s.parts.length}):`,
    ...s.parts.map((p) => `  [ ] ${p.ref.padEnd(5)} ${p.value.padEnd(8)} ${p.footprint.padEnd(12)} pins ${p.pins}`),
    '',
  ];
  return lines.join('\n');
}
