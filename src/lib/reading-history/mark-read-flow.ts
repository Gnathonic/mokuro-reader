import { get, writable, type Readable } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { volumes as catalogVolumes } from '$lib/catalog';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import { sortVolumes } from '$lib/catalog/sort-volumes';
import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
import { markReadPolicy, setMarkReadPolicy } from '$lib/settings/tracking-data';
import {
  markVolumeUnread,
  markVolumesRead,
  volumesWithTrash,
  type MarkReadItem,
  type RetractableCredit
} from '$lib/settings/volume-data';
import type { VolumeMetadata } from '$lib/types';
import { showSnackbar } from '$lib/util/snackbar';
import { isVolumeFinished } from '$lib/util/volume-helpers';
import {
  creditPages,
  creditSpeed,
  currentPassCredits,
  estimateMinutes,
  formatMinutes,
  pageCharsOf,
  retractable,
  splitTime,
  type CreditSpeed
} from './credit';
import { recordEvent } from './record';
import { MAX_CREDIT_RUN } from './segment-codec';
import {
  flushReadingStats,
  pagesNotReadHere,
  readingStats,
  readingStatsReady
} from './stats-store';
import { getVolumeEvents } from './turns-store';

/**
 * "Mark as read" with the pages this app never saw read (#224; spec
 * `2026-11-07-mark-as-read-credit-design.md`): works out what they hold, asks
 * through the sheet (`MarkReadSheet.svelte`) when the user's setting says to,
 * marks, records the credit, and offers an Undo for `UNDO_MS`.
 *
 * The sheet appears only from these actions — never from reader completion,
 * sync or position adoption, which do not come through here.
 */

export const UNDO_MS = 8000;

/** One volume as the sheet shows it. */
export interface SheetVolume {
  uuid: string;
  title: string;
  /** 0 = unknown: the volume cannot be marked. */
  pageCount: number;
  totalChars?: number;
  /** 1-based page p's characters at index p − 1. */
  pageChars: number[];
  /** Pages no counting view read and no live credit claims, this pass. */
  notRead: number[];
}

export type SheetMode = 'single' | 'bulk' | 'editor';

export interface SheetRequest {
  mode: SheetMode;
  volumes: SheetVolume[];
  /** Bulk: the volumes ticked at first. */
  checked: string[];
  speed: CreditSpeed | null;
  /** Which finishing button gets focus. */
  focus: 'count' | 'skip';
  /** Single/editor: "Count up to page" at first. */
  upTo: number;
}

export interface SheetAnswer {
  count: boolean;
  /** Bulk: the volumes still ticked. */
  checked: string[];
  /** Single/editor: credit only pages up to here. */
  upTo: number;
  /** Minutes the user typed (bulk: the total); `null` = the estimate. */
  typedMinutes: number | null;
  /** Single: the button pressed becomes the setting. */
  dontAskAgain: boolean;
}

type PendingSheet = SheetRequest & { answer: (answer: SheetAnswer | null) => void };
const sheet = writable<PendingSheet | null>(null);
/** The open sheet, if any — `MarkReadSheet.svelte` renders it. */
export const markReadSheet: Readable<PendingSheet | null> = { subscribe: sheet.subscribe };

/** Is the sheet on screen? (A modal under it must leave Escape to it.) */
export function markReadSheetOpen(): boolean {
  return get(sheet) !== null;
}

/** Open the sheet; settles with the answer, or `null` for ×, Escape or the backdrop. */
export function askSheet(request: SheetRequest): Promise<SheetAnswer | null> {
  get(sheet)?.answer(null);
  return new Promise((resolve) => {
    const pending: PendingSheet = {
      ...request,
      answer(answer) {
        if (get(sheet) === pending) sheet.set(null);
        resolve(answer);
      }
    };
    sheet.set(pending);
  });
}

/** History counted up to now: events recorded a moment ago are in the figures. */
async function settledStats() {
  await readingStatsReady();
  // Recorded events reach the stats through a microtask (turns-store).
  await Promise.resolve();
  flushReadingStats();
  return get(readingStats);
}

/** A volume's pages, their characters and which of them were never read here. */
export async function prepareSheetVolume(volume: VolumeMetadata): Promise<SheetVolume> {
  const stats = await settledStats();
  const pageCount = volume.page_count ?? 0;
  // A page count no credit could carry (a damaged `series.json` gave a
  // placeholder 250,000 pages) still marks, but counts no pages: nothing is
  // listed per page for it, and no segment could hold the run.
  const countable = pageCount > 0 && pageCount <= MAX_CREDIT_RUN;
  const counted = volume.page_char_counts?.length === pageCount;
  const ocr =
    !counted && countable && isVolumeInstalled(volume)
      ? await db.volume_ocr.get(volume.volume_uuid).catch(() => undefined)
      : undefined;
  const pageChars = countable ? pageCharsOf(volume, ocr?.pages) : [];
  const record = get(volumesWithTrash)[volume.volume_uuid];
  return {
    uuid: volume.volume_uuid,
    title: decodeURI(volume.volume_title),
    pageCount,
    totalChars:
      volume.character_count && volume.character_count > 0
        ? volume.character_count
        : pageChars.reduce((n, c) => n + c, 0) || undefined,
    pageChars,
    notRead: countable ? pagesNotReadHere(stats, volume.volume_uuid, pageCount, record) : []
  };
}

