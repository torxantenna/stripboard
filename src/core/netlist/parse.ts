import { FootprintError, getFootprint } from '../footprints';
import type { BoardSize, Component, Netlist } from '../types';

export interface ParseMessage {
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ParseResult {
  netlist: Netlist | null;
  errors: ParseMessage[];
  warnings: ParseMessage[];
}

const REF_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const NET_RE = /^[A-Za-z0-9_+\-.~/]+$/;

/**
 * Parse a netlist in the simple text format or JSON.
 *
 * Text format (one component per line, `#` starts a comment):
 *
 *     board 20x30                       # optional: strips x holes
 *     U1 dip8 NE555 1=GND 2=TRIG 8=VCC  # REF FOOTPRINT [VALUE] pin=NET ...
 *     R1 axial(4-8) 10k 1=VCC 2=DIS
 *
 * JSON format:
 *
 *     { "board": {"strips": 20, "holes": 30},
 *       "components": [{"ref": "R1", "footprint": "axial(4-8)", "value": "10k", "pins": {"1": "VCC", "2": "DIS"}}] }
 *
 * Pins not listed are left unconnected.
 */
export function parseNetlist(src: string): ParseResult {
  const trimmed = src.trim();
  if (trimmed.startsWith('{')) return parseJson(trimmed);
  return parseText(src);
}

interface RawComponent {
  ref: string;
  footprint: string;
  value?: string;
  pins: Record<string, string>;
  line: number;
}

function parseText(src: string): ParseResult {
  const errors: ParseMessage[] = [];
  const raws: RawComponent[] = [];
  let board: BoardSize | undefined;

  src.split(/\r?\n/).forEach((rawLine, i) => {
    const line = i + 1;
    const text = rawLine.replace(/#.*$/, '').trim();
    if (!text) return;
    const tokens = text.split(/\s+/);
    const err = (message: string) => errors.push({ line, message, severity: 'error' });

    if (tokens[0].toLowerCase() === 'board') {
      const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(tokens.slice(1).join(''));
      if (!m) return err('board line must look like "board 20x30" (strips x holes)');
      board = { strips: Number(m[1]), holes: Number(m[2]) };
      return;
    }

    if (tokens.length < 2) return err(`expected "REF FOOTPRINT [VALUE] pin=NET ...", got "${text}"`);
    const [ref, footprint, ...rest] = tokens;
    let value: string | undefined;
    const pins: Record<string, string> = {};
    for (const tok of rest) {
      const eq = tok.indexOf('=');
      if (eq < 0) {
        if (value !== undefined) return err(`unexpected token "${tok}" (only one value allowed; pins look like 1=NET)`);
        value = tok;
        continue;
      }
      const pin = tok.slice(0, eq);
      const net = tok.slice(eq + 1);
      if (pin in pins) return err(`pin ${pin} of ${ref} assigned twice`);
      pins[pin] = net;
    }
    raws.push({ ref, footprint, value, pins, line });
  });

  return build(raws, board, errors);
}

function parseJson(src: string): ParseResult {
  const fail = (message: string): ParseResult => ({
    netlist: null,
    errors: [{ line: 1, message, severity: 'error' }],
    warnings: [],
  });
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch (e) {
    return fail(`invalid JSON: ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null) return fail('JSON netlist must be an object');
  const obj = data as Record<string, unknown>;
  let board: BoardSize | undefined;
  if (obj.board !== undefined) {
    const b = obj.board as Record<string, unknown>;
    if (typeof b?.strips !== 'number' || typeof b?.holes !== 'number') {
      return fail('"board" must be {"strips": number, "holes": number}');
    }
    board = { strips: b.strips, holes: b.holes };
  }
  if (!Array.isArray(obj.components)) return fail('"components" must be an array');
  const raws: RawComponent[] = [];
  const errors: ParseMessage[] = [];
  obj.components.forEach((c: unknown, i: number) => {
    const line = i + 1;
    const cc = c as Record<string, unknown>;
    if (typeof cc?.ref !== 'string' || typeof cc?.footprint !== 'string') {
      errors.push({ line, message: `component #${i + 1} needs string "ref" and "footprint"`, severity: 'error' });
      return;
    }
    const pins: Record<string, string> = {};
    if (cc.pins !== undefined) {
      if (typeof cc.pins !== 'object' || cc.pins === null) {
        errors.push({ line, message: `${cc.ref}: "pins" must be an object`, severity: 'error' });
        return;
      }
      for (const [k, v] of Object.entries(cc.pins as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          errors.push({ line, message: `${cc.ref}: pin ${k} net must be a string`, severity: 'error' });
          return;
        }
        pins[k] = v;
      }
    }
    raws.push({
      ref: cc.ref,
      footprint: cc.footprint,
      value: typeof cc.value === 'string' ? cc.value : undefined,
      pins,
      line,
    });
  });
  return build(raws, board, errors);
}

function build(raws: RawComponent[], board: BoardSize | undefined, errors: ParseMessage[]): ParseResult {
  const warnings: ParseMessage[] = [];
  const components: Component[] = [];
  const seen = new Map<string, number>();
  const netUses = new Map<string, { count: number; line: number }>();

  if (board && (board.strips < 2 || board.holes < 2 || board.strips > 200 || board.holes > 200)) {
    errors.push({ line: 1, message: 'board size must be between 2 and 200 in each direction', severity: 'error' });
  }

  for (const r of raws) {
    const err = (message: string) => errors.push({ line: r.line, message, severity: 'error' });
    if (!REF_RE.test(r.ref)) {
      err(`bad reference "${r.ref}" (letters, digits, underscore; must start with a letter)`);
      continue;
    }
    if (seen.has(r.ref)) {
      err(`duplicate reference ${r.ref} (first used on line ${seen.get(r.ref)})`);
      continue;
    }
    seen.set(r.ref, r.line);
    let fp;
    try {
      fp = getFootprint(r.footprint);
    } catch (e) {
      if (e instanceof FootprintError) {
        err(`${r.ref}: ${e.message}`);
        continue;
      }
      throw e;
    }
    const pins: (string | null)[] = new Array(fp.pinCount).fill(null);
    let ok = true;
    for (const [pinStr, net] of Object.entries(r.pins)) {
      const pin = Number(pinStr);
      if (!Number.isInteger(pin) || pin < 1 || pin > fp.pinCount) {
        err(`${r.ref}: pin "${pinStr}" out of range (${fp.name} has pins 1..${fp.pinCount})`);
        ok = false;
        continue;
      }
      if (!net || !NET_RE.test(net)) {
        err(`${r.ref}: bad net name "${net}" on pin ${pin}`);
        ok = false;
        continue;
      }
      pins[pin - 1] = net;
      const u = netUses.get(net);
      if (u) u.count++;
      else netUses.set(net, { count: 1, line: r.line });
    }
    if (!ok) continue;
    components.push({ ref: r.ref, footprint: fp.name, value: r.value, pins, line: r.line });
  }

  if (components.length === 0 && errors.length === 0) {
    errors.push({ line: 1, message: 'netlist has no components', severity: 'error' });
  }

  for (const [net, u] of netUses) {
    if (u.count === 1) {
      warnings.push({ line: u.line, message: `net ${net} has only one pin`, severity: 'warning' });
    }
  }

  if (errors.length) return { netlist: null, errors, warnings };
  return {
    netlist: { board, components, nets: [...netUses.keys()].sort() },
    errors,
    warnings,
  };
}

/** Serialise a netlist back to the text format. */
export function formatNetlist(n: Netlist): string {
  const lines: string[] = [];
  if (n.board) lines.push(`board ${n.board.strips}x${n.board.holes}`);
  for (const c of n.components) {
    const pins = c.pins.map((net, i) => (net ? `${i + 1}=${net}` : null)).filter(Boolean);
    lines.push([c.ref, c.footprint, c.value, ...pins].filter(Boolean).join(' '));
  }
  return lines.join('\n') + '\n';
}
