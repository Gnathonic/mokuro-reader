/**
 * Chords: one string per key combination — modifiers in a fixed order, then
 * the key: `Ctrl+Alt+Shift+Meta+<code>` (`KeyA`, `Shift+Space`,
 * `Ctrl+Shift+KeyZ`, `ArrowLeft`).
 *
 * - **Position, not character.** The key is `KeyboardEvent.code`, so a
 *   Russian or kana layout still triggers letter shortcuts and WASD stays
 *   where the fingers are on AZERTY. An empty `code` falls back to `e.key`;
 *   a Numpad key with NumLock off (`Numpad4` + `key: 'ArrowLeft'`) counts as
 *   the navigation key it sends.
 * - **Exact modifiers.** A chord carries every modifier that was held, and a
 *   binding matches only the identical string: `KeyA` never fires on Shift+A.
 * - Labels are per device and never stored (`formatChord`, `key-labels.ts`).
 */

export const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
export type Modifier = (typeof MODIFIERS)[number];

export interface ParsedChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** A `KeyboardEvent.code`-style key name. */
  key: string;
}

/** `e.code` / `e.key` values of the modifier keys themselves. */
const MODIFIER_KEYS = new Set([
  'Shift',
  'ShiftLeft',
  'ShiftRight',
  'Control',
  'ControlLeft',
  'ControlRight',
  'Alt',
  'AltLeft',
  'AltRight',
  'AltGraph',
  'Meta',
  'MetaLeft',
  'MetaRight',
  'OS',
  'OSLeft',
  'OSRight',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'Symbol',
  'SymbolLock'
]);

/** Keys a Numpad sends with NumLock off — matched as the key they send. */
const NUMPAD_NAV_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Delete'
]);

/** US-layout punctuation → its `code`, for events without one. */
const PUNCTUATION_CODES: Record<string, string> = {
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote'
};

/** Legacy `e.key` names (old Edge/IE) → standard ones. */
const LEGACY_KEYS: Record<string, string> = {
  Esc: 'Escape',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Del: 'Delete',
  Spacebar: 'Space'
};

type KeyLike = Pick<
  KeyboardEvent,
  'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing' | 'keyCode'
>;

/** Is this the press of a modifier key on its own (Shift, Ctrl, …)? */
export function isModifierKey(e: Pick<KeyboardEvent, 'code' | 'key'>): boolean {
  return MODIFIER_KEYS.has(e.code) || MODIFIER_KEYS.has(e.key);
}

function codeFromKey(rawKey: string | undefined): string | null {
  if (!rawKey || rawKey === 'Unidentified' || rawKey === 'Dead' || rawKey === 'Process') {
    return null;
  }
  const key = LEGACY_KEYS[rawKey] ?? rawKey;
  if (key === ' ') return 'Space';
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (PUNCTUATION_CODES[key]) return PUNCTUATION_CODES[key];
  // A named key (ArrowLeft, F5, Enter…). A lone glyph of another layout has
  // no position to bind to.
  if (/^[A-Za-z][A-Za-z0-9]+$/.test(key)) return key;
  return null;
}

/** The key part of a chord for this event (no modifiers). */
export function keyFromEvent(e: Pick<KeyboardEvent, 'code' | 'key'>): string | null {
  const code = e.code;
  if (code && code.startsWith('Numpad') && NUMPAD_NAV_KEYS.has(e.key)) return e.key;
  if (code && code !== 'Unidentified') return code;
  return codeFromKey(e.key);
}

/**
 * The chord an event makes, or null when the event must never match a
 * binding: a bare modifier press, or IME composition (`isComposing`, or the
 * 229 keyCode some browsers send for the composition's first key).
 */
export function chordFromEvent(e: KeyLike): string | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (isModifierKey(e)) return null;
  const key = keyFromEvent(e);
  if (!key) return null;
  return buildChord({
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
    key
  });
}

