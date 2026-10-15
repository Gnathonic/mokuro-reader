/**
 * A cloud-direct mokuro-bunko announces itself with a MARKER at the library
 * root, `mokuro-reader/.mokuro-bunko.json` (bunko design 0.8 §9.2, §9.5):
 *
 * ```json
 * {"version":1,"kind":"mokuro-bunko","instance_id":"6f1c…","instance_name":"nas",
 *  "epoch":3,"claimed_at":"…","heartbeat_at":"…","ttl_s":900,"state":"active",
 *  "compiles":["series.json","catalog.json"],"ocr":true,"queue":".mokuro-queue.json"}
 * ```
 *
 * While a marker is FRESH the reader treats the library like a bunko server:
 * `serverCompilesMetadata` turns true (it stops producing `series.json` /
 * `catalog.json` itself) and the queue file is trusted — but only the queue
 * file written by the lease HOLDER.
 *
 * Freshness is judged by what this device OBSERVED, not by Bunko's clock:
 * - per marker node, `changedAt` is the local time this device first saw the
 *   node's current version (Drive md5/modifiedTime, Graph cTag, MEGA handle,
 *   WebDAV ETag). A live Bunko rewrites its marker every `ttl_s/3`.
 * - fresh: `state == "active"`, `compiles` lists the file, and
 *   `now − changedAt < 2 × ttl_s` — so an UNCHANGED marker goes stale after
 *   2 × ttl even while it is polled.
 * - cold start (no history for the node): fresh while
 *   `|now − heartbeat_at| < ttl_s + 5 min` (Bunko's clock, with skew allowed).
 * - `released` is honoured at once.
 * - rank (the holder is the top fresh marker): higher `epoch`, then earlier
 *   `claimed_at`, then smaller `instance_id`.
 *
 * Records persist in localStorage per provider, so a cold offline start keeps
 * the last verdict, and an expiry timer re-announces the verdict the moment a
 * fresh marker goes stale (the provider manager recomputes its status then).
 */
import type {
  CloudBunkoStatus,
  ControlFileResult,
  ProviderStatus
} from '$lib/util/sync/provider-interface';

/** Files a marker may say Bunko compiles. */
export const COMPILED_METADATA_FILES = ['series.json', 'catalog.json'] as const;
/** Cold start: how far Bunko's `heartbeat_at` may sit from our clock beyond `ttl_s`. */
export const COLD_START_GRACE_S = 300;
const DEFAULT_TTL_S = 900;
const STORAGE_KEY = 'cloud-bunko-marker:v1';

