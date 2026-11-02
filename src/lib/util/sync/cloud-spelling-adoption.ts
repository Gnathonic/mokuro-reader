/**
 * Adopt the cloud's spelling of a series title on a server that merges
 * case variants itself.
 *
 * mokuro-bunko folds `one piece/` and `One Piece/` into ONE folder. A device
 * that imported the series as `one piece` then holds rows under a title the
 * cloud no longer has: every exact-path lookup misses, so a backup would mint
 * the losing spelling again and the server would merge it again, forever. On
 * such a provider (`serverCompilesMetadata`) the reader renames its own rows to
 * the cloud's spelling — LOCAL ONLY, nothing in the cloud moves, because the
 * cloud is already right.
 *
 * Deliberately narrow. Plain storage never adopts: nothing merges folders
 * there, so its rows keep the spelling the user gave them (the folded lookups
 * — `resolveCloudFolderTitle` — still back them up into, and find them in, a
 * folder folding onto that title when none is spelled exactly like it; an
 * exact folder always wins). And even on bunko a plan
 * needs all three of: exactly one cloud folder folding onto the local title,
 * none spelled exactly like it, and at least one local volume listed in that
 * folder — evidence the folder IS this series, not a namesake.
 */

import { db } from '$lib/catalog/db';
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { isVolumeOpen } from '$lib/util/hash-router';
import type { VolumeMetadata } from '$lib/types';
import type { CloudFileMetadata, ProviderType } from './provider-interface';
import { providerManager } from './provider-manager';
import { isCbzFile } from './syncable-file';

export interface CloudSpellingAdoption {
  /** The local series title, as the rows carry it. */
  from: string;
  /** The cloud folder's spelling. */
  to: string;
  /** The rows to move. */
  volumeUuids: string[];
}

/**
 * A `volumes` row. Rows are never placeholders — a placeholder is a cloud
 * listing with no row at all (`catalog/volume-state.ts`) — so there is no
 * state to test here; installed and metadata-only rows alike carry the title
 * the adoption renames.
 */
type AdoptionRow = Pick<VolumeMetadata, 'volume_uuid' | 'series_title' | 'volume_title'>;

/** Top-level folders holding at least one `.cbz` → their folded archive stems. */
function cloudSeriesFolders(files: CloudFileMetadata[]): Map<string, Set<string>> {
  const folders = new Map<string, Set<string>>();
  for (const file of files) {
    const parts = file.path.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2 || !parts[0] || !isCbzFile(parts[1])) continue;
    const stem = normalizeVolumeTitleKey(parts[1].slice(0, -4));
    const stems = folders.get(parts[0]);
    if (stems) stems.add(stem);
    else folders.set(parts[0], new Set([stem]));
  }
  return folders;
}

/**
 * Local titles with no folder of their own and exactly ONE folder folding onto
 * them — the only titles a plan can be made for. Cheap: titles only, so the
 * caller reads rows just for these.
 */
function candidateTitles(
  localTitles: Iterable<string>,
  folders: Map<string, Set<string>>
): Map<string, string> {
  const byFold = new Map<string, string[]>();
  for (const folder of folders.keys()) {
    const key = normalizeVolumeTitleKey(folder);
    const list = byFold.get(key);
    if (list) list.push(folder);
    else byFold.set(key, [folder]);
  }
  const out = new Map<string, string>();
  for (const title of localTitles) {
    if (!title || folders.has(title)) continue;
    const matches = byFold.get(normalizeVolumeTitleKey(title));
    // Two folders folding alike: neither is more correct, so no guess.
    if (matches?.length === 1) out.set(title, matches[0]);
  }
  return out;
}

/** Pure: which local series should take the cloud's spelling. */
export function planCloudSpellingAdoptions(
  rows: AdoptionRow[],
  files: CloudFileMetadata[]
): CloudSpellingAdoption[] {
  const folders = cloudSeriesFolders(files);
  const titled = rows.filter((row) => row.series_title);
  const candidates = candidateTitles(new Set(titled.map((row) => row.series_title)), folders);

  const plans: CloudSpellingAdoption[] = [];
  for (const [from, to] of candidates) {
    const seriesRows = titled.filter((row) => row.series_title === from);
    const stems = folders.get(to)!;
    if (!seriesRows.some((row) => stems.has(normalizeVolumeTitleKey(row.volume_title)))) continue;
    plans.push({ from, to, volumeUuids: seriesRows.map((row) => row.volume_uuid) });
  }
  return plans;
}

function adoptsOn(providerType: ProviderType): boolean {
  const provider = providerManager.getActiveProvider();
  return (
    !!provider &&
    provider.type === providerType &&
    provider.getStatus().serverCompilesMetadata === true
  );
}

/**
 * Plan against `files` (a listing of `providerType`) and commit each plan as a
 * local-only series rename. No-op unless that provider is still the active one
 * and compiles its own metadata. Returns the plans committed.
 */
export async function adoptCloudSeriesSpellings(
  files: CloudFileMetadata[],
  providerType: ProviderType
): Promise<CloudSpellingAdoption[]> {
  if (files.length === 0 || !adoptsOn(providerType)) return [];

  const folders = cloudSeriesFolders(files);
  if (folders.size === 0) return [];
  const titles = (await db.volumes.orderBy('series_title').uniqueKeys()) as string[];
  const candidates = candidateTitles(titles, folders);
  // The common case — every title spelled like its folder — reads no rows.
  if (candidates.size === 0) return [];

  const rows = await db.volumes
    .where('series_title')
    .anyOf([...candidates.keys()])
    .toArray();
  const plans = planCloudSpellingAdoptions(rows, files);
  if (plans.length === 0) return [];

  // Deferred: series-rename imports the cloud manager, which imports this.
  const { commitLocalSeriesRename, generateRenameSeriesPreview } = await import(
    '$lib/util/series-rename'
  );
  const committed: CloudSpellingAdoption[] = [];
  for (const plan of plans) {
    // The provider may have changed while the rows were read.
    if (!adoptsOn(providerType)) break;
    // Never under the reader: the row write would reload the open volume's
    // data mid-page (`volumeRowSignature` covers the whole row — every page
    // image swapped, an edit session moved), the same reason the OCR upgrade
    // defers. The next listing retries the series.
    if (plan.volumeUuids.some(isVolumeOpen)) {
      console.debug(`[cloud-spelling] '${plan.from}' deferred: a volume is open`);
      continue;
    }
    // Stats ride along exactly as in a user rename, including entries for
    // volumes no longer on this device.
    const preview = await generateRenameSeriesPreview(plan.from, plan.to);
    await commitLocalSeriesRename(
      plan.from,
      plan.to,
      plan.volumeUuids,
      preview.localStorageChanges.map((change) => change.volumeUuid)
    );
    console.log(`[cloud-spelling] adopted '${plan.from}' -> '${plan.to}'`);
    committed.push(plan);
  }
  return committed;
}
