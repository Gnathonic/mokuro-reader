/**
 * What happens when the user presses a chord to add to an action — pure, so
 * the settings section only renders the verdict.
 */

import { ACTIONS_BY_ID, GROUP_LABELS, type ActionId, type KeyActionDef } from './actions';
import {
  MAX_CHORDS_PER_ACTION,
  chordRelation,
  compileKeymap,
  effectiveChords,
  type KeyBindings
} from './keymap';
import { refusalReason, warningsFor } from './reserved';

export type CaptureVerdict =
  | { kind: 'refused'; reason: string }
  | { kind: 'duplicate' }
  | { kind: 'full' }
  | { kind: 'conflict'; others: ActionId[]; notes: string[]; warnings: string[] }
  | { kind: 'ok'; notes: string[]; warnings: string[] };

export function assessCapture(
  action: KeyActionDef,
  chord: string,
  bindings: KeyBindings | undefined
): CaptureVerdict {
  const reason = refusalReason(chord);
  if (reason) return { kind: 'refused', reason };

  const own = effectiveChords(action, bindings);
  if (own.includes(chord)) return { kind: 'duplicate' };
  if (own.length >= MAX_CHORDS_PER_ACTION) return { kind: 'full' };

  const keymap = compileKeymap(bindings);
  const others: ActionId[] = [];
  const notes: string[] = [];
  for (const [id, chords] of keymap.chords) {
    if (!chords.includes(chord)) continue;
    const other = ACTIONS_BY_ID.get(id)!;
    const relation = chordRelation(action, other);
    if (relation === 'conflict') others.push(id);
    else if (relation === 'shadow') {
      const editing = action.scope === 'edit' ? action : other;
      const shadowed = action.scope === 'edit' ? other : action;
      notes.push(
        `In ${GROUP_LABELS.edit.toLowerCase()}, this key is “${editing.label}” before “${shadowed.label}”.`
      );
    }
  }
  const warnings = warningsFor(chord);
  if (others.length > 0) return { kind: 'conflict', others, notes, warnings };
  return { kind: 'ok', notes, warnings };
}