export function buildChord(c: ParsedChord): string {
  let s = '';
  if (c.ctrl) s += 'Ctrl+';
  if (c.alt) s += 'Alt+';
  if (c.shift) s += 'Shift+';
  if (c.meta) s += 'Meta+';
  return s + c.key;
}

/**
 * Parse a stored chord. Modifiers may come in any order (a hand-edited file);
 * duplicates, unknown modifiers, a modifier as the key or an empty key make
 * it unparseable (null), which the keymap ignores without deleting it.
 */
export function parseChord(chord: unknown): ParsedChord | null {
  if (typeof chord !== 'string' || chord.length === 0 || chord.length > 40) return null;
  const parts = chord.split('+');
  const key = parts.pop()!;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || MODIFIER_KEYS.has(key)) return null;
  const parsed: ParsedChord = { ctrl: false, alt: false, shift: false, meta: false, key };
  for (const part of parts) {
    const flag = ({ Ctrl: 'ctrl', Alt: 'alt', Shift: 'shift', Meta: 'meta' } as const)[
      part as Modifier
    ];
    if (!flag || parsed[flag]) return null;
    parsed[flag] = true;
  }
  return parsed;
}

/** The canonical spelling of a chord, or null when it cannot be parsed. */
export function normalizeChord(chord: unknown): string | null {
  const parsed = parseChord(chord);
  return parsed ? buildChord(parsed) : null;
}

/** Does the chord carry Shift or Alt — the keys pop-up dictionaries scan with? */
export function usesScanModifier(chord: string): boolean {
  const p = parseChord(chord);
  return !!p && (p.shift || p.alt);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const NAMED_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: 'Space',
  Escape: 'Esc',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Home: 'Home',
  End: 'End',
  Insert: 'Ins',
  Tab: 'Tab',
  ContextMenu: 'Menu',
  IntlBackslash: '\\',
  IntlRo: 'ろ',
  IntlYen: '¥'
};

const PUNCTUATION_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(PUNCTUATION_CODES).map(([glyph, code]) => [code, glyph])
);

/**
 * The US-layout label for a key code — the fallback when neither the
 * browser's layout map nor a learned label knows better.
 */
export function usKeyLabel(code: string): string {
  if (NAMED_LABELS[code]) return NAMED_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (PUNCTUATION_LABELS[code]) return PUNCTUATION_LABELS[code];
  if (/^Numpad/.test(code)) {
    const rest = code.slice(6);
    const ops: Record<string, string> = {
      Add: '+',
      Subtract: '-',
      Multiply: '*',
      Divide: '/',
      Decimal: '.'
    };
    return `Num ${ops[rest] ?? rest}`;
  }
  return code;
}

/** Is this a key whose glyph depends on the keyboard layout? */
export function isLayoutKey(code: string): boolean {
  return (
    /^Key[A-Z]$/.test(code) ||
    /^Digit[0-9]$/.test(code) ||
    code in PUNCTUATION_LABELS ||
    code.startsWith('Intl')
  );
}

export interface FormatOptions {
  /** Apple platforms say Cmd/Option for Meta/Alt. */
  apple?: boolean;
  /** Per-device glyph for a layout key (`key-labels.ts`); undefined = US. */
  labelFor?: (code: string) => string | undefined;
}

/** A human label for a chord: `Ctrl+Shift+Z`, `←`, `Cmd+Y`. */
export function formatChord(chord: string, opts: FormatOptions = {}): string {
  const p = parseChord(chord);
  if (!p) return chord;
  const mods: string[] = [];
  if (p.ctrl) mods.push('Ctrl');
  if (p.alt) mods.push(opts.apple ? 'Option' : 'Alt');
  if (p.shift) mods.push('Shift');
  if (p.meta) mods.push(opts.apple ? 'Cmd' : 'Meta');
  const glyph = (isLayoutKey(p.key) && opts.labelFor?.(p.key)) || usKeyLabel(p.key);
  return [...mods, glyph].join('+');
}
