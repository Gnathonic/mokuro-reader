/**
 * Golden table: what every pre-#55 shortcut does under the default keymap
 * (`keyBindings: {}`), per context — and, in a second table, every
 * deliberate change at defaults (spec section 9). A failure here means a
 * user who never opened the shortcut settings sees different keys.
 */
import { describe, expect, it } from 'vitest';
import { KEY_ACTIONS, type ActionId, type KeyScope, type ReaderMode } from './actions';
import { compileKeymap } from './keymap';
import { dispatchKey, type KeyEventLike } from './dispatch';

type Ctx = 'paged' | 'vertical' | 'horizontal' | 'edit' | 'series-card' | 'volume' | 'app';

const CONTEXTS: Record<Ctx, { scopes: KeyScope[]; mode?: ReaderMode }> = {
  paged: { scopes: ['reader', 'app'], mode: 'paged' },
  vertical: { scopes: ['reader', 'app'], mode: 'vertical' },
  horizontal: { scopes: ['reader', 'app'], mode: 'horizontal' },
  edit: { scopes: ['edit', 'reader', 'app'], mode: 'paged' },
  'series-card': { scopes: ['library.series'] },
  volume: { scopes: ['library.volume'] },
  app: { scopes: ['app'] }
};

interface Press {
  code: string;
  key?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  repeat?: boolean;
}

function event(p: Press): KeyEventLike & { prevented: boolean } {
  const e = {
    code: p.code,
    key: p.key ?? p.code,
    ctrlKey: !!p.ctrl,
    altKey: !!p.alt,
    shiftKey: !!p.shift,
    metaKey: !!p.meta,
    isComposing: false,
    keyCode: 0,
    repeat: !!p.repeat,
    defaultPrevented: false,
    prevented: false,
    preventDefault() {
      e.prevented = true;
    }
  };
  return e;
}

const keymap = compileKeymap({});

/** Every action has a handler that accepts — edit.delete's "has a selection" included. */
const accepting = Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, () => true])) as Record<
  ActionId,
  () => boolean
>;

function resolve(ctx: Ctx, p: Press): ActionId | null {
  return dispatchKey(event(p), CONTEXTS[ctx], accepting, keymap);
}

