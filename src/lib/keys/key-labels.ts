/**
 * Per-device glyphs for layout-dependent keys. Bindings store positions
 * (`KeyQ`); the label says what this keyboard prints there. Never stored in
 * a profile — two devices of one user can have different layouts.
 *
 * Priority: the browser's layout map (`navigator.keyboard.getLayoutMap()`,
 * Chromium only) → a label learned when the user pressed that key in the
 * settings section (localStorage `keyLabels`) → the US name (`chord.ts`).
 */

import { writable } from 'svelte/store';
import { isLayoutKey } from './chord';

const STORAGE_KEY = 'keyLabels';

let layoutMap: Map<string, string> | null = null;
let learned: Record<string, string> = {};
let layoutRequested = false;

/** Bumps whenever a label source changes, so hint stores recompute. */
export const keyLabelsVersion = writable(0);

function bump() {
  keyLabelsVersion.update((n) => n + 1);
}

function readLearned(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [code, glyph] of Object.entries(parsed)) {
      if (typeof glyph === 'string' && glyph.length > 0 && glyph.length <= 4) out[code] = glyph;
    }
    return out;
  } catch {
    return {};
  }
}

function display(glyph: string): string {
  return glyph.length === 1 ? glyph.toUpperCase() : glyph;
}

/** The glyph this device prints for a layout key, if known. */
export function labelForCode(code: string): string | undefined {
  const glyph = layoutMap?.get(code) ?? learned[code];
  return glyph ? display(glyph) : undefined;
}

/**
 * Remember what a captured key prints (`e.key` with no modifiers held — a
 * shifted glyph would be the wrong label).
 */
export function learnLabel(
  e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>
) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (!e.code || !isLayoutKey(e.code)) return;
  if (e.key.length !== 1 || e.key === ' ') return;
  if (learned[e.code] === e.key) return;
  learned = { ...learned, [e.code]: e.key };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(learned));
  } catch {
    // Private mode or blocked storage: the label lives for this session.
  }
  bump();
}

interface KeyboardWithLayoutMap {
  getLayoutMap?: () => Promise<Iterable<[string, string]>>;
}

/** Load the label sources once (browser only; safe to call repeatedly). */
export function initKeyLabels(): void {
  if (layoutRequested || typeof window === 'undefined') return;
  layoutRequested = true;
  learned = readLearned();
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardWithLayoutMap }).keyboard;
  keyboard
    ?.getLayoutMap?.()
    .then((map) => {
      layoutMap = new Map(map);
      bump();
    })
    .catch(() => {
      // Not allowed here (iframe, permissions policy): learned/US labels.
    });
  if (Object.keys(learned).length > 0) bump();
}

/** Apple platforms label Meta as Cmd and Alt as Option. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}