export interface BunkoMarker {
  version: 1;
  instance_id: string;
  instance_name: string;
  epoch: number;
  claimed_at: string;
  heartbeat_at: string;
  ttl_s: number;
  /** `active` | `released`; anything else is treated as not active. */
  state: string;
  compiles: string[];
  ocr: boolean;
  queue: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Validate a marker document; null when it is not one. Unknown fields are ignored. */
export function parseBunkoMarker(json: unknown): BunkoMarker | null {
  if (!isObject(json) || json.version !== 1) return null;
  if (json.kind !== undefined && json.kind !== 'mokuro-bunko') return null;
  const id = json.instance_id;
  if (typeof id !== 'string' || !id) return null;
  const ttl = json.ttl_s;
  const epoch = json.epoch;
  return {
    version: 1,
    instance_id: id,
    instance_name: typeof json.instance_name === 'string' ? json.instance_name : '',
    epoch: typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : 0,
    claimed_at: typeof json.claimed_at === 'string' ? json.claimed_at : '',
    heartbeat_at: typeof json.heartbeat_at === 'string' ? json.heartbeat_at : '',
    ttl_s: typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_S,
    state: typeof json.state === 'string' ? json.state : '',
    compiles: Array.isArray(json.compiles)
      ? json.compiles.filter((f): f is string => typeof f === 'string')
      : [],
    ocr: json.ocr === true,
    queue: typeof json.queue === 'string' ? json.queue : ''
  };
}

/** What this device keeps about one marker node. */
export interface MarkerNodeRecord {
  /** The provider's node id. */
  id: string;
  /** The node version last seen (`ControlFileNode.etag`). */
  version: string;
  instance_id: string;
  instance_name: string;
  heartbeat_at: string;
  ttl_s: number;
  state: string;
  epoch: number;
  claimed_at: string;
  compiles: string[];
  /** Local ms this device first saw `version`; null = no history (cold start). */
  changedAt: number | null;
}

// ---------------------------------------------------------------- the rules (pure)

function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/** When this node stops being fresh (local ms), ignoring `state` and `compiles`. */
function staleAt(rec: MarkerNodeRecord): number {
  if (rec.changedAt !== null) return rec.changedAt + 2 * rec.ttl_s * 1000;
  const beat = parseMs(rec.heartbeat_at);
  if (!Number.isFinite(beat)) return -Infinity;
  return beat + (rec.ttl_s + COLD_START_GRACE_S) * 1000;
}

function coldTooFarAhead(rec: MarkerNodeRecord, now: number): boolean {
  if (rec.changedAt !== null) return false;
  const beat = parseMs(rec.heartbeat_at);
  return Number.isFinite(beat) && beat - now >= (rec.ttl_s + COLD_START_GRACE_S) * 1000;
}

/**
 * Is this marker node fresh at `now`? With `file`, it must also say it
 * compiles that file (`series.json`, `catalog.json`).
 */
export function isMarkerFresh(rec: MarkerNodeRecord, now: number, file?: string): boolean {
  if (rec.state !== 'active') return false;
  if (file !== undefined && !rec.compiles.includes(file)) return false;
  if (coldTooFarAhead(rec, now)) return false;
  return now < staleAt(rec);
}

function claimedMs(rec: MarkerNodeRecord): number {
  const ms = parseMs(rec.claimed_at);
  return Number.isFinite(ms) ? ms : Infinity;
}

/** Rank order: epoch desc, claimed_at asc, instance_id asc (then node id, for a total order). */
export function compareMarkerRank(a: MarkerNodeRecord, b: MarkerNodeRecord): number {
  if (a.epoch !== b.epoch) return b.epoch - a.epoch;
  const ca = claimedMs(a);
  const cb = claimedMs(b);
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (a.instance_id !== b.instance_id) return a.instance_id < b.instance_id ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The lease holder: the top-ranked FRESH marker, or null. */
export function topFreshMarker(
  recs: readonly MarkerNodeRecord[],
  now: number
): MarkerNodeRecord | null {
  const fresh = recs.filter((r) => isMarkerFresh(r, now)).sort(compareMarkerRank);
  return fresh[0] ?? null;
}

/** Does any fresh marker say Bunko compiles the library metadata? */
export function anyMarkerCompilesFresh(recs: readonly MarkerNodeRecord[], now: number): boolean {
  return recs.some((r) => COMPILED_METADATA_FILES.some((file) => isMarkerFresh(r, now, file)));
}

/** The next moment (local ms) a currently fresh node goes stale; null when none is fresh. */
export function nextMarkerExpiry(recs: readonly MarkerNodeRecord[], now: number): number | null {
  let next: number | null = null;
  for (const rec of recs) {
    if (!isMarkerFresh(rec, now)) continue;
    const at = staleAt(rec);
    if (next === null || at < next) next = at;
  }
  return next;
}

/**
 * Fold one read of the marker's nodes into what was known. A listed node is
 * matched to its history by node id, else by `instance_id` (MEGA rewrites a
 * marker as a NEW node): a moved version stamps `changedAt = now`, an
 * unchanged one keeps its stamp, and a node with no history starts cold.
 */
export function foldMarkerNodes(
  previous: readonly MarkerNodeRecord[],
  nodes: ReadonlyArray<{ id: string; etag: string; marker: BunkoMarker }>,
  now: number
): MarkerNodeRecord[] {
  const byId = new Map(previous.map((r) => [r.id, r]));
  const byInstance = new Map<string, MarkerNodeRecord>();
  for (const r of previous) if (!byInstance.has(r.instance_id)) byInstance.set(r.instance_id, r);
  return nodes.map(({ id, etag, marker }) => {
    const prior = byId.get(id) ?? byInstance.get(marker.instance_id);
    const changedAt = !prior ? null : prior.version === etag ? prior.changedAt : now;
    return {
      id,
      version: etag,
      instance_id: marker.instance_id,
      instance_name: marker.instance_name,
      heartbeat_at: marker.heartbeat_at,
      ttl_s: marker.ttl_s,
      state: marker.state,
      epoch: marker.epoch,
      claimed_at: marker.claimed_at,
      compiles: marker.compiles,
      changedAt
    };
  });
}

/** The provider status view of a record set. */
export function markerStatusOf(recs: readonly MarkerNodeRecord[], now: number): CloudBunkoStatus {
  const top = topFreshMarker(recs, now);
  return {
    fresh: anyMarkerCompilesFresh(recs, now),
    holder: top
      ? {
          instanceId: top.instance_id,
          instanceName: top.instance_name,
          heartbeatAt: top.heartbeat_at
        }
      : null
  };
}

// ---------------------------------------------------------------- the store

let records: Map<string, MarkerNodeRecord[]> | null = null;
const listeners = new Set<() => void>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let lastAnnounced = '';
let clock: () => number = () => Date.now();

function isRecord(v: unknown): v is MarkerNodeRecord {
  const r = v as MarkerNodeRecord;
  return (
    isObject(v) &&
    typeof r.id === 'string' &&
    typeof r.version === 'string' &&
    typeof r.instance_id === 'string' &&
    typeof r.instance_name === 'string' &&
    typeof r.heartbeat_at === 'string' &&
    typeof r.ttl_s === 'number' &&
    typeof r.state === 'string' &&
    typeof r.epoch === 'number' &&
    typeof r.claimed_at === 'string' &&
    Array.isArray(r.compiles) &&
    (r.changedAt === null || typeof r.changedAt === 'number')
  );
}

function load(): Map<string, MarkerNodeRecord[]> {
  if (records) return records;
  records = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (isObject(parsed)) {
      for (const [scope, list] of Object.entries(parsed)) {
        if (Array.isArray(list)) records.set(scope, list.filter(isRecord));
      }
    }
  } catch {
    // Unreadable: no history; the first read starts cold.
  }
  return records;
}

function save(): void {
  try {
    const map = load();
    if (map.size === 0) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Storage unavailable: the verdict lasts this session.
  }
}

function snapshot(now: number): string {
  const out: Record<string, CloudBunkoStatus> = {};
  for (const [scope, recs] of load()) out[scope] = markerStatusOf(recs, now);
  return JSON.stringify(out);
}

/** Tell listeners when any scope's verdict changed, and arm the timer for the next expiry. */
function reannounce(): void {
  const now = clock();
  const current = snapshot(now);
  if (current !== lastAnnounced) {
    lastAnnounced = current;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.debug('[cloud-bunko-marker] listener failed:', error);
      }
    }
  }
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  let next: number | null = null;
  for (const recs of load().values()) {
    const at = nextMarkerExpiry(recs, now);
    if (at !== null && (next === null || at < next)) next = at;
  }
  if (next !== null) {
    // +1 ms: past the boundary, so the re-check sees the node stale.
    expiryTimer = setTimeout(reannounce, Math.max(0, next - now) + 1);
  }
}

