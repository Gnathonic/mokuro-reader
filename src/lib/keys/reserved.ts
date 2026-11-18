/**
 * Chords the settings section refuses to bind, and the ones it binds with a
 * warning (#55, spec section 10). Tuned against what Chrome, Firefox and
 * Safari actually deliver to a page: the refused ones either never reach
 * the page (the browser keeps them) or are needed to move focus.
 */

import { parseChord, usesScanModifier } from './chord';

/** Keys that toggle a lock or open a menu — never a shortcut. */
const REFUSED_KEYS = new Set(['CapsLock', 'NumLock', 'ScrollLock', 'ContextMenu']);

/** With Ctrl or Meta (± Shift): tabs, windows, quitting. The browser keeps these. */
const BROWSER_KEPT_WITH_CTRL = new Set([
  'KeyW',
  'KeyT',
  'KeyN',
  'KeyQ',
  'Tab',
  'PageUp',
  'PageDown'
]);

/** With Ctrl or Meta: an everyday browser action the binding would take over. */
const BROWSER_ACTION_WITH_CTRL = new Set([
  'KeyC',
  'KeyV',
  'KeyX',
  'KeyA',
  'KeyF',
  'KeyP',
  'KeyS',
  'KeyR',
  'KeyL'
]);

export const SCAN_MODIFIER_WARNING = 'Dictionary pop-ups often scan while Shift or Alt is held.';
export const BROWSER_ACTION_WARNING = 'This takes over a browser shortcut.';

/** Why a chord cannot be bound, or null when it can. */
export function refusalReason(chord: string): string | null {
  const p = parseChord(chord);
  if (!p) return 'That key cannot be recorded.';
  const ctrlOrMeta = p.ctrl || p.meta;
  if (REFUSED_KEYS.has(p.key)) return 'Lock and menu keys cannot be shortcuts.';
  if (p.key === 'Tab' && !ctrlOrMeta && !p.alt) return 'Tab moves focus; it cannot be a shortcut.';
  if (p.key === 'Escape' && !ctrlOrMeta && !p.alt && !p.shift) {
    return 'Escape cancels recording.';
  }
  if (ctrlOrMeta && BROWSER_KEPT_WITH_CTRL.has(p.key)) {
    return 'The browser keeps this chord for itself.';
  }
  if (p.key === 'F11' && !ctrlOrMeta && !p.alt) return 'The browser keeps F11 for fullscreen.';
  if (p.key === 'F4' && p.alt) return 'Alt+F4 closes the window.';
  return null;
}

/** Warnings shown beside a chord that is allowed. */
export function warningsFor(chord: string): string[] {
  const p = parseChord(chord);
  if (!p) return [];
  const out: string[] = [];
  if (usesScanModifier(chord)) out.push(SCAN_MODIFIER_WARNING);
  const ctrlOrMeta = p.ctrl || p.meta;
  const plainCtrl = ctrlOrMeta && !p.alt && !p.shift;
  if (
    (plainCtrl && BROWSER_ACTION_WITH_CTRL.has(p.key)) ||
    (p.key === 'F5' && !p.alt) ||
    (p.alt && !ctrlOrMeta && !p.shift && (p.key === 'ArrowLeft' || p.key === 'ArrowRight'))
  ) {
    out.push(BROWSER_ACTION_WARNING);
  }
  return out;
}
