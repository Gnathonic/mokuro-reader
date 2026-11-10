/**
 * The settings section's rows (#55, spec 17.9). The registry holds about 250
 * ACTIONS; the section lists about 130 TARGETS — the things on the owner's
 * list. A command or a toggle is one target with one action. A list or a
 * slider setting is one target that opens to its actions (Next, Previous and
 * each "Set to"; or Step up, Step down, Reset).
 *
 * Pure: the section passes in what it knows (the keymap's chords, the
 * conflict map, the sparse maps), so everything here is a function of its
 * arguments and is derived ONCE in the section, never per row.
 */
import {
  GROUP_LABELS,
  GROUP_ORDER,
  type ActionGroup,
  type ActionId,
  type KeyActionDef
} from './actions';
import type { IconName } from './icon-names';

export interface KeyTarget {
  /** The row's key: the action id, or `setting:<def>` for a folded setting. */
  readonly key: string;
  readonly group: ActionGroup;
  readonly label: string;
  readonly icon: IconName;
  /** A list or slider setting: the row opens to its actions. */
  readonly folded: boolean;
  /** The one action of a command or toggle; every action of a folded setting. */
  readonly actions: readonly KeyActionDef[];
}

/**
 * Fold the action list into targets, in registry order. `settingLabel` names a
 * folded setting ("Paged zoom"); without one the row takes what its actions'
 * labels share before the colon.
 */
export function buildTargets(
  actions: Iterable<KeyActionDef>,
  settingLabel: (def: string) => string | undefined = () => undefined
): KeyTarget[] {
  const out: KeyTarget[] = [];
  const folded = new Map<string, { actions: KeyActionDef[] }>();
  for (const action of actions) {
    if (!action.parent) {
      out.push({
        key: action.id,
        group: action.group,
        label: action.label,
        icon: action.icon,
        folded: false,
        actions: [action]
      });
      continue;
    }
    const open = folded.get(action.parent);
    if (open) {
      open.actions.push(action);
      continue;
    }
    const target = {
      key: `setting:${action.parent}`,
      group: action.group,
      label: settingLabel(action.parent) ?? action.label.split(': ')[0],
      icon: action.icon,
      folded: true,
      actions: [action]
    };
    folded.set(action.parent, target);
    out.push(target);
  }
  return out;
}

/** An action's label under its setting's row: "Paged zoom: Next" → "Next". */
export function labelWithin(target: KeyTarget, action: KeyActionDef): string {
  const prefix = `${target.label}: `;
  return target.folded && action.label.startsWith(prefix)
    ? action.label.slice(prefix.length)
    : action.label;
}

export interface TargetFilter {
  /** Free text: every word must be found. */
  query: string;
  hasKey: boolean;
  changed: boolean;
  onMenu: boolean;
}

export const NO_FILTER: TargetFilter = { query: '', hasKey: false, changed: false, onMenu: false };

export function isFiltering(filter: TargetFilter): boolean {
  return filter.query.trim() !== '' || filter.hasKey || filter.changed || filter.onMenu;
}

/** What the section knows about the actions, each derived once there. */
export interface TargetFacts {
  /** An action's effective chords (locked first): `Keymap.chords`. */
  chords: ReadonlyMap<ActionId, readonly string[]>;
  /** The device label of a chord (`Ctrl+Z`). */
  labelOf(chord: string): string;
  /** Actions whose keys differ from the defaults. */
  keysChanged: ReadonlySet<string>;
  /** Actions on the profile's quick menu. */
  onMenu: ReadonlySet<string>;
  /** Actions whose quick-menu choice differs from the default. */
  menuChanged: ReadonlySet<string>;
  /** Actions sharing a chord with another (`findConflicts`). */
  conflicts: ReadonlyMap<ActionId, ReadonlySet<ActionId>>;
}