async function readNodes(
  result: Exclude<ControlFileResult, 'not-modified' | null>
): Promise<Array<{ id: string; etag: string; marker: BunkoMarker }>> {
  const out: Array<{ id: string; etag: string; marker: BunkoMarker }> = [];
  for (const node of result.nodes) {
    try {
      const marker = parseBunkoMarker(JSON.parse(await node.blob.text()));
      if (marker) out.push({ id: node.id, etag: node.etag, marker });
    } catch {
      // Not JSON (a half-written upload): this node says nothing.
    }
  }
  return out;
}

/**
 * Record a read of the marker for `scope` (the provider type). `'not-modified'`
 * changes nothing — an unchanged marker ages towards stale — and null (no
 * marker node at all) forgets the scope.
 */
export async function ingestMarkerRead(scope: string, result: ControlFileResult): Promise<void> {
  if (result === 'not-modified') {
    reannounce();
    return;
  }
  const map = load();
  if (result === null || result.nodes.length === 0) {
    if (map.delete(scope)) save();
    reannounce();
    return;
  }
  const nodes = await readNodes(result);
  map.set(scope, foldMarkerNodes(map.get(scope) ?? [], nodes, clock()));
  save();
  reannounce();
}

/** The marker nodes known for `scope`. */
export function markerRecords(scope: string): MarkerNodeRecord[] {
  return [...(load().get(scope) ?? [])];
}

/** The lease holder for `scope` right now, or null. */
export function cloudBunkoHolder(scope: string): MarkerNodeRecord | null {
  return topFreshMarker(load().get(scope) ?? [], clock());
}

/** The marker verdict for `scope`, or undefined when no marker was ever read there. */
export function cloudBunkoStatus(scope: string): CloudBunkoStatus | undefined {
  const recs = load().get(scope);
  if (!recs || recs.length === 0) return undefined;
  return markerStatusOf(recs, clock());
}

/**
 * A provider's own status with the marker folded in:
 * `serverCompilesMetadata = reported || anyMarkerFresh`.
 */
export function withCloudBunkoStatus<T extends ProviderStatus>(scope: string, status: T): T {
  const marker = cloudBunkoStatus(scope);
  if (!marker) return status;
  return {
    ...status,
    cloudBunko: marker,
    serverCompilesMetadata: status.serverCompilesMetadata === true || marker.fresh
  };
}

/** Called whenever a verdict changes (a read, or a fresh marker expiring). Returns the unsubscribe. */
export function onCloudBunkoMarkerChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget the marker of one scope (logout), or of every scope. */
export function clearCloudBunkoMarkers(scope?: string): void {
  const map = load();
  if (scope === undefined) map.clear();
  else map.delete(scope);
  save();
  reannounce();
}

/** Tests: drop all state, listeners and timers; optionally pin the clock. */
export function resetCloudBunkoMarkersForTest(now?: () => number): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  records = null;
  listeners.clear();
  lastAnnounced = '';
  clock = now ?? (() => Date.now());
}
