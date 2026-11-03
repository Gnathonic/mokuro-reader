import { beforeEach, describe, expect, it } from 'vitest';
import { confirmAnkiUrl, resetAnkiUrlTrustForTest } from '$lib/anki-connect/url-trust';
import { migrateProfiles, type Profiles } from './settings';
import {
  importNotice,
  overwriteWarning,
  parseProfilesFile,
  planProfileImport
} from './profile-import';

function profile(fields: Record<string, unknown> = {}, anki: Record<string, unknown> = {}) {
  return {
    lastUpdated: '2026-10-01T00:00:00.000Z',
    ...fields,
    ankiConnectSettings: { url: 'http://127.0.0.1:8765', ...anki }
  } as any;
}

/** What the store holds: migrated, as every profile in it is. */
function existing(profiles: Record<string, any>): Profiles {
  return migrateProfiles(profiles);
}

beforeEach(() => {
  localStorage.clear();
  resetAnkiUrlTrustForTest();
});

describe('parseProfilesFile', () => {
  it('reads a profiles export', () => {
    expect(Object.keys(parseProfilesFile(JSON.stringify({ Mine: profile() })))).toEqual(['Mine']);
  });

  it.each(['not json', '[]', 'null', '"text"', JSON.stringify({ Mine: 'nope' })])(
    'refuses %s',
    (text) => {
      expect(() => parseProfilesFile(text)).toThrow();
    }
  );
});

describe('planProfileImport', () => {
  it('names the existing profiles the file would replace', () => {
    const plan = planProfileImport(
      { Mine: profile({ fontSize: 30 }), New: profile() },
      existing({ Mine: profile({ fontSize: 12 }), Other: profile() })
    );
    expect(plan.overwrites).toEqual(['Mine']);
    expect(Object.keys(plan.profiles).sort()).toEqual(['Mine', 'New']);
  });

  it('a same-name profile with the same settings is not an overwrite, whatever its stamp', () => {
    const plan = planProfileImport(
      { Mine: profile({ fontSize: 30, lastUpdated: '2026-11-01T00:00:00.000Z' }) },
      existing({ Mine: profile({ fontSize: 30 }) })
    );
    expect(plan.overwrites).toEqual([]);
  });

  it('a deleted profile of that name is not an overwrite (the import brings it back)', () => {
    const plan = planProfileImport(
      { Mine: profile({ fontSize: 30 }) },
      existing({ Mine: profile({ fontSize: 12, deletedOn: '2026-10-02T00:00:00.000Z' }) })
    );
    expect(plan.overwrites).toEqual([]);
  });

  it('lists the AnkiConnect URLs this device has not confirmed, once each', () => {
    const plan = planProfileImport(
      {
        A: profile({}, { url: 'https://anki.example.com' }),
        B: profile({}, { url: 'https://anki.example.com' }),
        C: profile({}, { url: 'http://localhost:8765' }),
        D: profile({}, { url: 'http://192.168.1.20:8765' })
      },
      {}
    );
    expect(plan.unconfirmedAnkiUrls).toEqual([
      'https://anki.example.com',
      'http://192.168.1.20:8765'
    ]);
    // Imported as they are: stored, just not used until confirmed.
    expect(plan.profiles.A.ankiConnectSettings.url).toBe('https://anki.example.com');
  });

  it('a URL already confirmed on this device is not listed', () => {
    confirmAnkiUrl('http://192.168.1.20:8765');
    const plan = planProfileImport({ D: profile({}, { url: 'http://192.168.1.20:8765' }) }, {});
    expect(plan.unconfirmedAnkiUrls).toEqual([]);
  });
});

describe('overwriteWarning', () => {
  it('names each profile', () => {
    expect(overwriteWarning(['Mine'])).toBe(
      'Importing will replace your profile "Mine" with the one in the file. Replace it?'
    );
    expect(overwriteWarning(['A', 'B'])).toBe(
      'Importing will replace your profiles "A", "B" with the ones in the file. Replace them?'
    );
  });
});

describe('importNotice', () => {
  it('is plain when every URL is already usable', () => {
    expect(importNotice([])).toBe('Profiles imported');
  });

  it('names the one URL to confirm', () => {
    expect(importNotice(['https://anki.example.com'])).toContain(
      'Confirm the AnkiConnect URL https://anki.example.com in Settings'
    );
  });

  it('names every URL to confirm, not just the first', () => {
    const notice = importNotice(['https://a.example.com', 'http://192.168.1.5:8765']);
    expect(notice).toContain('AnkiConnect URLs https://a.example.com, http://192.168.1.5:8765');
  });
});
