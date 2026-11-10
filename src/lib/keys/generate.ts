/**
 * Setting definitions → key actions (#55, spec 17.2 and 17.3).
 *
 * | Setting kind | Actions                                   | Repeat      |
 * | ------------ | ----------------------------------------- | ----------- |
 * | toggle       | Toggle                                    | no          |
 * | list         | Next, Previous, one "Set to X" per option | no          |
 * | slider       | Step up, Step down, Reset                 | up and down |
 *
 * Ids: `set.<def>.toggle | .next | .prev | .to.<stored value> | .up | .down |
 * .reset`. Everything after `.to.` is the option, so a profile name with dots
 * or spaces parses. A toggle that predates the definitions keeps its old id
 * and default key (`PINNED_ACTIONS`); every NEW action ships unbound.
 *
 * Nothing here handles a key: `setting-actions.ts` is the one handler.
 */
import { PINNED_ACTIONS, type KeyActionDef, type SettingOp } from './actions';
import {
  resolveOptions,
  type SettingCtx,
  type SettingDef,
  type SettingOptions
} from '$lib/settings/setting-defs';

export const SETTING_ID_PREFIX = 'set.';

/** The id of the action that applies `op` to the definition `def`. */
export function settingActionId(def: SettingDef, op: SettingOp, value?: string): string {
  if (op === 'toggle' && def.kind === 'toggle' && def.actionId) return def.actionId;
  const base = `${SETTING_ID_PREFIX}${def.id}.${op}`;
  return op === 'to' ? `${base}.${value}` : base;
}

/**
 * Read a generated id back: `set.profile.to.My.Profile` → def `profile`, op
 * `to`, value `My.Profile`. Null for anything else (a pinned id has no
 * `set.` form; its action carries the link in `setting`).
 */
export function parseSettingActionId(
  id: string
): { def: string; op: SettingOp; value?: string } | null {
  if (!id.startsWith(SETTING_ID_PREFIX)) return null;
  const rest = id.slice(SETTING_ID_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const def = rest.slice(0, dot);
  const tail = rest.slice(dot + 1);
  if (tail.startsWith('to.')) {
    const value = tail.slice(3);
    return value ? { def, op: 'to', value } : null;
  }
  if (['toggle', 'next', 'prev', 'up', 'down', 'reset'].includes(tail)) {
    return { def, op: tail as SettingOp };
  }
  return null;
}

function action(
  def: SettingDef,
  op: SettingOp,
  over: { label: string; description: string; repeat?: boolean; value?: string; option?: string }
): KeyActionDef {
  return {
    id: settingActionId(def, op, over.value),
    label: over.label,
    description: over.description,
    group: def.group,
    scope: def.scope,
    ...(def.modes ? { modes: def.modes } : {}),
    defaults: [],
    repeat: over.repeat ?? false,
    icon: def.icon,
    menu: def.menu,
    setting: { def: def.id, op, ...(over.value !== undefined ? { value: over.value } : {}) },
    ...(over.option !== undefined ? { option: over.option } : {}),
    ...(def.kind === 'toggle' ? {} : { parent: def.id })
  };
}

/** One "Set to" action per option. */
function setToActions(def: SettingDef, options: SettingOptions): KeyActionDef[] {
  return options.map((option) =>
    action(def, 'to', {
      value: option.value,
      option: option.name,
      label: `${def.label}: Set to ${option.name}`,
      description: `Set ${def.label} to ${option.name}.`
    })
  );
}

/** The actions of one definition, in the order the settings section lists them. */
export function actionsForSetting(def: SettingDef, ctx: SettingCtx = {}): KeyActionDef[] {
  const about = def.description ? `${def.description} ` : '';
  switch (def.kind) {
    case 'toggle': {
      const pinned = def.actionId ? PINNED_ACTIONS[def.actionId] : undefined;
      const base = action(def, 'toggle', {
        label: def.label,
        description: pinned?.description ?? def.description ?? `Turn ${def.label} on or off.`
      });
      return [pinned ? { ...base, defaults: pinned.defaults } : base];
    }
    case 'list':
      return [
        action(def, 'next', {
          label: `${def.label}: Next`,
          description: `${about}Step to the next option.`
        }),
        action(def, 'prev', {
          label: `${def.label}: Previous`,
          description: `${about}Step to the previous option.`
        }),
        ...setToActions(def, resolveOptions(def, ctx))
      ];
    case 'slider':
      return [
        action(def, 'up', {
          label: `${def.label}: Step up`,
          description: `${about}Up by ${def.format(def.step)}.`,
          repeat: true
        }),
        action(def, 'down', {
          label: `${def.label}: Step down`,
          description: `${about}Down by ${def.format(def.step)}.`,
          repeat: true
        }),
        action(def, 'reset', {
          label: `${def.label}: Reset`,
          description: `${about}Back to ${def.format(def.reset)}.`
        })
      ];
  }
}

/** Every action the definitions give, in definition order. */
export function generateSettingActions(
  defs: readonly SettingDef[],
  ctx: SettingCtx = {}
): KeyActionDef[] {
  return defs.flatMap((def) => actionsForSetting(def, ctx));
}
