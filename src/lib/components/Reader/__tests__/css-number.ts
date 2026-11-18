import { expect } from 'vitest';

/**
 * Numbers read back off `element.style` are rounded. jsdom (≥ 31, like
 * Chrome's CSSOM) serialises every number in a declaration to 6 significant
 * digits: `el.style.fontSize = '42.10526315789474px'` reads back `42.1053px`,
 * `246.911967848411px` reads back `246.912px`. So a read-back value is off by
 * up to half a unit in its 6th significant digit — and no more.
 */
const CSS_SIGNIFICANT_DIGITS = 6;

/** The most a value of this magnitude can move when serialised. */
export function cssRoundingSlack(value: number): number {
  if (value === 0 || !Number.isFinite(value)) return 0;
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  return 0.5 * 10 ** (exponent - (CSS_SIGNIFICANT_DIGITS - 1));
}

/**
 * A style value ('42.1053px', '-2.10526px') is `expected`, to the precision an
 * inline style keeps: within its 6-significant-digit rounding, or within
 * 5e-7 (`toBeCloseTo(…, 6)`) where that is coarser — near zero, where the
 * rounding is finer than float noise.
 */
export function expectCssNumber(actual: string, expected: number): void {
  const value = parseFloat(actual);
  const slack = Math.max(cssRoundingSlack(expected), 5e-7);
  expect(
    Math.abs(value - expected),
    `${actual} ≈ ${expected} (±${slack.toPrecision(2)})`
  ).toBeLessThanOrEqual(slack);
}
