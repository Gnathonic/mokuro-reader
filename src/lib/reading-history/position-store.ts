import { derived, get, writable, type Readable } from 'svelte/store';
import { applyMissedRestart, jumpToPosition, volumesWithTrash } from '$lib/settings/volume-data';
import { isVolumeComplete } from '$lib/util/volume-helpers';
import type { HistoryDexie } from './history-db';
import { planPosition, type PositionOffer, type PositionPlan } from './position-offer';
import { getOrCreateDeviceId, recordEvent } from './record';
import {
  getVolumeEvents,
  historyTurns,
  historyVolumes,
  onHistoryChanged,
  volumeEventsVersion
} from './turns-store';
import { currentView } from '$lib/util/hash-router';

/**
 * Cross-device position offers in the app (phase 2c): the plan for a volume
 * from its merged events (`planPosition`), the answers, the automatic re-apply
 * of a missed restart, and how often the prompt may show.
 */

const ownDevice = writable<string | null>(null);
let stopListening: (() => void) | null = null;
const applying = new Set<string>();

/** Start watching history: needs this device's id, and re-applies missed restarts. */
export async function initPositionOffers(db?: HistoryDexie): Promise<void> {
  const target = db ?? (await import('./history-db')).historyDb();
  ownDevice.set(await getOrCreateDeviceId(target));
  stopListening?.();
  const stopHistory = onHistoryChanged((volumes) =>
    applyMissedRestarts(volumes === 'all' ? historyVolumes() : [...volumes], target)
  );
  // A reset never moves the page under an open reader: it waits for the reader
  // to leave that volume.
  let openVolume = openVolumeOf(get(currentView));
  const stopView = currentView.subscribe((view) => {
    const next = openVolumeOf(view);
    const closed = openVolume;
    openVolume = next;
    if (closed && closed !== next) applyMissedRestarts([closed], target);
  });
  stopListening = () => {
    stopHistory();
    stopView();
  };
  applyMissedRestarts(historyVolumes(), target);
}

const EMPTY: PositionPlan = Object.freeze({}) as PositionPlan;
const memo = new Map<
  string,
  { version: number; progress: number; own: string; plan: PositionPlan }
>();

/**
 * The plan for one volume right now (`{}` when there is nothing to offer).
 * Memoised on the volume's events version and position, so a store emission
 * that did not touch this volume returns the SAME object (no re-render).
 */
export function positionPlanFor(volume: string): PositionPlan {
  const own = get(ownDevice);
  const record = get(volumesWithTrash)[volume];
  if (!own || !record || record.deletedOn) return EMPTY;
  const version = volumeEventsVersion(volume);
  const cached = memo.get(volume);
  if (
    cached &&
    cached.version === version &&
    cached.progress === record.progress &&
    cached.own === own
  ) {
    return cached.plan;
  }
  const computed = planPosition(getVolumeEvents(volume), record, own);
  const plan = computed.offer || computed.reset ? computed : EMPTY;
  memo.set(volume, { version, progress: record.progress, own, plan });
  return plan;
}

/** The plan for one volume, kept current as history and the record change. */
export function positionPlan(volume: string): Readable<PositionPlan> {
  return derived([historyTurns, volumesWithTrash, ownDevice], () => positionPlanFor(volume));
}

/**
 * Answer an offer. `jump` moves to the offered page (not a page view, no
 * completion notice); `stay` keeps the current one. Either way the answer is a
 * history event, so it syncs and is never asked again for that reading.
 */
export async function answerPosition(
  volume: string,
  offer: PositionOffer,
  answer: 'jump' | 'stay',
  pageCount: number,
  db?: HistoryDexie
): Promise<void> {
  if (answer === 'jump') {
    jumpToPosition(
      volume,
      offer.page,
      offer.chars,
      isVolumeComplete(offer.page, pageCount),
      offer.at
    );
  }
  await recordEvent(
    { kind: 'position', volume, answer, through: offer.at, page: offer.page },
    Date.now(),
    db
  );
}

function openVolumeOf(view: unknown): string | null {
  const v = view as { type?: string; volumeId?: string };
  return v.type === 'reader' || v.type === 'volume-text' ? (v.volumeId ?? null) : null;
}

function applyMissedRestarts(volumes: string[], db: HistoryDexie): void {
  const open = openVolumeOf(get(currentView));
  for (const volume of volumes) {
    if (volume === open) continue;
    const reset = positionPlanFor(volume).reset;
    if (!reset) continue;
    const key = `${volume}|${reset.at}`;
    if (applying.has(key)) continue;
    applying.add(key);
    applyMissedRestart(volume);
    void recordEvent(
      { kind: 'position', volume, answer: 'reset', through: reset.at, page: 0 },
      Date.now(),
      db
    ).finally(() => applying.delete(key));
  }
}

// ---- cadence: at most once a session, in at most two sessions ----

const SHOWN_KEY = 'position-offer:shown';
const MAX_PROMPT_SESSIONS = 2;
let session = Math.random().toString(36).slice(2);

interface ShownEntry {
  through: number;
  sessions: string[];
}

function readShown(): Record<string, ShownEntry> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SHOWN_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Should the prompt show for this offer now? Not twice in one session, and
 * not in more than two sessions — after that the volume card carries a chip
 * until it is answered. A newer offer (newer reading) starts over.
 */
export function shouldPrompt(volume: string, offer: PositionOffer): boolean {
  const entry = readShown()[volume];
  if (!entry || entry.through !== offer.at) return true;
  if (entry.sessions.includes(session)) return false;
  return entry.sessions.length < MAX_PROMPT_SESSIONS;
}

/** The chip: an unanswered offer whose prompts are used up. */
export function showsChip(volume: string, offer: PositionOffer): boolean {
  const entry = readShown()[volume];
  return !!entry && entry.through === offer.at && entry.sessions.length >= MAX_PROMPT_SESSIONS;
}

export function markPrompted(volume: string, offer: PositionOffer): void {
  const shown = readShown();
  const entry =
    shown[volume]?.through === offer.at ? shown[volume] : { through: offer.at, sessions: [] };
  if (!entry.sessions.includes(session)) entry.sessions.push(session);
  shown[volume] = entry;
  try {
    window.localStorage.setItem(SHOWN_KEY, JSON.stringify(shown));
  } catch {
    // Storage blocked: the prompt may show again next session. Harmless.
  }
}

/** Test hooks. */
export function _newSessionForTests(): void {
  session = Math.random().toString(36).slice(2);
}
export function _resetPositionStoreForTests(): void {
  stopListening?.();
  stopListening = null;
  applying.clear();
  memo.clear();
  ownDevice.set(null);
}
