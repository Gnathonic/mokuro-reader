/**
 * May this sync skip uploading `volume-data.json`? Only for a page turn made
 * while the user is still reading.
 *
 * Every page turn changes `progress`, `chars` and `lastProgressUpdate`. So
 * every progress sync during reading (at most one per 3 min, from the activity
 * tracker) re-uploaded the whole file. While the reader is open, the other
 * devices already get that position from `positions.json`, which costs one
 * small write per turn. Here the volume-data upload waits for the END of the
 * session instead. Leaving the reader or hiding the tab flushes a sync that is
 * not in a session, and that sync uploads. So does every sync outside a
 * session. The merge and the file format do not change.
 *
 * The upload is deferred only when ALL of these hold:
 * - **position-only**: every record that differs from the cloud copy (the
 *   survivor) differs only in `progress`, `chars` or `lastProgressUpdate` —
 *   what `positions.json` carries. The record exists on both sides, both
 *   sides have `progress > 0`, and the series and tracking sections are
 *   equal. A first read (0 → n), a reset to 0, a new or removed record, a
 *   tombstone, a title or settings edit, archived reads, a `completed` flip
 *   or a completion date all upload.
 * - **in session**: the reader is open and the document is visible.
 * - **covered**: history syncs here (`historySyncAllowed`), the provider is
 *   not read-only, `positions.json` may be written (`positionsWriteAllowed`),
 *   and the provider already holds this device's legacy turns
 *   (`legacyCarriedBy`; otherwise the file still carries turns). Each
 *   deferred volume's position must also be on its way through
 *   `positions.json`. Either this device marked it changed AT the record's
 *   stamp (the push sends exactly that), or the cloud `positions.json` entry
 *   is known to have `t >=` that stamp.
 *
 * PURE MODULE: no stores, no IO. The caller gathers the inputs.
 */

import type { ProviderStatus } from './provider-interface';
import { historySyncAllowed } from '$lib/reading-history/history-capability';
import { positionsWriteAllowed } from '$lib/positions/positions-capability';

/**
 * The record fields a page turn writes that `positions.json` carries to the
 * other devices. Only these may differ in a deferred upload. NOT `completed`,
 * though a turn into or out of the last-page window writes it: a positions
 * entry is `[t, page, chars, device]`, and a device adopting one keeps its
 * own flag for every volume it does not have open (`applyAdoptions`), so only
 * this file carries the flip.
 */
export const POSITION_FIELDS: readonly string[] = ['progress', 'chars', 'lastProgressUpdate'];

/**
 * Deep-sorts object keys before `JSON.stringify`, so two values that differ
 * only in key order compare equal.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    const out: Record<string, unknown> = {};
    for (const [key, v] of entries) out[key] = sortKeysDeep(v);
    return out;
  }
  return value;
}

/** A record as the file would hold it (`toJSON` applied), as plain JSON. */
function plain(record: unknown): Record<string, unknown> | null {
  if (record === undefined || record === null) return null;
  const json = JSON.parse(JSON.stringify(record)) as unknown;
  return json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : null;
}

function withoutPositionFields(record: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...record };
  for (const field of POSITION_FIELDS) delete rest[field];
  return rest;
}

function progressOf(record: Record<string, unknown>): number {
  const progress = Number(record.progress ?? 0);
  return Number.isFinite(progress) ? progress : 0;
}

