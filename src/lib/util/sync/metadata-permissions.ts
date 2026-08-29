/**
 * UI-gating for per-series metadata edits (names/links/tag/unit/spine offsets), per the
 * scope a provider's identity check reports (currently: mokuro-bunko via WebDAV — see
 * `ProviderStatus.metadataPermissions` / `providers/webdav/identity.ts`).
 *
 * Server enforcement is independent and already fails quietly (`isBestEffortMetadataPath`):
 * this module exists purely so the UI can disable + label the controls a write would be
 * rejected for, instead of letting the user hit a silent no-op. Never used to hide a
 * control — only to disable it with a reason (see CLAUDE.md / the task that added this).
 *
 * No active provider, or a provider that doesn't report `metadataPermissions` at all
 * (older mokuro-bunko, or any non-bunko provider) — both read as "no restriction".
 */
import { derived, get, type Readable } from 'svelte/store';
import { providerManager } from '$lib/util/sync';
import type { SeriesMetadataPermissions } from './provider-interface';
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';

export interface SeriesMetadataEditCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Reactive view of the active provider's metadata scope. `canEditSeriesMetadata` itself
 * takes only a `seriesTitle` (a plain function, not a store read) so it stays cheap and
 * synchronous to call from anywhere — but that means a plain `$derived(canEditSeriesMetadata(x))`
 * in a component only re-evaluates when `x` changes, not when the provider's reported scope
 * does. Gated components should also read `$activeMetadataPermissions` inside that same
 * `$derived` (even just to touch it) so Svelte tracks it and the gate updates live if a
 * scope arrives after mount (e.g. a slow identity check, or a reconnect while a modal is
 * already open) — see the components under `src/lib/components/Series/` for the pattern.
 */
export const activeMetadataPermissions: Readable<SeriesMetadataPermissions | undefined> = derived(
  providerManager.status,
  ($status) => {
    const type = $status.currentProviderType;
    if (!type) return undefined;
    return $status.providers[type]?.metadataPermissions;
  }
);

const CANNOT_EDIT_REASON = "This account can't edit series details on this server";
const NOT_OWNED_REASON = 'Editing this series requires ownership on this server';
const CANNOT_DELETE_REASON = "This account can't delete this series on this server";

/**
 * Folded `ownedSeries` set, memoized on the permissions OBJECT's identity so a fresh
 * identity response (a reconnect, a login) recomputes the fold exactly once — never per
 * call. `canEditSeriesMetadata` is cheap enough to call straight from a component's
 * `$derived` (CLAUDE.md: `$derived` runs per component instance).
 */
let cachedPermissions: SeriesMetadataPermissions | undefined;
let cachedOwnedKeys: Set<string> | undefined;

function ownedKeysFor(permissions: SeriesMetadataPermissions): Set<string> {
  if (cachedPermissions === permissions && cachedOwnedKeys) return cachedOwnedKeys;
  cachedPermissions = permissions;
  cachedOwnedKeys = new Set((permissions.ownedSeries ?? []).map(normalizeVolumeTitleKey));
  return cachedOwnedKeys;
}

/**
 * Can the signed-in account edit `seriesTitle`'s shared metadata on the currently active
 * provider? `seriesTitle` is the series FOLDER name (the same identity `ownedSeries`
 * lists) — both sides are folded through `normalizeVolumeTitleKey` before comparing, so a
 * folder name that arrived NFD-decomposed still matches an NFC-composed entry.
 */
/**
 * Can the signed-in account delete `seriesTitle`'s files on the currently active
 * provider? Mirrors the server's DELETE rules: a modify/delete role may delete
 * anything; an uploader-style account (canModifyDelete: false) only what it owns —
 * the server grants per-volume ownership deletes, approximated here at series
 * granularity via the same `ownedSeries` list the edit gate uses. A provider that
 * reports no `canModifyDelete` at all (plain WebDAV, other providers) reads as
 * unrestricted, like every absent permission field.
 */
export function canDeleteSeriesOnServer(seriesTitle: string): SeriesMetadataEditCheck {
  const status = get(providerManager.status);
  const type = status.currentProviderType;
  const provider = type ? status.providers[type] : undefined;
  if (!provider || provider.canModifyDelete !== false) return { allowed: true };

  const permissions = provider.metadataPermissions;
  if (permissions?.scope === 'owned') {
    const owned = ownedKeysFor(permissions);
    if (owned.has(normalizeVolumeTitleKey(seriesTitle))) return { allowed: true };
  }
  return { allowed: false, reason: CANNOT_DELETE_REASON };
}

export function canEditSeriesMetadata(seriesTitle: string): SeriesMetadataEditCheck {
  const permissions = get(activeMetadataPermissions);
  if (!permissions) return { allowed: true };

  switch (permissions.scope) {
    case 'all':
      return { allowed: true };
    case 'none':
      return { allowed: false, reason: CANNOT_EDIT_REASON };
    case 'owned': {
      const owned = ownedKeysFor(permissions);
      return owned.has(normalizeVolumeTitleKey(seriesTitle))
        ? { allowed: true }
        : { allowed: false, reason: NOT_OWNED_REASON };
    }
    default:
      return { allowed: true };
  }
}
