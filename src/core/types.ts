/**
 * Core domain types for the stripboard layout optimiser.
 *
 * Coordinate system: a board is `holes` wide (x, along the copper strips) and
 * `strips` tall (y, one row per copper strip). Hole (x, y) is the x-th hole
 * along strip y. All distances are in hole pitches (0.1" / 2.54 mm).
 */

export interface Hole {
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface BoardSize {
  /** Number of copper strips (rows). */
  strips: number;
  /** Number of holes along each strip (columns). */
  holes: number;
}

/** A component instance from the netlist. */
export interface Component {
  ref: string;
  /** Footprint spec string, e.g. "dip8", "axial(4-8)". */
  footprint: string;
  value?: string;
  /** Net name per pin (index 0 = pin 1). `null` means not connected. */
  pins: (string | null)[];
  /** Source line (1-based) for error reporting, if parsed from text. */
  line?: number;
}

export interface Netlist {
  board?: BoardSize;
  components: Component[];
  /** All distinct net names, sorted. */
  nets: string[];
}

/** Where and how a component sits on the board. (x, y) is the top-left of its bounding box. */
export interface Placement {
  x: number;
  y: number;
  rot: Rotation;
  /** Lead span for variable-span parts (e.g. axial resistors); fixed parts use their only span. */
  span: number;
}

export type Layout = Placement[];

/**
 * A track cut. `kind: 'hole'` drills out the copper at hole (x, y) isolating it;
 * `kind: 'between'` scores the copper between hole x and hole x+1 on strip y.
 */
export interface Cut {
  x: number;
  y: number;
  kind: 'hole' | 'between';
}

/** A straight wire link soldered between two holes (always vertical: same x). */
export interface Link {
  net: string;
  x: number;
  y1: number;
  y2: number;
}

/**
 * A solder-side trace or a perfboard jumper wire, from hole (x1, y1) to hole (x2, y2).
 * Traces are always horizontal or vertical and solder every hole they pass through;
 * jumpers only touch their two end holes.
 */
export interface Wire {
  net: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type CutMode = 'hole' | 'between';

/** Stripboard: copper strips joined along each row. Perfboard: an isolated pad per hole. */
export type BoardType = 'stripboard' | 'perfboard';

/**
 * - `none`: no jumper wires.
 * - `straight`: bare wire, horizontal or vertical on the component side; may not pass over
 *   pins, bodies or other jumpers, and ends in free holes.
 * - `angled`: insulated wire between any two holes; may cross anything and may end on a pad
 *   of its own net (point-to-point wiring).
 */
export type JumperMode = 'none' | 'straight' | 'angled';

export interface PerfOptions {
  /** Allow solder-side traces (solder bridges / bare wire along the hole grid). */
  traces: boolean;
  jumpers: JumperMode;
  /** Longest jumper, in hole pitches (Euclidean for angled jumpers). */
  maxJumper: number;
}

export const DEFAULT_PERF: PerfOptions = { traces: true, jumpers: 'straight', maxJumper: 10 };

export interface RouteOptions {
  cutMode: CutMode;
  /** Defaults to `stripboard`. */
  board?: BoardType;
  /** Perfboard wiring options; defaults to `DEFAULT_PERF`. */
  perf?: PerfOptions;
}

export type ViolationType = 'short' | 'overlap' | 'bounds';

export interface Violation {
  type: ViolationType;
  message: string;
  holes: Hole[];
}

/** An unmade connection between two parts of one net (for ratsnest drawing). */
export interface Unrouted {
  net: string;
  from: Hole;
  to: Hole;
}

/** A maximal run of one net's pins on a strip, with the copper it ended up owning. */
export interface Segment {
  net: string;
  y: number;
  /** First and last pin x of this net's run. */
  pinMin: number;
  pinMax: number;
  /** Final copper extent after cuts (inclusive). */
  lo: number;
  hi: number;
}

export interface RouteResult {
  cuts: Cut[];
  links: Link[];
  /** Perfboard only: solder-side traces (empty on stripboard). */
  traces?: Wire[];
  /** Perfboard only: jumper wires (empty on stripboard). */
  jumpers?: Wire[];
  segments: Segment[];
  unrouted: Unrouted[];
  violations: Violation[];
}

export interface Metrics {
  cuts: number;
  /** Wire links (stripboard) or jumpers (perfboard). */
  links: number;
  linkLength: number;
  /** Perfboard: hole-to-hole steps of solder-side trace. */
  traceLength: number;
  unrouted: number;
  shorts: number;
  overlaps: number;
  outOfBounds: number;
  /** Bounding box of everything placed (pins, bodies, links). */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  width: number;
  height: number;
  area: number;
  /** Paper metric (arXiv:2512.04910): Σ over 2+-pin parts of |strip(pin1) − strip(pin2)|. */
  paperTD: number;
}

export interface CostWeights {
  unrouted: number;
  short: number;
  overlap: number;
  bounds: number;
  area: number;
  cut: number;
  link: number;
  linkLength: number;
  /** Perfboard: per hole-to-hole step of solder-side trace. */
  trace: number;
  paperTD: number;
}

export const DEFAULT_WEIGHTS: CostWeights = {
  unrouted: 1000,
  short: 1000,
  overlap: 500,
  bounds: 1000,
  area: 1,
  cut: 2,
  link: 5,
  linkLength: 1,
  trace: 0.5,
  paperTD: 0,
};
