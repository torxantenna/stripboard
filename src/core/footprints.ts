import type { BoardType, Hole, Placement, Rotation } from './types';

/** Geometry of a footprint at a given rotation and span, normalised so its bounding box starts at (0,0). */
export interface Geometry {
  /** Pin holes, index 0 = pin 1. */
  pins: Hole[];
  /** Holes covered by the body on the component side (no other pins or links may use them). */
  body: Hole[];
  w: number;
  h: number;
}

export interface Footprint {
  /** Canonical spec string, e.g. "axial(4-8)". */
  name: string;
  /** Short human description. */
  description: string;
  pinCount: number;
  /** Allowed lead spans (one entry for fixed-geometry parts). */
  spans: number[];
  rotations: Rotation[];
  /** Geometry at rotation 0 for a given span. */
  base(span: number): { pins: Hole[]; body: Hole[] };
}

export class FootprintError extends Error {}

/** Radius (in holes) of a radial part's can, for a lead spacing of n holes. */
export function radialRadius(n: number): number {
  return n / 2 + 0.3;
}

const ALL_ROTATIONS: Rotation[] = [0, 90, 180, 270];

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** Pins in a line along x with the given pitch; body covers the holes between the first and last pin. */
function inlineGeometry(n: number, pitch: number) {
  const pins = range(0, n - 1).map((i) => ({ x: i * pitch, y: 0 }));
  const pinX = new Set(pins.map((p) => p.x));
  const body = range(0, (n - 1) * pitch)
    .filter((x) => !pinX.has(x))
    .map((x) => ({ x, y: 0 }));
  return { pins, body };
}

function parseIntParam(s: string | undefined, what: string, min: number, max: number): number {
  if (s === undefined || s.trim() === '') throw new FootprintError(`missing ${what}`);
  const v = Number(s.trim());
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new FootprintError(`${what} must be an integer in ${min}..${max}, got "${s}"`);
  }
  return v;
}

/** Parse "4-8" or "4" into a span list. */
function parseSpanRange(s: string): number[] {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(s);
  if (!m) throw new FootprintError(`bad span "${s}" (expected e.g. 4 or 3-8)`);
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : a;
  if (a < 1 || b < a || b > 20) throw new FootprintError(`span range "${s}" must satisfy 1 <= min <= max <= 20`);
  return range(a, b);
}

function makeInline(name: string, description: string, n: number, pitch: number): Footprint {
  return {
    name,
    description,
    pinCount: n,
    spans: [pitch],
    rotations: n === 1 ? [0] : ALL_ROTATIONS,
    base: () => inlineGeometry(n, pitch),
  };
}

/**
 * Footprint library. Spec grammar: `name` or `name(args)`.
 *
 *   axial(min-max)   2-lead part with variable lead span (resistors, diodes). Default axial(4-8).
 *   radial(n)        2-lead part, leads n holes apart (capacitors, LEDs). Default radial(2).
 *   dip<N> / dip(N)  dual in-line IC, rows 0.3" apart. Pin rows always run across the strips.
 *   sip<N>, header<N>, header(N)   single row, 0.1" pitch.
 *   inline(n,pitch)  single row with custom pitch.
 *   to92, to220      3 leads in line, 0.1" pitch.
 *   pot              3 leads in line, 0.2" pitch (typical trimmer / panel pot breakout).
 *   pad              single hole for an off-board wire.
 */
export function parseFootprint(specRaw: string): Footprint {
  const spec = specRaw.trim().toLowerCase();
  const m = /^([a-z_]+?)(\d+)?(?:\(([^)]*)\))?$/.exec(spec);
  if (!m) throw new FootprintError(`unrecognised footprint "${specRaw}"`);
  const [, kind, suffixNum, argStr] = m;
  const args = argStr !== undefined ? argStr.split(',').map((s) => s.trim()) : [];

  switch (kind) {
    case 'axial': {
      if (suffixNum) throw new FootprintError(`use axial(min-max), e.g. axial(4-8)`);
      const spans = args.length ? parseSpanRange(args[0]) : range(4, 8);
      const name = `axial(${spans[0]}-${spans[spans.length - 1]})`;
      return {
        name,
        description: `2-lead axial, span ${spans[0]}–${spans[spans.length - 1]}`,
        pinCount: 2,
        spans,
        rotations: ALL_ROTATIONS,
        base: (span) => inlineGeometry(2, span),
      };
    }
    case 'radial': {
      if (suffixNum) throw new FootprintError(`use radial(n), e.g. radial(2)`);
      const n = args.length ? parseIntParam(args[0], 'radial lead spacing', 1, 10) : 2;
      return {
        name: `radial(${n})`,
        description: `2-lead radial, ${n} apart`,
        pinCount: 2,
        spans: [n],
        rotations: ALL_ROTATIONS,
        base: () => {
          // The can is a disc of radius RADIAL_BODY(n) around the midpoint of the leads; it covers
          // every hole whose centre lies inside it (other than the two lead holes).
          const pins = [
            { x: 0, y: 0 },
            { x: n, y: 0 },
          ];
          const r = radialRadius(n);
          const body: Hole[] = [];
          const R = Math.ceil(r);
          for (let y = -R; y <= R; y++)
            for (let x = -R; x <= n + R; x++) {
              if ((x === 0 || x === n) && y === 0) continue;
              if (Math.hypot(x - n / 2, y) < r) body.push({ x, y });
            }
          return { pins, body };
        },
      };
    }
    case 'dip': {
      const n = parseIntParam(suffixNum ?? args[0], 'DIP pin count', 4, 64);
      if (n % 2 !== 0) throw new FootprintError(`DIP pin count must be even, got ${n}`);
      const half = n / 2;
      return {
        name: `dip${n}`,
        description: `DIP-${n}, 0.3" rows`,
        pinCount: n,
        spans: [3],
        // Pin rows must run across the strips, otherwise every pin in a row would share a strip.
        rotations: [0, 180],
        base: () => {
          const pins: Hole[] = [];
          for (let i = 0; i < half; i++) pins.push({ x: 0, y: i });
          for (let i = 0; i < half; i++) pins.push({ x: 3, y: half - 1 - i });
          const body: Hole[] = [];
          for (let y = 0; y < half; y++) body.push({ x: 1, y }, { x: 2, y });
          return { pins, body };
        },
      };
    }
    case 'sip':
    case 'header': {
      const n = parseIntParam(suffixNum ?? args[0], `${kind} pin count`, 1, 64);
      return makeInline(`${kind}${n}`, `${n}-pin single row`, n, 1);
    }
    case 'inline': {
      if (args.length !== 2) throw new FootprintError(`use inline(pins,pitch), e.g. inline(3,2)`);
      const n = parseIntParam(args[0], 'inline pin count', 1, 64);
      const p = parseIntParam(args[1], 'inline pitch', 1, 10);
      return makeInline(`inline(${n},${p})`, `${n} pins in line, pitch ${p}`, n, p);
    }
    case 'to': {
      if (suffixNum === '92') return makeInline('to92', 'TO-92 (3 leads in line)', 3, 1);
      if (suffixNum === '220') return makeInline('to220', 'TO-220 (3 leads in line)', 3, 1);
      throw new FootprintError(`unknown package "${specRaw}" (known: to92, to220)`);
    }
    case 'pot':
      return makeInline('pot', 'potentiometer, 3 leads 0.2" apart', 3, 2);
    case 'pad':
      return makeInline('pad', 'single wire pad', 1, 1);
    default:
      throw new FootprintError(
        `unknown footprint "${specRaw}" (known: axial, radial, dipN, sipN, headerN, inline, to92, to220, pot, pad)`,
      );
  }
}

