/**
 * The reader quick menu, as data (#55, spec 17.6 and 17.7): which actions are
 * on it for a profile, in what order, and what each entry shows.
 *
 * `Settings.quickMenu` is SPARSE, like `keyBindings`: an absent id means the
 * default (on for the default list, off for the rest), `true` = shown,
 * `false` = hidden. A write that equals the default deletes the entry, so a
 * changed default reaches everyone who has not chosen.
 *
 * Pure: `settings.ts` imports it for the shape check, so it holds no store
 * and no component. What the READER knows (the layout, edit mode, a second
 * page, a toggle's value) arrives as `QuickMenuState`.
 */
import { isLiveIn, type KeyActionDef, type KeyScope, type ReaderMode } from './actions';
import type { IconName } from './icon-names';

export type QuickMenuSelection = Record<string, boolean>;

/**
 * The default menu, TOP TO BOTTOM — the owner's list (the rows marked for
 * the menu), in the order of the eight buttons it replaces. The last two are
 * Next page and Previous page, as that list has them: live in EVERY layout,
 * so vertical scroll keeps its two page buttons. The physical pair (Page
 * left, Page right) is available and off. An entry's arrow is drawn the way
 * it turns (`PAGE_TURN_ICONS`), so in a right-to-left book the ← button
 * still turns toward the left (spec 17.7).
 *
 * After the #362 PR merges, its image-adjustment toggle joins this list.
 */
export const QUICK_MENU_DEFAULT: readonly string[] = [
  'reader.ocr-layers',
  'reader.edit-mode',
  'reader.anki-image',
  'reader.anki-image-2',
  'reader.fullscreen',
  'reader.zoom-fit',
  'reader.page-next',
  'reader.page-prev'
];

const DEFAULT_SET: ReadonlySet<string> = new Set(QUICK_MENU_DEFAULT);

/** The menu exists in the reader only, so only what can run there may be on it. */
const MENU_SCOPES: readonly KeyScope[] = ['reader', 'edit', 'app'];

/** May the action be put on the menu at all? Where this is false there is no switch. */
export function menuEligible(action: KeyActionDef): boolean {
  return action.menu !== 'never' && MENU_SCOPES.includes(action.scope);
}

/** Is the action on the profile's menu (in some layout)? */
export function isOnMenu(quickMenu: QuickMenuSelection | undefined, action: KeyActionDef): boolean {
  if (!menuEligible(action)) return false;
  const stored = quickMenu?.[action.id];
  return typeof stored === 'boolean' ? stored : DEFAULT_SET.has(action.id);
}

/** Does the profile's choice for the action differ from the default? */
export function isMenuChanged(
  quickMenu: QuickMenuSelection | undefined,
  action: KeyActionDef
): boolean {
  return menuEligible(action) && isOnMenu(quickMenu, action) !== DEFAULT_SET.has(action.id);
}

/**
 * The ids on the menu, top to bottom: the defaults in their order, then the
 * profile's additions in registry order (`actions` is the full list, in that
 * order — `Keymap.actions`), minus the ones switched off. An id that is
 * unknown, or whose action can never be on the menu, is ignored. With `mode`,
 * only what is live in that reader layout.
 */
export function quickMenuIds(
  quickMenu: QuickMenuSelection | undefined,
  actions: Iterable<KeyActionDef>,
  mode?: ReaderMode
): string[] {
  const byId = new Map<string, KeyActionDef>();
  for (const action of actions) byId.set(action.id, action);
  const shown = (action: KeyActionDef | undefined): action is KeyActionDef =>
    !!action && isOnMenu(quickMenu, action) && isLiveIn(action, mode);
  const ids: string[] = [];
  for (const id of QUICK_MENU_DEFAULT) if (shown(byId.get(id))) ids.push(id);
  for (const action of byId.values()) {
    if (!DEFAULT_SET.has(action.id) && shown(action)) ids.push(action.id);
  }
  return ids;
}

/**
 * Put `action` on the menu or take it off: a NEW sparse map, with the entry
 * deleted when the choice equals the default. Every other entry stays,
 * unknown ids included (they may be a newer client's).
 */
export function withQuickMenu(
  quickMenu: QuickMenuSelection | undefined,
  action: KeyActionDef,
  on: boolean
): QuickMenuSelection {
  const next: QuickMenuSelection = { ...(quickMenu ?? {}) };
  if (!menuEligible(action)) return next;
  if (on === DEFAULT_SET.has(action.id)) delete next[action.id];
  else next[action.id] = on;
  return next;
}

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

// ---------------------------------------------------------------------------
// What an entry shows
// ---------------------------------------------------------------------------

/** Hand-registered actions that share an icon with a neighbour. */
const HAND_BADGES: Readonly<Record<string, string>> = {
  'reader.ocr-layer': '›',
  'reader.ocr-layer-prev': '‹',
  'reader.ocr-layer-primary': 'P',
  'reader.zoom-in': '+',
  'reader.zoom-out': '−'
};