function speedFor(series_uuid: string): CreditSpeed | null {
  const ids = Object.values(get(catalogVolumes) ?? {})
    .filter((v) => v.series_uuid === series_uuid)
    .map((v) => v.volume_uuid);
  return creditSpeed(get(readingStats), ids, get(personalizedReadingSpeed));
}

const number = (n: number) => n.toLocaleString();

/** "counted 9,412 characters, 38 min" / "…, no time added". */
function countedText(chars: number, ms: number): string {
  const time = ms >= 30_000 ? formatMinutes(ms / 60_000) : 'no time added';
  return `counted ${number(chars)} characters, ${time}`;
}

/** Mark, credit, and offer one Undo for the batch. */
function commit(items: MarkReadItem[], message: string): void {
  const action = markVolumesRead(items);
  showSnackbar(message, UNDO_MS, { label: 'Undo', onClick: () => void action.undo() }, () =>
    action.release()
  );
}

/** The credit of one volume's not-read pages up to `upTo`, at `minutes` (null = none known). */
function creditItem(v: SheetVolume, upTo: number, ms: number): MarkReadItem['credit'] {
  const { pages, page_chars, chars } = creditPages(v.notRead, v.pageChars, upTo);
  if (pages.length === 0 || chars <= 0) return undefined;
  return { pages, page_chars, time_ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0 };
}

/** "Mark as read" on one volume: ask, count or skip by the user's setting. */
export async function markRead(volume: VolumeMetadata): Promise<void> {
  if (!volume.page_count) {
    showSnackbar('Error: Missing page count data');
    return;
  }
  const v = await prepareSheetVolume(volume);
  const all = creditPages(v.notRead, v.pageChars, v.pageCount);
  const base: MarkReadItem = { volume: v.uuid, pageCount: v.pageCount, totalChars: v.totalChars };
  const plain = `Marked ${v.title} as read`;
  const policy = get(markReadPolicy);
  if (all.chars <= 0 || policy === 'skip') {
    commit([base], plain);
    return;
  }
  const speed = speedFor(volume.series_uuid);
  if (policy === 'count') {
    const ms = (estimateMinutes(all.chars, speed) ?? 0) * 60_000;
    commit(
      [{ ...base, credit: creditItem(v, v.pageCount, ms) }],
      `${plain} · ${countedText(all.chars, ms)}`
    );
    return;
  }
  const answer = await askSheet({
    mode: 'single',
    volumes: [v],
    checked: [v.uuid],
    speed,
    focus: 'skip',
    upTo: v.pageCount
  });
  if (!answer) return;
  if (answer.dontAskAgain) setMarkReadPolicy(answer.count ? 'count' : 'skip');
  if (!answer.count) {
    commit([base], plain);
    return;
  }
  const { chars } = creditPages(v.notRead, v.pageChars, answer.upTo);
  const minutes = answer.typedMinutes ?? estimateMinutes(chars, speed) ?? 0;
  const ms = minutes * 60_000;
  const credit = creditItem(v, answer.upTo, ms);
  commit([{ ...base, credit }], credit ? `${plain} · ${countedText(chars, ms)}` : plain);
}

/**
 * The bulk sheet (series menu: every unfinished volume ticked; a card's "Mark
 * as read up to here": the unfinished ones up to it). Always asks — the
 * sheet is open anyway; the setting only picks the focused button.
 */
