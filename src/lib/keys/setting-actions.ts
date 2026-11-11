/**
 * The ONE handler for every action generated from a setting definition (#55,
 * spec 17.2): read the definition, compute the next value, write it, announce
 * it ("Brightness: 110%", "Paged zoom: Fit to width", "Bold font: On"). No
 * listener site has a per-setting handler; the settings UI's cycle buttons
 * call `applySettingOp` too, so a button and a key walk the same order.
 */
import { get } from 'svelte/store';
import {
  findSettingDef,
  resolveOptions,
  type SettingCtx,
  type SettingDef,
  type SettingDefId
} from '$lib/settings/setting-defs';
import { isWithinSchedule, settings, updateScheduleSetting } from '$lib/settings/settings';
import type { KeyActionDef, SettingOp } from './actions';
import { announce, type AnnounceAction } from './announce';

export type SettingOpResult =
  /** Not this action's to take (no volume open, a retired definition): the key falls through. */
  | { done: false }
  /** Handled. `changed` is false when a guard answered instead of a write. */
  | { done: true; changed: boolean; message: string; key: string; action?: AnnounceAction };

const DECLINED: SettingOpResult = { done: false };

function onOff(value: unknown): string {
  return value ? 'On' : 'Off';
}

function withNote(def: SettingDef, ctx: SettingCtx, text: string): string {
  const note = def.note?.(ctx);
  return note ? `${text} (${note})` : text;
}

/** "Set to manual": the schedule goes off and what is on screen stays. */
function setManual(def: Extract<SettingDef, { kind: 'toggle' }>, ctx: SettingCtx) {
  const key = def.schedule;
  if (!key) return;
  const shown = isWithinSchedule(get(settings)[key]);
  updateScheduleSetting(key, 'enabled', false);
  def.write(ctx, shown);
  announce(`${def.label}: ${onOff(shown)} (manual)`, `set-${def.id}`);
}

/**
 * Apply `op` to a definition and say what happened. Pure of feedback: the
 * caller announces (`runSettingAction`) or does not (a settings-page button).
 */
export function applySettingOp(
  def: SettingDef,
  op: SettingOp,
  ctx: SettingCtx = {},
  value?: string
): SettingOpResult {
  if (def.available && !def.available(ctx)) return DECLINED;
  const key = `set-${def.id}`;
  const done = (text: string): SettingOpResult => ({
    done: true,
    changed: true,
    message: withNote(def, ctx, `${def.label}: ${text}`),
    key
  });

  switch (def.kind) {
    case 'toggle': {
      if (op !== 'toggle') return DECLINED;
      // The schedule owns the filter: change nothing, say so, offer the way out.
      if (def.schedule && get(settings)?.[def.schedule]?.enabled) {
        return {
          done: true,
          changed: false,
          message: `${def.scheduleName ?? def.label} is on automatic schedule`,
          key: `${key}-scheduled`,
          action: { label: 'Set to manual', run: () => setManual(def, ctx) }
        };
      }
      const next = !def.read(ctx);
      def.write(ctx, next);
      return done(onOff(next));
    }
    case 'list': {
      const options = resolveOptions(def, ctx);
      if (options.length === 0) return DECLINED;
      let target: (typeof options)[number] | undefined;
      if (op === 'to') {
        target = options.find((o) => o.value === value);
      } else if (op === 'next' || op === 'prev') {
        const at = options.findIndex((o) => o.value === String(def.read(ctx)));
        const last = options.length - 1;
        const wrap = def.wrap !== false;
        let index: number;
        // A stored value that is not an option: Next starts at the first, Previous at the last.
        if (at < 0) index = op === 'next' ? 0 : last;
        else if (op === 'next') index = at < last ? at + 1 : wrap ? 0 : last;
        else index = at > 0 ? at - 1 : wrap ? last : 0;
        target = options[index];
      }
      if (!target) return DECLINED;
      def.write(ctx, target.value);
      return done(target.name);
    }
    case 'slider': {
      const current = Number(def.read(ctx));
      const from = Number.isFinite(current) ? current : def.reset;
      let next: number;
      if (op === 'up') next = from + def.step;
      else if (op === 'down') next = from - def.step;
      else if (op === 'reset') next = def.reset;
      else return DECLINED;
      next = Math.min(def.max, Math.max(def.min, next));
      def.write(ctx, next);
      return done(def.format(next));
    }
  }
}

/**
 * A generated TOGGLE's state as the reader shows it — for the quick menu's
 * pressed look. A scheduled filter shows what its schedule has on screen.
 * Undefined for anything that is not a toggle, or has nothing to act on.
 */
export function settingToggleOn(action: KeyActionDef, ctx: SettingCtx = {}): boolean | undefined {
  if (action.setting?.op !== 'toggle') return undefined;
  const def = findSettingDef(action.setting.def);
  if (!def || def.kind !== 'toggle') return undefined;
  if (def.available && !def.available(ctx)) return undefined;
  const schedule = def.schedule ? get(settings)?.[def.schedule] : undefined;
  if (schedule?.enabled) return isWithinSchedule(schedule);
  return !!def.read(ctx);
}

/** A settings-page button: step a setting the way its key would, without the announcement. */
export function stepSetting(id: SettingDefId, op: 'next' | 'prev', ctx: SettingCtx = {}): void {
  const def = findSettingDef(id);
  if (def) applySettingOp(def, op, ctx);
}

/**
 * Run a generated action: apply it and announce the result. Returns false
 * when the action declined, so `dispatchKey` lets the key fall through.
 */
export function runSettingAction(action: KeyActionDef, ctx: SettingCtx = {}): boolean {
  const link = action.setting;
  if (!link) return false;
  const def = findSettingDef(link.def);
  if (!def) return false;
  const result = applySettingOp(def, link.op, ctx, link.value);
  if (!result.done) return false;
  announce(result.message, result.key, result.action);
  return true;
}
