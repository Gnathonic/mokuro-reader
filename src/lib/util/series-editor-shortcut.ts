// Pure decision logic for the catalog card "hover + e" series editor shortcut.
// Kept separate from CatalogItem.svelte / CatalogListItem.svelte so it can be unit
// tested without pulling in either component's (heavy) import graph.

/** Is focus somewhere that swallows keys — a field, or any contentEditable? */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
}

/**
 * Whether a keydown while hovering a catalog card should open the series editor.
 * True iff: the card is hovered, the key is "e" with no ctrl/meta/alt modifier, and
 * focus is not currently on a typing target (input/textarea/select/contentEditable).
 */
export function shouldOpenSeriesEditor(
  e: KeyboardEvent,
  hovered: boolean,
  activeElement: Element | null
): boolean {
  if (!hovered) return false;
  if (e.key !== 'e') return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (isTypingTarget(activeElement)) return false;
  return true;
}
