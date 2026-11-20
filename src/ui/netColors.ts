/** Stable, well-separated colours per net (golden-angle hues). Power rails get fixed colours. */
export function netColor(net: string, index: number): string {
  const n = net.toUpperCase();
  if (n === 'GND' || n === '0V' || n === 'VSS') return 'hsl(220 10% 45%)';
  if (n === 'VCC' || n === 'VDD' || n === 'V+' || n === '5V' || n === '+5V' || n === '9V') return 'hsl(0 75% 52%)';
  const hue = (index * 137.508 + 40) % 360;
  return `hsl(${hue.toFixed(0)} 70% 48%)`;
}

export function netColorMap(nets: string[]): Map<string, string> {
  return new Map(nets.map((n, i) => [n, netColor(n, i)]));
}
