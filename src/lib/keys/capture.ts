/**
 * What happens when the user presses a chord to add to an action — pure, so
 * the settings section only renders the verdict.
 */

import { SCOPES, type ActionId, type KeyActionDef } from './actions';
import {
  MAX_CHORDS_PER_ACTION,
  chordRelation,
  compileKeymap,
  effectiveChords,
  shadowingScope,
  type KeyBindings
} from './keymap';
import { refusalReason, warningsFor } from './reserved';

export type CaptureVerdict =
  | { kind: 'refused'; reason: string }
  | { kind: 'duplicate' }
  | { kind: 'full' }
  | { kind: 'conflict'; others: ActionId[]; notes: string[]; warnings: string[] }
  | { kind: 'ok'; notes: string[]; warnings: string[] };

/**
 * The note for two actions on one chord where one scope is tried first:
 * "In edit mode, this key is “Undo” before “Zoom”.", "While a volume is under
 * the pointer, this key is “Edit volume” before “Edit series”."
 */
export function shadowNote(a: KeyActionDef, b: KeyActionDef): string {
  const first = shadowingScope(a.scope, b.scope) === a.scope ? a : b;
  const second = first === a ? b : a;
  const when = SCOPES[first.scope].when ?? `In ${SCOPES[first.scope].label.toLowerCase()}`;
  return `${when}, this key is “${first.label}” before “${second.label}”.`;
}

/**
 * `actions` is the full list the bindings apply to (`Keymap.actions` of the
 * live keymap, or `allActions()`).
 */
export function assessCapture(
  action: KeyActionDef,
  chord: string,
  bindings: KeyBindings | undefined,
  actions: readonly KeyActionDef[]
): CaptureVerdict {
  const reason = refusalReason(chord);
  if (reason) return { kind: 'refused', reason };

  const own = effectiveChords(action, bindings);
  if (own.includes(chord)) return { kind: 'duplicate' };
  if (own.length >= MAX_CHORDS_PER_ACTION) return { kind: 'full' };

  const keymap = compileKeymap(bindings, actions);
  const others: ActionId[] = [];
  const notes: string[] = [];
  for (const [id, chords] of keymap.chords) {
    if (!chords.includes(chord)) continue;
    const other = keymap.actions.get(id)!;
    const relation = chordRelation(action, other);
    if (relation === 'conflict') others.push(id);
    else if (relation === 'shadow') notes.push(shadowNote(action, other));
  }
  const warnings = warningsFor(chord);
  if (others.length > 0) return { kind: 'conflict', others, notes, warnings };
  return { kind: 'ok', notes, warnings };
}