/**
 * The mark that tells apart actions sharing an icon: `+` `−` `0` for a
 * slider's three, `›` `‹` for Next and Previous, up to three letters of the
 * option for a "Set to". Undefined where the icon is enough.
 */
export function menuBadge(action: KeyActionDef): string | undefined {
  switch (action.setting?.op) {
    case 'up':
      return '+';
    case 'down':
      return '−';
    case 'reset':
      return '0';
    case 'next':
      return '›';
    case 'prev':
      return '‹';
    case 'to':
      return [...(action.option ?? action.setting.value ?? '').trim()].slice(0, 3).join('');
    default:
      return HAND_BADGES[action.id];
  }
}

/** Where the next page is on screen: the reading direction, or down the vertical strip. */
export type TurnDirection = 'right' | 'left' | 'down';

/**
 * Next page and Previous page as the menu draws them. The registry's icons
 * are the left-to-right pair; on the menu the arrow points where the page
 * actually goes, so nobody taps → and moves left. Only the glyph: the action,
 * its name and its row in the settings stay the same.
 */
const PAGE_TURN_ICONS: Readonly<Record<string, Readonly<Record<TurnDirection, IconName>>>> = {
  'reader.page-next': {
    right: 'ArrowRightOutline',
    left: 'ArrowLeftOutline',
    down: 'ArrowDownOutline'
  },
  'reader.page-prev': {
    right: 'ArrowLeftOutline',
    left: 'ArrowRightOutline',
    down: 'ArrowUpOutline'
  }
};

/** What the reader knows that decides how an entry shows. */
export interface QuickMenuState {
  mode: ReaderMode;
  /** Where "Next page" goes on screen in this layout and this book. */
  forward: TurnDirection;
  /** OCR edit mode is on. */
  editing: boolean;
  ankiEnabled: boolean;
  /** A second page is on screen: "Add image 2 to Anki" has something to add. */
  hasSecondPage: boolean;
  /** The volume has OCR layers beside its primary. */
  hasLayers: boolean;
  /** Why edit mode cannot be entered for a reason other than the layout. */
  editBlocked?: string;
  /** A toggle's state right now; undefined for an action that is not a toggle. */
  toggleOn(action: KeyActionDef): boolean | undefined;
}

export interface QuickMenuItem {
  id: string;
  /** The action's label: the button's title and aria-label. */
  label: string;
  icon: IconName;
  badge?: string;
  /** A toggle's state; undefined for an action that has none. */
  active?: boolean;
  /** Set when the button is disabled: why. */
  disabled?: string;
  /** A step (brightness up, zoom in): the menu stays open for the next tap. */
  keepOpen: boolean;
}

export const EDIT_PAGED_ONLY = 'Edit is available in paged mode only';
export const EDIT_MODE_ONLY = 'Only in edit mode';

const STEPS: ReadonlySet<string> = new Set(['reader.zoom-in', 'reader.zoom-out']);

/**
 * The menu's entries for `ids` (already filtered to the layout by
 * `quickMenuIds`), in that order. An entry with nothing to act on is LEFT
 * OUT — the Anki pair with AnkiConnect off, the second image with one page
 * on screen, the layer picker with no layers outside edit mode. One that
 * exists but cannot run now is disabled with its reason.
 */
export function quickMenuItems(
  ids: readonly string[],
  actions: ReadonlyMap<string, KeyActionDef>,
  state: QuickMenuState
): QuickMenuItem[] {
  const items: QuickMenuItem[] = [];
  for (const id of ids) {
    const action = actions.get(id);
    if (!action) continue;
    if (id === 'reader.anki-image' || id === 'reader.anki-image-2') {
      if (!state.ankiEnabled) continue;
      if (id === 'reader.anki-image-2' && !state.hasSecondPage) continue;
    }
    if (id === 'reader.ocr-layers' && !state.hasLayers && !state.editing) continue;

    const item: QuickMenuItem = {
      id,
      label: action.label,
      icon: PAGE_TURN_ICONS[id]?.[state.forward] ?? action.icon,
      keepOpen: action.setting?.op === 'up' || action.setting?.op === 'down' || STEPS.has(id)
    };

    // The Anki pair is numbered only while there are two pages to choose from.
    const badge =
      id === 'reader.anki-image'
        ? state.hasSecondPage
          ? '1'
          : undefined
        : id === 'reader.anki-image-2'
          ? '2'
          : menuBadge(action);
    if (badge) item.badge = badge;

    if (id === 'reader.edit-mode') {
      item.active = state.editing;
      if (state.mode !== 'paged') item.disabled = EDIT_PAGED_ONLY;
      else if (state.editBlocked) item.disabled = state.editBlocked;
    } else if (action.scope === 'edit') {
      if (!state.editing) item.disabled = EDIT_MODE_ONLY;
    }

    const on = state.toggleOn(action);
    if (on !== undefined) item.active = on;

    items.push(item);
  }
  return items;
}
