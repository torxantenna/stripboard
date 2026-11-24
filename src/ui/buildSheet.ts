import { placedGeometry } from '../core/footprints';
import type { Problem } from '../core/problem';
import { holeName, stripName } from '../core/route';
import type { BoardType, Layout, RouteResult, Wire } from '../core/types';

export interface BuildSheet {
  kind: BoardType;
  board: string;
  cuts: string[];
  /** Stripboard wire links, or perfboard jumper wires. */
  links: string[];
  /** Perfboard solder-side traces (empty on stripboard). */
  traces: string[];
  parts: { ref: string; value: string; footprint: string; pins: string }[];
}

const byPosition = (a: Wire, b: Wire) => a.y1 - b.y1 || a.x1 - b.x1 || a.y2 - b.y2 || a.x2 - b.x2;
const fmtLen = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

/** Human build instructions. Holes are named row/strip letter + hole number, e.g. C12. */
export function buildSheet(
  problem: Problem,
  layout: Layout,
  route: RouteResult,
  used: { width: number; height: number },
  kind: BoardType = 'stripboard',
): BuildSheet {
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
  if (kind === 'perfboard') {
    const traces = [...(route.traces ?? [])]
      .sort(byPosition)
      .map((t) => `Bridge ${holeName(t.x1, t.y1)} – ${holeName(t.x2, t.y2)}  (${Math.abs(t.x2 - t.x1) + Math.abs(t.y2 - t.y1) + 1} pads, ${t.net})`);
    const jumpers = [...(route.jumpers ?? [])].sort(byPosition).map((j) => {
      const straight = j.x1 === j.x2 || j.y1 === j.y2;
      const len = Math.hypot(j.x2 - j.x1, j.y2 - j.y1);
      return `Jumper ${holeName(j.x1, j.y1)} – ${holeName(j.x2, j.y2)}  (${straight ? 'bare' : 'insulated'}, ${fmtLen(len)} holes, ${j.net})`;
    });
    return {
      kind,
      board: `${used.height} rows × ${used.width} holes (rows ${stripName(0)}–${stripName(used.height - 1)}, holes 1–${used.width})`,
      cuts: [],
      links: jumpers,
      traces,
      parts,
    };
  }
  return {
    kind,
    board: `${used.height} strips × ${used.width} holes (strips ${stripName(0)}–${stripName(used.height - 1)}, holes 1–${used.width})`,
    cuts,
    links,
    traces: [],
    parts,
  };
}

export function buildSheetText(s: BuildSheet): string {
  const parts = [
    `Components (${s.parts.length}):`,
    ...s.parts.map((p) => `  [ ] ${p.ref.padEnd(5)} ${p.value.padEnd(8)} ${p.footprint.padEnd(12)} pins ${p.pins}`),
    '',
  ];
  if (s.kind === 'perfboard') {
    return [
      'PERFBOARD BUILD SHEET',
      '',
      `Board: ${s.board}`,
      '',
      `Solder-side traces (${s.traces.length}) — join every pad along each run with solder or bare wire:`,
      ...s.traces.map((t) => `  [ ] ${t}`),
      '',
      `Jumper wires (${s.links.length}):`,
      ...s.links.map((l) => `  [ ] ${l}`),
      '',
      ...parts,
    ].join('\n');
  }
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
    ...parts,
  ];
  return lines.join('\n');
}
