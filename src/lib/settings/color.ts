export type RGB = [number, number, number];

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function parseHex(hex: string): RGB {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const num = parseInt(h, 16);
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

export function toHex(rgb: RGB): string {
  return '#' + rgb.map((c) => clampChannel(c).toString(16).padStart(2, '0')).join('');
}

/** Linear blend: t=0 returns a, t=1 returns b. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex([0, 1, 2].map((i) => ca[i] + (cb[i] - ca[i]) * t) as unknown as RGB);
}

/** Lighten (amount > 0) toward white or darken (amount < 0) toward black. */
export function shade(hex: string, amount: number): string {
  return amount >= 0 ? mix(hex, '#ffffff', amount) : mix(hex, '#000000', -amount);
}
