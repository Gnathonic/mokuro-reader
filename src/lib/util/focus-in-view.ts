/**
 * Keep keyboard focus with a restored scroll position (#363).
 *
 * A dialog focuses its first control when it opens; when the dialog then
 * restores an earlier scroll position, that control is off-screen. The first
 * Tab would move on from there and scroll the dialog back to the top, and a
 * screen reader would announce a control the user cannot see. This moves focus
 * — without scrolling — to the first tabbable control inside the visible part
 * of the container, but only when the current focus is not already visible.
 */

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function fullyInView(el: Element, view: DOMRect): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.top >= view.top && r.bottom <= view.bottom;
}

/** Returns the element focused, or null when focus was left where it was. */
export function focusFirstInView(container: HTMLElement): HTMLElement | null {
  const view = container.getBoundingClientRect();
  const current = document.activeElement;
  // Focus the user (or something else) moved outside the container is theirs.
  if (current && current !== document.body && !container.contains(current)) return null;
  if (current && current !== container && container.contains(current) && fullyInView(current, view))
    return null;
  for (const el of container.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (!fullyInView(el, view)) continue;
    el.focus({ preventScroll: true });
    return el;
  }
  return null;
}
