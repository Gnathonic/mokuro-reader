/**
 * Recording one chord for the settings section (#55).
 *
 * A window CAPTURE-phase listener installed only while recording, so no
 * other handler — the reader's shortcuts, a dialog's Escape, an extension
 * listening at the bubble phase — sees the keys meant for the recorder:
 * every key is `preventDefault()`ed and `stopImmediatePropagation()`ed.
 * Modifier presses are held until a real key arrives. Escape cancels; Tab
 * (and Shift+Tab) ends recording and is let through so focus moves; a blur
 * of the window or a press anywhere outside `owner` cancels.
 */

import { chordFromEvent, isModifierKey } from './chord';
import { learnLabel } from './key-labels';

export interface CaptureCallbacks {
  onChord: (chord: string) => void;
  onCancel: () => void;
}

export function startCapture(owner: Element | null, cb: CaptureCallbacks): () => void {
  let active = true;

  function stop() {
    if (!active) return;
    active = false;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('blur', onBlur);
  }

  function onKeyDown(e: KeyboardEvent) {
    const plainOrShift = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === 'Tab' && plainOrShift) {
      stop();
      cb.onCancel();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape' && plainOrShift && !e.shiftKey) {
      stop();
      cb.onCancel();
      return;
    }
    if (isModifierKey(e) || e.isComposing || e.keyCode === 229) return;
    const chord = chordFromEvent(e);
    if (!chord) return;
    stop();
    learnLabel(e);
    cb.onChord(chord);
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.key === 'Tab') return;
    e.stopImmediatePropagation();
  }

  function onPointerDown(e: PointerEvent) {
    if (owner && e.target instanceof Node && owner.contains(e.target)) return;
    stop();
    cb.onCancel();
  }

  function onBlur() {
    stop();
    cb.onCancel();
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('blur', onBlur);
  return stop;
}