export async function markReadBulk(volumes: VolumeMetadata[], upToUuid?: string): Promise<void> {
  const records = get(volumesWithTrash);
  const ordered = [...volumes].sort(sortVolumes);
  const unfinished = ordered.filter((v) => !isVolumeFinished(v, records[v.volume_uuid]));
  if (unfinished.length === 0) {
    showSnackbar('Every volume here is already read');
    return;
  }
  const limit = upToUuid ? ordered.findIndex((v) => v.volume_uuid === upToUuid) : -1;
  const checked = unfinished
    .filter((v) => limit < 0 || ordered.indexOf(v) <= limit)
    .map((v) => v.volume_uuid);
  const prepared = await Promise.all(unfinished.map(prepareSheetVolume));
  const speed = speedFor(unfinished[0].series_uuid);
  const answer = await askSheet({
    mode: 'bulk',
    volumes: prepared,
    checked,
    speed,
    focus: get(markReadPolicy) === 'count' ? 'count' : 'skip',
    upTo: 0
  });
  if (!answer || answer.checked.length === 0) return;
  const chosen = prepared.filter((v) => answer.checked.includes(v.uuid));
  const markable = chosen.filter((v) => v.pageCount > 0);
  const skipped = chosen.length - markable.length;
  if (markable.length === 0) {
    showSnackbar(
      `Nothing marked: page count unknown for ${skipped === 1 ? 'that volume' : 'those volumes'}`
    );
    return;
  }
  const charsOf = markable.map((v) => creditPages(v.notRead, v.pageChars, v.pageCount).chars);
  const times =
    answer.typedMinutes !== null
      ? splitTime(answer.typedMinutes * 60_000, charsOf)
      : charsOf.map((c) => (estimateMinutes(c, speed) ?? 0) * 60_000);
  const items: MarkReadItem[] = markable.map((v, i) => ({
    volume: v.uuid,
    pageCount: v.pageCount,
    totalChars: v.totalChars,
    ...(answer.count && { credit: creditItem(v, v.pageCount, times[i]) })
  }));
  const counted = answer.count ? items.filter((item) => item.credit) : [];
  const chars = counted.reduce(
    (n, item) => n + item.credit!.page_chars.reduce((a, c) => a + c, 0),
    0
  );
  const ms = counted.reduce((n, item) => n + item.credit!.time_ms, 0);
  let message = `Marked ${markable.length} volume${markable.length === 1 ? '' : 's'} as read`;
  if (counted.length > 0) message += ` · ${countedText(chars, ms)}`;
  if (skipped > 0) message += ` · ${skipped} skipped (page count unknown)`;
  commit(items, message);
}

/**
 * The volume editor's "Count pages read elsewhere…": the same sheet, nothing
 * marked. Resolves `true` once a credit is recorded.
 */
export async function countReadElsewhere(volume: VolumeMetadata, upTo: number): Promise<boolean> {
  const v = await prepareSheetVolume(volume);
  const speed = speedFor(volume.series_uuid);
  const answer = await askSheet({
    mode: 'editor',
    volumes: [v],
    checked: [v.uuid],
    speed,
    focus: 'count',
    upTo: Math.min(Math.max(1, upTo), v.pageCount)
  });
  if (!answer?.count) return false;
  const { chars } = creditPages(v.notRead, v.pageChars, answer.upTo);
  const ms = (answer.typedMinutes ?? estimateMinutes(chars, speed) ?? 0) * 60_000;
  const credit = creditItem(v, answer.upTo, ms);
  if (!credit) return false;
  const stored = await recordEvent({ kind: 'credit', volume: v.uuid, ...credit });
  // No snackbar: the editor's own dialog would cover it. The editor shows the
  // counted line with its Remove, which is this action's undo.
  await settledStats();
  return stored !== null;
}

/** What retracting a volume's current-pass credits takes away. */
function removedText(credits: Array<{ ms: number; chars: number }>): string {
  const ms = credits.reduce((n, c) => n + c.ms, 0);
  const chars = credits.reduce((n, c) => n + c.chars, 0);
  if (ms >= 30_000) return `removed ${formatMinutes(ms / 60_000)} counted`;
  if (chars > 0) return `removed ${number(chars)} characters counted`;
  return '';
}

function liveCredits(volume: string): {
  credits: RetractableCredit[];
  removed: string;
} {
  const totals = currentPassCredits(get(readingStats), volume);
  return {
    credits: retractable(totals, getVolumeEvents(volume)),
    removed: removedText(totals)
  };
}

/**
 * "Mark as unread": the record back to unread, and the current pass's
 * credits retracted — the credit was part of the mark. Undo restores both.
 */
export async function markUnread(volume: VolumeMetadata): Promise<void> {
  await settledStats();
  const { credits, removed } = liveCredits(volume.volume_uuid);
  const action = markVolumeUnread(volume.volume_uuid, credits);
  const title = decodeURI(volume.volume_title);
  showSnackbar(`Marked ${title} as unread${removed ? ` · ${removed}` : ''}`, UNDO_MS, {
    label: 'Undo',
    onClick: () => void action.undo()
  });
}

/**
 * The editor's Remove: retract the current pass's credits. Resolves once the
 * stats reflect it, with what was removed and an undo that records the same
 * credits again (the editor shows both inline: a snackbar would sit under
 * its dialog).
 */
export async function removeCredits(
  volume: string
): Promise<{ removed: string; undo: () => Promise<void> } | null> {
  await settledStats();
  const { credits, removed } = liveCredits(volume);
  if (credits.length === 0) return null;
  await Promise.all(
    credits.map((credit) => recordEvent({ kind: 'retract', volume, target: credit.target }))
  );
  await settledStats();
  let undone = false;
  return {
    removed: removed ? removed.replace(/^r/, 'R') : 'Removed',
    async undo() {
      if (undone) return;
      undone = true;
      await Promise.all(
        credits.map((credit) => recordEvent({ kind: 'credit', volume, ...credit.fields }))
      );
      await settledStats();
    }
  };
}