// [context, press, action]: today's inventory, unchanged.
const GOLDEN: [Ctx, Press, ActionId][] = [
  // Paged
  ['paged', { code: 'ArrowLeft' }, 'reader.page-left'],
  ['paged', { code: 'ArrowRight' }, 'reader.page-right'],
  ['paged', { code: 'ArrowUp' }, 'reader.scroll-up'],
  ['paged', { code: 'ArrowDown' }, 'reader.scroll-down'],
  ['paged', { code: 'PageUp' }, 'reader.page-prev'],
  ['paged', { code: 'PageDown' }, 'reader.page-next'],
  ['paged', { code: 'Space', key: ' ' }, 'reader.page-next'],
  ['paged', { code: 'Home' }, 'reader.page-first'],
  ['paged', { code: 'End' }, 'reader.page-last'],
  ['paged', { code: 'KeyF', key: 'f' }, 'reader.fullscreen'],
  ['paged', { code: 'KeyZ', key: 'z' }, 'reader.zoom-mode'],
  ['paged', { code: 'KeyP', key: 'p' }, 'reader.page-mode'],
  ['paged', { code: 'KeyV', key: 'v' }, 'reader.continuous'],
  ['paged', { code: 'KeyO', key: 'o' }, 'reader.offset-spreads'],
  ['paged', { code: 'KeyC', key: 'c' }, 'reader.cover'],
  ['paged', { code: 'KeyT', key: 't' }, 'reader.ocr-always'],
  ['paged', { code: 'KeyL', key: 'l' }, 'reader.ocr-layer'],
  ['paged', { code: 'KeyE', key: 'e' }, 'reader.edit-mode'],
  ['paged', { code: 'KeyI', key: 'i' }, 'reader.invert'],
  ['paged', { code: 'KeyN', key: 'n' }, 'reader.night'],
  ['paged', { code: 'KeyG', key: 'g' }, 'reader.grayscale'],
  ['paged', { code: 'Escape' }, 'app.back'],
  // Vertical continuous: ← → scroll sideways, the rest pages/scrolls.
  ['vertical', { code: 'ArrowLeft' }, 'reader.scroll-left'],
  ['vertical', { code: 'ArrowRight' }, 'reader.scroll-right'],
  ['vertical', { code: 'ArrowUp' }, 'reader.scroll-up'],
  ['vertical', { code: 'ArrowDown' }, 'reader.scroll-down'],
  ['vertical', { code: 'PageUp' }, 'reader.page-prev'],
  ['vertical', { code: 'PageDown' }, 'reader.page-next'],
  ['vertical', { code: 'Space', key: ' ' }, 'reader.page-next'],
  ['vertical', { code: 'Home' }, 'reader.page-first'],
  ['vertical', { code: 'End' }, 'reader.page-last'],
  ['vertical', { code: 'KeyM', key: 'm' }, 'reader.dividers'],
  ['vertical', { code: 'KeyF', key: 'f' }, 'reader.fullscreen'],
  ['vertical', { code: 'Escape' }, 'app.back'],
  // Horizontal continuous
  ['horizontal', { code: 'ArrowLeft' }, 'reader.page-left'],
  ['horizontal', { code: 'ArrowRight' }, 'reader.page-right'],
  ['horizontal', { code: 'ArrowUp' }, 'reader.scroll-up'],
  ['horizontal', { code: 'ArrowDown' }, 'reader.scroll-down'],
  ['horizontal', { code: 'PageUp' }, 'reader.page-prev'],
  ['horizontal', { code: 'PageDown' }, 'reader.page-next'],
  ['horizontal', { code: 'Space', key: ' ' }, 'reader.page-next'],
  ['horizontal', { code: 'Home' }, 'reader.page-first'],
  ['horizontal', { code: 'End' }, 'reader.page-last'],
  ['horizontal', { code: 'KeyM', key: 'm' }, 'reader.dividers'],
  // Edit mode (paged): its own keys first, reader keys underneath.
  ['edit', { code: 'KeyZ', key: 'z', ctrl: true }, 'edit.undo'],
  ['edit', { code: 'KeyZ', key: 'z', meta: true }, 'edit.undo'],
  ['edit', { code: 'KeyZ', key: 'Z', ctrl: true, shift: true }, 'edit.redo'],
  ['edit', { code: 'KeyZ', key: 'Z', meta: true, shift: true }, 'edit.redo'],
  ['edit', { code: 'KeyY', key: 'y', ctrl: true }, 'edit.redo'],
  ['edit', { code: 'KeyY', key: 'y', meta: true }, 'edit.redo'],
  ['edit', { code: 'Delete' }, 'edit.delete'],
  ['edit', { code: 'Backspace' }, 'edit.delete'],
  ['edit', { code: 'Escape' }, 'edit.back'],
  ['edit', { code: 'ArrowLeft' }, 'reader.page-left'],
  ['edit', { code: 'KeyE', key: 'e' }, 'reader.edit-mode'],
  ['edit', { code: 'KeyL', key: 'l' }, 'reader.ocr-layer'],
  // Library
  ['series-card', { code: 'KeyE', key: 'e' }, 'library.series-edit'],
  ['series-card', { code: 'Delete' }, 'library.series-remove'],
  ['volume', { code: 'KeyE', key: 'e' }, 'library.volume-edit'],
  ['volume', { code: 'KeyC', key: 'c' }, 'library.volume-cover'],
  ['volume', { code: 'Delete' }, 'library.volume-remove'],
  ['volume', { code: 'Delete', shift: true }, 'library.volume-delete-cloud'],
  // Everywhere else
  ['app', { code: 'Escape' }, 'app.back']
];

describe('defaults are today’s keys', () => {
  it.each(GOLDEN)('%s: %o → %s', (ctx, press, action) => {
    expect(resolve(ctx, press)).toBe(action);
  });

  it('M does nothing in paged mode (dividers are a continuous setting)', () => {
    expect(resolve('paged', { code: 'KeyM', key: 'm' })).toBeNull();
  });

  it('Numpad keys with NumLock off still navigate (the scroll readers matched e.key)', () => {
    expect(resolve('vertical', { code: 'Numpad3', key: 'PageDown' })).toBe('reader.page-next');
    expect(resolve('paged', { code: 'Numpad4', key: 'ArrowLeft' })).toBe('reader.page-left');
  });

  it('edit.delete without a selection falls through to the reader scope', () => {
    const map = compileKeymap({ 'reader.night': ['Delete'] });
    const handlers = { ...accepting, 'edit.delete': () => false };
    expect(dispatchKey(event({ code: 'Delete' }), CONTEXTS.edit, handlers, map)).toBe(
      'reader.night'
    );
  });
});

