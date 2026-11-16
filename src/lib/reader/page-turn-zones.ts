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
 * the page it turns; over the background it is the background's region, which
 * `tapOutsideImageToTurn` alone decides.
 */
export function screenStripTurns(overPage: boolean, outsideTurns: boolean): boolean {
  return overPage || outsideTurns;
}
