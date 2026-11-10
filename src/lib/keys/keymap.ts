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
  SCOPES,
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
  /**
   * The actions this keymap was compiled from, in registry order. The list
   * is not a constant (one "Set to" action per profile), so everything that
   * resolves an id — `lookup`, `findConflicts`, dispatch, capture — reads it
   * here and never from a module-level table.
   */
  readonly actions: ReadonlyMap<ActionId, KeyActionDef>;
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

/**
 * Compile `bindings` over `actions` — the full list (`allActions()` in
 * `registry.ts`), passed in because this module stays free of the setting
 * stores the generated actions come from.
 */
export function compileKeymap(
  bindings: KeyBindings | undefined,
  actions: readonly KeyActionDef[]
): Keymap {
  const byScope = new Map<KeyScope, Map<string, ActionId[]>>();
  const chords = new Map<ActionId, string[]>();
  const byId = new Map<ActionId, KeyActionDef>();
  for (const action of actions) {
    byId.set(action.id as ActionId, action);
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
  return { byScope, chords, actions: byId };
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
    const a = keymap.actions.get(id)!;
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
 * How two actions on the same chord relate. The scope table (`SCOPES` in
 * actions.ts) is the data; this only reads it.
 *
 * - `conflict`: both could fire for one press and nothing says which — the
 *   same scope (and, in the reader, a shared live mode), or `app` against
 *   any scope it is live with.
 * - `shadow`: one scope is tried before the other while both are live
 *   (`edit` before `reader` and `app`, a hovered card before its page), so
 *   the other one only loses that key there — a note, not a prompt.
 * - `none`: never live together (reader vs library, catalog vs series page,
 *   a dialog vs anything, Page left vs Scroll left, which share no mode).
 */
export type ChordRelation = 'conflict' | 'shadow' | 'none';

function modesOverlap(a: KeyActionDef, b: KeyActionDef): boolean {
  if (!a.modes || !b.modes) return true;
  return a.modes.some((m) => b.modes!.includes(m));
}

/** Of two scopes, the one tried first while both are live; null when neither shadows. */
export function shadowingScope(a: KeyScope, b: KeyScope): KeyScope | null {
  if (SCOPES[a].shadows.includes(b)) return a;
  if (SCOPES[b].shadows.includes(a)) return b;
  return null;
}

export function chordRelation(a: KeyActionDef, b: KeyActionDef): ChordRelation {
  if (a.id === b.id) return 'none';
  if (a.scope === b.scope) return modesOverlap(a, b) ? 'conflict' : 'none';
  if (shadowingScope(a.scope, b.scope)) return modesOverlap(a, b) ? 'shadow' : 'none';
  const other = a.scope === 'app' ? b : b.scope === 'app' ? a : null;
  if (other) return SCOPES[other.scope].dialog ? 'none' : 'conflict';
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
        const a = keymap.actions.get(ids[i])!;
        const b = keymap.actions.get(ids[j])!;
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
  others: readonly KeyActionDef[]
): KeyBindings {
  let next: KeyBindings = { ...(bindings ?? {}) };
  for (const other of others) next = removeChord(next, other, chord);
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
 * Actions that no longer exist, and where their stored chords go (spec 17.3).
 * `dropped` chords are freed for everyone; any other stored chord moves onto
 * `into`. Applied by `sanitizeKeyBindings`, so on load and on every merged
 * profile. Deterministic and stamp-free, like the other shape migrations:
 * two devices converge without a write.
 *
 * `reader.cover` (C) only shifted the spread pairing as a side effect, which
 * is what `reader.offset-spreads` (O) is for. No released build stored it;
 * this covers profiles written by earlier builds of the branch, and is the
 * pattern for any later retirement.
 */
export const RETIRED_ACTIONS: Record<string, { into: string; dropped: readonly string[] }> = {
  'reader.cover': { into: 'reader.offset-spreads', dropped: ['KeyC'] }
};

function foldRetired(bindings: KeyBindings): KeyBindings {
  for (const [id, { into, dropped }] of Object.entries(RETIRED_ACTIONS)) {
    if (!(id in bindings)) continue;
    const moved = bindings[id].filter((c) => !dropped.includes(normalizeChord(c) ?? c));
    delete bindings[id];
    if (moved.length === 0) continue;
    const target = (KEY_ACTIONS as readonly KeyActionDef[]).find((a) => a.id === into);
    const base = Array.isArray(bindings[into]) ? bindings[into] : [...(target?.defaults ?? [])];
    const list = [...base];
    for (const c of moved) {
      const canon = normalizeChord(c) ?? c;
      if (!list.some((x) => (normalizeChord(x) ?? x) === canon)) list.push(c);
    }
    bindings[into] = list.slice(0, MAX_STORED_CHORDS);
  }
  return bindings;
}

/**
 * Shape check for a synced or hand-edited `keyBindings` (`migrateProfiles`):
 * a non-object becomes `{}`, a non-array entry is dropped, a list keeps at
 * most `MAX_STORED_CHORDS` strings of at most `MAX_STORED_CHORD_LENGTH`
 * chars. Unknown ids and unparseable chords are KEPT — they may be a newer
 * client's, and `compileKeymap` ignores them. A RETIRED id is folded into
 * its successor (`RETIRED_ACTIONS`).
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
  return foldRetired(out);
}
