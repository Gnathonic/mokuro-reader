/**
 * Importing a profiles file (Settings → Profile → Import profiles): what it
 * would change, worked out before anything is written, so the UI can warn
 * about the profiles it would replace and about AnkiConnect URLs it brings.
 */
import { isAnkiUrlTrusted } from '$lib/anki-connect/url-trust';
import { migrateProfiles, type Profiles, type Settings } from './settings';

export interface ProfileImportPlan {
  /** The file's profiles, migrated to the current shape: what an import writes. */
  profiles: Profiles;
  /** Names of existing (live) profiles the import would replace with different settings. */
  overwrites: string[];
  /**
   * AnkiConnect URLs the imported profiles point at that this device has not
   * confirmed (`anki-connect/url-trust.ts`). They are imported, and not used
   * until confirmed.
   */
  unconfirmedAnkiUrls: string[];
}

/** Parse a profiles export. Throws on anything that is not a name → profile object. */
export function parseProfilesFile(text: string): Profiles {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Not a profiles file');
  }
  for (const profile of Object.values(parsed)) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error('Not a profiles file');
    }
  }
  return parsed as Profiles;
}

/** Key-order-independent JSON, for "would this change anything?". */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

/** Same settings, whenever each was last stamped. */
function sameSettings(a: Settings, b: Settings): boolean {
  const { lastUpdated: _a, ...restA } = a;
  const { lastUpdated: _b, ...restB } = b;
  return JSON.stringify(stable(restA)) === JSON.stringify(stable(restB));
}

/**
 * What importing `imported` over `existing` (the live profiles, tombstones
 * excluded) would do. A same-name profile whose settings are identical is not
 * an overwrite; a tombstoned one is not either (the import brings it back).
 */
export function planProfileImport(imported: Profiles, existing: Profiles): ProfileImportPlan {
  const profiles = migrateProfiles(imported);
  const overwrites = Object.keys(profiles).filter((name) => {
    const current = existing[name];
    return !!current && !current.deletedOn && !sameSettings(current, profiles[name]);
  });
  const unconfirmedAnkiUrls = [
    ...new Set(
      Object.values(profiles)
        .map((profile) => profile.ankiConnectSettings?.url)
        .filter((url): url is string => !!url && !isAnkiUrlTrusted(url))
    )
  ];
  return { profiles, overwrites, unconfirmedAnkiUrls };
}

/** The confirmation question for an import that replaces `names`. */
export function overwriteWarning(names: string[]): string {
  const list = names.map((name) => `"${name}"`).join(', ');
  return names.length === 1
    ? `Importing will replace your profile ${list} with the one in the file. Replace it?`
    : `Importing will replace your profiles ${list} with the ones in the file. Replace them?`;
}

/**
 * The notice after an import. Names every AnkiConnect URL the file brought
 * that this device has not confirmed: each stays unused until confirmed in
 * Settings → Anki Connect, or mining just stops.
 */
export function importNotice(unconfirmedAnkiUrls: string[]): string {
  if (unconfirmedAnkiUrls.length === 0) return 'Profiles imported';
  const where = 'in Settings → Anki Connect before cards are sent there.';
  if (unconfirmedAnkiUrls.length === 1) {
    return `Profiles imported. Confirm the AnkiConnect URL ${unconfirmedAnkiUrls[0]} ${where}`;
  }
  return `Profiles imported. Confirm the AnkiConnect URLs ${unconfirmedAnkiUrls.join(', ')} ${where}`;
}
