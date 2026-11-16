/**
 * Non-modal reader overlays that share the bottom-centre of the screen — the
 * page image panel (#363) and the long-pause prompt — never cover each other,
 * and never move under the user once they are on screen.
 *
 * Rule: whichever arrives SECOND stacks above the one already there. The one
 * already on screen keeps its place; the newcomer picks its place once, when
 * it appears, and keeps it while it stays — also when the other one LEAVES
 * or SHRINKS. Dropping back down then would move it under a finger or a
 * cursor that may be on its slider; the gap left below it is harmless, and
 * an overlay that shows up later simply takes its own default place in it.
 * So a prompt that shows up while the brightness slider is held appears above
 * the panel instead of over the slider, and a panel opened over a waiting
 * prompt opens above it and stays there when the prompt is answered.
 *
 * A stacked overlay moves only:
 *  - UP, just far enough, when an overlay it cleared grows into it — the one
 *    case where staying put would cover something. The long-pause prompt
 *    reserves the height of its taller variant (LongPausePrompt.svelte), so
 *    its copy changing does not grow it;
 *  - when the screen changes (a resize or rotation, which re-lays out
 *    everything anyway): it is placed again from scratch.
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
 * Where `own` (measured where it is now) must sit to clear every box in
 * `others`: its `bottom` in px from the viewport's bottom edge, or null when
 * it already clears them all. Lifting above one box can land on another
 * higher up, so it repeats until nothing overlaps. It only ever lifts.
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
  const others = () =>
    [...document.querySelectorAll(`[${BOTTOM_OVERLAY_ATTR}]`)].filter((el) => el !== node);
  // Watches the overlays a stacked one cleared. Observing reports each one's
  // size once, and a report for one that left (a removed element reports a
  // zero size) or shrank finds nothing in the way: neither moves anything.
  const watch =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          for (const e of entries) if (!e.target.isConnected) watch?.unobserve(e.target);
          lift();
        });

  /** Up from where it is now, just clear of anything over it; never down. */
  function lift() {
    const bottom = clearancePlacement(
      node.getBoundingClientRect(),
      others().map((el) => el.getBoundingClientRect()),
      window.innerHeight
    );
    if (bottom !== null) node.style.bottom = `${bottom}px`;
  }

  /** From scratch: the CSS default, stacked above whatever is there. */
  function place() {
    node.style.bottom = '';
    lift();
    watch?.disconnect();
    // An overlay at its default place was there first: what comes later
    // stacks above it, so it has nothing to watch.
    if (node.style.bottom) for (const el of others()) watch?.observe(el);
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
      watch?.disconnect();
    }
  };
}
