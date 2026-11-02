/**
 * The root `positions.json`: the newest reading position of every volume read
 * in the last 30 days, at a FIXED address.
 *
 * It exists for the device swap. The reading history knows every page turn,
 * but its month files live under per-device paths only a listing can find, so
 * a device that was just picked up cannot learn where the user stopped without
 * the full (slow) listing. This file can be fetched by name, before the reader
 * picks its page.
 *
 * Not authoritative: the history events and `volume-data.json` still carry
 * every position, so a lost or corrupt copy loses nothing — the next write
 * heals it.
 *
 * PURE MODULE — no stores, no Dexie.
 */

import { FUTURE_TOLERANCE_MS, isRecord } from '$lib/metadata/sanitize';

export const POSITIONS_FILE_NAME = 'positions.json';

export const POSITIONS_FILE_VERSION = 1;

/** Entries older than this leave the file on every write. */
export const POSITION_WINDOW_MS = 30 * 86_400_000;

export interface PositionEntry {
  /** When the position was set, epoch ms — the merge key. */
  t: number;
  /** The page; 0 is a reset (an un-read or restart), never jumped to. */
  page: number;
  chars: number;
  /** The device that set it. */
  device: string;
}

export type PositionsMap = Record<string, PositionEntry>;

export interface PositionsFile {
  version: 1;
  positions: Record<string, [number, number, number, string]>;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseEntry(raw: unknown, now: number): PositionEntry | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [t, page, chars, device] = raw;
  if (!isCount(t) || !isCount(page) || !isCount(chars)) return null;
  if (typeof device !== 'string' || device === '') return null;
  // A fast-clock device's stamp would out-rank every real position for as
  // long as its clock runs ahead. Dropped, not clamped: a clamp re-dates it to
  // each reader's `now` and the bogus position wins anyway.
  if (t > now + FUTURE_TOLERANCE_MS) return null;
  return { t, page, chars, device };
}

/** Well-formed entries of a parsed file; anything else is `{}`. */
export function parsePositionsFile(raw: unknown, now: number): PositionsMap {
  if (!isRecord(raw) || raw.version !== POSITIONS_FILE_VERSION) return {};
  const positions = raw.positions;
  if (!isRecord(positions)) return {};
  const out: PositionsMap = {};
  for (const [volume, value] of Object.entries(positions)) {
    const entry = parseEntry(value, now);
    if (entry) out[volume] = entry;
  }
  return out;
}

/** Does `a` win over `b`? Newest `t`; a tie goes to the greater device id. */
function wins(a: PositionEntry, b: PositionEntry): boolean {
  return a.t !== b.t ? a.t > b.t : a.device > b.device;
}

/** Per volume, the newest entry. Order-independent. */
export function mergePositions(a: PositionsMap, b: PositionsMap): PositionsMap {
  const out: PositionsMap = { ...a };
  for (const [volume, entry] of Object.entries(b)) {
    const mine = out[volume];
    if (!mine || wins(entry, mine)) out[volume] = entry;
  }
  return out;
}

/** Drop entries older than the 30-day window. */
export function prunePositions(map: PositionsMap, now: number): PositionsMap {
  const cutoff = now - POSITION_WINDOW_MS;
  const out: PositionsMap = {};
  for (const [volume, entry] of Object.entries(map)) {
    if (entry.t >= cutoff) out[volume] = entry;
  }
  return out;
}

/** The wire form, volume keys sorted so equal maps give equal bytes. */
export function composePositionsFile(map: PositionsMap): PositionsFile {
  const positions: PositionsFile['positions'] = {};
  for (const volume of Object.keys(map).sort()) {
    const { t, page, chars, device } = map[volume];
    positions[volume] = [t, page, chars, device];
  }
  return { version: POSITIONS_FILE_VERSION, positions };
}

/**
 * A canonical string of the RAW `positions` object ('' when the file is absent
 * or unparseable), for the "does the cloud already say this?" check. Raw, not
 * parsed: a bogus or malformed entry the parser drops must still make the
 * cloud copy differ from its healed rewrite, or the file never heals.
 */
export function positionsContent(raw: unknown): string {
  if (!isRecord(raw) || !isRecord(raw.positions)) return '';
  const positions = raw.positions;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(positions).sort()) sorted[key] = positions[key];
  return JSON.stringify({ version: raw.version, positions: sorted });
}
