import { useMemo, useRef, useState, type PointerEvent as RPointerEvent, type Ref } from 'react';
import { geometry, placedGeometry, radialRadius } from '../core/footprints';
import type { Problem } from '../core/problem';
import { stripName } from '../core/route';
import type { Hole, Layout, Placement, RouteResult } from '../core/types';
import { netColorMap } from './netColors';

export type Side = 'component' | 'copper';

interface Props {
  problem: Problem;
  layout: Layout;
  route: RouteResult;
  side: Side;
  selected: number | null;
  hoverNet: string | null;
  editable: boolean;
  onSelect: (i: number | null) => void;
  onHoverNet: (net: string | null) => void;
  onMove: (i: number, p: Placement) => void;
  svgRef?: Ref<SVGSVGElement>;
  /** Used area (inclusive hole bounds), outlined as the size to cut the board to. */
  used?: { x0: number; y0: number; x1: number; y1: number };
}

const S = 22; // px per hole
const M = 28; // margin for axis labels

export function BoardView(props: Props) {
  const { problem, layout, route, side, selected, hoverNet, editable } = props;
  const { holes: W, strips: H } = problem.board;
  const colors = useMemo(() => netColorMap(problem.nets), [problem.nets]);
  const localRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ i: number; dx: number; dy: number; moved: boolean } | null>(null);

  const copper = side === 'copper';
  const cx = (x: number) => M + (copper ? W - 1 - x : x) * S + S / 2;
  const cy = (y: number) => M + y * S + S / 2;
  const width = W * S + 2 * M;
  const height = H * S + 2 * M;

  const toHole = (e: RPointerEvent): Hole | null => {
    const svg = localRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    let x = Math.round((pt.x - M - S / 2) / S);
    if (copper) x = W - 1 - x;
    return { x, y: Math.round((pt.y - M - S / 2) / S) };
  };

  const onPointerDownPart = (e: RPointerEvent, i: number) => {
    e.stopPropagation();
    props.onSelect(i);
    if (!editable) return;
    const h = toHole(e);
    if (!h) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ i, dx: h.x - layout[i].x, dy: h.y - layout[i].y, moved: false });
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (!drag) return;
    const h = toHole(e);
    if (!h) return;
    const p = layout[drag.i];
    const g = geometry(problem.fps[drag.i], p.rot, p.span);
    const x = Math.max(0, Math.min(W - g.w, h.x - drag.dx));
    const y = Math.max(0, Math.min(H - g.h, h.y - drag.dy));
    if (x !== p.x || y !== p.y) {
      props.onMove(drag.i, { ...p, x, y });
      if (!drag.moved) setDrag({ ...drag, moved: true });
    }
  };

  const netOpacity = (net: string | null) => (hoverNet === null || net === hoverNet ? 1 : 0.25);

  // Unused copper per strip = everything not covered by a segment.
  const segByStrip = useMemo(() => {
    const m = new Map<number, typeof route.segments>();
    for (const s of route.segments) {
      if (!m.has(s.y)) m.set(s.y, []);
      m.get(s.y)!.push(s);
    }
    return m;
  }, [route.segments]);

  const segX = (lo: number, hi: number) => {
    const a = cx(lo);
    const b = cx(hi);
    return { x: Math.min(a, b) - S / 2, w: Math.abs(b - a) + S };
  };

  const strips = [];
  for (let y = 0; y < H; y++) {
    const yy = cy(y) - S * 0.38;
    strips.push(
      <rect key={`s${y}`} className="copper" x={M} y={yy} width={W * S} height={S * 0.76} rx={2} opacity={copper ? 1 : 0.55} />,
    );
    for (const seg of segByStrip.get(y) ?? []) {
      const { x, w } = segX(seg.lo, seg.hi);
      strips.push(
        <rect
          key={`g${y}-${seg.lo}`}
          x={x}
          y={yy}
          width={w}
          height={S * 0.76}
          rx={2}
          fill={colors.get(seg.net)}
          opacity={(copper ? 0.55 : 0.32) * netOpacity(seg.net)}
          onPointerEnter={() => props.onHoverNet(seg.net)}
          onPointerLeave={() => props.onHoverNet(null)}
        >
          <title>{`Net ${seg.net} — strip ${stripName(y)}`}</title>
        </rect>,
      );
    }
  }

  const holes = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) holes.push(<circle key={`h${x},${y}`} className="hole" cx={cx(x)} cy={cy(y)} r={S * 0.13} />);

  const cuts = route.cuts.map((c, i) => {
    if (c.kind === 'hole') {
      const x = cx(c.x);
      const y = cy(c.y);
      const r = S * 0.3;
      return (
        <g key={`c${i}`} className="cut">
          {copper && <rect className="cut-gap" x={x - S * 0.32} y={y - S * 0.42} width={S * 0.64} height={S * 0.84} />}
          <path d={`M${x - r} ${y - r}L${x + r} ${y + r}M${x - r} ${y + r}L${x + r} ${y - r}`} />
          <title>{`Cut ${stripName(c.y)}${c.x + 1}`}</title>
        </g>
      );
    }
    const x = (cx(c.x) + cx(c.x + 1)) / 2;
    const y = cy(c.y);
    return (
      <g key={`c${i}`} className="cut">
        {copper && <rect className="cut-gap" x={x - 2} y={y - S * 0.42} width={4} height={S * 0.84} />}
        <path d={`M${x} ${y - S * 0.42}L${x} ${y + S * 0.42}`} />
        <title>{`Cut between ${stripName(c.y)}${c.x + 1} and ${stripName(c.y)}${c.x + 2}`}</title>
      </g>
    );
  });

  const links = route.links.map((l, i) => (
    <g
      key={`l${i}`}
      className={copper ? 'link link-under' : 'link'}
      opacity={netOpacity(l.net)}
      onPointerEnter={() => props.onHoverNet(l.net)}
      onPointerLeave={() => props.onHoverNet(null)}
    >
      <line x1={cx(l.x)} y1={cy(l.y1)} x2={cx(l.x)} y2={cy(l.y2)} />
      <circle cx={cx(l.x)} cy={cy(l.y1)} r={S * 0.2} />
      <circle cx={cx(l.x)} cy={cy(l.y2)} r={S * 0.2} />
      <title>{`Link ${stripName(l.y1)}${l.x + 1}–${stripName(l.y2)}${l.x + 1} (net ${l.net})`}</title>
    </g>
  ));

  const parts = problem.netlist.components.map((c, i) => {
    const fp = problem.fps[i];
    const pl = layout[i];
    const g = placedGeometry(fp, pl);
    const pins = g.pins;
    const all = [...g.pins, ...g.body];
    const xs = all.map((h) => cx(h.x));
    const ys = all.map((h) => cy(h.y));
    const bx0 = Math.min(...xs) - S / 2;
    const bx1 = Math.max(...xs) + S / 2;
    const by0 = Math.min(...ys) - S / 2;
    const by1 = Math.max(...ys) + S / 2;
    const mx = (bx0 + bx1) / 2;
    const my = (by0 + by1) / 2;
    const kind = fp.name.replace(/[\d(].*$/, '');
    const isSel = selected === i;
    let body;
    if (kind === 'axial' && pins.length === 2) {
      const [a, b] = pins;
      const ax = cx(a.x), ay = cy(a.y), bxx = cx(b.x), byy = cy(b.y);
      const horiz = a.y === b.y;
      const len = Math.hypot(bxx - ax, byy - ay);
      const bodyLen = Math.max(S * 0.7, len - S * 1.1);
      body = (
        <>
          <line className="lead" x1={ax} y1={ay} x2={bxx} y2={byy} />
          {pl.span <= 2 ? (
            <circle className="body" cx={ax} cy={ay} r={S * 0.42} />
          ) : (
            <rect
              className="body"
              x={horiz ? mx - bodyLen / 2 : mx - S * 0.3}
              y={horiz ? my - S * 0.3 : my - bodyLen / 2}
              width={horiz ? bodyLen : S * 0.6}
              height={horiz ? S * 0.6 : bodyLen}
              rx={S * 0.25}
            />
          )}
        </>
      );
    } else if (kind === 'radial') {
      const r = radialRadius(pl.span) * S;
      const ccx = (cx(pins[0].x) + cx(pins[1].x)) / 2;
      const ccy = (cy(pins[0].y) + cy(pins[1].y)) / 2;
      body = <circle className="body" cx={ccx} cy={ccy} r={r} />;
    } else if (kind === 'dip') {
      // Pin rows run along pin1 -> pin2; the notch sits at the pin-1 end of that axis.
      const vertical = pins[1].x === pins[0].x;
      const p1 = { x: cx(pins[0].x), y: cy(pins[0].y) };
      const nx = vertical ? mx : p1.x < mx ? bx0 + S * 0.1 : bx1 - S * 0.1;
      const ny = vertical ? (p1.y < my ? by0 + S * 0.1 : by1 - S * 0.1) : my;
      body = (
        <>
          <rect className="body ic" x={bx0 + S * 0.1} y={by0 + S * 0.1} width={bx1 - bx0 - S * 0.2} height={by1 - by0 - S * 0.2} rx={3} />
          <circle className="notch" cx={nx} cy={ny} r={S * 0.25} />
        </>
      );
    } else {
      body = <rect className="body" x={bx0 + S * 0.08} y={by0 + S * 0.08} width={bx1 - bx0 - S * 0.16} height={by1 - by0 - S * 0.16} rx={S * 0.3} />;
    }
    return (
      <g
        key={c.ref}
        className={`part kind-${kind}${isSel ? ' selected' : ''}${copper ? ' ghost' : ''}`}
        onPointerDown={copper ? undefined : (e) => onPointerDownPart(e, i)}
        style={{ cursor: editable && !copper ? 'grab' : 'default' }}
      >
        <title>{`${c.ref} ${c.value ?? ''} (${fp.name})`}</title>
        {body}
        {pins.map((p, pi) => {
          const net = c.pins[pi];
          const col = net ? colors.get(net) : undefined;
          const x = cx(p.x);
          const y = cy(p.y);
          const r = S * 0.24;
          const common = {
            className: 'pin',
            stroke: col ?? 'var(--muted)',
            opacity: netOpacity(net),
            onPointerEnter: () => props.onHoverNet(net),
            onPointerLeave: () => props.onHoverNet(null),
          };
          return pi === 0 && pins.length > 1 ? (
            <rect key={pi} {...common} x={x - r} y={y - r} width={2 * r} height={2 * r}>
              <title>{`${c.ref} pin ${pi + 1}${net ? ` — ${net}` : ' (n/c)'}`}</title>
            </rect>
          ) : (
            <circle key={pi} {...common} cx={x} cy={y} r={r}>
              <title>{`${c.ref} pin ${pi + 1}${net ? ` — ${net}` : ' (n/c)'}`}</title>
            </circle>
          );
        })}
        {!copper && (
          <text className="label" x={mx} y={my} textAnchor="middle" dominantBaseline="central">
            <tspan className="ref">{c.ref}</tspan>
            {c.value && pins.length > 1 && (bx1 - bx0 >= S * 3 || by1 - by0 >= S * 3) && (
              <tspan className="val" x={mx} dy="1.1em">
                {c.value}
              </tspan>
            )}
          </text>
        )}
      </g>
    );
  });

  const ratsnest = route.unrouted.map((u, i) => (
    <line key={`u${i}`} className="ratsnest" x1={cx(u.from.x)} y1={cy(u.from.y)} x2={cx(u.to.x)} y2={cy(u.to.y)}>
      <title>{`Unrouted: ${u.net}`}</title>
    </line>
  ));

  const problems = route.violations.flatMap((v, i) =>
    v.holes.map((h, j) => (
      <circle key={`v${i}-${j}`} className="violation" cx={cx(h.x)} cy={cy(h.y)} r={S * 0.45}>
        <title>{v.message}</title>
      </circle>
    )),
  );

  const axes = [];
  for (let y = 0; y < H; y++) {
    axes.push(
      <text key={`ay${y}`} className="axis" x={M / 2} y={cy(y)} textAnchor="middle" dominantBaseline="central">
        {stripName(y)}
      </text>,
      <text key={`ay2${y}`} className="axis" x={width - M / 2} y={cy(y)} textAnchor="middle" dominantBaseline="central">
        {stripName(y)}
      </text>,
    );
  }
  for (let x = 0; x < W; x++) {
    if (W > 30 && (x + 1) % 2 === 0 && x !== 0) continue;
    axes.push(
      <text key={`ax${x}`} className="axis" x={cx(x)} y={M / 2} textAnchor="middle" dominantBaseline="central">
        {x + 1}
      </text>,
    );
  }

  return (
    <svg
      ref={(el) => {
        localRef.current = el;
        const r = props.svgRef;
        if (typeof r === 'function') r(el);
        else if (r) (r as { current: SVGSVGElement | null }).current = el;
      }}
      className={`board side-${side}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      xmlns="http://www.w3.org/2000/svg"
      onPointerMove={onPointerMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      onPointerDown={() => props.onSelect(null)}
      role="img"
      aria-label={`Stripboard layout, ${side} side`}
    >
      <rect className="pcb" x={M - 6} y={M - 6} width={W * S + 12} height={H * S + 12} rx={6} />
      {strips}
      {holes}
      {props.used && (() => {
        const u = props.used;
        const xa = Math.min(cx(u.x0), cx(u.x1)) - S / 2 - 2;
        const xb = Math.max(cx(u.x0), cx(u.x1)) + S / 2 + 2;
        return (
          <rect className="used" x={xa} y={cy(u.y0) - S / 2 - 2} width={xb - xa} height={(u.y1 - u.y0 + 1) * S + 4} rx={4}>
            <title>Used area — cut the board to this size</title>
          </rect>
        );
      })()}
      {copper ? (
        <>
          {parts}
          {links}
          {cuts}
        </>
      ) : (
        <>
          {links}
          {parts}
          {cuts}
        </>
      )}
      {ratsnest}
      {problems}
      {axes}
      <text className="axis side-label" x={width - M} y={height - 8} textAnchor="end">
        {copper ? 'Copper side (mirrored)' : 'Component side'}
      </text>
    </svg>
  );
}
