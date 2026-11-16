/**
 * Non-modal reader overlays that share the bottom-centre of the screen — the
 * page image panel (#363) and the long-pause prompt — never cover each other,
 * and never move once they are on screen.
 *
 * Rule: whichever arrives SECOND stacks above the one already there. The one
 * already on screen keeps its place; the newcomer picks its place once, when
 * it appears, and keeps it while it stays (even if the other one leaves). So
 * nothing jumps under a finger or a cursor: a prompt that shows up while the
 * brightness slider is held appears above the panel instead of over the
 * slider, and a panel opened over a waiting prompt opens above it.
 *
 * A placement is redone only when the screen changes (a resize or rotation,
 * which re-lays out everything anyway) or when the overlay it cleared grows
 * into it.
 */

/** Marks an element as a bottom overlay (`use:bottomOverlay`). */
export const BOTTOM_OVERLAY_ATTR = 'data-bottom-overlay';

/** Space left between two stacked overlays, px. */
export const BOTTOM_OVERLAY_GAP = 8;

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Where `own` (measured at its default place) must sit to clear every box in
 * `others`: its `bottom` in px from the viewport's bottom edge, or null when
 * the default place already clears them all. Lifting above one box can land
 * on another higher up, so it repeats until nothing overlaps.
 */
export function clearancePlacement(
  own: Box,
  others: readonly Box[],
  viewportHeight: number,
  gap = BOTTOM_OVERLAY_GAP
): number | null {
  let box = own;
  let lifted = false;
  for (let round = 0; round <= others.length; round++) {
    const hit = others.filter((o) => overlaps(box, o));
    if (hit.length === 0) break;
    const top = Math.min(...hit.map((o) => o.top));
    const height = box.bottom - box.top;
    box = { ...box, bottom: top - gap, top: top - gap - height };
    lifted = true;
  }
  return lifted ? Math.round(viewportHeight - box.bottom) : null;
}

/**
 * Svelte action for a bottom overlay: on mount it takes its default place
 * (the element's own CSS) unless another bottom overlay is already there, in
 * which case it stacks above it by setting an inline `bottom`.
 */
export function bottomOverlay(node: HTMLElement) {
  node.setAttribute(BOTTOM_OVERLAY_ATTR, '');
  // The overlays the current placement cleared, with the height each had.
  let cleared = new Map<Element, number>();
  const grown =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          // Observing reports the current size once; only a real change re-places.
          const changed = entries.some(
            (e) =>
              Math.abs(e.target.getBoundingClientRect().height - (cleared.get(e.target) ?? -1)) >
              0.5
          );
          if (changed) place();
        });

  function place() {
    node.style.bottom = '';
    const own = node.getBoundingClientRect();
    const others = [...document.querySelectorAll(`[${BOTTOM_OVERLAY_ATTR}]`)].filter(
      (el) => el !== node
    );
    const bottom = clearancePlacement(
      own,
      others.map((el) => el.getBoundingClientRect()),
      window.innerHeight
    );
    if (bottom !== null) node.style.bottom = `${bottom}px`;
    grown?.disconnect();
    cleared = new Map();
    if (bottom === null) return;
    for (const el of others) {
      cleared.set(el, el.getBoundingClientRect().height);
      grown?.observe(el);
    }
  }

  function onResize() {
    // Only an overlay that stacked needs a new place; the other keeps its CSS.
    if (node.style.bottom) place();
  }

  place();
  window.addEventListener('resize', onResize);
  return {
    destroy() {
      window.removeEventListener('resize', onResize);
      grown?.disconnect();
    }
  };
}
