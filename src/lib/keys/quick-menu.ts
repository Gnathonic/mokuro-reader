/**
 * The reader quick menu's per-profile selection (#55, spec 17.6).
 *
 * `Settings.quickMenu` is SPARSE, like `keyBindings`: an absent id means the
 * default (on for the default list, off for the rest), `true` = shown,
 * `false` = hidden. A write that equals the default deletes the entry, so a
 * changed default reaches everyone who has not chosen.
 *
 * Pure: `settings.ts` imports it for the shape check.
 */

export type QuickMenuSelection = Record<string, boolean>;

/**
 * Shape check for a synced or hand-edited `quickMenu` (`migrateProfiles`): a
 * non-object becomes `{}`, a non-boolean entry is dropped. Unknown ids are
 * KEPT — they may be a newer client's — and an id whose action can never be
 * on the menu is ignored when the menu is built, not here.
 */
export function sanitizeQuickMenu(value: unknown): QuickMenuSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: QuickMenuSelection = {};
  for (const [id, on] of Object.entries(value as Record<string, unknown>)) {
    if (typeof on === 'boolean') out[id] = on;
  }
  return out;
}
