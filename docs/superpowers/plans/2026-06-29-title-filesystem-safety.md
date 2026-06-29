# Title Filesystem-Safety Sanitization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sanitize series/volume titles at their three source points so the stored title is a legal file/folder name on every sink (MEGA, Drive, WebDAV, OneDrive, the File System Access API, and local export).

**Architecture:** A single pure helper substitutes the Windows/OneDrive-illegal character set with fullwidth look-alikes (plus dot-leader, control-strip, reserved-name, and trim rules), then it is applied at the only three places a stored title is written: import (`database.ts`), series rename (`executeRenameSeries`), and volume rename (`VolumeEditorModal.handleSave`). Because the cloud/disk path is built *from* the stored title, sanitizing the title makes every downstream path safe with **zero changes to `unified-cloud-manager` or any provider**.

**Tech Stack:** SvelteKit 5 / Svelte 5 runes, TypeScript, Vitest, Dexie.

## Global Constraints

- Worktree/branch: `fix/cloud-rename-sidecar` (stacked on PR #233). All work happens here.
- **Do NOT modify** `unified-cloud-manager.ts` or any provider — they consume already-safe titles.
- Substitution table is fixed (verbatim): `/`->`／`, `\`->`＼`, `:`->`：`, `*`->`＊`, `?`->`？`, `"`->`＂`, `<`->`＜`, `>`->`＞`, `|`->`｜`; dot-leader = `․` (U+2024).
- Going-forward only — no migration of existing stored titles.
- Test runner: `npx vitest run <path>` for one file; `npm test` for the suite.
- Spec: `docs/superpowers/specs/2026-06-29-title-filesystem-safety-design.md`.

---

### Task 1: Pure `sanitizeTitleSegment` helper

**Files:**
- Create: `src/lib/util/sanitize-title.ts`
- Test: `src/lib/util/sanitize-title.test.ts`

**Interfaces:**
- Produces:
  - `sanitizeTitleSegment(raw: string): string` — sanitized segment; `''` if nothing usable remains.
  - `sanitizeRenameTitle(raw: string): { value: string; changed: boolean; empty: boolean }` — UI convenience wrapper.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/util/sanitize-title.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeTitleSegment, sanitizeRenameTitle } from './sanitize-title';

const CTRL = String.fromCharCode(1); // a control char (U+0001)
const DEL = String.fromCharCode(127); // DEL (U+007F)

describe('sanitizeTitleSegment', () => {
  it('substitutes each Windows-illegal char with its fullwidth twin', () => {
    expect(sanitizeTitleSegment('a/b')).toBe('a／b');
    expect(sanitizeTitleSegment('a\\b')).toBe('a＼b');
    expect(sanitizeTitleSegment('Steins;Gate: 0')).toBe('Steins;Gate： 0');
    expect(sanitizeTitleSegment('What If?')).toBe('What If？');
    expect(sanitizeTitleSegment('a*b"c<d>e|f')).toBe('a＊b＂c＜d＞e｜f');
  });

  it('strips control characters and DEL', () => {
    expect(sanitizeTitleSegment('a' + CTRL + 'b' + DEL + 'c')).toBe('abc');
  });

  it('trims leading and trailing spaces but keeps interior ones', () => {
    expect(sanitizeTitleSegment('  Vol 3  ')).toBe('Vol 3');
  });

  it('converts leading, trailing, and all-dot runs to dot leaders, keeping interior dots', () => {
    expect(sanitizeTitleSegment('.')).toBe('․');
    expect(sanitizeTitleSegment('..')).toBe('․․');
    expect(sanitizeTitleSegment('Vol. 3')).toBe('Vol. 3');
    expect(sanitizeTitleSegment('etc.')).toBe('etc․');
  });

  it('suffixes reserved device names (case-insensitive)', () => {
    expect(sanitizeTitleSegment('CON')).toBe('CON_');
    expect(sanitizeTitleSegment('nul')).toBe('nul_');
    expect(sanitizeTitleSegment('Com1')).toBe('Com1_');
    expect(sanitizeTitleSegment('LPT9')).toBe('LPT9_');
    expect(sanitizeTitleSegment('console')).toBe('console'); // not reserved
  });

  it('returns empty string when nothing usable remains', () => {
    expect(sanitizeTitleSegment('   ')).toBe('');
    expect(sanitizeTitleSegment('')).toBe('');
  });

  it('is idempotent', () => {
    for (const raw of ['a/b', '..', 'CON', 'Steins;Gate: 0', 'etc.']) {
      const once = sanitizeTitleSegment(raw);
      expect(sanitizeTitleSegment(once)).toBe(once);
    }
  });
});

