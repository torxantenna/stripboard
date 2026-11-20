import type { AnnealStatus } from '../core/anneal';
import type { BoardSize, CostWeights, Layout, Metrics, Netlist, RouteOptions } from '../core/types';

export interface StartMessage {
  type: 'start';
  netlist: Netlist;
  board: BoardSize;
  iterations: number;
  restarts: number;
  seed: number;
  weights: CostWeights;
  route: RouteOptions;
  initial?: Layout;
}

export interface BestSnapshot {
  layout: Layout;
  cost: number;
  metrics: Metrics;
}

export type WorkerMessage =
  | { type: 'progress'; status: AnnealStatus; best?: BestSnapshot }
  | { type: 'done'; status: AnnealStatus; best: BestSnapshot }
  | { type: 'error'; message: string };