/**
 * Rotations a part may take on a board type. Stripboard restricts some parts (a DIP must
 * straddle the strips); on perfboard every pad is isolated, so any multi-pin part may turn.
 */
export function rotationsFor(fp: Footprint, board: BoardType | undefined): Rotation[] {
  return board === 'perfboard' && fp.pinCount > 1 ? ALL_ROTATIONS : fp.rotations;
}

const fpCache = new Map<string, Footprint>();

export function getFootprint(spec: string): Footprint {
  let fp = fpCache.get(spec);
  if (!fp) {
    fp = parseFootprint(spec);
    fpCache.set(spec, fp);
  }
  return fp;
}

function rotatePoint(p: Hole, rot: Rotation): Hole {
  switch (rot) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: -p.y, y: p.x };
    case 180:
      return { x: -p.x, y: -p.y };
    case 270:
      return { x: p.y, y: -p.x };
  }
}

const geomCache = new Map<string, Geometry>();

/** Geometry at a rotation/span, normalised so the bounding box starts at (0,0). Cached. */
export function geometry(fp: Footprint, rot: Rotation, span: number): Geometry {
  const key = `${fp.name}|${rot}|${span}`;
  let g = geomCache.get(key);
  if (g) return g;
  const base = fp.base(span);
  const pins = base.pins.map((p) => rotatePoint(p, rot));
  const body = base.body.map((p) => rotatePoint(p, rot));
  const all = [...pins, ...body];
  const minX = Math.min(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const norm = (p: Hole) => ({ x: p.x - minX, y: p.y - minY });
  const np = pins.map(norm);
  const nb = body.map(norm);
  const allN = [...np, ...nb];
  g = {
    pins: np,
    body: nb,
    w: Math.max(...allN.map((p) => p.x)) + 1,
    h: Math.max(...allN.map((p) => p.y)) + 1,
  };
  geomCache.set(key, g);
  return g;
}

/** Absolute pin and body holes of a placed component. */
export function placedGeometry(fp: Footprint, pl: Placement): { pins: Hole[]; body: Hole[]; w: number; h: number } {
  const g = geometry(fp, pl.rot, pl.span);
  return {
    pins: g.pins.map((p) => ({ x: p.x + pl.x, y: p.y + pl.y })),
    body: g.body.map((p) => ({ x: p.x + pl.x, y: p.y + pl.y })),
    w: g.w,
    h: g.h,
  };
}

/** Clamp a placement's origin so the part lies on the board (assumes it fits at all). */
export function clampToBoard(fp: Footprint, pl: Placement, holes: number, strips: number): Placement {
  const g = geometry(fp, pl.rot, pl.span);
  return {
    ...pl,
    x: Math.max(0, Math.min(holes - g.w, pl.x)),
    y: Math.max(0, Math.min(strips - g.h, pl.y)),
  };
}

/** Footprint names offered in the UI's help. */
export const FOOTPRINT_HELP: { spec: string; text: string }[] = [
  { spec: 'axial(4-8)', text: 'Resistor/diode lying flat, lead span 4–8 holes (optimiser picks)' },
  { spec: 'axial(1-2)', text: 'Resistor/diode standing up' },
  { spec: 'radial(2)', text: 'Capacitor/LED with leads 2 holes apart' },
  { spec: 'dip8', text: '8-pin DIP IC (any even count: dip14, dip16…)' },
  { spec: 'to92', text: 'Small transistor / regulator, 3 leads' },
  { spec: 'to220', text: 'Power transistor / regulator, 3 leads' },
  { spec: 'header3', text: 'Pin header / connector, 0.1" pitch' },
  { spec: 'inline(3,2)', text: '3 pins in a row, 2 holes apart' },
  { spec: 'pot', text: 'Potentiometer, 3 leads 0.2" apart' },
  { spec: 'pad', text: 'Single off-board wire pad' },
];
