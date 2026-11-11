/**
 * The FULL action list (#55): the hand-registered tuple (`actions.ts`), then
 * the actions generated from the setting definitions, then one "Set to" per
 * profile. Kept apart from `actions.ts` and `keymap.ts`, which the settings
 * store imports and which therefore cannot import the definitions.
 *
 * The list is not a constant — the profile list changes it — so nothing
 * resolves an id against a module-level table: a compiled keymap carries the
 * list it was built from (`Keymap.actions`).
 */
import { SETTING_DEFS, type SettingDef } from '$lib/settings/setting-defs';
import { KEY_ACTIONS, type ActionId, type KeyActionDef } from './actions';
import { actionsForSetting } from './generate';

const DEFS = SETTING_DEFS as readonly SettingDef[];
const isDynamic = (def: SettingDef) => def.kind === 'list' && typeof def.options === 'function';

/** Generated once: every definition whose option list is a constant. */
const CONSTANT_GENERATED = new Map<string, KeyActionDef[]>(
  DEFS.filter((def) => !isDynamic(def)).map((def) => [def.id, actionsForSetting(def)])
);

/**
 * Every action, in registry order, as of now. Call it again when the set of
 * profile names changes (`live.ts` does); everything else in it is constant.
 */
export function allActions(): KeyActionDef[] {
  return [
    ...(KEY_ACTIONS as readonly KeyActionDef[]),
    ...DEFS.flatMap((def) => CONSTANT_GENERATED.get(def.id) ?? actionsForSetting(def))
  ];
}

/** The definition of an action that exists right now. Throws on an unknown id. */
export function actionDef(id: ActionId): KeyActionDef {
  const found = allActions().find((a) => a.id === id);
  if (!found) throw new Error(`Unknown key action: ${id}`);
  return found;
}