describe('sanitizeRenameTitle', () => {
  it('reports value, changed, and empty', () => {
    expect(sanitizeRenameTitle('a/b')).toEqual({ value: 'a／b', changed: true, empty: false });
    expect(sanitizeRenameTitle('Naruto')).toEqual({ value: 'Naruto', changed: false, empty: false });
    expect(sanitizeRenameTitle('   ')).toEqual({ value: '', changed: true, empty: true });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/lib/util/sanitize-title.test.ts`
Expected: FAIL — `Failed to resolve import "./sanitize-title"` / functions not defined.

- [ ] **Step 3: Implement the helper**

The control-char strip uses a `charCodeAt` filter rather than a regex, to avoid embedding literal control bytes in source.

```typescript
// src/lib/util/sanitize-title.ts

/**
 * Make series/volume titles safe as file/folder names on every sync sink:
 * MEGA, Google Drive, WebDAV, OneDrive, the File System Access API, and local export.
 * Illegal characters are substituted with visually-identical fullwidth look-alikes so
 * titles stay human-readable; only control characters are removed.
 */

const FULLWIDTH: Record<string, string> = {
  '/': '／', // FULLWIDTH SOLIDUS
  '\\': '＼', // FULLWIDTH REVERSE SOLIDUS
  ':': '：', // FULLWIDTH COLON
  '*': '＊', // FULLWIDTH ASTERISK
  '?': '？', // FULLWIDTH QUESTION MARK
  '"': '＂', // FULLWIDTH QUOTATION MARK
  '<': '＜', // FULLWIDTH LESS-THAN SIGN
  '>': '＞', // FULLWIDTH GREATER-THAN SIGN
  '|': '｜' // FULLWIDTH VERTICAL LINE
};

const DOT_LEADER = '․'; // ONE DOT LEADER — renders like '.', legal as a filename char
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Sanitize a single path segment (one series OR one volume title).
 * Returns '' when nothing usable remains; callers decide how to treat empty.
 */
export function sanitizeTitleSegment(raw: string): string {
  // 1. strip control chars (code point <= 0x1F) and DEL (0x7F)
  let s = Array.from(raw, (ch) =>
    ch.charCodeAt(0) <= 0x1f || ch.charCodeAt(0) === 0x7f ? '' : ch
  ).join('');
  s = s.replace(/[\\/:*?"<>|]/g, (c) => FULLWIDTH[c]); // 2. fullwidth substitution
  s = s.replace(/^ +| +$/g, ''); // 3. trim leading/trailing spaces
  s = s.replace(/^\.+/, (m) => DOT_LEADER.repeat(m.length)); // 4a. leading dots -> leaders
  s = s.replace(/\.+$/, (m) => DOT_LEADER.repeat(m.length)); // 4b. trailing dots -> leaders
  if (RESERVED_DEVICE_NAME.test(s)) s = `${s}_`; // 5. reserved device names
  return s;
}

export interface SanitizedRename {
  value: string;
  changed: boolean;
  empty: boolean;
}

/** UI convenience: sanitize plus the flags a rename handler needs to notify/block. */
export function sanitizeRenameTitle(raw: string): SanitizedRename {
  const value = sanitizeTitleSegment(raw);
  return { value, changed: value !== raw, empty: value.length === 0 };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/lib/util/sanitize-title.test.ts`
Expected: PASS (all assertions green, no warnings).

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sanitize-title.ts src/lib/util/sanitize-title.test.ts
git commit -m "feat(util): add filesystem-safe title sanitizer"
```

---

### Task 2: Apply at import (`database.ts`)

**Files:**
- Modify: `src/lib/import/database.ts:53-57`
- Test: `src/lib/import/__tests__/database.test.ts`

**Interfaces:**
- Consumes: `sanitizeTitleSegment` (Task 1).
- The DB write at `database.ts:53` maps `ProcessedMetadata.series`/`.volume` -> `VolumeMetadata.series_title`/`.volume_title`. This is the single import/re-download chokepoint (both OCR-content and path-derived titles pass through it).

- [ ] **Step 1: Write the failing test** (append inside the existing `describe` in `src/lib/import/__tests__/database.test.ts`)

```typescript
  it('sanitizes filesystem-illegal characters in series and volume titles', async () => {
    const volume = createProcessedVolume({
      metadata: { series: 'A/B: C', volume: 'Vol?1' }
    });

    await saveVolume(volume);

    const addCall = (db.volumes.add as any).mock.calls[0][0];
    expect(addCall.series_title).toBe('A／B： C');
    expect(addCall.volume_title).toBe('Vol？1');
  });

  it('falls back to Untitled when a title sanitizes to empty', async () => {
    const volume = createProcessedVolume({
      metadata: { series: '   ', volume: '' }
    });

    await saveVolume(volume);

    const addCall = (db.volumes.add as any).mock.calls[0][0];
    expect(addCall.series_title).toBe('Untitled');
    expect(addCall.volume_title).toBe('Untitled');
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/lib/import/__tests__/database.test.ts`
Expected: FAIL — `series_title` is the raw `'A/B: C'`, not the fullwidth form.

- [ ] **Step 3: Implement** — add the import and sanitize the two fields.

At the top of `src/lib/import/database.ts`, add to the imports:

```typescript
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
```

Change lines 55 and 57 inside the `volumeMetadata` object literal:

```typescript
    series_title: sanitizeTitleSegment(metadata.series) || 'Untitled',
    series_uuid: metadata.seriesUuid,
    volume_title: sanitizeTitleSegment(metadata.volume) || 'Untitled',
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/lib/import/__tests__/database.test.ts`
Expected: PASS (existing tests still green — `'My Series'`/`'Volume 01'` are unchanged by the sanitizer).

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/database.ts src/lib/import/__tests__/database.test.ts
git commit -m "feat(import): sanitize titles on write to the volumes table"
```

---

### Task 3: Apply at series rename (`executeRenameSeries` + SeriesView display)

**Files:**
- Modify: `src/lib/util/series-rename.ts` (`executeRenameSeries`, ~line 159)
- Modify: `src/lib/views/SeriesView.svelte` (`saveRename`, ~line 645 and ~line 665)
- Test: `src/lib/util/series-rename.test.ts`

**Interfaces:**
- Consumes: `sanitizeTitleSegment` (Task 1).
- `executeRenameSeries(oldTitle, newTitle, seriesUuid?)` sanitizes `newTitle` before building the preview / cloud rename / DB write, and throws a user-facing `Error` if it sanitizes to empty. SeriesView already surfaces a thrown `Error.message` via its `renameError` slot (line 669/759).

- [ ] **Step 1: Write the failing test** (append inside the existing `describe` in `src/lib/util/series-rename.test.ts`)

```typescript
  it('sanitizes the new series title before cloud rename and DB write', async () => {
    const { db } = await import('$lib/catalog/db');
    const { get } = await import('svelte/store');
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

    vi.mocked(db.volumes.where).mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          volume_uuid: 'vol-1',
          volume_title: 'Volume 1',
          series_uuid: 'series-1',
          series_title: 'Old Series'
        }
      ])
    } as any);
    vi.mocked(get).mockReturnValue({
      'vol-1': { series_uuid: 'series-1', series_title: 'Old Series' }
    });

    await executeRenameSeries('Old Series', 'New/Series', 'series-1');

    expect(unifiedCloudManager.renameSeries).toHaveBeenCalledWith('Old Series', 'New／Series', [
      { volumeUuid: 'vol-1', volumeTitle: 'Volume 1' }
    ]);
    expect(db.volumes.update).toHaveBeenCalledWith('vol-1', { series_title: 'New／Series' });
  });

  it('throws when the new title sanitizes to empty', async () => {
    const { db } = await import('$lib/catalog/db');
    vi.mocked(db.volumes.where).mockReturnValue({
      toArray: vi.fn().mockResolvedValue([])
    } as any);

    await expect(executeRenameSeries('Old Series', '', 'series-1')).rejects.toThrow();
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/lib/util/series-rename.test.ts`
Expected: FAIL — `renameSeries` called with raw `'New/Series'`; empty case does not throw.

- [ ] **Step 3: Implement** in `src/lib/util/series-rename.ts`.

Add to the imports at the top:

```typescript
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
```

At the very start of the `executeRenameSeries` body (just before `// Generate preview of changes`), insert:

```typescript
  // Sanitize the user-supplied title so the stored title is a legal name on every
  // sink (cloud + filesystem + OneDrive + export). title === path going forward.
  newTitle = sanitizeTitleSegment(newTitle);
  if (!newTitle) {
    throw new Error('Series not renamed: the name has no usable characters.');
  }

```

(`newTitle` is a function parameter, so reassigning it flows into the preview, the cloud rename, and the DB writes below.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/lib/util/series-rename.test.ts`
Expected: PASS — including the pre-existing `'New Series'` test (unchanged by the sanitizer).

- [ ] **Step 5: Update SeriesView so its success snackbar shows the sanitized name**

In `src/lib/views/SeriesView.svelte`, add to the script imports:

```typescript
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
```

In `saveRename`, replace the success lines (currently lines 664-665):

```typescript
      nav.toSeries(newTitle, { replaceState: true });
      showSnackbar(`Renamed to "${newTitle}"`);
```

with:

```typescript
      const finalTitle = sanitizeTitleSegment(newTitle);
      nav.toSeries(finalTitle, { replaceState: true });
      showSnackbar(`Renamed to "${finalTitle}"`);
```

(The empty/whitespace case is still caught by the existing `if (!newTitle)` guard at line 647 and, for sanitize-to-empty input, by the `Error` thrown from `executeRenameSeries` which lands in `renameError` at line 669.)

- [ ] **Step 6: Verify the file's tests and type-check**

Run: `npx vitest run src/lib/util/series-rename.test.ts && npm run check`
Expected: tests PASS; svelte-check reports 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/util/series-rename.ts src/lib/util/series-rename.test.ts src/lib/views/SeriesView.svelte
git commit -m "feat(series): sanitize new series title on rename"
```

---

### Task 4: Apply at volume rename (`VolumeEditorModal.handleSave`)

**Files:**
- Modify: `src/lib/components/VolumeEditorModal.svelte` (`handleSave`, lines 196-221; imports line 17)

**Interfaces:**
- Consumes: `sanitizeRenameTitle` (Task 1).
- The sanitize/empty/changed decision is fully unit-tested in Task 1 (`sanitizeRenameTitle`). This task is thin wiring: it sanitizes `finalSeriesTitle` and `volumeTitle` before they feed `metadataUpdates`, `renameVolumeInCloud`, and `updateVolumeStats`, so all three writes (DB, cloud, localStorage) use the same safe values. **No mount test is added** — the heavyweight modal has no existing test harness, and a full mount would require mocking the entire sync/store surface to re-verify logic already covered by `sanitizeRenameTitle`. Coverage = the Task 1 unit tests + review of this diff + the manual smoke in Step 4.

- [ ] **Step 1: Add the import**

In `src/lib/components/VolumeEditorModal.svelte`, immediately after `import { showSnackbar } from '$lib/util';` (line 17), add:

```typescript
  import { sanitizeRenameTitle } from '$lib/util/sanitize-title';
```

- [ ] **Step 2: Sanitize both titles before any write**

In `handleSave`, immediately after the `isNewSeries` block (after line 208, where `finalSeriesTitle` is finalized) and before the `// Update IndexedDB metadata` comment (line 210), insert:

```typescript
      // Sanitize so the stored title is a legal name on every sink (cloud + filesystem +
      // OneDrive + export); title === path going forward. Notify the user of any change;
      // block only when a field has no usable characters.
      const safeSeries = sanitizeRenameTitle(finalSeriesTitle);
      const safeVolume = sanitizeRenameTitle(volumeTitle);
      if (safeSeries.empty || safeVolume.empty) {
        showSnackbar("Name can't be empty or only unusable characters.");
        return;
      }
      if (safeSeries.changed || safeVolume.changed) {
        showSnackbar(
          `Saved as “${safeSeries.value} / ${safeVolume.value}” to keep the name file-safe.`
        );
      }
      finalSeriesTitle = safeSeries.value;
      volumeTitle = safeVolume.value;
```

The existing code from line 210 onward (`metadataUpdates`, the cloud-rename gate at 223-241, `updateVolumeStats` at 248-255) then reads the sanitized `finalSeriesTitle` / `volumeTitle` unchanged. The `return` lands in the existing `finally { saving = false; }`.

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 4: Manual smoke (verify)**

Open the volume editor, rename a volume's title to `A/B:C?`, save. Confirm the snackbar reports the file-safe name and the catalog shows `A／B：C？`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/VolumeEditorModal.svelte
git commit -m "feat(volume): sanitize title and series on volume rename"
```

---

### Task 5: Full-suite gate

- [ ] **Step 1: Run the whole suite + type-check**

Run: `npm test && npm run check`
Expected: all tests PASS; svelte-check 0 errors.

- [ ] **Step 2: Confirm the sync layer was untouched**

Run: `git diff --stat origin/fix/cloud-rename-sidecar...HEAD`
Expected: no changes to `unified-cloud-manager.ts` or any file under `src/lib/util/sync/providers/`.

- [ ] **Step 3 (if anything fails):** use superpowers:systematic-debugging — do not patch blindly.
