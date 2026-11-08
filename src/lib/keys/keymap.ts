/**
 * Stored bindings → a lookup table, and the rules about which bindings
 * collide.
 *
 * Storage (`Settings.keyBindings`, per profile, synced in `profiles.json`) is
 * SPARSE: an absent id means the registry's defaults, `[]` means unbound, a
 * non-empty list replaces the defaults. Locked chords (Escape on Back) are
 * implicit and never stored — a locked action's list holds only its extras.
 * Defaults live in code, so a changed default reaches everyone who has not
 * customised that action.
 *
 * What the keymap cannot parse or does not know (an id from a newer client,
 * a hand-edited chord) it IGNORES; it never deletes it from storage, so an
 * older client's write-back cannot erase a newer client's bindings.
 */

import {
  KEY_ACTIONS,
  ACTIONS_BY_ID,
  type ActionId,
  type KeyActionDef,
  type KeyScope,
  type ReaderMode
} from './actions';
import { normalizeChord } from './chord';

export type KeyBindings = Record<string, string[]>;

export interface Keymap {
  /** scope → chord → action ids, in registry order. */
  readonly byScope: ReadonlyMap<KeyScope, ReadonlyMap<string, readonly ActionId[]>>;
  /** action id → its effective chords (locked first). */
  readonly chords: ReadonlyMap<ActionId, readonly string[]>;
}

/** The UI's cap on chords per action (locked ones included). */
export const MAX_CHORDS_PER_ACTION = 4;

function dedupe(list: (string | null)[]): string[] {
  const out: string[] = [];
  for (const c of list) if (c && !out.includes(c)) out.push(c);
  return out;
}

/** The user-editable chords of an action: the stored list, else the defaults. */
export function editableChords(action: KeyActionDef, bindings: KeyBindings | undefined): string[] {
  const stored = bindings?.[action.id];
  const list = Array.isArray(stored) ? stored : action.defaults;
  const locked = new Set(action.locked ?? []);
  return dedupe(list.map(normalizeChord)).filter((c) => !locked.has(c));
}

/** Every chord that fires an action: locked first, then the editable ones. */
export function effectiveChords(action: KeyActionDef, bindings: KeyBindings | undefined): string[] {
  return dedupe([...(action.locked ?? []), ...editableChords(action, bindings)]);
}

export function compileKeymap(bindings: KeyBindings | undefined): Keymap {
  const byScope = new Map<KeyScope, Map<string, ActionId[]>>();
  const chords = new Map<ActionId, string[]>();
  for (const action of KEY_ACTIONS as readonly KeyActionDef[]) {
    const list = effectiveChords(action, bindings);
    chords.set(action.id as ActionId, list);
    let scope = byScope.get(action.scope);
    if (!scope) byScope.set(action.scope, (scope = new Map()));
    for (const chord of list) {
      const ids = scope.get(chord);
      if (ids) ids.push(action.id as ActionId);
      else scope.set(chord, [action.id as ActionId]);
    }
  }
  return { byScope, chords };
}

/** The actions a chord fires in `scope`, live in `mode`, registry order. */
export function lookup(
  keymap: Keymap,
  scope: KeyScope,
  chord: string,
  mode?: ReaderMode
): ActionId[] {
  const ids = keymap.byScope.get(scope)?.get(chord);
  if (!ids) return [];
  return ids.filter((id) => {
    const a = ACTIONS_BY_ID.get(id)!;
    return !mode || !a.modes || a.modes.includes(mode);
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c) => b.includes(c));
}

