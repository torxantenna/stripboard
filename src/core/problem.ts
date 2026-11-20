import { geometry, getFootprint, type Footprint } from './footprints';
import type { BoardSize, Layout, Netlist } from './types';

/** A netlist bound to a board, with footprints and net indices resolved once (hot-path friendly). */
export interface Problem {
  netlist: Netlist;
  board: BoardSize;
  fps: Footprint[];
  /** Per component, per pin: net index or -1 for not connected. */
  pinNets: Int32Array[];
  nets: string[];
  netIndex: Map<string, number>;
}

export function makeProblem(netlist: Netlist, board?: BoardSize): Problem {
  const fps = netlist.components.map((c) => getFootprint(c.footprint));
  const nets = netlist.nets;
  const netIndex = new Map(nets.map((n, i) => [n, i]));
  const pinNets = netlist.components.map((c) => Int32Array.from(c.pins.map((n) => (n ? netIndex.get(n)! : -1))));
  return { netlist, board: board ?? netlist.board ?? autoBoardSize(netlist), fps, pinNets, nets, netIndex };
}

/** Pick a board comfortably larger than the parts need, if the netlist doesn't specify one. */
export function autoBoardSize(netlist: Netlist): BoardSize {
  let area = 0;
  let maxDim = 0;
  for (const c of netlist.components) {
    const fp = getFootprint(c.footprint);
    const g = geometry(fp, fp.rotations[0], fp.spans[0]);
    area += (g.w + 1) * (g.h + 1);
    maxDim = Math.max(maxDim, g.w, g.h);
  }
  const target = area * 3.5;
  const strips = Math.max(maxDim + 2, Math.min(60, Math.ceil(Math.sqrt(target / 1.4))));
  const holes = Math.max(maxDim + 2, Math.min(80, Math.ceil(target / strips)));
  return { strips: Math.max(6, strips), holes: Math.max(8, holes) };
}

export function cloneLayout(l: Layout): Layout {
  return l.map((p) => ({ ...p }));
}
