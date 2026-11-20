interface Props {
  points: { p: number; best: number; current: number }[];
  width?: number;
  height?: number;
}

/** Cost-over-time chart (log scale: penalties make early costs orders of magnitude larger). */
export function Sparkline({ points, width = 260, height = 64 }: Props) {
  if (points.length < 2) return <svg className="spark" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" />;
  const vals = points.flatMap((d) => [d.best, d.current]).filter((v) => Number.isFinite(v) && v > 0);
  const lo = Math.log10(Math.max(1, Math.min(...vals)));
  const hi = Math.log10(Math.max(...vals));
  const span = Math.max(0.1, hi - lo);
  const pad = 4;
  const X = (p: number) => pad + p * (width - 2 * pad);
  const Y = (v: number) => pad + (1 - (Math.log10(Math.max(1, v)) - lo) / span) * (height - 2 * pad);
  const path = (key: 'best' | 'current') =>
    points
      .filter((d) => Number.isFinite(d[key]))
      .map((d, i) => `${i ? 'L' : 'M'}${X(d.p).toFixed(1)} ${Y(d[key]).toFixed(1)}`)
      .join('');
  return (
    <svg className="spark" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Cost over time">
      <path className="spark-current" d={path('current')} />
      <path className="spark-best" d={path('best')} />
    </svg>
  );
}