/** Does the action differ from its registry defaults? */
export function isModified(action: KeyActionDef, bindings: KeyBindings | undefined): boolean {
  if (!bindings || !(action.id in bindings)) return false;
  return !sameSet(editableChords(action, bindings), editableChords(action, undefined));
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * How two actions on the same chord relate.
 *
 * - `conflict`: both could fire for one press and nothing says which — same
 *   scope (and, in the reader, a shared live mode), or `app` (live
 *   everywhere) against any scope but `edit`.
 * - `shadow`: `edit` runs first while editing, so the other one only loses
 *   that key in edit mode — a note, not a prompt.
 * - `none`: never live together (reader vs library, series vs volume cards,
 *   Page left vs Scroll left, which share no mode).
 */
export type ChordRelation = 'conflict' | 'shadow' | 'none';

function modesOverlap(a: KeyActionDef, b: KeyActionDef): boolean {
  if (!a.modes || !b.modes) return true;
  return a.modes.some((m) => b.modes!.includes(m));
}

export function chordRelation(a: KeyActionDef, b: KeyActionDef): ChordRelation {
  if (a.id === b.id) return 'none';
  const scopes = new Set([a.scope, b.scope]);
  if (scopes.has('edit') && scopes.size === 2) {
    if (!scopes.has('reader') && !scopes.has('app')) return 'none';
    return modesOverlap(a, b) ? 'shadow' : 'none';
  }
  if (a.scope === b.scope) return modesOverlap(a, b) ? 'conflict' : 'none';
  if (scopes.has('app')) return 'conflict';
  return 'none';
}

/** Every action that has at least one conflicting chord, with what it collides with. */
export function findConflicts(keymap: Keymap): Map<ActionId, Set<ActionId>> {
  const out = new Map<ActionId, Set<ActionId>>();
  const owners = new Map<string, ActionId[]>();
  for (const [id, chords] of keymap.chords) {
    for (const chord of chords) {
      const list = owners.get(chord);
      if (list) list.push(id);
      else owners.set(chord, [id]);
    }
  }
  for (const ids of owners.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ACTIONS_BY_ID.get(ids[i])!;
        const b = ACTIONS_BY_ID.get(ids[j])!;
        if (chordRelation(a, b) !== 'conflict') continue;
        if (!out.has(ids[i])) out.set(ids[i], new Set());
        if (!out.has(ids[j])) out.set(ids[j], new Set());
        out.get(ids[i])!.add(ids[j]);
        out.get(ids[j])!.add(ids[i]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits — every one returns a NEW sparse map
// ---------------------------------------------------------------------------

/** Store `chords` as the action's editable list, dropping the entry when it equals the defaults. */
export function withChords(
  bindings: KeyBindings | undefined,
  action: KeyActionDef,
  chords: string[]
): KeyBindings {
  const next: KeyBindings = { ...(bindings ?? {}) };
  const locked = new Set(action.locked ?? []);
  const list = dedupe(chords.map(normalizeChord)).filter((c) => !locked.has(c));
  if (sameSet(list, editableChords(action, undefined))) delete next[action.id];
  else next[action.id] = list;
  return next;
}

export function addChord(
  bindings: KeyBindings | undefined,
  action: KeyActionDef,
  chord: string
): KeyBindings {
  return withChords(bindings, action, [...editableChords(action, bindings), chord]);
}

export function removeChord(
  bindings: KeyBindings | undefined,
  action: KeyActionDef,
  chord: string
): KeyBindings {
  return withChords(
    bindings,
    action,
    editableChords(action, bindings).filter((c) => c !== chord)
  );
}

export function resetAction(bindings: KeyBindings | undefined, action: KeyActionDef): KeyBindings {
  const next: KeyBindings = { ...(bindings ?? {}) };
  delete next[action.id];
  return next;
}

/** Add `chord` to `action` after taking it off every action it conflicts with there. */
export function replaceChord(
  bindings: KeyBindings | undefined,
  action: KeyActionDef,
  chord: string,
  others: readonly ActionId[]
): KeyBindings {
  let next: KeyBindings = { ...(bindings ?? {}) };
  for (const id of others) next = removeChord(next, ACTIONS_BY_ID.get(id)!, chord);
  return addChord(next, action, chord);
}

// ---------------------------------------------------------------------------
// Storage shape
// ---------------------------------------------------------------------------

/** Most chords one stored list may carry (above the UI's cap, for headroom). */
export const MAX_STORED_CHORDS = 8;
/** Longest stored chord string. */
export const MAX_STORED_CHORD_LENGTH = 40;

/**
 * Shape check for a synced or hand-edited `keyBindings` (`migrateProfiles`):
 * a non-object becomes `{}`, a non-array entry is dropped, a list keeps at
 * most `MAX_STORED_CHORDS` strings of at most `MAX_STORED_CHORD_LENGTH`
 * chars. Unknown ids and unparseable chords are KEPT — they may be a newer
 * client's, and `compileKeymap` ignores them.
 */
export function sanitizeKeyBindings(value: unknown): KeyBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: KeyBindings = {};
  for (const [id, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    out[id] = list
      .filter((c): c is string => typeof c === 'string' && c.length <= MAX_STORED_CHORD_LENGTH)
      .slice(0, MAX_STORED_CHORDS);
  }
  return out;
}