// [context, press, result now, what it did before] — spec section 9.
const CHANGED: [Ctx, Press, ActionId | null, string][] = [
  ['paged', { code: 'Space', key: ' ', shift: true }, null, '§9.1 Shift+Space turned forward'],
  ['paged', { code: 'PageDown', ctrl: true }, null, '§9.1 Ctrl+PageDown turned forward'],
  ['paged', { code: 'PageUp', alt: true }, null, '§9.1 Alt+PageUp turned back'],
  ['paged', { code: 'Escape', shift: true }, null, '§9.1 Shift+Escape left the reader'],
  ['vertical', { code: 'ArrowDown', shift: true }, null, '§9.2 Shift+↓ scrolled'],
  ['vertical', { code: 'ArrowLeft', alt: true }, null, '§9.2 Alt+← scrolled (browser back now)'],
  ['horizontal', { code: 'ArrowRight', ctrl: true }, null, '§9.2 Ctrl+→ paged'],
  ['vertical', { code: 'Space', key: ' ', shift: true }, null, '§9.2 Shift+Space paged'],
  ['edit', { code: 'KeyZ', ctrl: true, alt: true }, null, '§9.3 Ctrl+Alt+Z undid'],
  ['edit', { code: 'Delete', shift: true }, null, '§9.3 Shift+Delete deleted boxes'],
  ['edit', { code: 'KeyY', ctrl: true, shift: true }, null, '§9.3 Ctrl+Shift+Y redid'],
  ['volume', { code: 'KeyC', key: 'c', ctrl: true }, null, '§9.4 Ctrl+C opened the cover picker'],
  ['volume', { code: 'KeyE', key: 'e', meta: true }, null, '§9.4 Cmd+E opened the editor'],
  ['volume', { code: 'KeyE', key: 'e', alt: true }, null, '§9.4 Alt+E opened the editor'],
  ['series-card', { code: 'KeyE', key: 'E' }, 'library.series-edit', '§9.5 CapsLock+E did not'],
  ['series-card', { code: 'KeyE', key: '.' }, 'library.series-edit', '§9.5 Dvorak: by position']
];

describe('section 9: deliberate changes at defaults', () => {
  it.each(CHANGED)('%s %o → %s (%s)', (ctx, press, now) => {
    expect(resolve(ctx, press)).toBe(now);
  });

  it('§9.6 toggles, Back and library actions ignore auto-repeat; page turns repeat', () => {
    const fired: ActionId[] = [];
    const recording = Object.fromEntries(
      KEY_ACTIONS.map((a) => [a.id, () => void fired.push(a.id)])
    ) as Record<ActionId, () => void>;
    for (const [ctx, code] of [
      ['paged', 'KeyF'],
      ['paged', 'Escape'],
      ['app', 'Escape'],
      ['volume', 'Delete'],
      ['paged', 'Home']
    ] as [Ctx, string][]) {
      const e = event({ code, repeat: true });
      dispatchKey(e, CONTEXTS[ctx], recording, keymap);
      expect(e.prevented, `${ctx} ${code}: a swallowed repeat still prevents the default`).toBe(
        true
      );
    }
    expect(fired).toEqual([]);
    dispatchKey(event({ code: 'ArrowLeft', repeat: true }), CONTEXTS.paged, recording, keymap);
    dispatchKey(event({ code: 'Space', repeat: true }), CONTEXTS.vertical, recording, keymap);
    expect(fired).toEqual(['reader.page-left', 'reader.page-next']);
  });

  it('§9.9 a key an extension already handled is left alone', () => {
    const e = { ...event({ code: 'ArrowLeft' }), defaultPrevented: true };
    expect(dispatchKey(e, CONTEXTS.paged, accepting, keymap)).toBeNull();
  });
});