function stampOf(record: Record<string, unknown>): number {
  const raw = record.lastProgressUpdate;
  if (typeof raw !== 'string' || !raw) return 0;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

/** One side of the comparison: the volume map, and the file's other sections. */
export interface VolumeDataSide {
  volumes: Readonly<Record<string, unknown>>;
  /** The series and tracking sections, as composed into the file (empty ones omitted). */
  sections: unknown;
}

export type VolumeDataDiff =
  | { kind: 'same' }
  /** Only page-turn fields of these existing, already-read records differ. */
  | { kind: 'position-only'; volumes: string[] }
  | { kind: 'other' };

/**
 * How does the next file differ from the cloud (survivor) copy? Compares
 * plain JSON with sorted keys, the same comparison the upload decision makes.
 */
export function classifyVolumeDataDiff(
  next: VolumeDataSide,
  cloud: VolumeDataSide
): VolumeDataDiff {
  if (stableStringify(next.sections) !== stableStringify(cloud.sections)) return { kind: 'other' };
  const ids = new Set([...Object.keys(next.volumes), ...Object.keys(cloud.volumes)]);
  const moved: string[] = [];
  for (const id of ids) {
    const a = plain(next.volumes[id]);
    const b = plain(cloud.volumes[id]);
    if (a === null && b === null) continue;
    // A record added or removed (or a value that is not a record): not a turn.
    if (a === null || b === null) return { kind: 'other' };
    if (stableStringify(a) === stableStringify(b)) continue;
    if (stableStringify(withoutPositionFields(a)) !== stableStringify(withoutPositionFields(b))) {
      return { kind: 'other' };
    }
    // A first read (0 → n) changes what counts as read at all; a move to 0
    // is a reset, never adopted from positions.json. Both upload.
    if (!(progressOf(a) > 0) || !(progressOf(b) > 0)) return { kind: 'other' };
    moved.push(id);
  }
  return moved.length === 0 ? { kind: 'same' } : { kind: 'position-only', volumes: moved };
}

export type UploadReason =
  | 'not-position-only'
  | 'no-session'
  | 'history-off'
  | 'read-only'
  | 'positions-off'
  | 'legacy-turns'
  | 'not-covered';

export type VolumeDataUploadPlan =
  | { action: 'none' }
  | { action: 'upload'; reason: UploadReason }
  | { action: 'defer'; volumes: string[] };

export interface VolumeDataUploadInput {
  next: VolumeDataSide;
  cloud: VolumeDataSide;
  /** Reader open on a volume AND the document visible, read at decision time. */
  sessionActive: boolean;
  status: Pick<
    ProviderStatus,
    'historySync' | 'serverCompilesMetadata' | 'isReadOnly' | 'positionsSync'
  >;
  /** `legacyCarriedBy`: this provider holds every converted legacy turn. */
  legacyCarried: boolean;
  /** This device's changed-mark for the volume (`positions-local`), if any. */
  markOf: (volume: string) => number | undefined;
  /** The `t` of the volume's entry in the cloud `positions.json`, when known. */
  cloudPositionOf: (volume: string) => number | undefined;
}

/** Upload, defer, or nothing to do. See the module doc for the rule. */
export function planVolumeDataUpload(input: VolumeDataUploadInput): VolumeDataUploadPlan {
  const diff = classifyVolumeDataDiff(input.next, input.cloud);
  if (diff.kind === 'same') return { action: 'none' };
  if (diff.kind === 'other') return { action: 'upload', reason: 'not-position-only' };
  if (!input.sessionActive) return { action: 'upload', reason: 'no-session' };
  const { status } = input;
  if (!historySyncAllowed(status)) return { action: 'upload', reason: 'history-off' };
  if (status.isReadOnly) return { action: 'upload', reason: 'read-only' };
  if (!positionsWriteAllowed(status)) return { action: 'upload', reason: 'positions-off' };
  if (!input.legacyCarried) return { action: 'upload', reason: 'legacy-turns' };
  for (const volume of diff.volumes) {
    const stamp = stampOf(plain(input.next.volumes[volume])!);
    if (!(stamp > 0)) return { action: 'upload', reason: 'not-covered' };
    const mark = input.markOf(volume);
    const cloudT = input.cloudPositionOf(volume);
    // Exactly the stamp: the push sends a volume only when its record's stamp
    // IS the mark (`ownChangedEntries`) and drops any other mark
    // (`clearChanged`). A mark past the stamp is a look-up restore's leftover
    // (`visit.ts` puts the old stamp back): nothing is on its way.
    const marked = mark !== undefined && mark === stamp;
    const inCloud = cloudT !== undefined && cloudT >= stamp;
    if (!marked && !inCloud) return { action: 'upload', reason: 'not-covered' };
  }
  return { action: 'defer', volumes: diff.volumes };
}
