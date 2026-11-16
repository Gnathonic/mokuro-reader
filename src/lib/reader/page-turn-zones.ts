/**
 * Tap-to-turn region rules (#54), kept out of the component so they test
 * without a layout engine. See `PageTurnZones.svelte` for the zones.
 */

export interface ClientRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Inclusive point-in-rect, in client px. */
export function pointInRect(x: number, y: number, r: ClientRect): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/**
 * Is the client point over the paged reader's page image (the whole spread,
 * its gap included)? `#manga-panel` is the camera's content: its client rect
 * already carries the pan and zoom transform.
 */
export function pointOverPage(x: number, y: number): boolean {
  const panel = document.getElementById('manga-panel');
  return !!panel && pointInRect(x, y, panel.getBoundingClientRect());
}

/**
 * Does a release on a desktop screen-edge strip turn the page? The strip is
 * the page-edge control (it only exists while `edgeButtonWidth > 0`), so over
 * the page it turns; over the background it covers a background zone, so it
 * does what that zone would — `tapOutsideImageToTurn` alone decides. With the
 * toggle on, the background under the strip turns with or without the strip.
 */
export function screenStripTurns(overPage: boolean, outsideTurns: boolean): boolean {
  return overPage || outsideTurns;
}

/**
 * How far the background zones reach past the spread, in CAMERA px (they live
 * inside the transformed wrapper, so this shrinks with the zoom). It has to
 * reach the screen's edge at the smallest scale the reader shows a page at —
 * a huge scan fit to a small screen is ~0.05–0.1× — so 100 000 camera px is
 * still 5 000+ screen px. Nothing paints at that size: the zones are clear
 * (1% opacity) and only tint under a hovering mouse, and the reader clips the
 * document (`overflow: hidden` on `<html>`), so they add no scroll.
 */
export const ZONE_REACH_PX = 100_000;

export interface BackgroundZone {
  label: string;
  /** Which page-turn handler a press calls: the VISUAL side of the screen. */
  side: 'left' | 'right';
  /** Inline position against the spread (the zone's containing block). */
  style: string;
}

const R = `${ZONE_REACH_PX}px`;

/**
 * The area OUTSIDE the page image, as six boxes around the spread that never
 * overlap it: a full-height column on each side (corners included), and the
 * bands above and below the spread split at its middle — the left half turns
 * like the left column, the right half like the right one.
 */
export const BACKGROUND_ZONES: readonly BackgroundZone[] = [
  {
    label: 'Previous page (left background)',
    side: 'left',
    style: `right: 100%; top: -${R}; bottom: -${R}; width: ${R};`
  },
  {
    label: 'Next page (right background)',
    side: 'right',
    style: `left: 100%; top: -${R}; bottom: -${R}; width: ${R};`
  },
  {
    label: 'Previous page (above, left)',
    side: 'left',
    style: `left: 0; width: 50%; bottom: 100%; height: ${R};`
  },
  {
    label: 'Next page (above, right)',
    side: 'right',
    style: `left: 50%; width: 50%; bottom: 100%; height: ${R};`
  },
  {
    label: 'Previous page (below, left)',
    side: 'left',
    style: `left: 0; width: 50%; top: 100%; height: ${R};`
  },
  {
    label: 'Next page (below, right)',
    side: 'right',
    style: `left: 50%; width: 50%; top: 100%; height: ${R};`
  }
];