export interface TargetRow {
  target: KeyTarget;
  /** The actions to list: all of them, or the ones the search and filters matched. */
  actions: readonly KeyActionDef[];
  /** Keys bound across the target's actions. */
  keys: number;
  /** How many of its actions are on the quick menu. */
  onMenu: number;
  changed: boolean;
  conflict: boolean;
  /** A folded setting's line while closed: "7 actions · 2 keys · 1 on the quick menu". */
  summary: string;
}

export interface TargetGroup {
  group: ActionGroup;
  label: string;
  rows: TargetRow[];
  /** Rows in the group, whatever the filter shows. */
  count: number;
  /** Rows with a changed key or quick-menu choice. */
  changed: number;
  conflict: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What is inside a folded setting, so nothing bound is invisible while it is closed. */
export function foldedSummary(actions: number, keys: number, onMenu: number): string {
  const parts = [plural(actions, 'action')];
  if (keys > 0) parts.push(plural(keys, 'key'));
  if (onMenu > 0) parts.push(`${onMenu} on the quick menu`);
  return parts.join(' · ');
}

function chordsOf(facts: TargetFacts, action: KeyActionDef): readonly string[] {
  return facts.chords.get(action.id as ActionId) ?? [];
}

/** The text a search looks in: label, setting, option, area and the bound keys' labels. */
function searchText(
  target: KeyTarget,
  action: KeyActionDef,
  groupLabel: string,
  facts: TargetFacts
): string {
  return [
    action.label,
    target.label,
    action.option ?? '',
    groupLabel,
    ...chordsOf(facts, action).map((chord) => facts.labelOf(chord))
  ]
    .join('\n')
    .toLowerCase();
}

/**
 * The section's groups for a filter, in the target list's order. Without a
 * filter every row is there with all its actions (the section decides what is
 * open). With one, a group holds only the rows with a matching action, and a
 * folded row only its matching actions; a group with none is left out.
 */
export function groupTargets(
  targets: readonly KeyTarget[],
  facts: TargetFacts,
  filter: TargetFilter = NO_FILTER
): TargetGroup[] {
  const filtering = isFiltering(filter);
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<ActionGroup, TargetGroup>();

  for (const target of targets) {
    let group = groups.get(target.group);
    if (!group) {
      group = {
        group: target.group,
        label: GROUP_LABELS[target.group],
        rows: [],
        count: 0,
        changed: 0,
        conflict: false
      };
      groups.set(target.group, group);
    }

    let keys = 0;
    let onMenu = 0;
    let changed = false;
    let conflict = false;
    for (const action of target.actions) {
      keys += chordsOf(facts, action).length;
      if (facts.onMenu.has(action.id)) onMenu++;
      if (facts.keysChanged.has(action.id) || facts.menuChanged.has(action.id)) changed = true;
      if ((facts.conflicts.get(action.id as ActionId)?.size ?? 0) > 0) conflict = true;
    }
    group.count++;
    if (changed) group.changed++;
    if (conflict) group.conflict = true;

    let actions = target.actions;
    if (filtering) {
      const label = group.label;
      actions = target.actions.filter((action) => {
        if (filter.hasKey && chordsOf(facts, action).length === 0) return false;
        if (
          filter.changed &&
          !facts.keysChanged.has(action.id) &&
          !facts.menuChanged.has(action.id)
        )
          return false;
        if (filter.onMenu && !facts.onMenu.has(action.id)) return false;
        if (words.length === 0) return true;
        const text = searchText(target, action, label, facts);
        return words.every((word) => text.includes(word));
      });
      if (actions.length === 0) continue;
    }

    group.rows.push({
      target,
      actions,
      keys,
      onMenu,
      changed,
      conflict,
      summary: target.folded ? foldedSummary(target.actions.length, keys, onMenu) : ''
    });
  }

  return GROUP_ORDER.flatMap((id) => {
    const group = groups.get(id);
    return group && group.rows.length > 0 ? [group] : [];
  });
}
