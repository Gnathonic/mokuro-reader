# Reading history phase 4: device views — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Readable device labels (generated, renamable, class-correctable, mergeable), synced through `volume-data.json`'s `tracking.devices`, and per-device stats on the reading-speed page.

**Architecture:** Facts stay in each device's own `history/<device>/device.json` (unchanged). User choices live in `tracking.devices[id] = {name?, class?, merged_into?, lastUpdated}`, merged per id newest-wins with the tracking section's future-stamp clamp and forfeit-on-bogus. A pure `devices.ts` resolves merges and builds labels; the stats engine keeps per-raw-device totals per volume, and a derived store groups them by resolved device. Three UI entry points share one name field: a Devices block on the cloud screen, inline rename in a per-device stats card, and a one-time banner when a second device appears. The position offer names the other device.

**Tech Stack:** SvelteKit 5 (runes), Dexie 4 (`liveQuery`), flowbite-svelte, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md` (Device record, Labels, Rollout 4).

## Global Constraints

- The device UUID is never shown in the UI.
- Legacy pseudo-devices (`legacy:<volume>`) are never listed as devices; `isDeviceId` filters every list and label key.
- A single-device user never sees a device anywhere (card, banner, Devices block).
- Generated label `<Class> · <OS> · <Browser>`; same-label collisions get ` (since Mon YYYY)` (UTC month of first seen), then ordinal ` 2`, ` 3`.
- No Dexie schema change, no `device.json` change.
- Modal action buttons in `relative z-10` containers; no layout motion on status UI.
- Never mention any public deployment domain. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings (adopted defaults; owner may revisit)

- R1 labels only in `tracking.devices`. R2 stamp field is `lastUpdated` (spec said `updated_at`; siblings use `lastUpdated`). R3 `merged_into` applies only when grouping by device (stats + lists); event ids never rewritten. R4 `planPosition` keeps raw ids. R5 legacy views form a "Before history" row. R6 known devices = facts rows ∪ native event device ids.
- Q1 the Devices block sits on the cloud screen (`CloudView.svelte`), after Storage, shown with a provider connected and ≥2 raw device ids known.
- Q2 merging does not carry the source name. Q3 "Before history" includes the unexplained pre-history baseline so rows sum to the page totals. Q4 volume-editor adjusts form a separate "Edits" row, hidden when zero. Q5 the position offer banner/chip name the other device by label. Q6 banner dismissal per browser. Q7 one stamp per device entry: concurrent rename + merge keep the newer edit.

## Corrections (BINDING — they override task text below)

**Task 1**

- **C1. Interfaces.** No code change. Record `DeviceLabel` (in `R/types.ts`), `KnownDevice.facts?` (optional) and `DeviceView.generated` as the canonical shapes. Tasks 2–6 must consume exactly these.

**Task 2** (it duplicates `DeviceLabel` and the class set)

- **C2a. Step 3(c).** Delete the `export interface DeviceLabel {…}` block. Change the Step 3(a) import to:
  - `import type { DeviceClass, DeviceLabel, PauseCount } from '$lib/reading-history/types';`
  - then add `export type { DeviceLabel };`
  - Tasks 3, 4 and 5 already `import type { DeviceLabel } from '$lib/settings/tracking-data'`, so the re-export keeps them working.
- **C2b. Step 3(c) and (d).** Delete `DEVICE_CLASSES` and the private `isDeviceClass`. Add `import { isDeviceClass, resolveDevice } from '$lib/reading-history/devices';` in Step 3(a), and drop the separate import in Step 7(a). `devices.ts` is pure, so importing it at runtime this early is safe.
- **C2c. Step 0.** Replace the expected grep text with `resolveDevice(id: string, labels: Readonly<Record<string, DeviceLabel>>): string`. Also replace "If devices.ts declares its own interface DeviceLabel…" with: "devices.ts imports `DeviceLabel` from `./types`; nothing to change."
- **C2d. `mergeDeviceLabels`, `mergeReaches`, `patchDeviceLabel`, `unmergeDevice` (low priority).** Read labels with `Object.hasOwn(map, id) ? map[id] : undefined`, as Task 1's `labelOf` does. Today `merged['constructor']` reads `Object.prototype.constructor`, and `isDeviceId('constructor')` is true. In practice ids are UUIDs.

**Task 3**

- **C3. Interfaces → Consumes.** Change `KnownDevice` to `facts?: …` and add `generated: string` to `DeviceView`. In Step 15's `knownDevicesFrom`, declare `const own: NonNullable<KnownDevice['facts']> = { class: row.class };`.
- **C4. Notes (binding for Tasks 4–7).** The stores `devices`, `knownDevices`, `deviceStats` and `deviceFacts` live in `$lib/reading-history/device-stats`. `ownDeviceId` lives in `position-store`. `CLASS_NAMES` and the `DeviceView` and `KnownDevice` types stay in `$lib/reading-history/devices`.

**Task 4**

- **C5a. Step 8, `DevicesSettings.svelte` imports.** Use:
  - `import { CLASS_NAMES, type DeviceView } from '$lib/reading-history/devices';`
  - `import { knownDevices, devices } from '$lib/reading-history/device-stats';`
- **C5b. Step 8, gate.** Change `{#if $devices.size >= 2}` to `{#if $knownDevices.length >= 2}`. `$devices` also holds synthesized merge-target views, so it can reach 2 with only one real raw id.
- **C6. Step 6 test mocks.** Replace the single `vi.mock('$lib/reading-history/devices', …)` with two mocks:
  - `vi.mock('$lib/reading-history/devices', () => ({ CLASS_NAMES: {…} }))`
  - `vi.mock('$lib/reading-history/device-stats', () => ({ devices: {subscribe…}, knownDevices: { subscribe: (run) => state.devices.subscribe((m) => run([...m.keys()].map((id) => ({ id, firstSeen: '' })))) } }))`
- **C7. Notes 1 and 4.** Drop the "kept the design's path" caveat. The paths are settled by C4.

**Task 5** (its interface does not match what Task 3 produces)

- **C8. Interfaces → Consumes.** Replace the block with Task 3's real shapes:
  - `deviceStats: Readable<DeviceStats>`, where `DeviceStats = { rows: DeviceStatsRow[]; totalTimeMs; totalChars; nativeGroups }`.
  - Each row is `{ key, kind, members, timeMs, readChars, skippedChars, sampleMs, sampleChars, charsPerMinute, share, firstReadAt, lastReadAt }`. The id field is `key`, not `id`.
  - `devices` is imported from `$lib/reading-history/device-stats`.
- **C9. Step 3, `DeviceStatsCard.svelte`.**
  - Imports: `import { deviceStats, devices, type DeviceStatsRow } from '$lib/reading-history/device-stats'; import type { DeviceView } from '$lib/reading-history/devices';`
  - Use `let groups = $derived($deviceStats.nativeGroups);` and `{#if groups >= 2}`.
  - Use `let rows = $derived(ordered($deviceStats.rows, $devices));` and delete `total`.
  - In `ordered`, `nameOf`, the `{#each}` key (`row.key`), `$devices.get(row.key)` and `editing === row.key`, change every `.id`/`r.id` on a row to `.key`.
  - `share(row)`: `row.timeMs <= 0 || row.share <= 0 ? '—' : row.share < 0.01 ? '<1% of time' : \`${Math.round(row.share \* 100)}% of time\``.
  - `time(ms)`: `(ms < 0 ? '−' : '') + formatDuration(Math.abs(ms) / 60_000)`. Task 3 says Edits can be negative.
- **C10. Step 7, `SecondDeviceBanner.svelte`.**
  - Import `deviceStats, devices` from `$lib/reading-history/device-stats` (drop the `devices` import from `…/devices`).
  - Use `let groups = $derived($deviceStats.nativeGroups);`.
- **C11. Step 1, `device-fixtures.ts`.**
  - `view()`: add `generated: \`Label ${id}\``(prefer`over.generated ?? label`). Without it, the fixture misses a required `DeviceView`field and`svelte-check` fails.
  - `row(kind, key, over)` returns a full `DeviceStatsRow`: `{ key, kind, members: kind === 'device' ? [key] : [], timeMs: 60*MIN, readChars: 6000, skippedChars: 0, sampleMs: 0, sampleChars: 0, charsPerMinute: null, share: 0, firstReadAt: null, lastReadAt: null, ...over }`.
  - Add `export const statsOf = (rows: DeviceStatsRow[]) => ({ rows, totalTimeMs: rows.reduce((s, r) => s + r.timeMs, 0), totalChars: rows.reduce((s, r) => s + r.readChars, 0), nativeGroups: rows.filter((r) => r.kind === 'device').length })`.
- **C12. Steps 1, 5 and 9 tests.**
  - `state.rows` becomes `Writable<DeviceStats>`. Every `state.rows.set([...])` becomes `state.rows.set(statsOf([...]))`. Initial values use `statsOf([])`.
  - Collapse the two `vi.mock`s into one: `vi.mock('$lib/reading-history/device-stats', () => ({ deviceStats: …, devices: … }))`.
  - In the "shows time, characters…" test, set `share: 0.75` and `share: 0.25` on the two rows.
  - Step 9 `ReadingSpeedView.devices.test.ts`:
    - `rowsStore` becomes `createStore<DeviceStats>(statsOf([]))`.
    - `deviceRow(id)` returns a full row with `key: id` and `share: 0.5`.
    - `deviceView` gains `generated`.
    - Return `devices: devicesStore` from the `device-stats` mock and delete the `$lib/reading-history/devices` mock.
- **C13. Step 13 e2e (real bug).** `deviceStats` counts only volumes that have a record (Task 3 iterates the `volumes` store). Neither `readHere` nor `readOnPhone` creates one, so `nativeGroups` stays 0 and the banner and card never appear.
  - In `readHere`: add `const { updateProgress } = await import('/src/lib/settings/volume-data.ts');` and `updateProgress(volume, p, p * 300);` after each `recordEvent`.
  - In `readOnPhone`: after `notifyEventsRecorded(events)`, add `(await import('/src/lib/settings/volume-data.ts')).updateProgress(volume, 3, 900);`.
- **C14. Step 13 imports.** Use `import { test, expect, type Browser, type Page } from '@playwright/test'; import { WebDavStub } from './helpers/webdav-stub';` so Task 7 can append without editing imports.
- **C15. Notes "Assumptions 1/3".** Replace them with "consumes Task 3/4 as built (C8)". Task 4's field already has `onDone`.

**Task 6**

- **C16. Steps 7 and 11.** In both components, use `import { devices } from '$lib/reading-history/device-stats';`.
- **C16b. Steps 5 and 9.** In both test files, mock `'$lib/reading-history/device-stats'` instead of `'$lib/reading-history/devices'`. The `import type { DeviceView } from '$lib/reading-history/devices'` lines stay.
- **C17. Steps 1, 5 and 9 fixtures.** Add `generated: label` to `dv()` (Step 1), and `generated: 'Phone · Android · Chrome'` to `pixel` (Steps 5 and 9). Without it, `svelte-check` reports a missing required property.
- **Notes "Module path assumed".** Replace with "`devices` comes from `device-stats.ts` (Task 3)".

**Task 7**

- **C18. Files and Step 1.**
  - Change "Create: `e2e/devices.spec.ts`" to "Modify: append to `e2e/devices.spec.ts` (created by Task 5)".
  - In Step 1, drop the import line (C14 already provides `Browser`, `Page` and `WebDavStub`). Wrap the three tests in `test.describe('device views through sync', () => { … })` and append that after Task 5's describe.
  - Step 2 expected result: "5 passed".
- **C19. `deviceIds()` helper.** Use `await import('/src/lib/reading-history/device-stats.ts')`.
- **C20. Card row testid.** Replace `getByTestId('device-stats-row')` with `getByTestId('device-row')` (2 places: `rows` and `phoneRows`). Task 5's card uses `device-row`; the scope is already the `device-stats` card. Update the DOM-contract note to match.
- **C21. Banner after naming.** Task 5 keeps the banner up with "Saved.". Replace `await expect(banner).toBeHidden();` with:
  ```
  await expect(banner).toContainText('Saved.');
  await banner.getByRole('button', { name: 'Close' }).click();
  await expect(banner).toBeHidden();
  ```
- **C22. Cloud rows have no label text.** Task 4 rows show an unnamed device only as the input's placeholder, and a named one only as the input's value. Neither is textContent, so `filter({ hasText })` cannot find them. Replace:
  - `phoneRow = settings.getByTestId('device-row').filter({ hasText: 'Desktop · ' })` with `settings.getByTestId('device-row').filter({ hasNotText: 'This device' }).filter({ has: laptop.getByPlaceholder(/^Desktop · /) })`.
  - `filter({ hasText: 'Phone · ' })` with `filter({ has: laptop.getByPlaceholder(/^Phone · /) })`.
  - `filter({ hasText: 'Old tablet' })` with `filter({ has: phone.getByPlaceholder('Tablet · Android · Chrome') })`.
  - Drop the "each `device-row` shows its label as visible text" line from the contract notes.
- **C23. UUID never shown (coverage gap).** At the end of test 2 add:
  ```
  await expect(card).not.toContainText(TABLET);
  await expect(card).not.toContainText(await deviceId(laptop));
  await go(laptop, '#/cloud');
  await expect(settings).not.toContainText(TABLET);
  ```
  In test 3 add `await expect(offer).not.toContainText(await deviceId(phone));`.
- **C24. Step 3 note.** The pinned assertion is at `position-offer.spec.ts:285`, not :281. Delete the alternative regex fix; Task 6 Step 13 owns that edit.
- **C25. Step 6 CLAUDE.md block.**
  - Add the module path: "grouped by `resolveDevice` in `deviceStats` (`device-stats.ts`; also `devices`, `knownDevices`, `deviceFacts`)".
  - Add: "the banner stays as 'Saved.' after naming until closed".

## Review Focus

Each line is assigned to a task; that task adds the test.

1. **Task 4: this device merged into another group from a remote device.** No `DevicesSettings` test covers it. The group head should carry "This device" and offer no "Merge into…". This device's id should appear as a member with "Unmerge", and the rename field should edit the target.
2. **Task 4: the Devices block gate counts synthesized merge targets.** A single-device user whose own label is `merged_into` an id with no facts or events would see the block. Add a test: one known id plus `labels: { own: merged('gone') }` must give no `devices-settings`.
3. **Task 5: a negative Edits row in the card.** When the zero clamp gives time back, the row should render a signed duration with share "—". The card should stay up, and its rows should not jump. No component test has `timeMs < 0`.
4. **Task 2: a rename on one device and a merge of the same device on another between syncs.** Q7 says only the newer edit survives and the other is silently lost. No sync-level test pins this. Add it to `unified-sync-service.test.ts` beside the per-id merge case.
5. **Task 3: `ownDeviceId` is `null` until `initPositionOffers` resolves.** `devices` is first built with `own = ''`, so nothing is "This device". Rows in the card and the Devices block reorder when the id arrives, and the banner appears late. No test covers the null→id transition or checks that nothing reorders.

---

### Task 1: `isDeviceId` and the pure `devices.ts` module (group resolution, generated labels, `labelDevices`)

**Files:**

- Modify: `src/lib/reading-history/paths.ts`. Insert before `export function parseHistoryPath` (:46) and change :50. `DEVICE_ID_RE` at :17 stays as it is.
- Modify: `src/lib/reading-history/paths.test.ts`. Change the import block (:2-11) and append one test before the closing `});` (:63).
- Modify: `src/lib/reading-history/types.ts`. Change the doc comment at :95 and add `DeviceLabel` after `DeviceFacts` (:96-103).
- Create: `src/lib/reading-history/devices.ts`
- Test: `src/lib/reading-history/devices.test.ts` (new)

**Interfaces:**

- Consumes:
  - `DeviceClass` and `DeviceFacts` from `./types`.
  - `DEVICE_ID_RE` (private) and `legacyDeviceFor` from `./paths`.
- Produces:
  - `paths.ts`: `export function isDeviceId(id: string): boolean`
  - `types.ts`: `export interface DeviceLabel { name?: string; class?: DeviceClass; merged_into?: string; lastUpdated: string }`
    - The design puts this in `tracking-data.ts`, but it lives here so `devices.ts` stays pure and Task 1 does not depend on Task 2. Task 2 imports it from here.
  - `devices.ts`:
    - `export const CLASS_NAMES: Readonly<Record<DeviceClass, string>>`
    - `export const UNKNOWN_DEVICE_LABEL = 'Unknown device'`
    - `export function isDeviceClass(value: unknown): value is DeviceClass`
    - `export interface KnownDevice { id: string; facts?: Pick<DeviceFacts, 'class' | 'os' | 'browser'>; firstSeen: string }`
    - `export interface DeviceView { id: string; label: string; generated: string; named: boolean; class: DeviceClass; detectedClass: DeviceClass; isThisDevice: boolean; canonical: string; mergedFrom: string[]; firstSeen: string }`. This is the design's shape plus `generated`.
    - `export function resolveDevice(id: string, labels: Readonly<Record<string, DeviceLabel>>): string`
    - `export function generatedLabel(facts?: Pick<DeviceFacts, 'class' | 'os' | 'browser'>, override?: DeviceClass): string`
    - `export function labelDevices(known: readonly KnownDevice[], labels: Readonly<Record<string, DeviceLabel>>, own: string): Map<string, DeviceView>`

---

#### Cycle 1: `isDeviceId`

- [ ] **Step 1: Write the failing test.** In `src/lib/reading-history/paths.test.ts`, replace the import block (:2-11):

```ts
import {
  historyDeviceFilePath,
  historyLegacyFilePath,
  legacyDeviceFor,
  historyMonthOf,
  historySegmentPath,
  isHistoryFileName,
  isHistoryFilePath,
  parseHistoryPath
} from './paths';
```

with:

```ts
import {
  historyDeviceFilePath,
  historyLegacyFilePath,
  legacyDeviceFor,
  historyMonthOf,
  historySegmentPath,
  isHistoryFileName,
  isDeviceId,
  isHistoryFilePath,
  parseHistoryPath
} from './paths';
```

Then insert this test just before the file's final `});` (:63):

```ts
it('a device id is what may name a history folder; legacy pseudo-devices are not devices', () => {
  expect(isDeviceId(DEV)).toBe(true);
  expect(isDeviceId('A-1')).toBe(true);
  expect(isDeviceId('x'.repeat(64))).toBe(true);
  expect(isDeviceId('x'.repeat(65))).toBe(false);
  expect(isDeviceId('')).toBe(false);
  expect(isDeviceId(legacyDeviceFor('vol-1'))).toBe(false);
  expect(isDeviceId('bad id!')).toBe(false);
  // `devices/<id>` namespaces a device's bogus-stamp key in `tracking`:
  // no device id can contain the slash.
  expect(isDeviceId('devices/x')).toBe(false);
});
```

- [ ] **Step 2: Run it.** `npx vitest run src/lib/reading-history/paths.test.ts --testTimeout=30000`
      Expected: FAIL. 1 failed and 13 passed, with `TypeError: (0 , isDeviceId) is not a function`.

- [ ] **Step 3: Implement.** In `src/lib/reading-history/paths.ts`, insert this directly above `export function parseHistoryPath(path: string): HistoryPath | null {` (:46):

```ts
/**
 * A real device: an id that may name a `history/<device>/` folder. Legacy
 * pseudo-devices (`legacy:<volume>`) fail it — `:` is not allowed — so every
 * device list, count and label filters with this.
 */
export function isDeviceId(id: string): boolean {
  return DEVICE_ID_RE.test(id);
}
```

Inside `parseHistoryPath`, replace `  if (!DEVICE_ID_RE.test(device)) return null;` with `  if (!isDeviceId(device)) return null;`

- [ ] **Step 4: Run it.** `npx vitest run src/lib/reading-history/paths.test.ts --testTimeout=30000`
      Expected: PASS (14 passed).

#### Cycle 2: `DeviceLabel`, `resolveDevice`, `generatedLabel`, `isDeviceClass`

- [ ] **Step 5: Write the failing test.** Create `src/lib/reading-history/devices.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generatedLabel, isDeviceClass, resolveDevice } from './devices';
import { legacyDeviceFor } from './paths';
import type { DeviceLabel } from './types';

const STAMP = '2026-10-01T00:00:00.000Z';
const merged = (target: string): DeviceLabel => ({ merged_into: target, lastUpdated: STAMP });

const PHONE = { class: 'phone', os: 'Android', browser: 'Chrome' } as const;
const DESKTOP = { class: 'desktop', os: 'Windows', browser: 'Firefox' } as const;

describe('resolveDevice', () => {
  it('an unmerged device is its own group', () => {
    expect(resolveDevice('a', {})).toBe('a');
    expect(resolveDevice('a', { a: { name: 'Pixel 8', lastUpdated: STAMP } })).toBe('a');
  });

  it('follows merged_into to the end of a chain', () => {
    const labels = { a: merged('b'), b: merged('c') };
    expect(resolveDevice('a', labels)).toBe('c');
    expect(resolveDevice('b', labels)).toBe('c');
    expect(resolveDevice('c', labels)).toBe('c');
  });

  it('a target this device has never seen still resolves', () => {
    expect(resolveDevice('a', { a: merged('x') })).toBe('x');
  });

  it('every device on or into a cycle shows unmerged (concurrent merges A→B, B→A)', () => {
    const labels = { a: merged('b'), b: merged('a'), d: merged('a') };
    expect(resolveDevice('a', labels)).toBe('a');
    expect(resolveDevice('b', labels)).toBe('b');
    expect(resolveDevice('d', labels)).toBe('d');
    expect(resolveDevice('s', { s: merged('s') })).toBe('s');
  });

  it('never follows into a legacy pseudo-device, nor reads inherited object keys', () => {
    expect(resolveDevice('a', { a: merged(legacyDeviceFor('vol-1')) })).toBe('a');
    expect(resolveDevice('constructor', {})).toBe('constructor');
  });
});

describe('generatedLabel', () => {
  it('is class · OS · browser, skipping what is unknown', () => {
    expect(generatedLabel(PHONE)).toBe('Phone · Android · Chrome');
    expect(generatedLabel({ class: 'desktop', os: 'Linux' })).toBe('Desktop · Linux');
    expect(generatedLabel({ class: 'tablet', browser: 'Safari' })).toBe('Tablet · Safari');
  });

  it('the user’s class correction replaces the detected one', () => {
    expect(generatedLabel(DESKTOP, 'laptop')).toBe('Laptop · Windows · Firefox');
  });

  it('a device nothing is known about is "Unknown device"', () => {
    expect(generatedLabel(undefined)).toBe('Unknown device');
    expect(generatedLabel({ class: 'unknown' })).toBe('Unknown device');
    expect(generatedLabel({ class: 'unknown', os: 'Linux', browser: 'Firefox' })).toBe(
      'Device · Linux · Firefox'
    );
  });

  it('knows the closed set of classes', () => {
    expect(isDeviceClass('laptop')).toBe(true);
    expect(isDeviceClass('watch')).toBe(false);
    expect(isDeviceClass('toString')).toBe(false);
    expect(isDeviceClass(undefined)).toBe(false);
  });
});
```

- [ ] **Step 6: Run it.** `npx vitest run src/lib/reading-history/devices.test.ts --testTimeout=30000`
      Expected: FAIL with `Error: Failed to resolve import "./devices" from "src/lib/reading-history/devices.test.ts". Does the file exist?` and no tests run.

- [ ] **Step 7: Implement.** In `src/lib/reading-history/types.ts`, replace the comment at :95, `/** Facts a device records about itself. User labels live elsewhere (phase 4). */`, with:

```ts
/** Facts a device records about itself. User labels are `DeviceLabel`, synced apart. */
```

Directly after the closing `}` of `interface DeviceFacts` (:103), add:

```ts
/**
 * The user's choices about a device (phase 4), which any device may edit:
 * `volume-data.json → tracking.devices[device]`, newest `lastUpdated` wins per
 * device and the entry is replaced whole. `lastUpdated`, not the spec's
 * `updated_at`, like every other `tracking` entry.
 */
export interface DeviceLabel {
  /** Trimmed, non-empty. Absent = the generated label. */
  name?: string;
  /** The user's correction of the detected class. Absent = detected. */
  class?: DeviceClass;
  /** This device's events count as that device's (another real device id). */
  merged_into?: string;
  lastUpdated: string;
}
```

Create `src/lib/reading-history/devices.ts`:

```ts
import { isDeviceId } from './paths';
import type { DeviceClass, DeviceFacts, DeviceLabel } from './types';

/**
 * Device labels (phase 4, spec: "Device record → Labels"). Pure: no stores,
 * no IndexedDB.
 *
 * - A device's GROUP is where its `merged_into` chain ends (`resolveDevice`).
 *   Only device lists and per-device stats group; event ids are never
 *   rewritten.
 * - The UUID is never shown. An unnamed device shows its generated label,
 *   `<class> · <OS> · <browser>`. Devices whose generated labels collide get
 *   their first-seen month (UTC, so every device agrees), then a number.
 *   Collisions are decided over EVERY known device, named and merged ones
 *   included, so renaming or merging one never relabels another.
 * - "This device" is a flag on the group that holds it, never label text.
 */

export const CLASS_NAMES: Readonly<Record<DeviceClass, string>> = {
  phone: 'Phone',
  tablet: 'Tablet',
  laptop: 'Laptop',
  desktop: 'Desktop',
  unknown: 'Device'
};

export const UNKNOWN_DEVICE_LABEL = 'Unknown device';

const DEVICE_CLASSES = Object.keys(CLASS_NAMES) as DeviceClass[];

export function isDeviceClass(value: unknown): value is DeviceClass {
  return (DEVICE_CLASSES as unknown[]).includes(value);
}

/** Labels arrive from a synced file: never read an inherited key (`constructor`). */
function labelOf(
  labels: Readonly<Record<string, DeviceLabel>>,
  id: string
): DeviceLabel | undefined {
  return Object.prototype.hasOwnProperty.call(labels, id) ? labels[id] : undefined;
}

/**
 * The group `id` counts under: follow `merged_into` to the end. A device on,
 * or leading into, a cycle (two devices merged into each other between
 * syncs) resolves to itself, so every one of them shows unmerged — the same
 * answer on every device, since it depends only on the synced labels. A
 * target this device has never seen still resolves.
 */
export function resolveDevice(id: string, labels: Readonly<Record<string, DeviceLabel>>): string {
  const seen = new Set([id]);
  let at = id;
  for (;;) {
    const next = labelOf(labels, at)?.merged_into;
    if (next === undefined || !isDeviceId(next)) return at;
    if (seen.has(next)) return id;
    seen.add(next);
    at = next;
  }
}

/** `<class> · <OS> · <browser>`, skipping what is unknown. */
export function generatedLabel(
  facts?: Pick<DeviceFacts, 'class' | 'os' | 'browser'>,
  override?: DeviceClass
): string {
  const cls = override ?? facts?.class ?? 'unknown';
  if (cls === 'unknown' && !facts?.os && !facts?.browser) return UNKNOWN_DEVICE_LABEL;
  return [CLASS_NAMES[cls], facts?.os, facts?.browser].filter(Boolean).join(' · ');
}
```

- [ ] **Step 8: Run it.** `npx vitest run src/lib/reading-history/devices.test.ts --testTimeout=30000`
      Expected: PASS (9 passed).

#### Cycle 3: `labelDevices`

- [ ] **Step 9: Write the failing test.** Make three edits to `src/lib/reading-history/devices.test.ts`.

First, replace the line `import { generatedLabel, isDeviceClass, resolveDevice } from './devices';` with:

```ts
import {
  generatedLabel,
  isDeviceClass,
  labelDevices,
  resolveDevice,
  type KnownDevice
} from './devices';
```

Second, directly after the `const DESKTOP = …` line, add:

```ts
function known(id: string, facts: KnownDevice['facts'], firstSeen: string): KnownDevice {
  return { id, facts, firstSeen };
}
```

Third, append at the end of the file:

```ts
describe('labelDevices', () => {
  it('labels each device, marks this one, and never shows a legacy pseudo-device', () => {
    const views = labelDevices(
      [
        known('own', DESKTOP, '2026-01-10T00:00:00.000Z'),
        known('phone', PHONE, '2026-02-10T00:00:00.000Z'),
        known(legacyDeviceFor('vol-1'), undefined, '2025-01-01T00:00:00.000Z')
      ],
      {},
      'own'
    );
    expect([...views.keys()]).toEqual(['own', 'phone']);
    expect(views.get('own')).toEqual({
      id: 'own',
      label: 'Desktop · Windows · Firefox',
      generated: 'Desktop · Windows · Firefox',
      named: false,
      class: 'desktop',
      detectedClass: 'desktop',
      isThisDevice: true,
      canonical: 'own',
      mergedFrom: [],
      firstSeen: '2026-01-10T00:00:00.000Z'
    });
    expect(views.get('phone')).toMatchObject({
      label: 'Phone · Android · Chrome',
      isThisDevice: false
    });
  });

  it('a user name is shown verbatim; a class correction changes the class, not the detected one', () => {
    const views = labelDevices(
      [
        known('a', DESKTOP, '2026-01-10T00:00:00.000Z'),
        known('b', PHONE, '2026-02-10T00:00:00.000Z'),
        known('c', PHONE, '2026-02-11T00:00:00.000Z')
      ],
      {
        a: { class: 'laptop', lastUpdated: STAMP },
        b: { name: 'Pixel 8', lastUpdated: STAMP },
        c: { name: '   ', lastUpdated: STAMP }
      },
      'a'
    );
    expect(views.get('a')).toMatchObject({
      label: 'Laptop · Windows · Firefox',
      named: false,
      class: 'laptop',
      detectedClass: 'desktop'
    });
    expect(views.get('b')).toMatchObject({ label: 'Pixel 8', named: true, class: 'phone' });
    expect(views.get('c')).toMatchObject({ named: false });
  });

  it('devices that generate the same label both get their first-seen month (UTC)', () => {
    const views = labelDevices(
      [
        // 23:30 on 28 Feb in New York is already March in UTC.
        known('a', PHONE, '2026-02-28T23:30:00-05:00'),
        known('b', PHONE, '2026-06-02T00:00:00.000Z'),
        known('c', DESKTOP, '2026-04-01T00:00:00.000Z')
      ],
      {},
      'c'
    );
    expect(views.get('a')!.label).toBe('Phone · Android · Chrome (since Mar 2026)');
    expect(views.get('b')!.label).toBe('Phone · Android · Chrome (since Jun 2026)');
    expect(views.get('c')!.label).toBe('Desktop · Windows · Firefox');
  });

  it('same label and same month: numbered by first seen, then id', () => {
    const views = labelDevices(
      [
        known('z', PHONE, '2026-03-20T00:00:00.000Z'),
        known('y', PHONE, '2026-03-05T00:00:00.000Z'),
        known('x', PHONE, '2026-03-05T00:00:00.000Z')
      ],
      {},
      'x'
    );
    expect(views.get('x')!.label).toBe('Phone · Android · Chrome (since Mar 2026)');
    expect(views.get('y')!.label).toBe('Phone · Android · Chrome (since Mar 2026) 2');
    expect(views.get('z')!.label).toBe('Phone · Android · Chrome (since Mar 2026) 3');
  });

  it('a device keeps its label when another is renamed or merged', () => {
    const devices = [
      known('a', PHONE, '2026-03-01T00:00:00.000Z'),
      known('b', PHONE, '2026-05-01T00:00:00.000Z')
    ];
    const before = labelDevices(devices, {}, 'a').get('a')!.label;
    const renamed = labelDevices(devices, { b: { name: 'Pixel 8', lastUpdated: STAMP } }, 'a');
    const mergedAway = labelDevices(devices, { b: merged('a') }, 'a');
    expect(before).toBe('Phone · Android · Chrome (since Mar 2026)');
    expect(renamed.get('a')!.label).toBe(before);
    expect(mergedAway.get('a')!.label).toBe(before);
    // The renamed device still offers its generated label as the placeholder.
    expect(renamed.get('b')!.generated).toBe('Phone · Android · Chrome (since May 2026)');
  });

  it('a merged device points at its group; the group lists it and carries "This device"', () => {
    const views = labelDevices(
      [
        known('own', PHONE, '2026-01-01T00:00:00.000Z'),
        known('old', PHONE, '2025-11-01T00:00:00.000Z'),
        known('pc', DESKTOP, '2026-02-01T00:00:00.000Z')
      ],
      { own: merged('pc'), old: merged('own') },
      'own'
    );
    expect(views.get('pc')).toMatchObject({
      canonical: 'pc',
      mergedFrom: ['old', 'own'],
      isThisDevice: true
    });
    expect(views.get('own')).toMatchObject({
      canonical: 'pc',
      mergedFrom: [],
      isThisDevice: false
    });
    expect(views.get('old')).toMatchObject({
      canonical: 'pc',
      mergedFrom: [],
      isThisDevice: false
    });
  });

  it('a merge target this device has never seen gets a group of its own', () => {
    const views = labelDevices(
      [
        known('own', DESKTOP, '2026-01-01T00:00:00.000Z'),
        known('a', PHONE, '2026-03-01T00:00:00.000Z')
      ],
      { a: merged('gone') },
      'own'
    );
    expect(views.get('gone')).toMatchObject({
      label: 'Unknown device',
      canonical: 'gone',
      mergedFrom: ['a'],
      detectedClass: 'unknown',
      firstSeen: '2026-03-01T00:00:00.000Z'
    });
    expect(views.get('a')!.canonical).toBe('gone');
  });

  it('a cycle from concurrent merges leaves both devices as their own groups', () => {
    const views = labelDevices(
      [
        known('a', PHONE, '2026-01-01T00:00:00.000Z'),
        known('b', DESKTOP, '2026-02-01T00:00:00.000Z')
      ],
      { a: merged('b'), b: merged('a') },
      'a'
    );
    expect(views.get('a')).toMatchObject({ canonical: 'a', mergedFrom: [], isThisDevice: true });
    expect(views.get('b')).toMatchObject({ canonical: 'b', mergedFrom: [], isThisDevice: false });
  });

  it('a device known twice keeps its facts and its earliest first-seen', () => {
    const views = labelDevices(
      [
        known('a', undefined, '2026-01-05T00:00:00.000Z'),
        known('a', PHONE, '2026-02-01T00:00:00.000Z')
      ],
      {},
      'a'
    );
    expect(views.size).toBe(1);
    expect(views.get('a')).toMatchObject({
      label: 'Phone · Android · Chrome',
      firstSeen: '2026-01-05T00:00:00.000Z'
    });
  });

  it('a device with events but no device.json is an "Unknown device"', () => {
    const views = labelDevices(
      [
        known('own', DESKTOP, '2026-01-01T00:00:00.000Z'),
        known('ev', undefined, '2026-03-01T00:00:00.000Z')
      ],
      {},
      'own'
    );
    expect(views.get('ev')).toMatchObject({
      label: 'Unknown device',
      class: 'unknown',
      detectedClass: 'unknown'
    });
  });
});
```

- [ ] **Step 10: Run it.** `npx vitest run src/lib/reading-history/devices.test.ts --testTimeout=30000`
      Expected: FAIL. 10 failed and 9 passed. Each failure reads `TypeError: (0 , labelDevices) is not a function`.

- [ ] **Step 11: Implement.** Make two edits to `src/lib/reading-history/devices.ts`.

First, directly after the closing `}` of `isDeviceClass`, insert:

```ts
/** A device this one knows of: a facts row, or only events (`facts` absent). */
export interface KnownDevice {
  id: string;
  facts?: Pick<DeviceFacts, 'class' | 'os' | 'browser'>;
  /** ISO: the facts' `first_seen`, else the earliest event's `t`. */
  firstSeen: string;
}

export interface DeviceView {
  /** Raw device id. */
  id: string;
  /** What to show: the user's name, else `generated`. */
  label: string;
  /** The generated label, disambiguated. The rename field's placeholder. */
  generated: string;
  /** The user named it. */
  named: boolean;
  /** The user's correction, else `detectedClass`. */
  class: DeviceClass;
  detectedClass: DeviceClass;
  /** On the group's own view (`id === canonical`) when the group holds this device. */
  isThisDevice: boolean;
  /** The group this device counts under; its own id when unmerged. */
  canonical: string;
  /** On a group's own view: the devices merged into it, by first seen. Else empty. */
  mergedFrom: string[];
  firstSeen: string;
}
```

Second, append at the end of the file:

```ts
/** "Mar 2026", in UTC. Null for a stamp that is not a date. */
function sinceMonth(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function byFirstSeen(a: KnownDevice, b: KnownDevice): number {
  if (a.firstSeen !== b.firstSeen) return a.firstSeen < b.firstSeen ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Group ids by `keyOf`, keeping only keys two or more devices share. */
function collisions(devices: KnownDevice[], keyOf: (d: KnownDevice) => string): KnownDevice[][] {
  const groups = new Map<string, KnownDevice[]>();
  for (const device of devices) {
    const key = keyOf(device);
    const group = groups.get(key);
    if (group) group.push(device);
    else groups.set(key, [device]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * One view per raw device id (legacy pseudo-devices dropped), in first-seen
 * order. A merge target missing from `known` gets a view of its own, first
 * seen with the earliest device merged into it.
 */
export function labelDevices(
  known: readonly KnownDevice[],
  labels: Readonly<Record<string, DeviceLabel>>,
  own: string
): Map<string, DeviceView> {
  const byId = new Map<string, KnownDevice>();
  for (const device of known) {
    if (!isDeviceId(device.id)) continue;
    const seen = byId.get(device.id);
    byId.set(
      device.id,
      seen
        ? {
            id: device.id,
            facts: seen.facts ?? device.facts,
            firstSeen: seen.firstSeen < device.firstSeen ? seen.firstSeen : device.firstSeen
          }
        : { ...device }
    );
  }

  // A merge target missing from `known` is first seen with its earliest member.
  const canonical = new Map<string, string>();
  const missing = new Set<string>();
  for (const [id, member] of [...byId]) {
    const group = resolveDevice(id, labels);
    canonical.set(id, group);
    if (group === id) continue;
    const target = byId.get(group);
    if (!target) {
      byId.set(group, { id: group, firstSeen: member.firstSeen });
      missing.add(group);
    } else if (missing.has(group) && member.firstSeen < target.firstSeen) {
      target.firstSeen = member.firstSeen;
    }
  }
  for (const id of missing) canonical.set(id, id);

  const devices = [...byId.values()].sort(byFirstSeen);

  const generated = new Map<string, string>();
  for (const device of devices) {
    generated.set(device.id, generatedLabel(device.facts, labelOf(labels, device.id)?.class));
  }
  for (const group of collisions(devices, (d) => generated.get(d.id)!)) {
    for (const device of group) {
      const month = sinceMonth(device.firstSeen);
      if (month) generated.set(device.id, `${generated.get(device.id)} (since ${month})`);
    }
  }
  for (const group of collisions(devices, (d) => generated.get(d.id)!)) {
    group.forEach((device, i) => {
      if (i > 0) generated.set(device.id, `${generated.get(device.id)} ${i + 1}`);
    });
  }

  const members = new Map<string, string[]>();
  for (const device of devices) {
    const group = canonical.get(device.id)!;
    if (group !== device.id) members.set(group, [...(members.get(group) ?? []), device.id]);
  }

  const ownGroup = resolveDevice(own, labels);
  const views = new Map<string, DeviceView>();
  for (const device of devices) {
    const label = labelOf(labels, device.id);
    const name = label?.name?.trim();
    const detectedClass = device.facts?.class ?? 'unknown';
    const group = canonical.get(device.id)!;
    views.set(device.id, {
      id: device.id,
      label: name || generated.get(device.id)!,
      generated: generated.get(device.id)!,
      named: Boolean(name),
      class: label?.class ?? detectedClass,
      detectedClass,
      isThisDevice: group === device.id && device.id === ownGroup,
      canonical: group,
      mergedFrom: members.get(device.id) ?? [],
      firstSeen: device.firstSeen
    });
  }
  return views;
}
```

- [ ] **Step 12: Run it.** `npx vitest run src/lib/reading-history/devices.test.ts src/lib/reading-history/paths.test.ts --testTimeout=30000`
      Expected: PASS. 2 files, 33 passed (19 + 14).

- [ ] **Step 13: Run the folder, lint and type-check.**
  - `npx vitest run src/lib/reading-history/ --testTimeout=30000`. Expected: all pass (24 files, 304 tests at the current branch head).
  - `npx prettier --check src/lib/reading-history/{paths,paths.test,types,devices,devices.test}.ts && npx eslint src/lib/reading-history/{paths,paths.test,types,devices,devices.test}.ts`. Expected: clean.
  - `npm run check`. Expected: `svelte-check found 0 errors`.

- [ ] **Step 14: Commit.**

```bash
git add src/lib/reading-history/paths.ts src/lib/reading-history/paths.test.ts src/lib/reading-history/types.ts src/lib/reading-history/devices.ts src/lib/reading-history/devices.test.ts
git commit -m "$(cat <<'EOF'
feat(history): device labels — generated names, merge groups, this device

isDeviceId keeps legacy pseudo-devices out of every device list. devices.ts
resolves merge groups (a cycle shows unmerged), builds "Phone · Android ·
Chrome" labels with a UTC first-seen month and then a number when they
collide, and flags the group holding this device.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **Verified in a scratch copy of the worktree; the repo itself was not touched.** Each RED step failed exactly as stated:
  - Cycle 1: `(0 , isDeviceId) is not a function`
  - Cycle 2: `Failed to resolve import "./devices"`
  - Cycle 3: 10 × `(0 , labelDevices) is not a function`

  Every GREEN step passed. The whole `reading-history` folder passed (304 tests), `svelte-check` reported 0 errors, and prettier and eslint were clean after formatting. The code above is the prettier-formatted version.

- **`DeviceLabel` lives in `reading-history/types.ts`, not `tracking-data.ts`.** This differs from design §2, for two reasons:
  - Task 1 runs before Task 2, and `devices.ts` must stay pure.
  - `tracking-data.ts` imports `$app/environment` and `stats-engine`. If `devices.ts` imported it, there would be an import-cycle risk once Task 3's stores import `devices.ts`.

  Task 2 should `import type { DeviceLabel } from '$lib/reading-history/types'`, re-exporting it if wanted, and must not redeclare it.

- **`isDeviceId(id: string)` keeps the design's signature.** Task 2's `parseDeviceLabels` must check `typeof v.merged_into === 'string'` before calling it.
- **`isDeviceClass` is exported for Task 2's `class` closed-set check and Task 4's Select.** `history-sync.ts`'s private `DEVICE_CLASSES` (:45) is left alone.
- **`DeviceView` gains one field, `generated`: the disambiguated generated label.**
  - Design §5 makes the generated label the rename placeholder. For a named device `label` holds the name, so the placeholder needs its own field.
  - Tasks 4 and 5 should use `device.generated` as the `DeviceNameField` placeholder.
- **Collision interpretation.** Collisions are computed over every known raw id: named, merged and synthesized ones alike.
  - This is the spec's "two devices generate the same label" read literally, and it keeps labels stable when a device is renamed or merged (there is a test for this).
  - User names are never compared or suffixed.
  - The cost: an unnamed device gets a "(since …)" suffix when a named device generates the same label.
  - The ordinal fallback is " 2", " 3", …. The first device has no number.
- **`isThisDevice` is set only on the group's own view** (`id === canonical === resolveDevice(own)`).
  - Merged member rows always have `false`. Task 4 should mark own's member row inside a group by comparing `id === $ownDeviceId`.
  - If own is absent from `known` and unmerged, no view is flagged. Task 3 should always include own's facts row, which exists from app start.
- **Map shape.** The map is keyed by raw id and holds:
  - unmerged devices,
  - merged members (their `canonical` is the target),
  - a synthesized view for any merge target missing from `known`, labelled "Unknown device" with `firstSeen` = its earliest member's.

  Iteration order is firstSeen, then id. Groups are `[...views.values()].filter(v => v.id === v.canonical)`.

- **Cycle rule is extended to tails.** Any id on a cycle, or leading into one (D→A↔B), resolves to itself. The design only names cycle members.
  - The visited set guarantees termination, so the design's "≤ keys+1 hops" cap is not needed.
  - A `merged_into` that fails `isDeviceId` stops resolution. Task 2's parse drops those anyway.
- **What Task 3 must pass as `KnownDevice[]`:**
  - facts rows → `{ id: f.device, facts: { class: f.class, os: f.os, browser: f.browser }, firstSeen: f.first_seen }`
  - event-only ids → `{ id, firstSeen: new Date(minT).toISOString() }`, with `facts` omitted, not `{ class: 'unknown' }`. This differs from R6's wording but gives the same label.
  - Duplicates are folded: facts are kept and the earliest firstSeen wins. Task 3 can simply concatenate facts ids and event ids. Legacy ids are filtered inside.
- **A name is trimmed again defensively**, so a whitespace-only name counts as unnamed. Task 2's parse should still trim and cap at `DEVICE_NAME_MAX`.

---

### Task 2: tracking.devices: parse, bogus detection, merge, fold, setters, deviceLabels

**Files:**

- Modify: `src/lib/settings/tracking-data.ts`
  - imports :3-5
  - module doc :19-23
  - `TrackingState` :41-44
  - `parseTrackingSection` :77-84
  - `detectBogusTrackingKeys` :86-96
  - `mergeTrackingSections` :111-127
  - setters inserted before `idleSettings` :199
  - `deviceLabels` appended after :209
- Modify: `src/lib/util/sync/unified-sync-service.ts`
  - import block :18-27 (drop `copyTrackingEntry`, add `foldableTracking`)
  - duplicate-copy tracking fold :568-584
- Test: `src/lib/settings/tracking-data.test.ts`
  - import block :6-19
  - new describes appended after :223
- Test: `src/lib/util/sync/unified-sync-service.test.ts`
  - new cases inside `describe('the tracking section of volume-data.json (idle cutoff)')`, inserted after :1789, before its closing `});` at :1790

**Interfaces:**

Consumes (from Task 1):

- `isDeviceId(id: string): boolean` from `$lib/reading-history/paths`
- `resolveDevice(id: string, labels: Record<string, DeviceLabel>): string` from `$lib/reading-history/devices`. A cycle returns `id` itself.

Consumes (already in the code):

- `DeviceClass` from `$lib/reading-history/types`
- `FUTURE_TOLERANCE_MS`, `isRecord`, `normalizeUpdatedAt` from `$lib/metadata/sanitize`

Produces (all in `src/lib/settings/tracking-data.ts`):

```ts
export interface DeviceLabel {
  name?: string;
  class?: DeviceClass;
  merged_into?: string;
  lastUpdated: string;
}
export interface TrackingState {
  idle?: IdleEntry;
  pauses?: PausesEntry;
  devices?: Record<string, DeviceLabel>;
}
export const DEVICE_BOGUS_PREFIX = 'devices/';
export const DEVICE_NAME_MAX = 40;
export function mergeDeviceLabels(
  local: Record<string, DeviceLabel>,
  cloud: Record<string, DeviceLabel>,
  bogusKeys?: ReadonlySet<string>
): Record<string, DeviceLabel>;
export interface TrackingCopy {
  tracking: TrackingState;
  bogus: ReadonlySet<string>;
}
export function foldableTracking(copies: readonly TrackingCopy[], i: number): TrackingState;
export function renameDevice(id: string, name: string): void;
export function setDeviceClass(id: string, cls: DeviceClass | null): void;
export function mergeDevice(source: string, target: string): boolean;
export function unmergeDevice(id: string): void;
export const deviceLabels: Readable<Record<string, DeviceLabel>>;
```

- `parseTrackingSection`, `detectBogusTrackingKeys` and `mergeTrackingSections` keep their signatures and now handle `devices`.
- The stamp field is `lastUpdated`, per design R2.
- Deviation from design: design §2 wrote `mergeDevice(source, target, labels = current)`. The real setter has no `labels` parameter. It must resolve against the same state it writes to; a map passed in by the caller could be stale and let the setter write a cycle.

---

- [ ] **Step 0: Check the Task 1 seam**

Run:

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-devices
grep -n "export function isDeviceId" src/lib/reading-history/paths.ts
grep -n "DeviceLabel\|export function resolveDevice\|^import" src/lib/reading-history/devices.ts
```

Expected:

- `isDeviceId` is exported from paths.ts.
- `resolveDevice(id: string, labels: Record<string, DeviceLabel>): string` is exported from devices.ts.
- devices.ts has no runtime import from `$lib/settings/tracking-data`. Only `import type` is allowed, because Step 6 makes tracking-data import devices.ts at runtime.

If devices.ts declares its own `interface DeviceLabel`, delete that declaration and add this to devices.ts after Step 3 lands:

```ts
import type { DeviceLabel } from '$lib/settings/tracking-data';
```

The fields are the same as the interface in Step 3.

- [ ] **Step 1: Write the failing tests (parse, bogus, merge, fold)**

In `src/lib/settings/tracking-data.test.ts`, replace the import block (:6-19) with:

```ts
import {
  DEVICE_NAME_MAX,
  TRACKING_SECTION_KEY,
  detectBogusTrackingKeys,
  foldableTracking,
  idleSettings,
  mergeDeviceLabels,
  mergeTrackingSections,
  parseTrackingSection,
  pauseDefault,
  resetIdleK,
  setIdleOverride,
  setPauseDefault,
  setTrackingStates,
  trackingState,
  widenIdleK
} from './tracking-data';
```

Append at the end of the file:

```ts
const FUTURE = '2999-01-01T00:00:00.000Z';

describe('tracking.devices: parse', () => {
  it('keeps a valid label, name trimmed', () => {
    expect(
      parseTrackingSection({
        devices: {
          'dev-a': { name: '  Pixel 8 ', class: 'phone', merged_into: 'dev-b', lastUpdated: T1 }
        }
      })
    ).toEqual({
      devices: {
        'dev-a': { name: 'Pixel 8', class: 'phone', merged_into: 'dev-b', lastUpdated: T1 }
      }
    });
  });

  it('drops ids that are not device ids and values that are not records', () => {
    expect(
      parseTrackingSection({
        devices: {
          'legacy:vol-1': { name: 'Old', lastUpdated: T1 },
          'a/b': { name: 'Slash', lastUpdated: T1 },
          ['x'.repeat(65)]: { name: 'Long', lastUpdated: T1 },
          'dev-a': 'Pixel',
          'dev-b': { name: 'Kept', lastUpdated: T1 }
        }
      })
    ).toEqual({ devices: { 'dev-b': { name: 'Kept', lastUpdated: T1 } } });
  });

  it('omits devices when nothing valid is left, and never takes another key with it', () => {
    expect(parseTrackingSection({ devices: { 'legacy:vol-1': { lastUpdated: T1 } } })).toEqual({});
    expect(
      parseTrackingSection({ devices: ['dev-a'], pauses: { default: 'full', lastUpdated: T1 } })
    ).toEqual({ pauses: { default: 'full', lastUpdated: T1 } });
  });

  it('drops invalid fields one by one and keeps a stamp-only entry', () => {
    const parsed = parseTrackingSection({
      devices: {
        'dev-a': { name: 42, class: 'watch', merged_into: 'dev-a', lastUpdated: T1 },
        'dev-b': { name: '   ', merged_into: 'legacy:vol-1', lastUpdated: T1 },
        'dev-c': { merged_into: 7, lastUpdated: T1 }
      }
    });
    expect(parsed.devices).toEqual({
      'dev-a': { lastUpdated: T1 },
      'dev-b': { lastUpdated: T1 },
      'dev-c': { lastUpdated: T1 }
    });
  });

  it('cuts a name longer than DEVICE_NAME_MAX characters (code points, not UTF-16 units)', () => {
    const parsed = parseTrackingSection({
      devices: { 'dev-a': { name: 'あ'.repeat(50), lastUpdated: T1 } }
    });
    expect(DEVICE_NAME_MAX).toBe(40);
    expect(parsed.devices?.['dev-a'].name).toBe('あ'.repeat(40));
  });

  it('an unparsable stamp loses every merge; a future one is clamped on read', () => {
    const parsed = parseTrackingSection({
      devices: { 'dev-a': { name: 'A' }, 'dev-b': { name: 'B', lastUpdated: FUTURE } }
    });
    expect(parsed.devices?.['dev-a'].lastUpdated).toBe(new Date(0).toISOString());
    expect(parsed.devices!['dev-b'].lastUpdated < FUTURE).toBe(true);
  });
});

describe('tracking.devices: bogus stamps', () => {
  it('names a future device stamp devices/<id>, beside the plain keys', () => {
    const bogus = detectBogusTrackingKeys({
      idle: { override_minutes: 5, lastUpdated: FUTURE },
      devices: {
        'dev-a': { name: 'A', lastUpdated: FUTURE },
        'dev-b': { name: 'B', lastUpdated: T1 },
        'legacy:vol-1': { lastUpdated: FUTURE }
      }
    });
    expect([...bogus].sort()).toEqual(['devices/dev-a', 'idle']);
  });

  it('never flags the devices map itself', () => {
    expect([...detectBogusTrackingKeys({ devices: { lastUpdated: FUTURE } })]).toEqual([]);
  });
});

describe('tracking.devices: merge', () => {
  it('merges per device id: newest wins, a tie keeps local, a missing one is adopted', () => {
    const merged = mergeDeviceLabels(
      {
        'dev-a': { name: 'Old', lastUpdated: T1 },
        'dev-b': { name: 'Mine', lastUpdated: T2 },
        'dev-d': { name: 'Tie local', lastUpdated: T1 }
      },
      {
        'dev-a': { name: 'New', lastUpdated: T2 },
        'dev-b': { name: 'Theirs', lastUpdated: T1 },
        'dev-c': { name: 'Third', lastUpdated: T1 },
        'dev-d': { name: 'Tie cloud', lastUpdated: T1 }
      }
    );
    expect(merged).toEqual({
      'dev-a': { name: 'New', lastUpdated: T2 },
      'dev-b': { name: 'Mine', lastUpdated: T2 },
      'dev-c': { name: 'Third', lastUpdated: T1 },
      'dev-d': { name: 'Tie local', lastUpdated: T1 }
    });
  });

  it('a bogus cloud label forfeits to local, but is adopted when local has none', () => {
    const raw = { devices: { 'dev-a': { name: 'Junk', lastUpdated: FUTURE } } };
    const bogus = detectBogusTrackingKeys(raw);
    const cloud = parseTrackingSection(raw);
    const local = { devices: { 'dev-a': { name: 'Mine', lastUpdated: T1 } } };
    expect(mergeTrackingSections(local, cloud, bogus).devices?.['dev-a'].name).toBe('Mine');
    expect(mergeTrackingSections({}, cloud, bogus).devices?.['dev-a'].name).toBe('Junk');
  });

  it('merges devices beside idle; a bogus idle never touches a device label', () => {
    const raw = {
      idle: { override_minutes: 3, lastUpdated: FUTURE },
      devices: { 'dev-a': { name: 'Newer', lastUpdated: T2 } }
    };
    const merged = mergeTrackingSections(
      {
        idle: { override_minutes: 8, lastUpdated: T1 },
        devices: { 'dev-a': { name: 'Older', lastUpdated: T1 } }
      },
      parseTrackingSection(raw),
      detectBogusTrackingKeys(raw)
    );
    expect(merged.idle?.override_minutes).toBe(8);
    expect(merged.devices).toEqual({ 'dev-a': { name: 'Newer', lastUpdated: T2 } });
  });

  it('a newer stamp-only entry (a cleared name) beats an older name', () => {
    const merged = mergeTrackingSections(
      { devices: { 'dev-a': { name: 'Pixel', lastUpdated: T1 } } },
      { devices: { 'dev-a': { lastUpdated: T2 } } }
    );
    expect(merged.devices).toEqual({ 'dev-a': { lastUpdated: T2 } });
  });

  it('adds no devices key when neither side has labels', () => {
    const merged = mergeTrackingSections(
      { idle: { k: 2, lastUpdated: T1 } },
      { pauses: { default: 'none', lastUpdated: T1 } }
    );
    expect('devices' in merged).toBe(false);
  });
});

describe('foldableTracking (duplicate volume-data.json copies)', () => {
  it("drops a copy's bogus device label only when another copy holds that id honestly", () => {
    const poisonedRaw = {
      devices: {
        'dev-a': { name: 'Junk', lastUpdated: FUTURE },
        'dev-b': { name: 'Kept', lastUpdated: T1 },
        'dev-c': { name: 'Only here', lastUpdated: FUTURE }
      }
    };
    const honestRaw = { devices: { 'dev-a': { name: 'Honest', lastUpdated: T1 } } };
    const copies = [poisonedRaw, honestRaw].map((raw) => ({
      tracking: parseTrackingSection(raw),
      bogus: detectBogusTrackingKeys(raw)
    }));
    expect(Object.keys(foldableTracking(copies, 0).devices ?? {}).sort()).toEqual([
      'dev-b',
      'dev-c'
    ]);
    expect(foldableTracking(copies, 1)).toEqual(honestRaw);
  });

  it('still folds idle and pauses per key', () => {
    const copies = [
      {
        tracking: {
          idle: { k: 9, lastUpdated: T2 },
          pauses: { default: 'full' as const, lastUpdated: T1 }
        },
        bogus: new Set(['idle'])
      },
      { tracking: { idle: { k: 2, lastUpdated: T1 } }, bogus: new Set<string>() }
    ];
    expect(foldableTracking(copies, 0)).toEqual({
      pauses: { default: 'full', lastUpdated: T1 }
    });
    expect(foldableTracking(copies, 1)).toEqual({ idle: { k: 2, lastUpdated: T1 } });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/lib/settings/tracking-data.test.ts --testTimeout=30000`

Expected: FAIL. The 22 existing tests pass. The new parse, bogus, merge and fold cases fail with messages such as:

- `expected {} to deeply equal { devices: { 'dev-a': … } }`: `parseTrackingSection` drops `devices`.
- `expected [ 'idle' ] to deeply equal [ 'devices/dev-a', 'idle' ]`
- `expected [ 'devices' ] to deeply equal []`: the generic loop flags the map itself.
- `mergeDeviceLabels is not a function` / `foldableTracking is not a function`

The two tests that assert an absence ("omits devices…", "adds no devices key…") already pass.

- [ ] **Step 3: Implement parse, bogus detection, merge and fold**

In `src/lib/settings/tracking-data.ts`:

**(a) Imports.** Replace :5

```ts
import type { PauseCount } from '$lib/reading-history/types';
```

with

```ts
import { isDeviceId } from '$lib/reading-history/paths';
import type { DeviceClass, PauseCount } from '$lib/reading-history/types';
```

**(b) Module doc.** Replace the last bullet's closing lines (:19-23)

```ts
 * - `pauses`: the standing answer to long-pause prompts. `default: null` =
 *   ask. When set, prompts stop and each view that reaches its cap while open
 *   is written with that answer — from then on, never backwards. Its own key,
 *   so it merges apart from `idle`.
 */
```

with

```ts
 * - `pauses`: the standing answer to long-pause prompts. `default: null` =
 *   ask. When set, prompts stop and each view that reaches its cap while open
 *   is written with that answer — from then on, never backwards. Its own key,
 *   so it merges apart from `idle`.
 * - `devices`: the user's labels for reading devices, keyed by device id —
 *   a name, a corrected class, `merged_into` another device. A MAP, so it
 *   merges per device id (`mergeDeviceLabels`), and its bogus keys are
 *   namespaced `devices/<id>` in the one bogus set. One stamp per device: a
 *   rename and a merge of the same device on two devices between syncs keep
 *   only the newer edit. The stamp is `lastUpdated` like every sibling here
 *   (the spec's `updated_at` was renamed to match).
 */
```

**(c) Types and constants.** Replace :41-44

```ts
export interface TrackingState {
  idle?: IdleEntry;
  pauses?: PausesEntry;
}
```

with

```ts
/** The user's label for one device. Absent fields = the detected / own value. */
export interface DeviceLabel {
  /** Trimmed, 1–`DEVICE_NAME_MAX` characters. */
  name?: string;
  /** A user correction of the detected class. */
  class?: DeviceClass;
  /** Another device id this one is shown as part of. */
  merged_into?: string;
  lastUpdated: string;
}

export interface TrackingState {
  idle?: IdleEntry;
  pauses?: PausesEntry;
  devices?: Record<string, DeviceLabel>;
}

/** The single-entry keys; `devices` is a map and merges per id. */
type EntryKey = Exclude<keyof TrackingState, 'devices'>;
const ENTRY_KEYS: readonly EntryKey[] = ['idle', 'pauses'];

/** Bogus-set id of a device label: `devices/<id>` (`/` is never in a device id). */
export const DEVICE_BOGUS_PREFIX = 'devices/';
export const DEVICE_NAME_MAX = 40;
const DEVICE_CLASSES: readonly DeviceClass[] = ['phone', 'tablet', 'laptop', 'desktop', 'unknown'];
const NO_LABELS: Record<string, DeviceLabel> = Object.freeze({}) as Record<string, DeviceLabel>;
```

**(d) Parse.** Replace `parseTrackingSection` (:77-84) with:

```ts
/** Trimmed and cut to `DEVICE_NAME_MAX` characters (not UTF-16 units); `undefined` when empty. */
function clampDeviceName(value: string): string | undefined {
  const name = Array.from(value.trim()).slice(0, DEVICE_NAME_MAX).join('').trimEnd();
  return name || undefined;
}

function isDeviceClass(value: unknown): value is DeviceClass {
  return (DEVICE_CLASSES as readonly unknown[]).includes(value);
}

function parseDeviceLabel(id: string, value: Record<string, unknown>): DeviceLabel {
  const label: DeviceLabel = { lastUpdated: normalizeUpdatedAt(value.lastUpdated) ?? EPOCH };
  const name = typeof value.name === 'string' ? clampDeviceName(value.name) : undefined;
  if (name) label.name = name;
  if (isDeviceClass(value.class)) label.class = value.class;
  const target = value.merged_into;
  if (typeof target === 'string' && target !== id && isDeviceId(target)) label.merged_into = target;
  return label;
}

/**
 * Per device id, like `parseSeriesSection`. An id that is not a device id
 * (`legacy:` pseudo-devices included) and a non-record value are dropped; an
 * entry carrying only its stamp is KEPT — it is how a cleared name or an
 * unmerge wins the merge.
 */
function parseDeviceLabels(raw: Record<string, unknown>): Record<string, DeviceLabel> {
  const labels: Record<string, DeviceLabel> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isDeviceId(id) || !isRecord(value)) continue;
    labels[id] = parseDeviceLabel(id, value);
  }
  return labels;
}

/** Validate an untrusted `tracking` section, key by key. Unknown keys are dropped. */
export function parseTrackingSection(raw: unknown): TrackingState {
  const state: TrackingState = {};
  if (!isRecord(raw)) return state;
  if (isRecord(raw.idle)) state.idle = parseIdle(raw.idle);
  if (isRecord(raw.pauses)) state.pauses = parsePauses(raw.pauses);
  if (isRecord(raw.devices)) {
    const devices = parseDeviceLabels(raw.devices);
    if (Object.keys(devices).length > 0) state.devices = devices;
  }
  return state;
}
```

**(e) Bogus detection.** Replace `detectBogusTrackingKeys` and its doc comment (:86-96) with:

```ts
function isFutureStamp(value: Record<string, unknown>, now: number): boolean {
  if (typeof value.lastUpdated !== 'string') return false;
  const stamp = Date.parse(value.lastUpdated);
  return !Number.isNaN(stamp) && stamp > now + FUTURE_TOLERANCE_MS;
}

/**
 * Keys whose RAW stamp is too far in the future (before the parse clamps it):
 * `idle` / `pauses` by name, a device label as `devices/<id>`.
 */
export function detectBogusTrackingKeys(raw: unknown, now: number = Date.now()): Set<string> {
  const bogus = new Set<string>();
  if (!isRecord(raw)) return bogus;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'devices' || !isRecord(value)) continue;
    if (isFutureStamp(value, now)) bogus.add(key);
  }
  if (isRecord(raw.devices)) {
    for (const [id, value] of Object.entries(raw.devices)) {
      if (!isDeviceId(id) || !isRecord(value)) continue;
      if (isFutureStamp(value, now)) bogus.add(DEVICE_BOGUS_PREFIX + id);
    }
  }
  return bogus;
}
```

`copyTrackingEntry` (:98-109) stays as it is.

**(f) Merge and fold.** Replace `mergeTrackingSections` and its doc comment (:111-127) with:

```ts
/**
 * Per device id, like `mergeSeriesSections`: local absent adopts the cloud
 * label; a bogus (`devices/<id>`) cloud label never beats a local one;
 * otherwise a strictly newer stamp wins and a tie keeps local.
 */
export function mergeDeviceLabels(
  local: Record<string, DeviceLabel>,
  cloud: Record<string, DeviceLabel>,
  bogusKeys: ReadonlySet<string> = new Set()
): Record<string, DeviceLabel> {
  const merged: Record<string, DeviceLabel> = { ...local };
  for (const [id, cloudLabel] of Object.entries(cloud)) {
    const localLabel = merged[id];
    if (!localLabel) {
      merged[id] = cloudLabel;
      continue;
    }
    if (bogusKeys.has(DEVICE_BOGUS_PREFIX + id)) continue;
    if (cloudLabel.lastUpdated > localLabel.lastUpdated) merged[id] = cloudLabel;
  }
  return merged;
}

/**
 * Newest `lastUpdated` per key (`devices`: per device id); a tie keeps local;
 * a bogus cloud key never beats a local one. An empty `devices` map is omitted.
 */
export function mergeTrackingSections(
  local: TrackingState,
  cloud: TrackingState,
  bogusKeys: ReadonlySet<string> = new Set()
): TrackingState {
  const merged: TrackingState = { ...local };
  for (const key of ENTRY_KEYS) {
    const cloudEntry = cloud[key];
    const localEntry = merged[key];
    if (!cloudEntry) continue;
    if (!localEntry || (!bogusKeys.has(key) && cloudEntry.lastUpdated > localEntry.lastUpdated)) {
      copyTrackingEntry(merged, cloud, key);
    }
  }
  const devices = mergeDeviceLabels(local.devices ?? {}, cloud.devices ?? {}, bogusKeys);
  if (Object.keys(devices).length > 0) merged.devices = devices;
  else delete merged.devices;
  return merged;
}

/** One readable copy of `volume-data.json`'s tracking section, for the duplicate fold. */
export interface TrackingCopy {
  tracking: TrackingState;
  /** That copy's own `detectBogusTrackingKeys(raw)`. */
  bogus: ReadonlySet<string>;
}

/**
 * What copy `i` may contribute to the duplicate-file fold: everything it
 * holds, except an entry whose stamp was bogus IN THIS COPY while another
 * copy holds the same entry honestly — that copy's own turn supplies it, so a
 * poisoned duplicate never clobbers an honest one, whatever the fold order.
 * `idle` / `pauses` are checked per key, `devices` per device id.
 */
export function foldableTracking(copies: readonly TrackingCopy[], i: number): TrackingState {
  const { tracking: own, bogus } = copies[i];
  const honestElsewhere = (bogusKey: string, holds: (other: TrackingState) => boolean): boolean =>
    bogus.has(bogusKey) &&
    copies.some((other, j) => j !== i && holds(other.tracking) && !other.bogus.has(bogusKey));
  const foldable: TrackingState = {};
  for (const key of ENTRY_KEYS) {
    if (own[key] && !honestElsewhere(key, (other) => !!other[key])) {
      copyTrackingEntry(foldable, own, key);
    }
  }
  const devices: Record<string, DeviceLabel> = {};
  for (const [id, label] of Object.entries(own.devices ?? {})) {
    if (!honestElsewhere(DEVICE_BOGUS_PREFIX + id, (other) => !!other.devices?.[id])) {
      devices[id] = label;
    }
  }
  if (Object.keys(devices).length > 0) foldable.devices = devices;
  return foldable;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/lib/settings/tracking-data.test.ts --testTimeout=30000`

Expected: PASS, 37 tests.

- [ ] **Step 5: Write the failing tests (setters and deviceLabels)**

In `src/lib/settings/tracking-data.test.ts`, replace the import block from Step 1 with:

```ts
import {
  DEVICE_NAME_MAX,
  TRACKING_SECTION_KEY,
  detectBogusTrackingKeys,
  deviceLabels,
  foldableTracking,
  idleSettings,
  mergeDevice,
  mergeDeviceLabels,
  mergeTrackingSections,
  parseTrackingSection,
  pauseDefault,
  renameDevice,
  resetIdleK,
  setDeviceClass,
  setIdleOverride,
  setPauseDefault,
  setTrackingStates,
  trackingState,
  unmergeDevice,
  widenIdleK
} from './tracking-data';
```

Append at the end of the file:

```ts
describe('device label setters', () => {
  it('renames: trimmed, stamped, persisted, and readable through deviceLabels', () => {
    expect(get(deviceLabels)).toEqual({});
    renameDevice('dev-a', '  Pixel 8  ');
    const label = get(trackingState).devices!['dev-a'];
    expect(label.name).toBe('Pixel 8');
    expect(get(deviceLabels)['dev-a'].name).toBe('Pixel 8');
    const stored = JSON.parse(window.localStorage.getItem('tracking-data')!);
    expect(stored.devices['dev-a'].name).toBe('Pixel 8');
    expect(parseTrackingSection(stored)).toEqual(get(trackingState));
  });

  it('an empty name removes the field under a newer stamp, which wins the next merge', () => {
    const named = {
      devices: { 'dev-a': { name: 'Pixel', class: 'phone' as const, lastUpdated: T1 } }
    };
    setTrackingStates(named);
    renameDevice('dev-a', '   ');
    const cleared = get(trackingState).devices!['dev-a'];
    expect(cleared).not.toHaveProperty('name');
    expect(cleared.class).toBe('phone');
    expect(mergeTrackingSections(named, get(trackingState)).devices?.['dev-a']).toEqual(cleared);
  });

  it('caps a long name and ignores ids that are not device ids', () => {
    renameDevice('dev-a', 'x'.repeat(60));
    expect(get(trackingState).devices!['dev-a'].name).toHaveLength(DEVICE_NAME_MAX);
    renameDevice('legacy:vol-1', 'Nope');
    setDeviceClass('legacy:vol-1', 'phone');
    expect(Object.keys(get(trackingState).devices!)).toEqual(['dev-a']);
  });

  it('sets a class and goes back to Automatic with null, keeping the name', () => {
    renameDevice('dev-a', 'Work');
    setDeviceClass('dev-a', 'laptop');
    expect(get(trackingState).devices!['dev-a']).toMatchObject({ name: 'Work', class: 'laptop' });
    setDeviceClass('dev-a', null);
    expect(get(trackingState).devices!['dev-a']).not.toHaveProperty('class');
    expect(get(trackingState).devices!['dev-a'].name).toBe('Work');
  });

  it('stamps past a future stamp already stored, and never touches idle', () => {
    setTrackingStates({
      idle: { k: 4, lastUpdated: T1 },
      devices: { 'dev-a': { name: 'A', lastUpdated: '2026-12-31T00:00:00.000Z' } }
    });
    renameDevice('dev-a', 'B');
    expect(get(trackingState).devices!['dev-a'].lastUpdated > '2026-12-31T00:00:00.000Z').toBe(
      true
    );
    expect(get(trackingState).idle).toEqual({ k: 4, lastUpdated: T1 });
  });

  it('merges into the canonical target, flattening a chain, and keeps the name', () => {
    setTrackingStates({
      devices: {
        'dev-a': { name: 'Old phone', lastUpdated: T1 },
        'dev-b': { merged_into: 'dev-c', lastUpdated: T1 }
      }
    });
    expect(mergeDevice('dev-a', 'dev-b')).toBe(true);
    expect(get(trackingState).devices!['dev-a']).toMatchObject({
      name: 'Old phone',
      merged_into: 'dev-c'
    });
    expect(get(trackingState).devices!['dev-a'].lastUpdated > T1).toBe(true);
  });

  it('refuses a merge into itself, into its own group, or between non-device ids', () => {
    setTrackingStates({ devices: { 'dev-a': { merged_into: 'dev-b', lastUpdated: T1 } } });
    const before = get(trackingState);
    expect(mergeDevice('dev-b', 'dev-b')).toBe(false);
    expect(mergeDevice('dev-b', 'dev-a')).toBe(false);
    expect(mergeDevice('legacy:vol-1', 'dev-b')).toBe(false);
    expect(mergeDevice('dev-c', 'legacy:vol-1')).toBe(false);
    expect(get(trackingState)).toBe(before);
  });

  it('refuses a merge that would join an existing cycle', () => {
    // A cycle from two devices merging concurrently (A→B here, B→A there).
    setTrackingStates({
      devices: {
        'dev-a': { merged_into: 'dev-b', lastUpdated: T1 },
        'dev-b': { merged_into: 'dev-a', lastUpdated: T1 }
      }
    });
    expect(mergeDevice('dev-b', 'dev-a')).toBe(false);
    expect(mergeDevice('dev-c', 'dev-a')).toBe(true);
  });

  it('unmerges under a newer stamp, which beats the merged entry in the next merge', () => {
    const merged = { devices: { 'dev-a': { name: 'Tab', merged_into: 'dev-b', lastUpdated: T1 } } };
    setTrackingStates(merged);
    unmergeDevice('dev-a');
    const label = get(trackingState).devices!['dev-a'];
    expect(label).toEqual({ name: 'Tab', lastUpdated: label.lastUpdated });
    expect(label.lastUpdated > T1).toBe(true);
    expect(mergeTrackingSections(merged, get(trackingState)).devices?.['dev-a']).toEqual(label);
  });

  it('unmerge writes nothing when the device is not merged', () => {
    setTrackingStates({ devices: { 'dev-a': { name: 'A', lastUpdated: T1 } } });
    const before = get(trackingState);
    unmergeDevice('dev-a');
    unmergeDevice('dev-z');
    expect(get(trackingState)).toBe(before);
  });
});
```

- [ ] **Step 6: Run the tests and watch them fail**

Run: `npx vitest run src/lib/settings/tracking-data.test.ts --testTimeout=30000`

Expected: FAIL. The 37 earlier tests pass. The 10 setter cases fail with `renameDevice is not a function` / `mergeDevice is not a function` / `unmergeDevice is not a function`, and the first one fails with `expected undefined to deeply equal {}` because `deviceLabels` is not exported.

- [ ] **Step 7: Implement the setters and `deviceLabels`**

In `src/lib/settings/tracking-data.ts`:

**(a) Import.** Add `resolveDevice` below the `stats-engine` import. The import block becomes:

```ts
import { DEFAULT_K, K_MAX, type IdleSettings } from '$lib/reading-history/stats-engine';
import { resolveDevice } from '$lib/reading-history/devices';
import { isDeviceId } from '$lib/reading-history/paths';
import type { DeviceClass, PauseCount } from '$lib/reading-history/types';
```

**(b) Setters.** Insert directly before `/** The idle cutoff every stat uses. */` (originally :199, after `setPauseDefault`):

```ts
/**
 * Change one device's label under a new stamp, keeping its other fields. A
 * field patched to `undefined` is removed, so the cleared entry still carries
 * a newer stamp and beats the older value on every other device.
 */
function patchDeviceLabel(id: string, patch: Partial<Omit<DeviceLabel, 'lastUpdated'>>): void {
  const state = get(trackingState);
  const existing = state.devices?.[id];
  const next: DeviceLabel = {
    ...existing,
    ...patch,
    lastUpdated: nextStamp(existing?.lastUpdated)
  };
  if (next.name === undefined) delete next.name;
  if (next.class === undefined) delete next.class;
  if (next.merged_into === undefined) delete next.merged_into;
  trackingState.set({ ...state, devices: { ...state.devices, [id]: next } });
}

/** Name a device; an empty (or all-blank) name goes back to the generated label. */
export function renameDevice(id: string, name: string): void {
  if (!isDeviceId(id)) return;
  patchDeviceLabel(id, { name: clampDeviceName(name) });
}

/** Correct a device's class; `null` = Automatic (the detected class). */
export function setDeviceClass(id: string, cls: DeviceClass | null): void {
  if (!isDeviceId(id) || (cls !== null && !isDeviceClass(cls))) return;
  patchDeviceLabel(id, { class: cls ?? undefined });
}

/** Does following `merged_into` from `from` ever land on `to` (or start there)? */
function mergeReaches(from: string, to: string, labels: Record<string, DeviceLabel>): boolean {
  const seen = new Set<string>();
  for (let id: string | undefined = from; id && !seen.has(id); id = labels[id]?.merged_into) {
    if (id === to) return true;
    seen.add(id);
  }
  return false;
}

/**
 * Show `source` as part of `target`. The target is resolved to its canonical
 * id first, so chains are flattened at write time. Refused (`false`, nothing
 * written) for a non-device id, a merge into itself, or one that would close
 * a cycle — `target` already resolves through `source`.
 */
export function mergeDevice(source: string, target: string): boolean {
  if (!isDeviceId(source) || !isDeviceId(target)) return false;
  const labels = get(trackingState).devices ?? {};
  const canonical = resolveDevice(target, labels);
  if (mergeReaches(canonical, source, labels)) return false;
  patchDeviceLabel(source, { merged_into: canonical });
  return true;
}

/** Show a merged device on its own again. Nothing is written when it is not merged. */
export function unmergeDevice(id: string): void {
  if (!get(trackingState).devices?.[id]?.merged_into) return;
  patchDeviceLabel(id, { merged_into: undefined });
}
```

**(c) Readable.** Append at the end of the file, after `pauseDefault`:

```ts
/** The user's device labels by raw device id (merges unresolved: see `resolveDevice`). */
export const deviceLabels: Readable<Record<string, DeviceLabel>> = derived(
  trackingState,
  ($state) => $state.devices ?? NO_LABELS
);
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npx vitest run src/lib/settings/tracking-data.test.ts --testTimeout=30000`

Expected: PASS, 47 tests.

- [ ] **Step 9: Write the failing sync tests (round trip, per-id merge, heal, multi-copy fold with a bogus device)**

In `src/lib/util/sync/unified-sync-service.test.ts`, inside `describe('the tracking section of volume-data.json (idle cutoff)', …)`, insert after the `it('folds duplicate copies per key', …)` case. That is after its closing `  });` at :1789 and before the describe's closing `});` at :1790. The block uses the existing `T1`, `T2`, `file`, `provider` helpers in that describe and the file-level `fileMeta`, `stubCache`, `makeProvider`, `jsonBlob` and `svc`.

```ts
it('round-trips device labels through the file', async () => {
  const devices = { 'dev-a': { name: 'Pixel 8', class: 'phone', lastUpdated: T2 } };
  setTrackingStates({
    devices: { 'dev-a': { name: 'Pixel 8', class: 'phone', lastUpdated: T2 } }
  });
  stubCache([fileMeta('only')]);
  const first = provider(file(undefined));
  await svc.syncVolumeData(first.provider);
  expect(first.uploads).toHaveLength(1);
  expect(first.uploads[0].tracking).toEqual({ devices });

  // Another device reads that upload back: adopted, and nothing to upload.
  setTrackingStates({});
  stubCache([fileMeta('only')]);
  const second = provider(first.uploads[0]);
  await svc.syncVolumeData(second.provider);
  expect(get(trackingState)).toEqual({ devices });
  expect(second.uploads).toHaveLength(0);
});

it('merges device labels per id, never as one block', async () => {
  setTrackingStates({ devices: { 'dev-a': { name: 'Mine', lastUpdated: T2 } } });
  stubCache([fileMeta('only')]);
  const { uploads, provider: p } = provider(
    file({
      devices: {
        'dev-a': { name: 'Theirs', lastUpdated: T1 },
        'dev-b': { name: 'Tablet', lastUpdated: T1 }
      }
    })
  );
  await svc.syncVolumeData(p);
  const expected = {
    'dev-a': { name: 'Mine', lastUpdated: T2 },
    'dev-b': { name: 'Tablet', lastUpdated: T1 }
  };
  expect(get(trackingState).devices).toEqual(expected);
  expect(uploads).toHaveLength(1);
  expect(uploads[0].tracking.devices).toEqual(expected);
});

it('heals a future-stamped device label and keeps the pending local name', async () => {
  setTrackingStates({ devices: { 'dev-a': { name: 'Mine', lastUpdated: T2 } } });
  stubCache([fileMeta('only')]);
  const { uploads, provider: p } = provider(
    file({
      devices: {
        'dev-a': { name: 'Junk', lastUpdated: '2999-01-01T00:00:00.000Z' },
        'dev-b': { name: 'Other', lastUpdated: T1 }
      }
    })
  );
  await svc.syncVolumeData(p);
  expect(get(trackingState).devices?.['dev-a']).toEqual({ name: 'Mine', lastUpdated: T2 });
  expect(uploads).toHaveLength(1);
  expect(uploads[0].tracking.devices).toEqual({
    'dev-a': { name: 'Mine', lastUpdated: T2 },
    'dev-b': { name: 'Other', lastUpdated: T1 }
  });
});

it.each([
  ['poisoned copy first', ['poisoned', 'honest']],
  ['honest copy first', ['honest', 'poisoned']]
])(
  'folds duplicate copies per device id: a bogus label never beats an honest one (%s)',
  async (_order, ids) => {
    const bodies: Record<string, unknown> = {
      poisoned: {
        devices: {
          'dev-a': { name: 'Junk', lastUpdated: '2999-01-01T00:00:00.000Z' },
          'dev-b': { name: 'Kept', lastUpdated: T1 }
        }
      },
      honest: { devices: { 'dev-a': { name: 'Honest', lastUpdated: T1 } } }
    };
    stubCache(ids.map(fileMeta));
    const p = makeProvider(async (f) => jsonBlob(file(bodies[f.fileId])));
    const result = await svc.downloadVolumeDataFile(p);
    expect(result.tracking.devices).toEqual({
      'dev-a': { name: 'Honest', lastUpdated: T1 },
      'dev-b': { name: 'Kept', lastUpdated: T1 }
    });
    expect([...result.bogusTrackingKeys]).toEqual(['devices/dev-a']);
  }
);
```

- [ ] **Step 10: Run the sync tests and watch them fail**

Run: `npx vitest run src/lib/util/sync/unified-sync-service.test.ts --testTimeout=30000`

Expected: FAIL, 1 failed and 71 passed. The failing case is `folds duplicate copies per device id: a bogus label never beats an honest one (poisoned copy first)`, with `expected { Object (dev-a, dev-b) } to deeply equal { …(2) }`.

The cause is the old fold. It copies the whole `devices` map with `copyTrackingEntry` and checks honesty only against the top-level key `devices`, which is never in the bogus set. So the poisoned copy's clamped-to-now `Junk` folds first and then out-dates the honest `T1` label. The round-trip, per-id and heal cases already pass, because the single-copy path only uses `parseTrackingSection`, `detectBogusTrackingKeys` and `mergeTrackingSections`.

- [ ] **Step 11: Switch the service fold to `foldableTracking`**

In `src/lib/util/sync/unified-sync-service.ts`:

**(a) Imports (:18-27).** Replace

```ts
  TRACKING_SECTION_KEY,
  copyTrackingEntry,
  detectBogusTrackingKeys,
  mergeTrackingSections,
```

with

```ts
  TRACKING_SECTION_KEY,
  detectBogusTrackingKeys,
  foldableTracking,
  mergeTrackingSections,
```

**(b) Fold (:565-584).** Replace

```ts
// The tracking section folds the same way as the series section below:
// newest per key, and a copy's bogus key never beats another copy's
// honest one.
const perCopyBogusTracking = readable.map((entry) =>
  detectBogusTrackingKeys(entry.result.value.rawTracking)
);
const bogusTrackingKeys = new Set<string>();
for (const keys of perCopyBogusTracking) for (const key of keys) bogusTrackingKeys.add(key);
let mergedTracking: TrackingState = {};
readable.forEach((entry, i) => {
  const own = entry.result.value.tracking ?? {};
  const foldable: TrackingState = {};
  for (const key of Object.keys(own) as Array<keyof TrackingState>) {
    const honestElsewhere =
      perCopyBogusTracking[i].has(key) &&
      readable.some(
        (_other, j) =>
          j !== i && readable[j].result.value.tracking?.[key] && !perCopyBogusTracking[j].has(key)
      );
    if (!honestElsewhere) copyTrackingEntry(foldable, own, key);
  }
  mergedTracking = mergeTrackingSections(mergedTracking, foldable, perCopyBogusTracking[i]);
});
```

with

```ts
// The tracking section folds the same way as the series section below:
// newest per key (`devices`: per device id), and a copy's bogus entry
// never beats another copy's honest one (`foldableTracking`).
const trackingCopies = readable.map((entry) => ({
  tracking: entry.result.value.tracking ?? {},
  bogus: detectBogusTrackingKeys(entry.result.value.rawTracking)
}));
const bogusTrackingKeys = new Set<string>();
for (const copy of trackingCopies) for (const key of copy.bogus) bogusTrackingKeys.add(key);
let mergedTracking: TrackingState = {};
trackingCopies.forEach((copy, i) => {
  mergedTracking = mergeTrackingSections(
    mergedTracking,
    foldableTracking(trackingCopies, i),
    copy.bogus
  );
});
```

Nothing else changes:

- The single-copy path (:652-666) and the returned `tracking`/`rawTracking`/`bogusTrackingKeys` (:648-650) stay as they are.
- `composeVolumeDataFile` and the `stableStringify` upload diff are already generic, and `mergeTrackingSections` never emits an empty `devices`.

- [ ] **Step 12: Run the tests and watch them pass, then run the neighbours, type-check and lint**

Run: `npx vitest run src/lib/util/sync/unified-sync-service.test.ts src/lib/settings/tracking-data.test.ts --testTimeout=30000`

Expected: PASS, 72 + 47 tests.

Run: `npx vitest run src/lib/util/sync src/lib/settings src/lib/reading-history src/lib/components/Settings/Reader --testTimeout=30000`

Expected: PASS. Every file passes, including `pause-review.test.ts`, `IdleCutoffSetting.test.ts`, `LongPauseSetting.test.ts` and `series-data.test.ts`.

Run: `npx tsc --noEmit -p . 2>&1 | grep -E "tracking-data|unified-sync-service|reading-history/devices"`

Expected: no output. The generic loop now iterates `ENTRY_KEYS: EntryKey[]`, so `.lastUpdated` type-checks.

Run: `npx eslint src/lib/settings/tracking-data.ts src/lib/settings/tracking-data.test.ts && npx prettier --check src/lib/settings/tracking-data.ts src/lib/settings/tracking-data.test.ts src/lib/util/sync/unified-sync-service.ts src/lib/util/sync/unified-sync-service.test.ts`

Expected: 0 ESLint problems, and "All matched files use Prettier code style!".

- [ ] **Step 13: Commit**

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-devices
git add src/lib/settings/tracking-data.ts src/lib/settings/tracking-data.test.ts \
  src/lib/util/sync/unified-sync-service.ts src/lib/util/sync/unified-sync-service.test.ts
# only if Step 0 changed it:
git add src/lib/reading-history/devices.ts
git commit -m "$(cat <<'EOF'
feat(history): device labels sync in volume-data.json tracking.devices

Per-device-id newest-wins merge, devices/<id> bogus keys with
forfeit-on-bogus, a per-id duplicate-copy fold (foldableTracking), and
renameDevice / setDeviceClass / mergeDevice / unmergeDevice setters with
cycle-safe, chain-flattening merges.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **Verified in a scratch copy, not in the worktree.** I ran every step against a copy of the worktree at `/tmp/claude-1000/-home-nathan-Projects-mokuro-reader/6f65961f-f765-436a-a0b9-aa680120300c/scratchpad/t2verify`, where Task 1 is stubbed: `isDeviceId` in paths.ts, and `resolveDevice` with the design's cycle rule returning `id`.
  - Steps 2, 6 and 10 failed as stated above.
  - After all edits: 47/47 tracking-data tests, 72/72 sync tests, and 1210 tests across util/sync, settings, reading-history and Settings/Reader all pass.
  - `tsc` shows no errors in the touched files, ESLint is clean, and Prettier is clean. The test code above is the Prettier-formatted text.
- **Import cycle hazard for Task 3.** tracking-data.ts now imports `resolveDevice` from `R/devices.ts` at runtime.
  - devices.ts must stay pure: only `import type { DeviceLabel }` from tracking-data.
  - Task 3's stores (`deviceFacts` liveQuery, `knownDevices`, `devices`, `deviceStats`) read `deviceLabels` at module level. They must go in a separate module such as `R/device-store.ts`, not in devices.ts. Otherwise tracking-data → devices → tracking-data hits the temporal dead zone (TDZ) on `deviceLabels`.
  - This is not a problem for `unified-sync-service.test.ts`: it already uses the real paths.ts, and devices.ts only adds pure imports.
- **`DeviceLabel` ownership.** Design §2 places it in tracking-data.ts, and that is where this task defines it. If Task 1 had to declare a stand-in in devices.ts because Task 1 runs first, Step 0 replaces it with a type-only import. Task 1 should ideally declare it with exactly `{ name?: string; class?: DeviceClass; merged_into?: string; lastUpdated: string }`.
- **`mergeDevice` has no `labels` parameter** (deviation from §2), so it cannot write a cycle from a stale map.
  - The cycle guard is a private walk (`mergeReaches`), not `resolveDevice`. On a cycle, `resolveDevice` returns the start id, so it cannot tell whether `source` lies on the cycle.
  - The "existing cycle" test therefore passes whether Task 1 returns the start id or a cycle member.
- **`unmergeDevice` writes nothing when the device is not merged.** This avoids dirtying `volume-data.json`, which matters for Task 4's Unmerge button. Design §2 only said it "deletes merged_into under a new stamp".
- **`setDeviceClass` checks the class at runtime** against the closed set as well as by type, because Task 4's `Select` hands it a string.
- **`renameDevice` and `setDeviceClass` ignore non-device ids silently** (void return). Task 4 and 5 UIs must not offer rename on the "Before history" row (R5).
- **`DEVICE_CLASSES` is duplicated as a private constant** in tracking-data.ts. The existing one in history-sync.ts:45 is not exported, and history-sync is too heavy to import into a settings store. A later cleanup could export a single copy from `R/types.ts`.
- **`copyTrackingEntry` is still exported** and used internally. After Step 11 the service no longer imports it.

---

### Task 3: Per-device totals in the engine, and the device stores

**Files:**

- Modify: `src/lib/reading-history/stats-engine.ts`. The edits fall at lines 75-76 (`PreparedVolume.adjusts`), 106 (new `DeviceTotals` above `VolumeTotals`), 121-123 (`VolumeTotals.byDevice`), 173 (the adjust push), 350-374 (`countVolume` second loop and adjusts loop), 388-398 (the return), and a new helper after `countVolume`, before `totalsBefore` at line 400.
- Modify: `src/lib/reading-history/stats-engine.test.ts`. The edits fall at lines 17-20 (imports), 85-86 (the `adjust` helper) and a new block appended after line 637.
- Modify: `src/lib/reading-history/stats-store.ts`, lines 195-224 (`figuresFor` is split and `unexplainedBaseline` is exported).
- Modify: `src/lib/reading-history/stats-store.test.ts`, lines 26-29 (imports) and a new test inserted before line 95.
- Modify: `src/lib/reading-history/position-store.ts`, line 22 (export `ownDeviceId`).
- Modify: `src/lib/reading-history/position-store.test.ts`, lines 22-24 (imports) and line 64 (new first test).
- Create: `src/lib/reading-history/device-stats.ts`
- Test: `src/lib/reading-history/device-stats.test.ts`

**Interfaces:**

Consumes from Task 1:

- `isDeviceId(id: string): boolean` from `./paths`.
- From `./devices`:
  - `resolveDevice(id: string, labels: Record<string, DeviceLabel>): string`
  - `labelDevices(known: KnownDevice[], labels: Record<string, DeviceLabel>, own: string): Map<string, DeviceView>`, keyed by raw id.
  - `interface KnownDevice { id: string; facts: Pick<DeviceFacts, 'class' | 'os' | 'browser'>; firstSeen: string }`
  - `interface DeviceView { id; label; named; class; detectedClass; isThisDevice; canonical; mergedFrom; firstSeen }`

Consumes from Task 2, all from `$lib/settings/tracking-data`:

- `interface DeviceLabel { name?; class?; merged_into?; lastUpdated: string }`
- `TrackingState.devices?: Record<string, DeviceLabel>`
- `deviceLabels: Readable<Record<string, DeviceLabel>>`
- `setTrackingStates(state: TrackingState)`, which must accept `devices`.

Produces:

```ts
// stats-engine.ts
export interface DeviceTotals {
  timeMs: number; readChars: number; skippedChars: number;
  sampleMs: number; sampleChars: number;
  adjustMs: number; adjustChars: number;
  firstReadAt: number | null; lastReadAt: number | null;
}
PreparedVolume.adjusts: Array<{ t: number; ms: number; chars: number; device: string }>;
VolumeTotals.byDevice: Map<string, DeviceTotals>; // raw id; every legacy view under LEGACY_DEVICE_PREFIX ('legacy:')

// stats-store.ts
export function unexplainedBaseline(stats: ReadingStatsState, volume: string, record?: BaselineSource): { timeMs: number; chars: number };

// position-store.ts
export const ownDeviceId: Readable<string | null>;

// device-stats.ts  (NEW; stores live here, not in devices.ts — see notes)
export const SPEED_MIN_SAMPLE_MS = 30 * 60_000;
export const BEFORE_HISTORY = 'before-history';
export const EDITS = 'edits';
export interface DeviceStatsRow { key: string; kind: 'device' | 'before-history' | 'edits'; members: string[]; timeMs: number; readChars: number; skippedChars: number; sampleMs: number; sampleChars: number; charsPerMinute: number | null; share: number; firstReadAt: number | null; lastReadAt: number | null; }
export interface DeviceStats { rows: DeviceStatsRow[]; totalTimeMs: number; totalChars: number; nativeGroups: number; }
export function liveDeviceFacts(open: () => Promise<HistoryDexie>): Readable<DeviceFacts[]>;
export const deviceFacts: Readable<DeviceFacts[]>;
export function knownDevicesFrom(facts: readonly DeviceFacts[], stats: ReadingStatsState): KnownDevice[];
export const knownDevices: Readable<KnownDevice[]>;          // re-emits only when its JSON changes
export const devices: Readable<Map<string, DeviceView>>;      // labelDevices(known, labels, own ?? '')
export function deviceStatsFrom(stats: ReadingStatsState, records: Record<string, BaselineSource>, labels: Record<string, DeviceLabel>): DeviceStats;
export const deviceStats: Readable<DeviceStats>;              // derived([readingStats, volumes, deviceLabels])
```

---

- [ ] **Step 1: Write the failing engine tests**

In `src/lib/reading-history/stats-engine.test.ts`, add the type import. Before (lines 17-20):

```ts
  type IdleSettings,
  type Pause,
  type PreparedVolume
} from './stats-engine';
```

After:

```ts
  type DeviceTotals,
  type IdleSettings,
  type Pause,
  type PreparedVolume
} from './stats-engine';
```

Give `adjust` a device parameter. Before (lines 85-86):

```ts
const adjust = (t: number, time: number, chars: number): ReadingEvent => ({
  device: 'dev-a',
```

After:

```ts
const adjust = (t: number, time: number, chars: number, device = 'dev-a'): ReadingEvent => ({
  device,
```

Append at the end of the file, after line 637:

```ts
describe('per-device totals', () => {
  const pace = 200;
  const none: DeviceTotals = {
    timeMs: 0,
    readChars: 0,
    skippedChars: 0,
    sampleMs: 0,
    sampleChars: 0,
    adjustMs: 0,
    adjustChars: 0,
    firstReadAt: null,
    lastReadAt: null
  };

  it('keeps the device on each volume-editor edit', () => {
    expect(prepareVolume([adjust(5, MIN, 40, 'dev-c')]).adjusts).toEqual([
      { t: 5, ms: MIN, chars: 40, device: 'dev-c' }
    ]);
  });

  it('splits a volume by raw device: first view credits a page, legacy under one key, edits apart', () => {
    const totals = countVolume(
      prepareVolume([
        view(0, 1, [300], 60_000, 'dev-a'),
        // Page 1 again, same pass: time counts here, characters went to dev-a.
        view(2 * MIN, 1, [300], 30_000, 'dev-b'),
        // A skim: 1000 characters in 5 s.
        view(3 * MIN, 2, [1000], 5_000, 'dev-b'),
        adjust(50 * MIN, 4 * MIN, 100, 'dev-c'),
        legacy(100 * MIN, 5, 100, 60_000),
        legacy(101 * MIN, 6, 400, null)
      ]),
      pace,
      AUTO
    );
    expect(totals.byDevice).toEqual(
      new Map<string, DeviceTotals>([
        [
          'dev-a',
          {
            ...none,
            timeMs: 60_000,
            readChars: 300,
            sampleMs: 60_000,
            sampleChars: 300,
            firstReadAt: 0,
            lastReadAt: 60_000
          }
        ],
        [
          'dev-b',
          {
            ...none,
            timeMs: 35_000,
            skippedChars: 1000,
            sampleMs: 30_000,
            firstReadAt: 2 * MIN,
            lastReadAt: 3 * MIN + 5_000
          }
        ],
        ['dev-c', { ...none, adjustMs: 4 * MIN, adjustChars: 100 }],
        [
          'legacy:',
          {
            ...none,
            timeMs: 60_000,
            readChars: 300,
            sampleMs: 60_000,
            sampleChars: 300,
            firstReadAt: 100 * MIN,
            lastReadAt: 101 * MIN
          }
        ]
      ])
    );
  });

  it('sums to the volume totals on random multi-device libraries', () => {
    const devices = ['dev-a', 'dev-b', 'dev-c'];
    for (const seed of [2, 17, 333, 4096]) {
      let x = seed;
      const rand = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const events: ReadingEvent[] = [];
      let t = 0;
      for (let i = 0; i < 120; i++) {
        t += Math.floor(rand() * 600_000);
        const device = devices[Math.floor(rand() * devices.length)];
        const page = 1 + Math.floor(rand() * 50);
        const amount = rand();
        const roll = rand();
        if (roll < 0.05) events.push(restart(t));
        else if (roll < 0.1) {
          events.push(
            adjust(t, (amount - 0.5) * 20 * MIN, Math.round((amount - 0.5) * 900), device)
          );
        } else if (roll < 0.2) {
          events.push(legacy(t, page, Math.floor(amount * 9000), Math.floor(amount * 600_000)));
        } else {
          events.push(
            view(t, page, [Math.floor(amount * 400)], Math.floor(rand() * 3_600_000), device)
          );
        }
      }
      const totals = countVolume(prepareVolume(events), pace, AUTO);
      const parts = [...totals.byDevice.values()];
      const sum = (f: (d: DeviceTotals) => number) => parts.reduce((n, d) => n + f(d), 0);
      expect(sum((d) => d.timeMs + d.adjustMs)).toBeCloseTo(totals.timeMs, 6);
      expect(sum((d) => d.readChars + d.adjustChars)).toBe(totals.readChars);
      expect(sum((d) => d.skippedChars)).toBe(totals.skippedChars);
      expect(sum((d) => d.sampleMs)).toBeCloseTo(
        totals.samples.reduce((n, s) => n + s.ms, 0),
        6
      );
      expect(sum((d) => d.sampleChars)).toBe(totals.samples.reduce((n, s) => n + s.chars, 0));
      expect(Math.max(...parts.map((d) => d.lastReadAt ?? -Infinity))).toBe(totals.lastReadAt);
      expect([...totals.byDevice.keys()].every((k) => devices.includes(k) || k === 'legacy:')).toBe(
        true
      );
    }
  });
});
```

- [ ] **Step 2: Run it**

`npx vitest run src/lib/reading-history/stats-engine.test.ts --testTimeout=30000`

Expected: FAIL. 3 tests in "per-device totals" fail:

- `adjusts` has no `device` key (a toEqual diff).
- `expect(totals.byDevice)` receives `undefined`.
- `TypeError: Cannot read properties of undefined (reading 'values')`.

The other 44 tests pass.

- [ ] **Step 3: Implement `byDevice` in the engine**

In `src/lib/reading-history/stats-engine.ts`:

Lines 75-76. Before:

```ts
/** Volume-editor edits, in time order. */
adjusts: Array<{ t: number; ms: number; chars: number }>;
```

After:

```ts
/** Volume-editor edits, in time order, with the device that made each. */
adjusts: Array<{ t: number; ms: number; chars: number; device: string }>;
```

Line 106. Insert this directly above `export interface VolumeTotals {`:

```ts
/**
 * One device's share of a volume (phase 4). The parts sum to the volume:
 * Σ (`timeMs` + `adjustMs`) = `VolumeTotals.timeMs`, Σ (`readChars` +
 * `adjustChars`) = `readChars`, Σ `skippedChars` = `skippedChars`. A page's
 * characters go to the device whose view credited them (first view wins).
 */
export interface DeviceTotals {
  /** Counted dwell of this device's views. */
  timeMs: number;
  readChars: number;
  skippedChars: number;
  /** What its speed samples hold (non-skip views that counted time). */
  sampleMs: number;
  sampleChars: number;
  /** Its volume-editor edits — kept apart: they are not reading. */
  adjustMs: number;
  adjustChars: number;
  /** Earliest view start and latest view end; `null` when it only edited. */
  firstReadAt: number | null;
  lastReadAt: number | null;
}
```

Lines 121-123. Before:

```ts
  /** Native views over their cap or answered, oldest first. Legacy never. */
  pauses: Pause[];
}
```

After:

```ts
  /** Native views over their cap or answered, oldest first. Legacy never. */
  pauses: Pause[];
  /**
   * By RAW device id (merges are applied by whoever groups them); every
   * converted turn under the one key `LEGACY_DEVICE_PREFIX`.
   */
  byDevice: Map<string, DeviceTotals>;
}
```

Line 173. Before:

```ts
adjusts.push({ t: e.t, ms: e.time_delta_ms, chars: e.chars_delta });
```

After:

```ts
adjusts.push({ t: e.t, ms: e.time_delta_ms, chars: e.chars_delta, device: e.device });
```

Lines 350-351. Before:

```ts
  const skippedSeen = new Set<string>();
  for (const { view, ms, reads } of counted) {
```

After:

```ts
  const skippedSeen = new Set<string>();
  const byDevice = new Map<string, DeviceTotals>();
  for (const { view, ms, reads } of counted) {
```

Lines 367-374. Before:

```ts
    entries.push([view.t, ms, fresh, skimmed]);
    if (reads && ms > 0) samples.push({ end: view.end, ms, chars: fresh });
  }
  for (const a of prepared.adjusts) {
    timeMs += a.ms;
    readChars += a.chars;
    entries.push([a.t, a.ms, a.chars, 0]);
  }
```

After:

```ts
    entries.push([view.t, ms, fresh, skimmed]);
    const part = deviceTotals(byDevice, view.device);
    part.timeMs += ms;
    part.readChars += fresh;
    part.skippedChars += skimmed;
    part.firstReadAt = Math.min(part.firstReadAt ?? view.t, view.t);
    part.lastReadAt = Math.max(part.lastReadAt ?? view.end, view.end);
    if (reads && ms > 0) {
      samples.push({ end: view.end, ms, chars: fresh });
      part.sampleMs += ms;
      part.sampleChars += fresh;
    }
  }
  for (const a of prepared.adjusts) {
    timeMs += a.ms;
    readChars += a.chars;
    entries.push([a.t, a.ms, a.chars, 0]);
    const part = deviceTotals(byDevice, a.device);
    part.adjustMs += a.ms;
    part.adjustChars += a.chars;
  }
```

Lines 395-398. Before:

```ts
    samples,
    pauses
  };
}
```

After:

```ts
    samples,
    pauses,
    byDevice
  };
}

/** The running share of `device` (converted turns all share one key), created empty. */
function deviceTotals(byDevice: Map<string, DeviceTotals>, device: string): DeviceTotals {
  const key = device.startsWith(LEGACY_DEVICE_PREFIX) ? LEGACY_DEVICE_PREFIX : device;
  let part = byDevice.get(key);
  if (!part) {
    part = {
      timeMs: 0,
      readChars: 0,
      skippedChars: 0,
      sampleMs: 0,
      sampleChars: 0,
      adjustMs: 0,
      adjustChars: 0,
      firstReadAt: null,
      lastReadAt: null
    };
    byDevice.set(key, part);
  }
  return part;
}
```

`LEGACY_DEVICE_PREFIX` is already imported at line 1. Each view costs one Map lookup and a few additions, and no per-sample array is created, so the page-turn hot path stays O(views).

- [ ] **Step 4: Run it**

`npx vitest run src/lib/reading-history/stats-engine.test.ts --testTimeout=30000`

Expected: PASS, 47 tests.

- [ ] **Step 5: Write the failing `ownDeviceId` test**

In `src/lib/reading-history/position-store.test.ts`, lines 22-24. Before:

```ts
  markPrompted,
  positionPlanFor,
  shouldPrompt
} from './position-store';
```

After:

```ts
  markPrompted,
  ownDeviceId,
  positionPlanFor,
  shouldPrompt
} from './position-store';
```

At line 64, make this the first test in `describe('position store', () => {`:

```ts
it("exposes this device's id once started, and none after a reset", () => {
  expect(get(ownDeviceId)).toBe(own);
  _resetPositionStoreForTests();
  expect(get(ownDeviceId)).toBeNull();
});
```

- [ ] **Step 6: Run it**

`npx vitest run src/lib/reading-history/position-store.test.ts --testTimeout=30000`

Expected: FAIL with `AssertionError: expected undefined to be '<uuid>'`. The export does not exist yet, so `get(undefined)` returns `undefined`.

- [ ] **Step 7: Export the own id**

In `src/lib/reading-history/position-store.ts`, line 22. Before:

```ts
const ownDevice = writable<string | null>(null);
let stopListening: (() => void) | null = null;
```

After:

```ts
const ownDevice = writable<string | null>(null);
/**
 * This device's history id, once `initPositionOffers` has read it (`null`
 * before). The one place the app holds it: device views mark "This device"
 * from here rather than reading `history_meta` again.
 */
export const ownDeviceId: Readable<string | null> = { subscribe: ownDevice.subscribe };
let stopListening: (() => void) | null = null;
```

`Readable` is already imported at line 1. There is still only the one existing `getOrCreateDeviceId` caller here.

- [ ] **Step 8: Run it**

`npx vitest run src/lib/reading-history/position-store.test.ts --testTimeout=30000`

Expected: PASS, 8 tests.

- [ ] **Step 9: Write the failing `unexplainedBaseline` test**

In `src/lib/reading-history/stats-store.test.ts`, lines 26-29. Before:

```ts
  seriesReadingSpeed,
  seriesSpeed
} from './stats-store';
```

After:

```ts
  seriesReadingSpeed,
  seriesSpeed,
  unexplainedBaseline
} from './stats-store';
```

Insert this before `it('is the snapshot alone for a volume with no events', () => {` (line 95):

```ts
it('names the part of the snapshot its history does not explain (what figuresFor adds)', async () => {
  await record([view('v1', 0, 1, 300, 2 * MIN), view('v1', 20 * MIN, 2, 300, MIN)]);
  const stats = get(readingStats);
  const legacyStats = { time_ms: 10 * MIN, chars: 1000, before: 10 * MIN };
  expect(unexplainedBaseline(stats, 'v1', { legacyStats })).toEqual({
    timeMs: 8 * MIN,
    chars: 700
  });
  // History before the freeze already explains more than the snapshot held.
  const small = { time_ms: MIN, chars: 100, before: 10 * MIN };
  expect(unexplainedBaseline(stats, 'v1', { legacyStats: small })).toEqual({
    timeMs: 0,
    chars: 0
  });
  expect(unexplainedBaseline(stats, 'v1')).toEqual({ timeMs: 0, chars: 0 });
  expect(unexplainedBaseline(stats, 'none', { legacyStats })).toEqual({
    timeMs: 10 * MIN,
    chars: 1000
  });
});
```

- [ ] **Step 10: Run it**

`npx vitest run src/lib/reading-history/stats-store.test.ts --testTimeout=30000`

Expected: FAIL with `TypeError: unexplainedBaseline is not a function`. The other 19 tests pass.

- [ ] **Step 11: Split `figuresFor`**

In `src/lib/reading-history/stats-store.ts`, lines 195-217. Before:

```ts
/**
 * A volume's time and characters: its history, plus whatever of the
 * pre-history snapshot the events from before its freeze do not explain.
 * Clamped only here, after the snapshot is added, so an editor edit below
 * the old figure takes effect.
 */
export function figuresFor(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): VolumeFigures {
  const totals = stats.byVolume.get(volume);
  let timeMs = totals?.timeMs ?? 0;
  let chars = totals?.readChars ?? 0;
  const snapshot = snapshotOf(record, !baselinesFrozen);
  if (snapshot) {
    const explained = totals
      ? totalsBefore(totals, snapshot.before)
      : { timeMs: 0, readChars: 0, skippedChars: 0 };
    timeMs += Math.max(0, snapshot.time_ms - explained.timeMs);
    chars += Math.max(0, snapshot.chars - explained.readChars - explained.skippedChars);
  }
  timeMs = Math.max(0, timeMs);
```

After:

```ts
/**
 * Whatever of a volume's pre-history snapshot the events from before its
 * freeze do not explain — never negative. It belongs to no device (the
 * device stats' "Before history" row).
 */
export function unexplainedBaseline(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): { timeMs: number; chars: number } {
  const snapshot = snapshotOf(record, !baselinesFrozen);
  if (!snapshot) return { timeMs: 0, chars: 0 };
  const totals = stats.byVolume.get(volume);
  const explained = totals
    ? totalsBefore(totals, snapshot.before)
    : { timeMs: 0, readChars: 0, skippedChars: 0 };
  return {
    timeMs: Math.max(0, snapshot.time_ms - explained.timeMs),
    chars: Math.max(0, snapshot.chars - explained.readChars - explained.skippedChars)
  };
}

/**
 * A volume's time and characters: its history, plus whatever of the
 * pre-history snapshot the events from before its freeze do not explain.
 * Clamped only here, after the snapshot is added, so an editor edit below
 * the old figure takes effect.
 */
export function figuresFor(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): VolumeFigures {
  const totals = stats.byVolume.get(volume);
  const baseline = unexplainedBaseline(stats, volume, record);
  const timeMs = Math.max(0, (totals?.timeMs ?? 0) + baseline.timeMs);
  const chars = (totals?.readChars ?? 0) + baseline.chars;
```

The `return { timeMs, minutes: …, chars: Math.max(0, chars), … }` that follows does not change.

- [ ] **Step 12: Run it**

`npx vitest run src/lib/reading-history/stats-store.test.ts src/lib/reading-history/total-stats.test.ts --testTimeout=30000`

Expected: PASS, 21 tests. The existing `figuresFor` and `totalStats` cases still hold, which shows the refactor changes no figure.

- [ ] **Step 13: Write the failing device-store tests**

Create `src/lib/reading-history/device-stats.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));

import { get, type Readable } from 'svelte/store';
import { setTrackingStates } from '$lib/settings/tracking-data';
import { VolumeData, clearVolumes, volumes, volumesWithTrash } from '$lib/settings/volume-data';
import { HistoryDexie, historyDb } from './history-db';
import { getOrCreateDeviceId, notifyEventsRecorded } from './record';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';
import { _resetPositionStoreForTests, initPositionOffers } from './position-store';
import {
  _countedForTests,
  _resetReadingStatsForTests,
  figuresFor,
  flushReadingStats,
  initReadingStats,
  readingStats
} from './stats-store';
import {
  BEFORE_HISTORY,
  EDITS,
  deviceStats,
  devices,
  knownDevices,
  liveDeviceFacts,
  type DeviceStatsRow
} from './device-stats';
import type { DeviceFacts, ReadingEvent } from './types';

const MIN = 60_000;
const T1 = '2026-10-01T00:00:00.000Z';
let db: HistoryDexie;
let seq = 0;

const view = (
  device: string,
  volume: string,
  t: number,
  page: number,
  chars: number,
  dwell: number
): ReadingEvent => ({
  device,
  seq: ++seq,
  t,
  kind: 'page',
  volume,
  first_page: page,
  last_page: page,
  page_chars: [chars],
  chars_before: 0,
  dwell_ms: dwell,
  layout: 'single',
  orientation: 'portrait',
  viewport: null
});

const adjust = (
  device: string,
  volume: string,
  t: number,
  ms: number,
  chars: number
): ReadingEvent => ({
  device,
  seq: ++seq,
  t,
  kind: 'adjust',
  volume,
  time_delta_ms: ms,
  chars_delta: chars
});

/** A converted page turn: `cumulative` characters read before it. */
const legacyTurn = (
  volume: string,
  t: number,
  page: number,
  cumulative: number,
  dwell: number | null
): ReadingEvent => ({
  device: `legacy:${volume}`,
  seq: ++seq,
  t,
  kind: 'page',
  volume,
  first_page: page,
  last_page: page,
  page_chars: [0],
  chars_before: cumulative,
  dwell_ms: dwell,
  layout: 'unknown',
  orientation: 'unknown',
  viewport: null
});

async function record(events: ReadingEvent[]) {
  await db.reading_events.bulkAdd(events);
  notifyEventsRecorded(events);
  await Promise.resolve();
  flushReadingStats();
}

function setRecords(records: Record<string, Partial<VolumeData>>) {
  volumesWithTrash.set(
    Object.fromEntries(Object.entries(records).map(([id, r]) => [id, new VolumeData(r)]))
  );
}

const stops: Array<() => void> = [];

/** Keep a store subscribed (a `liveQuery` behind it delivers asynchronously). */
function watch<T>(store: Readable<T>) {
  let value!: T;
  let emissions = 0;
  const stop = store.subscribe((v) => {
    value = v;
    emissions++;
  });
  stops.push(stop);
  return { latest: () => value, emissions: () => emissions };
}

const row = (over: Partial<DeviceStatsRow> & Pick<DeviceStatsRow, 'key' | 'kind'>) => ({
  members: [],
  timeMs: 0,
  readChars: 0,
  skippedChars: 0,
  sampleMs: 0,
  sampleChars: 0,
  charsPerMinute: null,
  share: 0,
  firstReadAt: null,
  lastReadAt: null,
  ...over
});

beforeEach(async () => {
  clearVolumes();
  window.localStorage.clear();
  setTrackingStates({});
  _resetHistoryTurns();
  _resetReadingStatsForTests();
  _resetPositionStoreForTests();
  await historyDb().devices.clear();
  db = new HistoryDexie(`devices-${Math.random()}`);
  await loadHistoryTurns(db);
  initReadingStats();
  flushReadingStats();
});

afterEach(() => {
  while (stops.length) stops.pop()!();
});

describe('deviceStats', () => {
  it('splits the page total by device, with Before history and Edits rows that make it add up', async () => {
    setRecords({
      v1: { legacyStats: { time_ms: 10 * MIN, chars: 2000, before: 5 * MIN } },
      v2: {}
    });
    await record([
      view('dev-a', 'v1', 0, 1, 300, 2 * MIN),
      view('dev-b', 'v1', 10 * MIN, 2, 600, 3 * MIN),
      adjust('dev-b', 'v1', 20 * MIN, MIN, 50),
      legacyTurn('v2', 30 * MIN, 1, 0, 2 * MIN),
      legacyTurn('v2', 32 * MIN, 2, 400, null)
    ]);
    const stats = get(deviceStats);
    expect(stats.rows).toEqual([
      row({
        key: 'dev-a',
        kind: 'device',
        members: ['dev-a'],
        timeMs: 2 * MIN,
        readChars: 300,
        sampleMs: 2 * MIN,
        sampleChars: 300,
        share: 2 / 16,
        firstReadAt: 0,
        lastReadAt: 2 * MIN
      }),
      row({
        key: 'dev-b',
        kind: 'device',
        members: ['dev-b'],
        timeMs: 3 * MIN,
        readChars: 600,
        sampleMs: 3 * MIN,
        sampleChars: 600,
        share: 3 / 16,
        firstReadAt: 10 * MIN,
        lastReadAt: 13 * MIN
      }),
      // v1's snapshot less the 2 min / 300 chars read before its freeze, plus
      // v2's converted turns.
      row({
        key: BEFORE_HISTORY,
        kind: 'before-history',
        timeMs: 10 * MIN,
        readChars: 2100,
        sampleMs: 2 * MIN,
        sampleChars: 400,
        share: 10 / 16,
        firstReadAt: 30 * MIN,
        lastReadAt: 32 * MIN
      }),
      row({ key: EDITS, kind: 'edits', timeMs: MIN, readChars: 50, share: 1 / 16 })
    ]);
    expect(stats.nativeGroups).toBe(2);
    const records = get(volumes);
    const pageTotal = Object.keys(records).reduce(
      (sum, id) => sum + figuresFor(get(readingStats), id, records[id]).timeMs,
      0
    );
    expect(stats.totalTimeMs).toBe(16 * MIN);
    expect(stats.totalTimeMs).toBe(pageTotal);
    expect(stats.totalChars).toBe(3050);
  });

  it('groups merged devices under their target; a label change regroups without a recount', async () => {
    setRecords({ v1: {} });
    await record([
      view('dev-a', 'v1', 0, 1, 300, 2 * MIN),
      view('dev-b', 'v1', 10 * MIN, 2, 600, 3 * MIN)
    ]);
    const counted = _countedForTests().length;
    setTrackingStates({ devices: { 'dev-b': { merged_into: 'dev-a', lastUpdated: T1 } } });
    const stats = get(deviceStats);
    expect(stats.rows).toEqual([
      row({
        key: 'dev-a',
        kind: 'device',
        members: ['dev-a', 'dev-b'],
        timeMs: 5 * MIN,
        readChars: 900,
        sampleMs: 5 * MIN,
        sampleChars: 900,
        share: 1,
        firstReadAt: 0,
        lastReadAt: 13 * MIN
      })
    ]);
    expect(stats.nativeGroups).toBe(1);
    expect(_countedForTests().length).toBe(counted);
  });

  it("shows a device's speed only from half an hour of its reading", async () => {
    setRecords({ v1: {} });
    await record([
      ...Array.from({ length: 10 }, (_, i) =>
        view('dev-a', 'v1', i * 4 * MIN, i + 1, 600, 3 * MIN)
      ),
      view('dev-b', 'v1', 60 * MIN, 20, 600, 3 * MIN)
    ]);
    const [a, b] = get(deviceStats).rows;
    expect(a).toMatchObject({ key: 'dev-a', sampleMs: 30 * MIN, charsPerMinute: 200 });
    expect(b).toMatchObject({ key: 'dev-b', sampleMs: 3 * MIN, charsPerMinute: null });
  });

  it('puts what the zero clamp takes back on the Edits row, so the rows still add up', async () => {
    setRecords({ v1: {} });
    await record([
      view('dev-a', 'v1', 0, 1, 300, 2 * MIN),
      adjust('dev-a', 'v1', MIN, -10 * MIN, -1000)
    ]);
    const stats = get(deviceStats);
    expect(stats.rows.map((r) => [r.key, r.timeMs, r.readChars, r.share])).toEqual([
      ['dev-a', 2 * MIN, 300, 0],
      [EDITS, -2 * MIN, -300, 0]
    ]);
    expect(stats.totalTimeMs).toBe(0);
    expect(stats.totalChars).toBe(0);
  });

  it('has no Before history or Edits row when they hold nothing', async () => {
    setRecords({ v1: {} });
    await record([view('dev-a', 'v1', 0, 1, 300, 2 * MIN)]);
    expect(get(deviceStats).rows.map((r) => r.key)).toEqual(['dev-a']);
  });

  it('counts only volumes the page counts (those with a record)', async () => {
    await record([view('dev-a', 'gone', 0, 1, 300, 2 * MIN)]);
    expect(get(deviceStats)).toMatchObject({ rows: [], nativeGroups: 0, totalTimeMs: 0 });
  });
});

describe('known devices', () => {
  const phone: DeviceFacts = {
    device: 'dev-x',
    class: 'phone',
    os: 'Android',
    first_seen: '2026-03-02T00:00:00.000Z',
    last_seen: '2026-10-01T00:00:00.000Z'
  };

  it('are the facts rows and every device with events, never converted turns', async () => {
    const known = watch(knownDevices);
    await historyDb().devices.put(phone);
    const may = Date.UTC(2026, 4, 1);
    await record([
      view('dev-a', 'v1', may + MIN, 2, 300, MIN),
      view('dev-a', 'v1', may, 1, 300, MIN),
      view('dev-x', 'v1', may + 2 * MIN, 3, 300, MIN),
      legacyTurn('v1', 0, 1, 0, MIN)
    ]);
    await vi.waitFor(() =>
      expect(known.latest()).toEqual([
        { id: 'dev-a', facts: { class: 'unknown' }, firstSeen: new Date(may).toISOString() },
        { id: 'dev-x', facts: { class: 'phone', os: 'Android' }, firstSeen: phone.first_seen }
      ])
    );
  });

  it('do not re-emit when a page turn changes nothing about them', async () => {
    const known = watch(knownDevices);
    await record([view('dev-a', 'v1', 0, 1, 300, MIN)]);
    await vi.waitFor(() => expect(known.latest().map((d) => d.id)).toEqual(['dev-a']));
    const before = known.emissions();
    await record([view('dev-a', 'v1', 5 * MIN, 2, 300, MIN)]);
    expect(known.emissions()).toBe(before);
  });

  it('are labelled, with this device marked', async () => {
    await initPositionOffers(db);
    const own = await getOrCreateDeviceId(db);
    const labelled = watch(devices);
    await historyDb().devices.put(phone);
    await record([view(own, 'v1', 0, 1, 300, MIN)]);
    await vi.waitFor(() => expect(labelled.latest().size).toBe(2));
    expect(labelled.latest().get(own)).toMatchObject({
      label: 'Unknown device',
      isThisDevice: true
    });
    expect(labelled.latest().get('dev-x')).toMatchObject({
      label: 'Phone · Android',
      isThisDevice: false
    });
    setTrackingStates({ devices: { [own]: { name: 'Kitchen tablet', lastUpdated: T1 } } });
    expect(labelled.latest().get(own)).toMatchObject({ label: 'Kitchen tablet', named: true });
  });

  it('liveDeviceFacts follows the devices table', async () => {
    const local = new HistoryDexie(`facts-${Math.random()}`);
    const facts = watch(liveDeviceFacts(async () => local));
    expect(facts.latest()).toEqual([]);
    await local.devices.put(phone);
    await vi.waitFor(() => expect(facts.latest()).toEqual([phone]));
    await local.devices.update('dev-x', { class: 'tablet' });
    await vi.waitFor(() => expect(facts.latest()[0].class).toBe('tablet'));
  });
});
```

- [ ] **Step 14: Run it**

`npx vitest run src/lib/reading-history/device-stats.test.ts --testTimeout=30000`

Expected: FAIL with `Failed to resolve import "./device-stats" from "src/lib/reading-history/device-stats.test.ts". Does the file exist?`

- [ ] **Step 15: Implement the device stores**

Create `src/lib/reading-history/device-stats.ts`:

```ts
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { deviceLabels, type DeviceLabel } from '$lib/settings/tracking-data';
import { volumes } from '$lib/settings/volume-data';
import { labelDevices, resolveDevice, type DeviceView, type KnownDevice } from './devices';
import type { HistoryDexie } from './history-db';
import { isDeviceId } from './paths';
import { ownDeviceId } from './position-store';
import type { DeviceTotals } from './stats-engine';
import {
  figuresFor,
  readingStats,
  unexplainedBaseline,
  type BaselineSource,
  type ReadingStatsState
} from './stats-store';
import type { DeviceFacts } from './types';

/**
 * Device views' data (phase 4): which devices the history knows, their
 * labels, and the reading split by device.
 *
 * - **Known devices** = facts rows (`db.devices`, read live) ∪ every device
 *   id with events. Converted turns (`legacy:…`) are never a device.
 * - **Merges group, never rewrite.** The engine keeps raw ids
 *   (`VolumeTotals.byDevice`); `resolveDevice` folds them into groups here,
 *   so a merge or an unmerge regroups without recounting anything.
 * - **The rows add up to the page.** Device rows, "Before history" (converted
 *   turns + each record's unexplained pre-history snapshot) and "Edits"
 *   (volume-editor adjusts, plus whatever the zero clamp takes back) sum to
 *   Σ `figuresFor` over the same records — the reading-speed page's totals.
 */

/** A device's speed shows from this much of its counted reading. */
export const SPEED_MIN_SAMPLE_MS = 30 * 60_000;
export const BEFORE_HISTORY = 'before-history';
export const EDITS = 'edits';
const EPOCH = new Date(0).toISOString();

export interface DeviceStatsRow {
  /** The group's canonical device id, or `BEFORE_HISTORY` / `EDITS`. */
  key: string;
  kind: 'device' | 'before-history' | 'edits';
  /** Raw device ids in the group, sorted (device rows only). */
  members: string[];
  /** Edits may be negative: an editor edit can take time away. */
  timeMs: number;
  readChars: number;
  skippedChars: number;
  sampleMs: number;
  sampleChars: number;
  /** Device rows with `SPEED_MIN_SAMPLE_MS` of samples; else `null`. */
  charsPerMinute: number | null;
  /** Of `DeviceStats.totalTimeMs`, within 0–1. */
  share: number;
  firstReadAt: number | null;
  /** From the newest view — never a device file's `last_seen` (stale). */
  lastReadAt: number | null;
}

export interface DeviceStats {
  /** Device groups by first read, then "Before history", then "Edits" (each only when non-zero). */
  rows: DeviceStatsRow[];
  totalTimeMs: number;
  totalChars: number;
  /** Device groups with reading of their own (what the stats card and the banner wait for). */
  nativeGroups: number;
}

/** `db.devices`, kept current. Dexie re-runs it only when that table is written (start, imports). */
export function liveDeviceFacts(open: () => Promise<HistoryDexie>): Readable<DeviceFacts[]> {
  return readable<DeviceFacts[]>([], (set) => {
    if (!browser) return;
    let stopped = false;
    let subscription: { unsubscribe(): void } | null = null;
    open().then(
      (db) => {
        if (stopped) return;
        subscription = liveQuery(() => db.devices.toArray()).subscribe({
          next: (rows) => set(rows),
          error: (error) => console.debug('[reading-history] device facts query failed:', error)
        });
      },
      (error) => console.debug('[reading-history] device facts unavailable:', error)
    );
    return () => {
      stopped = true;
      subscription?.unsubscribe();
    };
  });
}

export const deviceFacts: Readable<DeviceFacts[]> = liveDeviceFacts(() =>
  import('./history-db').then((m) => m.historyDb())
);

/** Facts rows ∪ event devices, by id. An id with events but no facts is an unknown class, first seen at its first view. */
export function knownDevicesFrom(
  facts: readonly DeviceFacts[],
  stats: ReadingStatsState
): KnownDevice[] {
  const firstRead = new Map<string, number | null>();
  for (const totals of stats.byVolume.values()) {
    for (const [id, part] of totals.byDevice) {
      if (!isDeviceId(id)) continue;
      const seen = firstRead.get(id) ?? null;
      const at = part.firstReadAt;
      firstRead.set(id, at === null ? seen : Math.min(seen ?? at, at));
    }
  }
  const known = new Map<string, KnownDevice>();
  for (const [id, at] of firstRead) {
    known.set(id, {
      id,
      facts: { class: 'unknown' },
      firstSeen: at === null ? EPOCH : new Date(at).toISOString()
    });
  }
  for (const row of facts) {
    if (!isDeviceId(row.device)) continue;
    const own: KnownDevice['facts'] = { class: row.class };
    if (row.os) own.os = row.os;
    if (row.browser) own.browser = row.browser;
    known.set(row.device, { id: row.device, facts: own, firstSeen: row.first_seen });
  }
  return [...known.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `source`, emitting only when `signature` changes (a page turn rarely changes who is known). */
function distinct<T>(source: Readable<T>, signature: (value: T) => string): Readable<T> {
  return readable<T>(undefined as T, (set) => {
    let last: string | null = null;
    return source.subscribe((value) => {
      const next = signature(value);
      if (next === last) return;
      last = next;
      set(value);
    });
  });
}

export const knownDevices: Readable<KnownDevice[]> = distinct(
  derived([deviceFacts, readingStats], ([$facts, $stats]) => knownDevicesFrom($facts, $stats)),
  (known) => JSON.stringify(known)
);

/** Every known device by raw id, labelled; "This device" is the group holding this device's id. */
export const devices: Readable<Map<string, DeviceView>> = derived(
  [knownDevices, deviceLabels, ownDeviceId],
  ([$known, $labels, $own]) => labelDevices($known, $labels, $own ?? '')
);

function emptyRow(key: string, kind: DeviceStatsRow['kind']): DeviceStatsRow {
  return {
    key,
    kind,
    members: [],
    timeMs: 0,
    readChars: 0,
    skippedChars: 0,
    sampleMs: 0,
    sampleChars: 0,
    charsPerMinute: null,
    share: 0,
    firstReadAt: null,
    lastReadAt: null
  };
}

function addViews(row: DeviceStatsRow, part: DeviceTotals): void {
  row.timeMs += part.timeMs;
  row.readChars += part.readChars;
  row.skippedChars += part.skippedChars;
  row.sampleMs += part.sampleMs;
  row.sampleChars += part.sampleChars;
  if (part.firstReadAt !== null) {
    row.firstReadAt = Math.min(row.firstReadAt ?? part.firstReadAt, part.firstReadAt);
  }
  if (part.lastReadAt !== null) {
    row.lastReadAt = Math.max(row.lastReadAt ?? part.lastReadAt, part.lastReadAt);
  }
}

/** The reading split by device group, over the same records the page totals. */
export function deviceStatsFrom(
  stats: ReadingStatsState,
  records: Record<string, BaselineSource>,
  labels: Record<string, DeviceLabel>
): DeviceStats {
  const groups = new Map<string, DeviceStatsRow>();
  const before = emptyRow(BEFORE_HISTORY, 'before-history');
  const edits = emptyRow(EDITS, 'edits');
  let totalTimeMs = 0;
  let totalChars = 0;
  for (const [volume, record] of Object.entries(records)) {
    // The page skips these too (`calculateReadingSpeedStats`).
    if (!volume) continue;
    const totals = stats.byVolume.get(volume);
    const figures = figuresFor(stats, volume, record);
    const baseline = unexplainedBaseline(stats, volume, record);
    totalTimeMs += figures.timeMs;
    totalChars += figures.chars;
    before.timeMs += baseline.timeMs;
    before.readChars += baseline.chars;
    // `figuresFor` clamps at zero after adding the baseline; only edits
    // (negative adjusts) can go below it, so what the clamp gives back is theirs.
    edits.timeMs += Math.max(0, -((totals?.timeMs ?? 0) + baseline.timeMs));
    edits.readChars += Math.max(0, -((totals?.readChars ?? 0) + baseline.chars));
    if (!totals) continue;
    for (const [id, part] of totals.byDevice) {
      edits.timeMs += part.adjustMs;
      edits.readChars += part.adjustChars;
      if (part.firstReadAt === null) continue;
      if (!isDeviceId(id)) {
        addViews(before, part);
        continue;
      }
      const key = resolveDevice(id, labels);
      let row = groups.get(key);
      if (!row) groups.set(key, (row = emptyRow(key, 'device')));
      if (!row.members.includes(id)) row.members.push(id);
      addViews(row, part);
    }
  }

  const deviceRows = [...groups.values()].sort(
    (a, b) =>
      (a.firstReadAt ?? 0) - (b.firstReadAt ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  for (const row of deviceRows) {
    row.members.sort();
    row.charsPerMinute =
      row.sampleMs >= SPEED_MIN_SAMPLE_MS ? (row.sampleChars / row.sampleMs) * 60_000 : null;
  }
  const rows = [...deviceRows];
  if (before.timeMs !== 0 || before.readChars !== 0 || before.skippedChars !== 0) rows.push(before);
  if (edits.timeMs !== 0 || edits.readChars !== 0) rows.push(edits);
  for (const row of rows) {
    row.share = totalTimeMs > 0 ? Math.min(1, Math.max(0, row.timeMs / totalTimeMs)) : 0;
  }
  return { rows, totalTimeMs, totalChars, nativeGroups: deviceRows.length };
}

export const deviceStats: Readable<DeviceStats> = derived(
  [readingStats, volumes, deviceLabels],
  ([$stats, $records, $labels]) => deviceStatsFrom($stats, $records, $labels)
);
```

- [ ] **Step 16: Run it**

`npx vitest run src/lib/reading-history/device-stats.test.ts --testTimeout=30000`

Expected: PASS, 10 tests.

- [ ] **Step 17: Run the whole history suite, type-check and lint**

```
npx vitest run src/lib/reading-history src/lib/components/Reader/__tests__ src/lib/settings --testTimeout=30000
npm run check
npx prettier --check src/lib/reading-history/{device-stats,device-stats.test,stats-engine,stats-engine.test,stats-store,stats-store.test,position-store,position-store.test}.ts
npx eslint src/lib/reading-history/device-stats.ts src/lib/reading-history/device-stats.test.ts src/lib/reading-history/stats-engine.ts src/lib/reading-history/stats-engine.test.ts src/lib/reading-history/stats-store.ts src/lib/reading-history/stats-store.test.ts src/lib/reading-history/position-store.ts src/lib/reading-history/position-store.test.ts
```

Expected:

- vitest: all pass (38 files / 481 tests with Tasks 1-2 in place).
- svelte-check: `0 ERRORS 0 WARNINGS`.
- prettier: "All matched files use Prettier code style!".
- eslint: no output.

- [ ] **Step 18: Commit**

```bash
git add src/lib/reading-history/stats-engine.ts src/lib/reading-history/stats-engine.test.ts \
  src/lib/reading-history/stats-store.ts src/lib/reading-history/stats-store.test.ts \
  src/lib/reading-history/position-store.ts src/lib/reading-history/position-store.test.ts \
  src/lib/reading-history/device-stats.ts src/lib/reading-history/device-stats.test.ts
git commit -m "$(cat <<'EOF'
feat(history): per-device totals and device stores

countVolume splits each volume by raw device id (byDevice; converted turns
under one legacy key, edits kept apart), and device-stats.ts groups it by
resolveDevice into rows that sum to the reading-speed page's totals, with
Before history and Edits rows. Known devices = live facts rows plus event
ids; position-store exports this device's id.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

**How this was checked.** I ran all of the code above in a scratch copy of the worktree at `/tmp/claude-1000/-home-nathan-Projects-mokuro-reader/6f65961f-f765-436a-a0b9-aa680120300c/scratchpad/t3dev`. It used minimal stand-ins for Task 1 (`isDeviceId`, `resolveDevice`, `generatedLabel`, `labelDevices`, `KnownDevice`, `DeviceView`) and Task 2 (`DeviceLabel`, `TrackingState.devices`, `deviceLabels`).

- Each RED message above is the one actually seen.
- The full unit suite passed (309 files, 4732 tests).
- svelte-check reported 0 errors; prettier and eslint were clean.
- Removing the `distinct` guard makes the "do not re-emit" test fail, so that test is not vacuous.

**Where this departs from the design:**

- **Stores live in a new `device-stats.ts`, not in `devices.ts`.** §3 says "R/devices.ts (pure, plus stores)", but the stores pull in Dexie `liveQuery`, `stats-store`, `position-store` and `volume-data`. That would make Task 1's pure tests load the whole app. Tasks 4, 5 and 6 should import `devices`, `knownDevices`, `deviceStats`, `deviceFacts` and `ownDeviceId` from `$lib/reading-history/device-stats` and `$lib/reading-history/position-store`.
- **`deviceStats` also derives from `volumes`.** §4 lists only `[readingStats, deviceLabels]`, but Q3 (rows must add up to the page's Total Time) needs the records. The rows cover exactly the records `calculateReadingSpeedStats` iterates (the `volumes` store, skipping `''`). History for a volume with no record counts towards no row. `knownDevices` scans every `byVolume` entry, records or not.
- **New `unexplainedBaseline` export in `stats-store.ts`.** `figuresFor` now delegates to it, with no change to any figure. Without it, the clamp correction could not be told apart from the baseline.
- **Edits row.** Adjusts are kept per device in the engine (`adjustMs`/`adjustChars`), as §4 says. Per Q4, the store puts all of them on the Edits row, plus whatever the zero clamp in `figuresFor` gives back.
  - **Edits can be negative.** Task 5 must render a sign (e.g. "−2 min").
  - `share` is clamped to 0–1.
- **Before history row.** It holds legacy views (with their samples) plus every record's unexplained baseline. Any non-legacy raw id that fails `isDeviceId` also lands there, so sums stay exact; that should never happen in practice. `charsPerMinute` is `null` on both non-device rows.
- **`DeviceTotals.firstReadAt`/`lastReadAt` come from views only**, so an id with only adjusts has `null` for both. Its `KnownDevice.firstSeen` then falls back to the epoch ISO string, unless it has a facts row (facts `first_seen` always wins).
- **Row order is stable.** Device rows are ordered by `firstReadAt`, then id, so a new device appends and nothing reshuffles (no layout motion). Showing "This device" first is Task 5's choice, using `$devices.get(id)?.isThisDevice`.
- **Speed is lifetime, not recent.** It shows when a group has ≥ 30 min of samples over all its reading (`SPEED_MIN_SAMPLE_MS`), not the 8 h recent window.

**What this task assumes from Task 1:**

- `KnownDevice` has exactly the shape `{ id: string; facts: Pick<DeviceFacts, 'class' | 'os' | 'browser'>; firstSeen: string }`. The design never spelled it out; Task 1 must define it this way or this task must adapt.
- `labelDevices` returns a Map keyed by **raw** id and accepts `own = ''` when the own id is not known yet.
- The "are labelled" test asserts Task 1's label rules:
  - an event-only device with class `unknown` and no OS/browser is "Unknown device";
  - `phone` + `Android` with no browser is "Phone · Android";
  - a `name` gives `label === name` and `named: true`.

**What this task assumes from Task 2:**

- `TrackingState` gains `devices?: Record<string, DeviceLabel>`, and `setTrackingStates({ devices: … })` type-checks.
- `deviceLabels` is exported from `$lib/settings/tracking-data`.

**Notes for the UI tasks:**

- **Task 5 gates:**
  - Card and banner wait for `$deviceStats.nativeGroups >= 2`.
  - The banner's "own device has no name" check is `$devices.get($ownDeviceId)?.named === false`. The own device always has a facts row from `touchDeviceRecord` at start, so it appears once the liveQuery delivers.
- **Task 4 gate:** `$knownDevices.length >= 2` (raw ids, per the §5 rule).
- **`ownDeviceId` can be `null` early.** It stays `null` until `initPositionOffers` resolves, which happens after history load and cut-over (`+layout.svelte:138-146`). UIs must tolerate `null` (no "This device" marker yet).
- **No facts `last_seen` anywhere.** "Last read" is `row.lastReadAt`.
- **Merges never trigger a recount.** A label change regroups without one; the `_countedForTests` assertion in the merge test checks this (R3).
- **No e2e in this task.** It adds no UI; e2e coverage comes with Task 7.

---

### Task 4: Device name field and the Devices block on the cloud screen

**Files:**

- Create: `src/lib/components/Devices/DeviceNameField.svelte`
- Create: `src/lib/components/Devices/DevicesSettings.svelte`
- Create: `src/lib/components/Devices/__tests__/device-view.ts` (fixture helper, not a test file; Task 5 reuses it)
- Test: `src/lib/components/Devices/__tests__/DeviceNameField.test.ts`
- Test: `src/lib/components/Devices/__tests__/DevicesSettings.test.ts`
- Modify: `src/lib/views/CloudView.svelte`
  - script imports, line 26: insert one import after it
  - connected-provider column, lines 1122–1124: insert `<DevicesSettings />` between the closing `</div>` of the Storage block and `<!-- Provider info box -->`
- Test: `src/lib/views/__tests__/cloud-devices.test.ts`. This is a source-level check, following the precedent in `backup-all-reconcile.test.ts`. Rendering CloudView needs five providers, quota and queues.

**Interfaces:**

Consumes from Task 1 (`src/lib/reading-history/devices.ts`):

```ts
export interface DeviceView {
  id: string;
  label: string; // user name verbatim, or generated label + collision suffix
  generated: string; // ADDITION (see notes): the collision-resolved generated label, === label when !named
  named: boolean;
  class: DeviceClass;
  detectedClass: DeviceClass;
  isThisDevice: boolean; // set on the canonical (group head) view
  canonical: string;
  mergedFrom: string[]; // raw ids whose resolveDevice(...) === this id (empty on non-heads)
  firstSeen: string; // ISO
}
export const CLASS_NAMES: Record<DeviceClass, string>; // must be EXPORTED (see notes)
```

Consumes from Task 3, at the path design §3 names (see notes about the import cycle):

```ts
export const devices: Readable<Map<string, DeviceView>>; // keyed by RAW id, every known isDeviceId id, merged ones included
```

Consumes from Task 2 (`src/lib/settings/tracking-data.ts`):

```ts
export const DEVICE_NAME_MAX: number; // 40
export interface DeviceLabel {
  name?: string;
  class?: DeviceClass;
  merged_into?: string;
  lastUpdated: string;
}
export const deviceLabels: Readable<Record<string, DeviceLabel>>;
export function renameDevice(id: string, name: string): void; // '' clears the name
export function setDeviceClass(id: string, cls: DeviceClass | null): void; // null = Automatic
export function mergeDevice(source: string, target: string): boolean; // false = refused
export function unmergeDevice(id: string): void;
```

Consumes `DeviceClass` from `src/lib/reading-history/types.ts` (exists, line 93).

Produces:

```ts
// DeviceNameField.svelte props
{ device: DeviceView; onDone?: () => void; autofocus?: boolean }
// DevicesSettings.svelte: no props; renders nothing until $devices.size >= 2
// __tests__/device-view.ts
export function deviceView(id: string, over?: Partial<DeviceView>): DeviceView;
export function deviceMap(...views: DeviceView[]): Map<string, DeviceView>;
```

- `onDone` and `autofocus` go beyond the design's `{ device }`. Task 5's inline rename swaps a label for the field, and needs to focus it and to know when to swap back. Both props are optional, so callers that pass only `device` are unaffected.

---

- [ ] **Step 1: Write the fixture helper.**

`src/lib/components/Devices/__tests__/device-view.ts`:

```ts
import type { DeviceView } from '$lib/reading-history/devices';

/** A DeviceView as `labelDevices` builds it: unnamed, unmerged, not this device. */
export function deviceView(id: string, over: Partial<DeviceView> = {}): DeviceView {
  const generated = over.generated ?? 'Desktop · Linux · Firefox';
  return {
    id,
    label: generated,
    generated,
    named: false,
    class: 'desktop',
    detectedClass: 'desktop',
    isThisDevice: false,
    canonical: id,
    mergedFrom: [],
    firstSeen: '2026-03-01T00:00:00.000Z',
    ...over
  };
}

/** The `devices` store's shape: every view under its raw id. */
export function deviceMap(...views: DeviceView[]): Map<string, DeviceView> {
  return new Map(views.map((v) => [v.id, v]));
}
```

- [ ] **Step 2: Write the failing test for DeviceNameField.**

`src/lib/components/Devices/__tests__/DeviceNameField.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { deviceView } from './device-view';

const renameDevice = vi.hoisted(() => vi.fn());
vi.mock('$lib/settings/tracking-data', () => ({ renameDevice, DEVICE_NAME_MAX: 40 }));

import DeviceNameField from '../DeviceNameField.svelte';

beforeEach(() => renameDevice.mockClear());
afterEach(cleanup);

describe('DeviceNameField', () => {
  it('an unnamed device shows an empty field with its generated label as the placeholder', () => {
    const { getByLabelText } = render(DeviceNameField, { props: { device: deviceView('dev-a') } });
    const field = getByLabelText('Device name') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('Desktop · Linux · Firefox');
    expect(field.maxLength).toBe(40);
  });

  it('Enter saves the trimmed name and ends the edit', async () => {
    const onDone = vi.fn();
    const { getByLabelText } = render(DeviceNameField, {
      props: { device: deviceView('dev-a'), onDone }
    });
    const field = getByLabelText('Device name') as HTMLInputElement;
    await fireEvent.input(field, { target: { value: '  Pixel 8 ' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(renameDevice).toHaveBeenCalledWith('dev-a', 'Pixel 8');
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('a named device shows its name; clearing it and saving goes back to the generated label', async () => {
    const device = deviceView('dev-a', { named: true, label: 'Pixel 8' });
    const { getByLabelText, getByRole } = render(DeviceNameField, { props: { device } });
    const field = getByLabelText('Device name') as HTMLInputElement;
    expect(field.value).toBe('Pixel 8');
    expect(field.placeholder).toBe('Desktop · Linux · Firefox');
    await fireEvent.input(field, { target: { value: '   ' } });
    await fireEvent.click(getByRole('button', { name: 'Save' }));
    expect(renameDevice).toHaveBeenCalledWith('dev-a', '');
  });

  it('Save on an unchanged name writes nothing but still ends the edit', async () => {
    const onDone = vi.fn();
    const device = deviceView('dev-a', { named: true, label: 'Pixel 8' });
    const { getByRole } = render(DeviceNameField, { props: { device, onDone } });
    await fireEvent.click(getByRole('button', { name: 'Save' }));
    expect(renameDevice).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('Escape reverts a draft and stops the key; on a clean field it ends the edit and lets the key through', async () => {
    const onDone = vi.fn();
    const device = deviceView('dev-a', { named: true, label: 'Pixel 8' });
    const { getByLabelText } = render(DeviceNameField, { props: { device, onDone } });
    const field = getByLabelText('Device name') as HTMLInputElement;
    expect(field.hasAttribute('data-escape-reverts')).toBe(false);
    await fireEvent.input(field, { target: { value: 'Pixel 9' } });
    expect(field.hasAttribute('data-escape-reverts')).toBe(true);
    // dispatchEvent returns false when the handler called preventDefault.
    expect(await fireEvent.keyDown(field, { key: 'Escape' })).toBe(false);
    expect(field.value).toBe('Pixel 8');
    expect(onDone).not.toHaveBeenCalled();
    expect(await fireEvent.keyDown(field, { key: 'Escape' })).toBe(true);
    expect(onDone).toHaveBeenCalledOnce();
    expect(renameDevice).not.toHaveBeenCalled();
  });

  it('a name arriving from sync replaces the shown name', async () => {
    const { getByLabelText, rerender } = render(DeviceNameField, {
      props: { device: deviceView('dev-a') }
    });
    await rerender({ device: deviceView('dev-a', { named: true, label: 'Kitchen tablet' }) });
    expect((getByLabelText('Device name') as HTMLInputElement).value).toBe('Kitchen tablet');
  });

  it('autofocus focuses the field on mount', () => {
    const { getByLabelText } = render(DeviceNameField, {
      props: { device: deviceView('dev-a'), autofocus: true }
    });
    expect(document.activeElement).toBe(getByLabelText('Device name'));
  });
});
```

- [ ] **Step 3: Run it.**

`npx vitest run src/lib/components/Devices/__tests__/DeviceNameField.test.ts --testTimeout=30000`

Expected: FAIL with `Failed to resolve import "../DeviceNameField.svelte" from "src/lib/components/Devices/__tests__/DeviceNameField.test.ts". Does the file exist?`

- [ ] **Step 4: Implement DeviceNameField.**

`src/lib/components/Devices/DeviceNameField.svelte`:

```svelte
<script lang="ts">
  /**
   * The one editor for a device's name (phase 4). The Devices block on the
   * cloud screen, the per-device stats card and the second-device banner all
   * use it. Enter or Save stores the trimmed name through `renameDevice`
   * (synced in `volume-data.json → tracking.devices`). An empty name goes back
   * to the generated label, which is the placeholder. Escape abandons a draft,
   * and only then stops the key; on a clean field it still reaches whatever
   * is around (`data-escape-reverts`, as in `SeriesRenameField`).
   *
   * The Save button is always there, so nothing appears or moves as you type.
   * With no change it only ends the edit (`onDone`).
   */
  import { Button } from 'flowbite-svelte';
  import type { DeviceView } from '$lib/reading-history/devices';
  import { DEVICE_NAME_MAX, renameDevice } from '$lib/settings/tracking-data';

  let {
    device,
    onDone,
    autofocus = false
  }: {
    device: DeviceView;
    /** After Save/Enter, and on Escape over a clean field: an inline editor closes. */
    onDone?: () => void;
    autofocus?: boolean;
  } = $props();

  /** The stored name; '' while the device goes by its generated label. */
  let saved = $derived(device.named ? device.label : '');
  // Writable derived: typing overrides it; a new stored name (a save, or a
  // rename from another device arriving by sync) re-seeds it.
  let draft = $derived(saved);
  let dirty = $derived(draft.trim() !== saved);

  function save() {
    if (dirty) renameDevice(device.id, draft.trim());
    onDone?.();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      if (!dirty) {
        onDone?.();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      draft = saved;
    }
  }

  function focusOnMount(node: HTMLInputElement) {
    if (autofocus) node.focus();
  }
</script>

<div class="flex items-center gap-2" data-testid="device-name-field">
  <input
    type="text"
    value={draft}
    oninput={(e) => (draft = e.currentTarget.value)}
    {onkeydown}
    maxlength={DEVICE_NAME_MAX}
    placeholder={device.generated}
    aria-label="Device name"
    data-escape-reverts={dirty ? '' : undefined}
    {@attach focusOnMount}
    class="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-2 py-1 text-sm text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
  />
  <!-- relative z-10: night mode's dialog filter resets stacking (see CLAUDE.md) -->
  <div class="relative z-10">
    <Button size="xs" color="primary" onclick={save}>Save</Button>
  </div>
</div>
```

- [ ] **Step 5: Run it.**

`npx vitest run src/lib/components/Devices/__tests__/DeviceNameField.test.ts --testTimeout=30000`

Expected: PASS (7 tests).

- [ ] **Step 6: Write the failing test for DevicesSettings.**

`src/lib/components/Devices/__tests__/DevicesSettings.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { writable, type Writable } from 'svelte/store';
import type { DeviceView } from '$lib/reading-history/devices';
import type { DeviceLabel } from '$lib/settings/tracking-data';
import { deviceMap, deviceView } from './device-view';

const state = vi.hoisted(() => ({
  devices: null as unknown as Writable<Map<string, DeviceView>>,
  labels: null as unknown as Writable<Record<string, DeviceLabel>>
}));
const setters = vi.hoisted(() => ({
  renameDevice: vi.fn(),
  setDeviceClass: vi.fn(),
  mergeDevice: vi.fn((_source: string, _target: string) => true),
  unmergeDevice: vi.fn()
}));

vi.mock('$lib/reading-history/devices', () => ({
  devices: {
    subscribe: (run: (value: Map<string, DeviceView>) => void) => state.devices.subscribe(run)
  },
  CLASS_NAMES: {
    phone: 'Phone',
    tablet: 'Tablet',
    laptop: 'Laptop',
    desktop: 'Desktop',
    unknown: 'Device'
  }
}));
vi.mock('$lib/settings/tracking-data', () => ({
  ...setters,
  deviceLabels: {
    subscribe: (run: (value: Record<string, DeviceLabel>) => void) => state.labels.subscribe(run)
  },
  DEVICE_NAME_MAX: 40
}));

import DevicesSettings from '../DevicesSettings.svelte';

const T1 = '2026-10-01T00:00:00.000Z';
const PHONE = 'Phone · Android · Chrome';
const own = deviceView('dev-own', {
  isThisDevice: true,
  generated: PHONE,
  label: PHONE,
  class: 'phone',
  detectedClass: 'phone',
  firstSeen: '2026-06-01T00:00:00.000Z'
});
// Seen BEFORE this device: still listed after it.
const laptop = deviceView('dev-lap', { firstSeen: '2026-01-01T00:00:00.000Z' });
// Seen after the laptop but named "Aaa…": rows never sort by name.
const tablet = deviceView('dev-tab', {
  named: true,
  label: 'Aaa tablet',
  generated: 'Tablet · iOS · Safari',
  class: 'tablet',
  detectedClass: 'tablet',
  firstSeen: '2026-02-01T00:00:00.000Z'
});

beforeEach(() => {
  state.devices = writable(deviceMap(own, laptop));
  state.labels = writable({});
  for (const fn of Object.values(setters)) fn.mockClear();
  setters.mergeDevice.mockImplementation(() => true);
});
afterEach(cleanup);

describe('DevicesSettings', () => {
  it('stays hidden while only one device is known', () => {
    state.devices.set(deviceMap(own));
    const { queryByTestId } = render(DevicesSettings);
    expect(queryByTestId('devices-settings')).toBeNull();
  });

  it('lists this device first, then the others by first seen; only the others can be merged', () => {
    state.devices.set(deviceMap(own, laptop, tablet));
    const { getAllByTestId } = render(DevicesSettings);
    const rows = getAllByTestId('device-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('This device')).toBeTruthy();
    expect((within(rows[0]).getByLabelText('Device name') as HTMLInputElement).placeholder).toBe(
      PHONE
    );
    expect(within(rows[0]).queryByRole('button', { name: 'Merge into…' })).toBeNull();
    expect(within(rows[1]).queryByText('This device')).toBeNull();
    expect((within(rows[1]).getByLabelText('Device name') as HTMLInputElement).placeholder).toBe(
      'Desktop · Linux · Firefox'
    );
    expect((within(rows[2]).getByLabelText('Device name') as HTMLInputElement).value).toBe(
      'Aaa tablet'
    );
    expect(within(rows[1]).getByRole('button', { name: 'Merge into…' })).toBeTruthy();
    expect(within(rows[2]).getByRole('button', { name: 'Merge into…' })).toBeTruthy();
  });

  it('renaming a device goes through renameDevice', async () => {
    const { getAllByTestId } = render(DevicesSettings);
    const field = within(getAllByTestId('device-row')[1]).getByLabelText('Device name');
    await fireEvent.input(field, { target: { value: 'Work laptop' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(setters.renameDevice).toHaveBeenCalledWith('dev-lap', 'Work laptop');
  });

  it('the type offers Automatic with the detected type, writes a correction, and clears it', async () => {
    const { getAllByTestId } = render(DevicesSettings);
    const select = within(getAllByTestId('device-row')[1]).getByLabelText(
      'Device type'
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'auto',
      'phone',
      'tablet',
      'laptop',
      'desktop'
    ]);
    expect(select.options[0].textContent).toBe('Automatic (detected: Desktop)');
    expect(select.value).toBe('auto');
    select.value = 'laptop';
    await fireEvent.change(select);
    expect(setters.setDeviceClass).toHaveBeenCalledWith('dev-lap', 'laptop');
    select.value = 'auto';
    await fireEvent.change(select);
    expect(setters.setDeviceClass).toHaveBeenLastCalledWith('dev-lap', null);
  });

  it('shows a stored type correction, and plain "Automatic" when nothing was detected', () => {
    state.devices.set(deviceMap(own, deviceView('dev-lap', { detectedClass: 'unknown' })));
    state.labels.set({ 'dev-lap': { class: 'laptop', lastUpdated: T1 } });
    const { getAllByTestId } = render(DevicesSettings);
    const select = within(getAllByTestId('device-row')[1]).getByLabelText(
      'Device type'
    ) as HTMLSelectElement;
    expect(select.value).toBe('laptop');
    expect(select.options[0].textContent).toBe('Automatic');
  });

  it('merging asks first, offers every other device, and merges into the one picked', async () => {
    state.devices.set(deviceMap(own, laptop, tablet));
    const { getAllByTestId, getByLabelText, getByRole, getByText, queryByRole } =
      render(DevicesSettings);
    await fireEvent.click(
      within(getAllByTestId('device-row')[1]).getByRole('button', { name: 'Merge into…' })
    );
    expect(getByText(/listed under the device you pick/)).toBeTruthy();
    const target = getByLabelText('Merge into') as HTMLSelectElement;
    expect(Array.from(target.options).map((o) => [o.value, o.textContent])).toEqual([
      ['dev-own', `${PHONE} (this device)`],
      ['dev-tab', 'Aaa tablet']
    ]);
    expect(target.value).toBe('dev-own');
    target.value = 'dev-tab';
    await fireEvent.change(target);
    await fireEvent.click(getByRole('button', { name: 'Merge' }));
    expect(setters.mergeDevice).toHaveBeenCalledWith('dev-lap', 'dev-tab');
    await waitFor(() => expect(queryByRole('button', { name: 'Merge' })).toBeNull());
  });

  it('a refused merge says so and keeps the dialog open', async () => {
    setters.mergeDevice.mockImplementation(() => false);
    const { getAllByTestId, getByRole, getByText } = render(DevicesSettings);
    await fireEvent.click(
      within(getAllByTestId('device-row')[1]).getByRole('button', { name: 'Merge into…' })
    );
    await fireEvent.click(getByRole('button', { name: 'Merge' }));
    expect(getByText("These two can't be merged.")).toBeTruthy();
    expect(getByRole('button', { name: 'Merge' })).toBeTruthy();
  });

  it('Cancel closes the dialog without merging', async () => {
    const { getAllByTestId, getByRole, queryByRole } = render(DevicesSettings);
    await fireEvent.click(
      within(getAllByTestId('device-row')[1]).getByRole('button', { name: 'Merge into…' })
    );
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(queryByRole('button', { name: 'Merge' })).toBeNull());
    expect(setters.mergeDevice).not.toHaveBeenCalled();
  });

  it('merged devices sit under their target with Unmerge, even when one group is left', async () => {
    state.devices.set(
      deviceMap(
        { ...own, mergedFrom: ['dev-lap'] },
        deviceView('dev-lap', { canonical: 'dev-own', firstSeen: laptop.firstSeen })
      )
    );
    const { getAllByTestId } = render(DevicesSettings);
    const rows = getAllByTestId('device-row');
    expect(rows).toHaveLength(1);
    const members = within(rows[0]).getAllByTestId('device-member');
    expect(members).toHaveLength(1);
    expect(within(members[0]).getByText('Desktop · Linux · Firefox')).toBeTruthy();
    await fireEvent.click(within(members[0]).getByRole('button', { name: 'Unmerge' }));
    expect(setters.unmergeDevice).toHaveBeenCalledWith('dev-lap');
  });
});
```

- [ ] **Step 7: Run it.**

`npx vitest run src/lib/components/Devices/__tests__/DevicesSettings.test.ts --testTimeout=30000`

Expected: FAIL with `Failed to resolve import "../DevicesSettings.svelte" from "src/lib/components/Devices/__tests__/DevicesSettings.test.ts". Does the file exist?`

- [ ] **Step 8: Implement DevicesSettings.**

`src/lib/components/Devices/DevicesSettings.svelte`:

```svelte
<script lang="ts">
  /**
   * The Devices block of the sync screen (spec "Settings → Sync → Devices";
   * it lives on `#/cloud`, the only sync UI). It lists every device this
   * library has been read on, grouped by `merged_into`. "This device" comes
   * first, then the others in the order they were first seen. Rows never sort
   * by name, so a rename never moves one. Each group has its name, its type
   * ("Automatic" = what the device detected about itself) and "Merge into…".
   * Merged devices sit under their target with "Unmerge". Every edit is a
   * label in `volume-data.json → tracking.devices`, so it syncs.
   *
   * The block appears once two raw device ids are known, not two groups, so an
   * unmerge stays reachable after everything has been merged into one.
   * Merging does not carry the source's name: the group shows the target's.
   */
  import { Badge, Button, Label, Modal, Select } from 'flowbite-svelte';
  import DeviceNameField from './DeviceNameField.svelte';
  import { CLASS_NAMES, devices, type DeviceView } from '$lib/reading-history/devices';
  import type { DeviceClass } from '$lib/reading-history/types';
  import {
    deviceLabels,
    mergeDevice,
    setDeviceClass,
    unmergeDevice
  } from '$lib/settings/tracking-data';

  const AUTO = 'auto';
  const CHOOSABLE: DeviceClass[] = ['phone', 'tablet', 'laptop', 'desktop'];

  let groups = $derived(
    [...$devices.values()]
      .filter((d) => d.id === d.canonical)
      .sort(
        (a, b) =>
          Number(b.isThisDevice) - Number(a.isThisDevice) ||
          a.firstSeen.localeCompare(b.firstSeen) ||
          a.id.localeCompare(b.id)
      )
  );

  function membersOf(group: DeviceView): DeviceView[] {
    return group.mergedFrom.flatMap((id) => $devices.get(id) ?? []);
  }

  function typeOptions(d: DeviceView) {
    const automatic =
      d.detectedClass === 'unknown'
        ? 'Automatic'
        : `Automatic (detected: ${CLASS_NAMES[d.detectedClass]})`;
    return [
      { value: AUTO, name: automatic },
      ...CHOOSABLE.map((c) => ({ value: c, name: CLASS_NAMES[c] }))
    ];
  }

  function typeValue(d: DeviceView): string {
    return $deviceLabels[d.id]?.class ?? AUTO;
  }

  function onTypeChange(d: DeviceView, event: Event) {
    const next = (event.target as HTMLSelectElement).value;
    setDeviceClass(d.id, next === AUTO ? null : (next as DeviceClass));
  }

  let mergeOpen = $state(false);
  let mergeSource = $state<DeviceView | null>(null);
  let mergeTarget = $state('');
  let mergeError = $state('');

  let mergeTargets = $derived.by(() => {
    const source = mergeSource;
    if (!source) return [];
    return groups
      .filter((g) => g.id !== source.id)
      .map((g) => ({ value: g.id, name: g.isThisDevice ? `${g.label} (this device)` : g.label }));
  });

  function openMerge(source: DeviceView) {
    mergeSource = source;
    mergeTarget = groups.find((g) => g.id !== source.id)?.id ?? '';
    mergeError = '';
    mergeOpen = true;
  }

  function confirmMerge() {
    if (!mergeSource || !mergeTarget) return;
    if (!mergeDevice(mergeSource.id, mergeTarget)) {
      mergeError = "These two can't be merged.";
      return;
    }
    mergeOpen = false;
  }
</script>

{#if $devices.size >= 2}
  <div class="mt-4 rounded-lg bg-gray-800 p-4" data-testid="devices-settings">
    <h3 class="mb-1 font-semibold">Devices</h3>
    <p class="mb-3 text-xs text-gray-400">
      The devices you read on. Names show in your reading stats on all of them.
    </p>
    <ul class="flex flex-col gap-3">
      {#each groups as group (group.id)}
        <li class="rounded-lg bg-gray-900/40 p-3" data-testid="device-row">
          <div class="flex flex-wrap items-center gap-2">
            <div class="min-w-48 flex-1">
              <DeviceNameField device={group} />
            </div>
            {#if group.isThisDevice}
              <Badge color="green">This device</Badge>
            {/if}
            <Select
              size="sm"
              class="w-48"
              aria-label="Device type"
              placeholder=""
              items={typeOptions(group)}
              value={typeValue(group)}
              onchange={(e: Event) => onTypeChange(group, e)}
            />
            {#if !group.isThisDevice}
              <Button size="xs" color="alternative" onclick={() => openMerge(group)}>
                Merge into…
              </Button>
            {/if}
          </div>
          {#if group.mergedFrom.length > 0}
            <ul class="mt-2 flex flex-col gap-1 border-l border-gray-700 pl-3">
              {#each membersOf(group) as member (member.id)}
                <li
                  class="flex items-center justify-between gap-2 text-sm text-gray-300"
                  data-testid="device-member"
                >
                  <span class="min-w-0 truncate">{member.label}</span>
                  <Button size="xs" color="alternative" onclick={() => unmergeDevice(member.id)}>
                    Unmerge
                  </Button>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

<Modal bind:open={mergeOpen} size="xs" autoclose={false}>
  {#if mergeSource}
    <div class="flex flex-col gap-4">
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
        Merge {mergeSource.label}
      </h3>
      <p class="text-sm text-gray-500 dark:text-gray-400">
        Its reading will be listed under the device you pick, with that device's name. You can
        unmerge it later.
      </p>
      <div>
        <Label for="device-merge-target" class="mb-2">Merge into</Label>
        <Select
          id="device-merge-target"
          size="sm"
          placeholder=""
          items={mergeTargets}
          bind:value={mergeTarget}
        />
      </div>
      {#if mergeError}
        <p class="text-sm text-red-500">{mergeError}</p>
      {/if}
      <!-- relative z-10: night mode's dialog filter resets stacking (see CLAUDE.md) -->
      <div class="relative z-10 flex justify-end gap-2">
        <Button color="alternative" onclick={() => (mergeOpen = false)}>Cancel</Button>
        <Button color="primary" onclick={confirmMerge}>Merge</Button>
      </div>
    </div>
  {/if}
</Modal>
```

- [ ] **Step 9: Run it.**

`npx vitest run src/lib/components/Devices --testTimeout=30000`

Expected: PASS (both files, 16 tests).

- [ ] **Step 10: Write the failing test for the CloudView mount.**

`src/lib/views/__tests__/cloud-devices.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

/**
 * The Devices block sits on the cloud screen, in the connected-provider
 * column after Storage (phase 4, Q1). Like `backup-all-reconcile.test.ts`,
 * this is asserted against the SOURCE: rendering CloudView means standing up
 * five providers, quota and queues just to see one child mounted. The block's
 * own behaviour is covered in `components/Devices/__tests__`.
 */
const sources = import.meta.glob('../CloudView.svelte', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;
const source = Object.values(sources)[0] ?? '';

describe('the Devices block on the cloud screen', () => {
  it('is imported', () => {
    expect(source).toContain(
      "import DevicesSettings from '$lib/components/Devices/DevicesSettings.svelte';"
    );
  });

  it('is mounted once, in the connected-provider column, after Storage and before About', () => {
    const connected = source.indexOf('{#if currentProvider}');
    const storage = source.indexOf('<h3 class="mb-2 font-semibold">Storage</h3>');
    const devices = source.indexOf('<DevicesSettings />');
    const about = source.indexOf('<!-- Provider info box -->');
    expect(connected).toBeGreaterThan(-1);
    expect(storage).toBeGreaterThan(connected);
    expect(devices).toBeGreaterThan(storage);
    expect(about).toBeGreaterThan(devices);
    expect(source.indexOf('<DevicesSettings />', devices + 1)).toBe(-1);
  });
});
```

- [ ] **Step 11: Run it.**

`npx vitest run src/lib/views/__tests__/cloud-devices.test.ts --testTimeout=30000`

Expected: FAIL with `expected '<script lang="ts">…' to contain 'import DevicesSettings from '$lib/components/Devices/DevicesSettings.svelte';'`. The second test also fails, because `devices` is `-1`.

- [ ] **Step 12: Mount the block in CloudView.**

In `src/lib/views/CloudView.svelte`:

Before (line 26):

```svelte
import {reconcileMissingMetadataFiles} from '$lib/metadata/series-file-sync';
```

After:

```svelte
import {reconcileMissingMetadataFiles} from '$lib/metadata/series-file-sync'; import DevicesSettings
from '$lib/components/Devices/DevicesSettings.svelte';
```

Before (lines 1119–1124):

```svelte
              {:else}
                <p class="text-sm text-gray-500">Storage information unavailable</p>
              {/if}
            </div>

            <!-- Provider info box -->
```

After:

```svelte
              {:else}
                <p class="text-sm text-gray-500">Storage information unavailable</p>
              {/if}
            </div>

            <!-- Devices: names, types and merges (renders nothing until 2 devices are known) -->
            <DevicesSettings />

            <!-- Provider info box -->
```

- [ ] **Step 13: Run it.**

`npx vitest run src/lib/views/__tests__/cloud-devices.test.ts src/lib/views/__tests__/backup-all-reconcile.test.ts src/lib/components/Devices --testTimeout=30000`

Expected: PASS (4 files, 19 tests).

- [ ] **Step 14: Type-check and lint the touched files.**

```
npm run check
npx prettier --write src/lib/components/Devices src/lib/views/CloudView.svelte src/lib/views/__tests__/cloud-devices.test.ts
npx eslint src/lib/components/Devices src/lib/views/CloudView.svelte src/lib/views/__tests__/cloud-devices.test.ts
```

Expected:

- `svelte-check found 0 errors`, with no new warnings in `src/lib/components/Devices/*` or `CloudView.svelte`.
- Prettier rewrites at most whitespace. Re-run Step 13 if it touched anything.
- ESLint prints no output.

- [ ] **Step 15: Commit.**

```
git add src/lib/components/Devices/DeviceNameField.svelte \
        src/lib/components/Devices/DevicesSettings.svelte \
        src/lib/components/Devices/__tests__/device-view.ts \
        src/lib/components/Devices/__tests__/DeviceNameField.test.ts \
        src/lib/components/Devices/__tests__/DevicesSettings.test.ts \
        src/lib/views/CloudView.svelte \
        src/lib/views/__tests__/cloud-devices.test.ts
git commit -m "feat(history): name, retype and merge devices on the cloud screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Notes for the plan author

1. **Import cycle hazard: `devices` store vs `tracking-data.ts`. Decide this in Task 1/3.**
   - Design §3 puts the stores in `R/devices.ts` beside `resolveDevice`, and §2's `mergeDevice` in `tracking-data.ts` needs `resolveDevice`. That makes `tracking-data → devices`.
   - The `devices` store is `derived([…, deviceLabels])`, which makes `devices → tracking-data`.
   - Whichever module loads first, the other evaluates `derived(deviceLabels, …)` or reads `resolveDevice` while its import binding is still uninitialized. That is a TDZ `ReferenceError` at module init.
   - Recommendation: keep `devices.ts` pure (Task 1) and put the stores in a separate `src/lib/reading-history/device-store.ts` (Task 3).
   - If you adopt that, change this task in exactly two places:
     - the import in `DevicesSettings.svelte` (`devices` from `$lib/reading-history/device-store`; `CLASS_NAMES` and `type DeviceView` stay on `devices`)
     - the `vi.mock` in `DevicesSettings.test.ts`, which splits into a `device-store` mock exporting `devices` and a `devices` mock exporting `CLASS_NAMES`
   - I kept the design's path because none of Tasks 1–3 exist in the worktree yet (HEAD `83ff5c87`, no `devices.ts`, no `isDeviceId`).
2. **`DeviceView.generated: string` is an addition to Task 1's `DeviceView`.**
   - A named device's field still needs the generated label as its placeholder, which design §5 requires.
   - Only `labelDevices` knows the collision-suffixed form ("… (since Mar 2026)"), and `label` holds the user's name once named.
   - Define it as the collision-resolved generated label, equal to `label` when `!named`. Task 5's banner and card get it for free.
3. **`CLASS_NAMES` must be exported from `devices.ts` (Task 1).** Design §3 names it inside `generatedLabel` but does not say it is exported.
4. **What this task assumes about the `devices` map (Task 3):**
   - It is keyed by every known raw id that passes `isDeviceId`. Legacy ids are already excluded (R5), so `$devices.size >= 2` is the design's "≥2 raw device ids" rule.
   - It holds a view for every canonical id, including a merge target with no local facts or events (design: "A target missing locally still resolves… 'Unknown device'"). A canonical with no view would hide its members.
   - `mergedFrom` on a head lists the raw ids that resolve to it, not including itself.
   - `isThisDevice` is set on the head of the group that `resolveDevice(own)` lands in. When this device has been merged into another device's group from elsewhere, that group carries the "This device" badge and no "Merge into…". This is how design §5's "marked inside its group" is met.
5. **Task 2's setter signatures as consumed:** `renameDevice(id, name)` (an empty string clears the name), `setDeviceClass(id, cls | null)`, `mergeDevice(source, target): boolean` (default third arg not passed), `unmergeDevice(id)`, `deviceLabels`, `DEVICE_NAME_MAX`. `DevicesSettings` reads `$deviceLabels[id]?.class` to tell an explicit correction from Automatic, because `DeviceView.class === detectedClass` cannot tell them apart.
6. **Visible text choices, all short and plain:**
   - Field and dialog: "Device name", "Device type", "Automatic (detected: Desktop)" (plain "Automatic" when detection is `unknown`), "Merge into…", "Merge into", "Merge", "Cancel", "Unmerge", "These two can't be merged."
   - The dialog body states the Q2 rule: "…with that device's name".
   - The `'unknown'` class is not offered as a choice.
7. **No layout motion:**
   - The Save button is always rendered. With no change it only calls `onDone`.
   - Rows sort by this-device, then `firstSeen`, then `id`, never by name.
   - The merge error appears inside the modal only.
8. **This is a deviation from the spec (Q1), already adopted.** The block exists only inside `{#if currentProvider}`, so with no provider connected there is no Devices UI. Record it in Task 7's As-built note.
9. **Task 7 (e2e) should cover this block**, since this task stops at component and source tests. After two contexts sync through the shared `WebDavStub`:
   - Open `#/cloud` and check that `getByTestId('devices-settings')` shows 2 `device-row`s.
   - Rename on A, sync A then B, and check that B's row input shows the name.
   - Merge B into A from A's block, and check it collapses to one `device-row` with one `device-member`.
   - Check that a single-device context has no `devices-settings`.
   - Run with `E2E_PORT=5199 E2E_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome npx playwright test e2e/devices.spec.ts`.
10. **`DeviceNameField` uses a writable `$derived` and `{@attach}`.** The draft re-seeds when the stored name changes. Both need Svelte ≥ 5.29, and the installed version is 5.43.14. One trade-off: a remote rename that arrives by sync while someone is typing replaces the draft.

---

### Task 5: Per-device stats card and second-device banner on the reading-speed page

**Files:**

- Create: `src/lib/components/Stats/DeviceStatsCard.svelte`
- Create: `src/lib/components/Stats/SecondDeviceBanner.svelte`
- Create: `src/lib/components/Stats/__tests__/device-fixtures.ts` (shared fixtures; it does not match `*.test.ts`, so vitest does not collect it)
- Create: `src/lib/components/Stats/__tests__/DeviceNameFieldStub.svelte` (test double for Task 4's field)
- Test: `src/lib/components/Stats/__tests__/DeviceStatsCard.test.ts`
- Test: `src/lib/components/Stats/__tests__/SecondDeviceBanner.test.ts`
- Modify: `src/lib/views/ReadingSpeedView.svelte`. There are three insertions:
  - an import after line 15 (`import LongPausesCard …`)
  - `<SecondDeviceBanner />` after line 1119 (`<h1 …>Reading Speed History</h1>`)
  - `<DeviceStatsCard />` after line 1217 (`<LongPausesCard … />`)
- Test: `src/lib/views/__tests__/ReadingSpeedView.devices.test.ts`
- Create (e2e): `e2e/devices.spec.ts`. It holds the stats-page describe block; Task 7 appends its own describe blocks to it.

**Interfaces:**

Consumes. These are Task 1, 3 and 4 outputs; the names come from the design.

```ts
// $lib/reading-history/devices   (Task 1 type; Task 3 store)
export interface DeviceView {
  id: string;
  label: string;
  named: boolean;
  class: DeviceClass;
  detectedClass: DeviceClass;
  isThisDevice: boolean;
  canonical: string;
  mergedFrom: string[];
  firstSeen: string; // ISO
}
export const devices: Readable<Map<string, DeviceView>>; // keyed by RAW id; a canonical id maps to its own view

// $lib/reading-history/device-stats   (Task 3)
export interface DeviceStatsRow {
  kind: 'device' | 'before-history' | 'edits';
  /** canonical device id for 'device'; the kind itself otherwise */
  id: string;
  timeMs: number;
  readChars: number;
  /** sampleChars / sampleMs * 60000, or null under 30 min of samples (and for non-device rows) */
  charsPerMinute: number | null;
  lastReadAt: number | null;
}
/** One 'device' row per group WITH native events (never for facts-only devices). [] until stats are ready. */
export const deviceStats: Readable<DeviceStatsRow[]>;

// $lib/components/Devices/DeviceNameField.svelte   (Task 4)
// props: { device: DeviceView; onDone?: () => void }
// renders exactly one <input type="text"> (the first input in the component);
// calls onDone() after a successful save (Enter) and after an Escape revert.
```

Produces:

```ts
// DeviceStatsCard.svelte: no props. data-testid="device-stats" (Card), "device-row" (li), "device-name" (label el)
// SecondDeviceBanner.svelte: no props. data-testid="device-banner", role="status"
//   <script module> export const DEVICE_BANNER_DISMISSED_KEY = 'device-banner:dismissed';
```

- [ ] **Step 1: Write the shared fixtures, the field double and the failing card test**

`src/lib/components/Stats/__tests__/device-fixtures.ts`:

```ts
import type { DeviceStatsRow } from '$lib/reading-history/device-stats';
import type { DeviceView } from '$lib/reading-history/devices';

export const MIN = 60_000;

export const view = (id: string, over: Partial<DeviceView> = {}): DeviceView => ({
  id,
  label: `Label ${id}`,
  named: false,
  class: 'phone',
  detectedClass: 'phone',
  isThisDevice: false,
  canonical: id,
  mergedFrom: [],
  firstSeen: '2026-03-01T00:00:00.000Z',
  ...over
});

export const row = (
  kind: DeviceStatsRow['kind'],
  id: string,
  over: Partial<DeviceStatsRow> = {}
): DeviceStatsRow => ({
  kind,
  id,
  timeMs: 60 * MIN,
  readChars: 6000,
  charsPerMinute: null,
  lastReadAt: null,
  ...over
});

export const mapOf = (...views: DeviceView[]) => new Map(views.map((v) => [v.id, v]));
```

`src/lib/components/Stats/__tests__/DeviceNameFieldStub.svelte`:

```svelte
<script lang="ts">
  /**
   * Test double for `DeviceNameField` (Task 4): these suites test where the
   * field is mounted and for which device, not how it saves.
   */
  import type { DeviceView } from '$lib/reading-history/devices';

  let { device, onDone }: { device: DeviceView; onDone?: () => void } = $props();
</script>

<input type="text" aria-label="Device name" data-device={device.id} value={device.label} />
<button type="button" onclick={() => onDone?.()}>Done</button>
```

`src/lib/components/Stats/__tests__/DeviceStatsCard.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable, type Writable } from 'svelte/store';
import type { DeviceStatsRow } from '$lib/reading-history/device-stats';
import type { DeviceView } from '$lib/reading-history/devices';
import { MIN, mapOf, row, view } from './device-fixtures';

const state = vi.hoisted(() => ({
  rows: null as unknown as Writable<DeviceStatsRow[]>,
  devices: null as unknown as Writable<Map<string, DeviceView>>
}));

vi.mock('$lib/reading-history/device-stats', () => ({
  deviceStats: { subscribe: (run: (v: DeviceStatsRow[]) => void) => state.rows.subscribe(run) }
}));
vi.mock('$lib/reading-history/devices', () => ({
  devices: {
    subscribe: (run: (v: Map<string, DeviceView>) => void) => state.devices.subscribe(run)
  }
}));
vi.mock('$lib/components/Devices/DeviceNameField.svelte', async () => ({
  default: (await import('./DeviceNameFieldStub.svelte')).default
}));
// turns-store (reached through volume-data, via the duration formatters) registers a listener at import.
vi.mock('$lib/reading-history/record', () => ({ onEventsRecorded: () => () => {} }));

import DeviceStatsCard from '../DeviceStatsCard.svelte';

const labelsOf = (rows: HTMLElement[]) =>
  rows.map((r) => r.querySelector('[data-testid="device-name"]')?.textContent?.trim());

beforeEach(() => {
  state.rows = writable([]);
  state.devices = writable(new Map());
});
afterEach(cleanup);

describe('DeviceStatsCard', () => {
  it('renders nothing for one device, even beside a "Before history" row', () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true })));
    state.rows.set([row('device', 'me'), row('before-history', 'before-history')]);
    const { queryByTestId } = render(DeviceStatsCard);
    expect(queryByTestId('device-stats')).toBeNull();
  });

  it('lists this device first, the others by first seen, then "Before history" and "Edits"', () => {
    state.devices.set(
      mapOf(
        view('late', { label: 'Phone · Android · Chrome', firstSeen: '2026-05-01T00:00:00.000Z' }),
        view('me', { label: 'Desktop · Linux · Firefox', isThisDevice: true }),
        view('early', { label: 'Tablet · iOS · Safari', firstSeen: '2026-01-01T00:00:00.000Z' })
      )
    );
    state.rows.set([
      row('edits', 'edits', { timeMs: 5 * MIN, readChars: 0 }),
      row('device', 'late'),
      row('before-history', 'before-history'),
      row('device', 'me'),
      row('device', 'early')
    ]);
    const { getByTestId, getAllByTestId } = render(DeviceStatsCard);
    expect(getByTestId('device-stats')).toBeTruthy();
    const rows = getAllByTestId('device-row');
    expect(labelsOf(rows)).toEqual([
      'Desktop · Linux · Firefox',
      'Tablet · iOS · Safari',
      'Phone · Android · Chrome',
      'Before history',
      'Edits'
    ]);
    expect(within(rows[0]).getByText('This device')).toBeTruthy();
    for (const other of rows.slice(1)) expect(within(other).queryByText('This device')).toBeNull();
  });

  it('shows time, characters, share of time, speed and last read per row', () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true }), view('b')));
    state.rows.set([
      row('device', 'me', {
        timeMs: 90 * MIN,
        readChars: 9000,
        charsPerMinute: 100.4,
        lastReadAt: Date.now() - 2 * MIN
      }),
      row('device', 'b', { timeMs: 30 * MIN, readChars: 1234, charsPerMinute: null })
    ]);
    const { getAllByTestId } = render(DeviceStatsCard);
    const [mine, other] = getAllByTestId('device-row');
    expect(within(mine).getByText('1h 30m')).toBeTruthy();
    expect(within(mine).getByText('9,000 chars')).toBeTruthy();
    expect(within(mine).getByText('75% of time')).toBeTruthy();
    expect(within(mine).getByText('100 chars/min')).toBeTruthy();
    expect(within(mine).getByText('Last read today')).toBeTruthy();
    expect(within(other).getByText('30 min')).toBeTruthy();
    expect(within(other).getByText('1,234 chars')).toBeTruthy();
    expect(within(other).getByText('25% of time')).toBeTruthy();
    // Under 30 min of samples the store gives no speed.
    expect(within(other).getByText('—')).toBeTruthy();
  });

  it('hides an empty "Before history" or "Edits" row', () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true }), view('b')));
    state.rows.set([
      row('device', 'me'),
      row('device', 'b'),
      row('before-history', 'before-history', { timeMs: 0, readChars: 0 }),
      row('edits', 'edits', { timeMs: 0, readChars: 0 })
    ]);
    const { getAllByTestId, queryByText } = render(DeviceStatsCard);
    expect(getAllByTestId('device-row')).toHaveLength(2);
    expect(queryByText('Before history')).toBeNull();
    expect(queryByText('Edits')).toBeNull();
  });

  it('notes the devices merged into a row', () => {
    state.devices.set(
      mapOf(view('me', { isThisDevice: true }), view('b', { mergedFrom: ['c', 'd'] }))
    );
    state.rows.set([row('device', 'me'), row('device', 'b')]);
    const { getAllByTestId } = render(DeviceStatsCard);
    expect(
      within(getAllByTestId('device-row')[1]).getByText(/includes 2 merged devices/)
    ).toBeTruthy();
  });

  it('clicking a device name opens the name field for that device; done closes it', async () => {
    state.devices.set(
      mapOf(view('me', { isThisDevice: true }), view('b', { label: 'Phone · Android · Chrome' }))
    );
    state.rows.set([row('device', 'me'), row('device', 'b')]);
    const { getAllByTestId, queryByLabelText } = render(DeviceStatsCard);
    const other = getAllByTestId('device-row')[1];
    await fireEvent.click(within(other).getByRole('button', { name: 'Phone · Android · Chrome' }));
    const field = within(other).getByLabelText('Device name');
    expect(field.getAttribute('data-device')).toBe('b');
    expect(document.activeElement).toBe(field);
    // One field at a time, and only in the row clicked.
    expect(within(getAllByTestId('device-row')[0]).queryByLabelText('Device name')).toBeNull();
    await fireEvent.click(within(other).getByRole('button', { name: 'Done' }));
    expect(queryByLabelText('Device name')).toBeNull();
    expect(within(other).getByRole('button', { name: 'Phone · Android · Chrome' })).toBeTruthy();
  });

  it('a renamed device shows its new name in place', async () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true }), view('b')));
    state.rows.set([row('device', 'me'), row('device', 'b')]);
    const { getAllByTestId } = render(DeviceStatsCard);
    const before = getAllByTestId('device-row');
    state.devices.set(
      mapOf(view('me', { isThisDevice: true }), view('b', { label: 'Pixel 8', named: true }))
    );
    await tick();
    const after = getAllByTestId('device-row');
    expect(after).toEqual(before);
    expect(within(after[1]).getByRole('button', { name: 'Pixel 8' })).toBeTruthy();
  });

  it('"Before history", "Edits" and a device with no record are not renamable', () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true })));
    state.rows.set([
      row('device', 'me'),
      row('device', 'gone'),
      row('before-history', 'before-history'),
      row('edits', 'edits')
    ]);
    const { getAllByTestId } = render(DeviceStatsCard);
    const rows = getAllByTestId('device-row');
    expect(labelsOf(rows)).toEqual(['Label me', 'Unknown device', 'Before history', 'Edits']);
    for (const fixed of rows.slice(1)) expect(within(fixed).queryByRole('button')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/components/Stats/__tests__/DeviceStatsCard.test.ts --testTimeout=30000`
Expected: FAIL, `Error: Failed to resolve import "../DeviceStatsCard.svelte" from "src/lib/components/Stats/__tests__/DeviceStatsCard.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `src/lib/components/Stats/DeviceStatsCard.svelte`**

```svelte
<script lang="ts">
  import { Badge, Card } from 'flowbite-svelte';
  import DeviceNameField from '$lib/components/Devices/DeviceNameField.svelte';
  import { deviceStats, type DeviceStatsRow } from '$lib/reading-history/device-stats';
  import { devices, type DeviceView } from '$lib/reading-history/devices';
  import { formatDuration, formatRelativeDate } from '$lib/util/reading-speed-history';

  /**
   * Per-device stats (phase 4; spec: "Labels", entry point 2): one row per
   * device group — merged devices count as the device they were merged into —
   * then "Before history" and "Edits" (each hidden when empty). Click a
   * device's name to rename it in place.
   *
   * Shown only when two or more groups have reading of their own: a
   * single-device user never sees a device anywhere.
   *
   * No layout motion: the order is fixed (this device, then by first seen),
   * never by the figures, and each figure sits in a fixed-width slot, so a
   * recount never moves or re-flows a row.
   */

  /** The group whose name field is open. One at a time. */
  let editing = $state<string | null>(null);

  let groups = $derived($deviceStats.filter((r) => r.kind === 'device'));
  let total = $derived($deviceStats.reduce((sum, r) => sum + r.timeMs, 0));
  let rows = $derived(ordered($deviceStats, $devices));

  function ordered(all: DeviceStatsRow[], views: Map<string, DeviceView>): DeviceStatsRow[] {
    const firstSeen = (id: string) => views.get(id)?.firstSeen ?? '\uffff';
    const own = (id: string) => (views.get(id)?.isThisDevice ? 0 : 1);
    const devs = all
      .filter((r) => r.kind === 'device')
      .sort(
        (a, b) =>
          own(a.id) - own(b.id) ||
          firstSeen(a.id).localeCompare(firstSeen(b.id)) ||
          a.id.localeCompare(b.id)
      );
    const extra = (kind: DeviceStatsRow['kind']) =>
      all.filter((r) => r.kind === kind && (r.timeMs !== 0 || r.readChars !== 0));
    return [...devs, ...extra('before-history'), ...extra('edits')];
  }

  function nameOf(row: DeviceStatsRow, view: DeviceView | undefined): string {
    if (row.kind === 'before-history') return 'Before history';
    if (row.kind === 'edits') return 'Edits';
    return view?.label ?? 'Unknown device';
  }

  function subline(row: DeviceStatsRow, view: DeviceView | undefined): string {
    if (row.kind === 'before-history') return 'Reading from before devices were tracked';
    if (row.kind === 'edits') return 'Changes made in the volume editor';
    const parts: string[] = [];
    if (row.lastReadAt !== null) {
      parts.push(`Last read ${formatRelativeDate(new Date(row.lastReadAt)).toLowerCase()}`);
    }
    const merged = view?.mergedFrom.length ?? 0;
    if (merged > 0) parts.push(`includes ${merged} merged device${merged === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }

  const time = (ms: number) => formatDuration(ms / 60_000);
  const count = (n: number) => Math.round(n).toLocaleString('en-US');
  const speed = (cpm: number | null) => (cpm === null ? '—' : `${Math.round(cpm)} chars/min`);

  function share(ms: number): string {
    if (total <= 0 || ms <= 0) return '—';
    const pct = (ms / total) * 100;
    return `${pct < 1 ? '<1' : Math.round(pct)}% of time`;
  }

  /** The swapped-in field takes the keyboard at once. */
  function focusInput(node: HTMLElement): void {
    node.querySelector('input')?.focus();
  }
</script>

{#if groups.length >= 2}
  <Card class="mb-6 w-full max-w-none p-6" data-testid="device-stats">
    <h2 class="mb-1 text-xl font-semibold">Devices</h2>
    <p class="mb-4 text-sm text-gray-400">
      Where your reading happened. Click a name to change it.
    </p>
    <ul class="divide-y divide-gray-200 dark:divide-gray-700">
      {#each rows as row (`${row.kind}:${row.id}`)}
        {@const view = row.kind === 'device' ? $devices.get(row.id) : undefined}
        <li class="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="device-row">
          <div class="min-w-0 flex-1">
            {#if view && editing === row.id}
              <div use:focusInput>
                <DeviceNameField device={view} onDone={() => (editing = null)} />
              </div>
            {:else}
              <div class="flex min-w-0 items-center gap-2">
                {#if view}
                  <button
                    type="button"
                    class="truncate text-left font-medium hover:underline"
                    title="Rename"
                    data-testid="device-name"
                    onclick={() => (editing = row.id)}>{view.label}</button
                  >
                  {#if view.isThisDevice}
                    <Badge color="blue">This device</Badge>
                  {/if}
                {:else}
                  <p class="truncate font-medium" data-testid="device-name">{nameOf(row, view)}</p>
                {/if}
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400">{subline(row, view)}</p>
            {/if}
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
            <span class="w-20 text-right" title="Time read">{time(row.timeMs)}</span>
            <span class="w-32 text-right" title="Characters read">{count(row.readChars)} chars</span
            >
            <span class="w-28 text-right" title="Share of reading time">{share(row.timeMs)}</span>
            <span class="w-28 text-right" title="Average speed">{speed(row.charsPerMinute)}</span>
          </div>
        </li>
      {/each}
    </ul>
  </Card>
{/if}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/lib/components/Stats/__tests__/DeviceStatsCard.test.ts --testTimeout=30000`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing banner test, `src/lib/components/Stats/__tests__/SecondDeviceBanner.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable, type Writable } from 'svelte/store';
import type { DeviceStatsRow } from '$lib/reading-history/device-stats';
import type { DeviceView } from '$lib/reading-history/devices';
import { mapOf, row, view } from './device-fixtures';

const state = vi.hoisted(() => ({
  rows: null as unknown as Writable<DeviceStatsRow[]>,
  devices: null as unknown as Writable<Map<string, DeviceView>>
}));

vi.mock('$lib/reading-history/device-stats', () => ({
  deviceStats: { subscribe: (run: (v: DeviceStatsRow[]) => void) => state.rows.subscribe(run) }
}));
vi.mock('$lib/reading-history/devices', () => ({
  devices: {
    subscribe: (run: (v: Map<string, DeviceView>) => void) => state.devices.subscribe(run)
  }
}));
vi.mock('$lib/components/Devices/DeviceNameField.svelte', async () => ({
  default: (await import('./DeviceNameFieldStub.svelte')).default
}));

import SecondDeviceBanner, { DEVICE_BANNER_DISMISSED_KEY } from '../SecondDeviceBanner.svelte';

const me = (over: Partial<DeviceView> = {}) => view('me', { isThisDevice: true, ...over });

/** Two device groups with reading, this one unnamed: the banner's case. */
function twoDevices(): void {
  state.devices.set(mapOf(me(), view('b')));
  state.rows.set([row('device', 'me'), row('device', 'b')]);
}

beforeEach(() => {
  window.localStorage.clear();
  state.rows = writable([]);
  state.devices = writable(new Map());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SecondDeviceBanner', () => {
  it('stays away for a single device', () => {
    state.devices.set(mapOf(me()));
    state.rows.set([row('device', 'me'), row('before-history', 'before-history')]);
    const { queryByTestId } = render(SecondDeviceBanner);
    expect(queryByTestId('device-banner')).toBeNull();
  });

  it('asks to name this device once a second device has reading', () => {
    twoDevices();
    const { getByTestId } = render(SecondDeviceBanner);
    const banner = getByTestId('device-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(within(banner).getByText('You read on 2 devices — name this one?')).toBeTruthy();
    // The field edits THIS device, not the other one.
    expect(within(banner).getByLabelText('Device name').getAttribute('data-device')).toBe('me');
    expect(within(banner).getByRole('button', { name: 'Not now' })).toBeTruthy();
  });

  it('counts every device group', () => {
    state.devices.set(mapOf(me(), view('b'), view('c')));
    state.rows.set([row('device', 'me'), row('device', 'b'), row('device', 'c')]);
    const { getByText } = render(SecondDeviceBanner);
    expect(getByText('You read on 3 devices — name this one?')).toBeTruthy();
  });

  it('asks about the group this device belongs to when it was merged into another', () => {
    state.devices.set(
      mapOf(
        view('me', { isThisDevice: true, canonical: 'main' }),
        view('main', { isThisDevice: true, mergedFrom: ['me'] }),
        view('b')
      )
    );
    state.rows.set([row('device', 'main'), row('device', 'b')]);
    const { getByLabelText } = render(SecondDeviceBanner);
    expect(getByLabelText('Device name').getAttribute('data-device')).toBe('main');
  });

  it('stays away once this device has a name', () => {
    state.devices.set(mapOf(me({ label: 'Work laptop', named: true }), view('b')));
    state.rows.set([row('device', 'me'), row('device', 'b')]);
    const { queryByTestId } = render(SecondDeviceBanner);
    expect(queryByTestId('device-banner')).toBeNull();
  });

  it('"Not now" hides it in this browser for good', async () => {
    twoDevices();
    const first = render(SecondDeviceBanner);
    await fireEvent.click(first.getByRole('button', { name: 'Not now' }));
    expect(first.queryByTestId('device-banner')).toBeNull();
    expect(window.localStorage.getItem(DEVICE_BANNER_DISMISSED_KEY)).toBe('1');
    cleanup();
    const again = render(SecondDeviceBanner);
    expect(again.queryByTestId('device-banner')).toBeNull();
  });

  it('naming the device here keeps the banner in place, confirmed, until closed', async () => {
    twoDevices();
    const { getByTestId, getByRole, queryByTestId } = render(SecondDeviceBanner);
    const banner = getByTestId('device-banner');
    state.devices.set(mapOf(me({ label: 'Work laptop', named: true }), view('b')));
    await tick();
    // Same element, same field: nothing jumps under the pointer.
    expect(getByTestId('device-banner')).toBe(banner);
    expect(within(banner).getByLabelText('Device name')).toBeTruthy();
    expect(within(banner).getByText(/^Saved\./)).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(queryByTestId('device-banner')).toBeNull();
  });

  it('still asks, and "Not now" still hides it, when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    twoDevices();
    const { getByRole, queryByTestId } = render(SecondDeviceBanner);
    expect(queryByTestId('device-banner')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Not now' }));
    expect(queryByTestId('device-banner')).toBeNull();
  });
});
```

- [ ] **Step 6: Run it**

Run: `npx vitest run src/lib/components/Stats/__tests__/SecondDeviceBanner.test.ts --testTimeout=30000`
Expected: FAIL, `Failed to resolve import "../SecondDeviceBanner.svelte" … Does the file exist?`

- [ ] **Step 7: Implement `src/lib/components/Stats/SecondDeviceBanner.svelte`**

```svelte
<script lang="ts" module>
  /** Per browser, not synced: it asks to name THIS device. */
  export const DEVICE_BANNER_DISMISSED_KEY = 'device-banner:dismissed';
</script>

<script lang="ts">
  import { Button } from 'flowbite-svelte';
  import DeviceNameField from '$lib/components/Devices/DeviceNameField.svelte';
  import { deviceStats } from '$lib/reading-history/device-stats';
  import { devices } from '$lib/reading-history/devices';

  /**
   * "You read on 2 devices — name this one?" (phase 4; spec: "Labels",
   * entry point 3). Inline under the page heading, never a modal. Asks while
   * two or more device groups have reading and this device's group has no
   * name; "Not now" ends it in this browser, and naming the device ends it
   * everywhere this device is the one asked about.
   *
   * No layout motion: naming here does not make the banner vanish under the
   * pointer. It stays, same box, same field, with a confirmation, until the
   * user closes it.
   */

  function readDismissed(): boolean {
    try {
      return window.localStorage.getItem(DEVICE_BANNER_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  let dismissed = $state(readDismissed());
  /** Asked on this visit: a name given since then is confirmed in place. */
  let asked = $state(false);

  let groups = $derived($deviceStats.filter((r) => r.kind === 'device').length);
  /** This device's group: its own entry, or the device it was merged into. */
  let own = $derived([...$devices.values()].find((v) => v.isThisDevice && v.id === v.canonical));
  let asking = $derived(groups >= 2 && own !== undefined && !own.named);

  $effect(() => {
    if (asking) asked = true;
  });

  function dismiss(): void {
    dismissed = true;
    try {
      window.localStorage.setItem(DEVICE_BANNER_DISMISSED_KEY, '1');
    } catch {
      // Storage blocked: it may ask again next visit. Harmless.
    }
  }
</script>

{#if !dismissed && own && (asking || (asked && own.named))}
  <div
    role="status"
    data-testid="device-banner"
    class="mb-6 flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
  >
    <p class="font-medium">
      {#if own.named}
        Saved. You can change it in the Devices list below.
      {:else}
        You read on {groups} devices — name this one?
      {/if}
    </p>
    <div class="flex flex-wrap items-end gap-2">
      <div class="min-w-0 flex-1">
        <DeviceNameField device={own} />
      </div>
      <Button size="sm" color="alternative" onclick={dismiss}>
        {own.named ? 'Close' : 'Not now'}
      </Button>
    </div>
  </div>
{/if}
```

- [ ] **Step 8: Run it**

Run: `npx vitest run src/lib/components/Stats/__tests__/SecondDeviceBanner.test.ts --testTimeout=30000`
Expected: PASS (8 tests).

- [ ] **Step 9: Write the failing page-placement test, `src/lib/views/__tests__/ReadingSpeedView.devices.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import type { PauseReview } from '$lib/reading-history/pause-review';
import type { DeviceStatsRow } from '$lib/reading-history/device-stats';
import type { DeviceView } from '$lib/reading-history/devices';

const { catalogVolumes, reviewStore, rowsStore, devicesStore } = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    const subs = new Set<(v: T) => void>();
    let current = initial;
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(current);
        return () => subs.delete(fn);
      },
      set(v: T) {
        current = v;
        subs.forEach((fn) => fn(current));
      }
    };
  }
  return {
    catalogVolumes: createStore<Record<string, unknown>>({}),
    reviewStore: createStore<PauseReview>({ pauses: [], unanswered: 0, answered: 0 }),
    rowsStore: createStore<DeviceStatsRow[]>([]),
    devicesStore: createStore<Map<string, DeviceView>>(new Map())
  };
});
vi.mock('$lib/catalog', () => ({ volumes: catalogVolumes }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: async () => undefined,
      bulkGet: async (uuids: string[]) => uuids.map(() => undefined),
      orderBy: () => ({ uniqueKeys: async () => [] })
    }
  }
}));
vi.mock('$lib/metadata/history-rows', () => ({ materializeHistoryRows: async () => 0 }));
vi.mock('$lib/metadata/series-index', () => ({ listSeriesIndexes: async () => [] }));
vi.mock('$lib/metadata/series-open', () => ({ openSeries: vi.fn(async () => {}) }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: () => ({ type: 'google-drive' }),
    cloudFiles: readable(new Map()),
    whenSeriesIndexesSettled: () => Promise.resolve()
  }
}));
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { getCache: () => ({ isLoaded: () => true }) }
}));
vi.mock('chart.js/auto', () => ({
  default: class {
    destroy() {}
    update() {}
  }
}));
vi.mock('$lib/reading-history/pause-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/reading-history/pause-review')>();
  return { ...actual, pauseReview: reviewStore };
});
vi.mock('$lib/reading-history/device-stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/reading-history/device-stats')>();
  return { ...actual, deviceStats: rowsStore };
});
vi.mock('$lib/reading-history/devices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/reading-history/devices')>();
  return { ...actual, devices: devicesStore };
});

import ReadingSpeedView from '$lib/views/ReadingSpeedView.svelte';
import { volumesWithTrash } from '$lib/settings/volume-data';

const MIN = 60_000;

const deviceView = (id: string, over: Partial<DeviceView> = {}): DeviceView => ({
  id,
  label: `Label ${id}`,
  named: false,
  class: 'desktop',
  detectedClass: 'desktop',
  isThisDevice: false,
  canonical: id,
  mergedFrom: [],
  firstSeen: '2026-03-01T00:00:00.000Z',
  ...over
});
const deviceRow = (id: string): DeviceStatsRow => ({
  kind: 'device',
  id,
  timeMs: 30 * MIN,
  readChars: 3000,
  charsPerMinute: null,
  lastReadAt: null
});

beforeEach(() => {
  window.localStorage.clear();
  volumesWithTrash.set({});
  catalogVolumes.set({});
  reviewStore.set({
    pauses: [
      {
        volume: 'v1',
        device: 'dev-a',
        seq: 1,
        t: Date.now() - MIN,
        page: 4,
        dwell: 12 * MIN,
        cap: 5 * MIN,
        typical: 4 * MIN,
        counted: 4 * MIN,
        answer: null
      }
    ],
    unanswered: 1,
    answered: 0
  });
  rowsStore.set([]);
  devicesStore.set(new Map());
});
afterEach(cleanup);

describe('ReadingSpeedView devices', () => {
  it('shows no device banner or device card for a single device', () => {
    devicesStore.set(new Map([['me', deviceView('me', { isThisDevice: true })]]));
    rowsStore.set([deviceRow('me')]);
    render(ReadingSpeedView);
    expect(screen.queryByTestId('device-banner')).toBeNull();
    expect(screen.queryByTestId('device-stats')).toBeNull();
  });

  it('asks right under the heading, and lists devices after the long pauses', async () => {
    devicesStore.set(
      new Map([
        ['me', deviceView('me', { isThisDevice: true })],
        ['b', deviceView('b')]
      ])
    );
    rowsStore.set([deviceRow('me'), deviceRow('b')]);
    render(ReadingSpeedView);
    const banner = await screen.findByTestId('device-banner');
    const heading = screen.getByRole('heading', { level: 1, name: 'Reading Speed History' });
    expect(heading.nextElementSibling).toBe(banner);
    const pauses = screen.getByTestId('long-pauses');
    const card = screen.getByTestId('device-stats');
    expect(pauses.nextElementSibling).toBe(card);
    expect(screen.getAllByTestId('device-row')).toHaveLength(2);
  });
});
```

- [ ] **Step 10: Run it**

Run: `npx vitest run src/lib/views/__tests__/ReadingSpeedView.devices.test.ts --testTimeout=30000`
Expected: FAIL. "shows no device banner…" passes. "asks right under the heading…" fails with `Unable to find an element by: [data-testid="device-banner"]`, because the view does not mount either component yet.

- [ ] **Step 11: Mount both in `src/lib/views/ReadingSpeedView.svelte`**

After line 15:

```svelte
import LongPausesCard from '$lib/components/Stats/LongPausesCard.svelte';
```

add:

```svelte
import DeviceStatsCard from '$lib/components/Stats/DeviceStatsCard.svelte'; import
SecondDeviceBanner from '$lib/components/Stats/SecondDeviceBanner.svelte';
```

Replace (line ~1119):

```svelte
  <h1 class="mb-6 text-3xl font-bold">Reading Speed History</h1>

  {#if !hasReadingData && $volumeSpeedData.length === 0}
```

with:

```svelte
  <h1 class="mb-6 text-3xl font-bold">Reading Speed History</h1>
  <!-- Asks to name this device once a second one has reading (phase 4) -->
  <SecondDeviceBanner />

  {#if !hasReadingData && $volumeSpeedData.length === 0}
```

Replace (line ~1217):

```svelte
<LongPausesCard titleOf={(volume) => pauseVolumeTitle(volume, $catalogStore, $volumes)} />

<!-- Achievement Badges -->
```

with:

```svelte
<LongPausesCard titleOf={(volume) => pauseVolumeTitle(volume, $catalogStore, $volumes)} />

<!-- Reading per device (phase 4); renders nothing for a single device -->
<DeviceStatsCard />

<!-- Achievement Badges -->
```

- [ ] **Step 12: Run the page tests, including the two that render the page over the REAL device stores**

Run: `npx vitest run src/lib/views/__tests__/ReadingSpeedView.devices.test.ts src/lib/views/__tests__/ReadingSpeedView.pauses.test.ts src/lib/views/__tests__/ReadingSpeedView.orphans.test.ts src/lib/components/Stats/ --testTimeout=30000`
Expected: PASS. That is 6 files and 30 tests: devices 2, pauses 2, orphans 5, DeviceStatsCard 8, SecondDeviceBanner 8, LongPausesCard 5.

The pauses and orphans suites do not mock `devices` or `deviceStats`. They load Task 3's real `liveQuery` adapter under jsdom with no IndexedDB. If either fails with a Dexie `MissingAPIError` or an unhandled rejection, the fix belongs in Task 3's adapter: catch the error and emit `[]`. Do not mock it away here.

- [ ] **Step 13: Write the e2e spec, `e2e/devices.spec.ts`**

```ts
import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * Device views (phase 4) on the reading-speed page, in a real browser over
 * the real stores: a single-device user sees no device anywhere; once the
 * history holds another device's reading, the page asks to name this one
 * and lists reading per device, and a name given in either place sticks
 * across a reload. The other device is planted the way a sync would import
 * it: its facts row plus its `page` events, then the recorded-events signal.
 */

const VOL_OWN = 'e2e-devices-own';
const VOL_PHONE = 'e2e-devices-phone';
const PHONE = 'e2e-phone-0001';
const PHONE_LABEL = 'Phone · Android · Chrome';

/** Three 300-char pages read for a minute each, on this device. */
async function readHere(page: Page) {
  await page.evaluate(async (volume) => {
    const { recordEvent } = await import('/src/lib/reading-history/record.ts');
    const { setIdleOverride } = await import('/src/lib/settings/tracking-data.ts');
    setIdleOverride(12);
    for (let p = 1; p <= 3; p++) {
      await recordEvent({
        kind: 'page',
        volume,
        first_page: p,
        last_page: p,
        page_chars: [300],
        chars_before: (p - 1) * 300,
        dwell_ms: 60_000,
        layout: 'single',
        orientation: 'portrait',
        viewport: { w: 400, h: 800 }
      });
    }
  }, VOL_OWN);
}

/** The same reading by another device, as a sync would import it. */
async function readOnPhone(page: Page) {
  await page.evaluate(
    async ({ volume, device }) => {
      const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
      const { notifyEventsRecorded } = await import('/src/lib/reading-history/record.ts');
      const db = historyDb();
      const now = Date.now();
      await db.devices.put({
        device,
        class: 'phone',
        os: 'Android',
        browser: 'Chrome',
        first_seen: new Date(now - 86_400_000).toISOString(),
        last_seen: new Date(now).toISOString()
      });
      const events = [1, 2, 3].map((p) => ({
        kind: 'page' as const,
        volume,
        first_page: p,
        last_page: p,
        page_chars: [300],
        chars_before: (p - 1) * 300,
        dwell_ms: 60_000,
        layout: 'single' as const,
        orientation: 'portrait' as const,
        viewport: { w: 400, h: 800 },
        device,
        seq: p,
        t: now - (4 - p) * 60_000
      }));
      await db.reading_events.bulkAdd(events);
      notifyEventsRecorded(events);
    },
    { volume: VOL_PHONE, device: PHONE }
  );
}

/** Counted time for a volume, once the stats store has caught up. */
async function countedMs(page: Page, volume: string): Promise<number> {
  return page.evaluate(async (volume) => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    stats.flushReadingStats();
    let ms = 0;
    stats.readingStats.subscribe((s) => (ms = s.byVolume.get(volume)?.timeMs ?? 0))();
    return ms;
  }, volume);
}

async function openStats(page: Page) {
  await page.evaluate(() => (window.location.hash = '#/reading-speed'));
  await expect(page.getByRole('heading', { name: 'Reading Speed History' })).toBeVisible();
}

test.describe('device views on the stats page', () => {
  test('one device shows none; a second brings the banner and the device list, and names stick', async ({
    page
  }) => {
    await gotoApp(page);
    await readHere(page);
    await expect.poll(() => countedMs(page, VOL_OWN), { timeout: 15000 }).toBeGreaterThan(0);
    await openStats(page);
    await expect(page.getByText('Achievements', { exact: true })).toBeVisible();
    await expect(page.getByTestId('device-banner')).toHaveCount(0);
    await expect(page.getByTestId('device-stats')).toHaveCount(0);

    await readOnPhone(page);
    const banner = page.getByTestId('device-banner');
    await expect(banner).toContainText('You read on 2 devices — name this one?', {
      timeout: 15000
    });
    const card = page.getByTestId('device-stats');
    const rows = card.getByTestId('device-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('This device');
    await expect(rows.nth(1).getByTestId('device-name')).toHaveText(PHONE_LABEL);
    await expect(rows.nth(1)).toContainText('3 min');
    await expect(rows.nth(1)).toContainText('900 chars');
    await expect(rows.nth(1)).toContainText('50% of time');

    // Inline rename of the other device.
    await rows.nth(1).getByRole('button', { name: PHONE_LABEL }).click();
    const field = rows.nth(1).getByRole('textbox');
    await expect(field).toBeFocused();
    await field.fill('Pixel 8');
    await field.press('Enter');
    await expect(rows.nth(1).getByTestId('device-name')).toHaveText('Pixel 8');

    // Name this device from the banner: it stays put, confirmed.
    const own = banner.getByRole('textbox');
    await own.fill('Work laptop');
    await own.press('Enter');
    await expect(banner).toContainText('Saved.');
    await expect(rows.nth(0).getByTestId('device-name')).toHaveText('Work laptop');

    // Both names survive a reload; a named device is not asked again.
    await gotoApp(page);
    await openStats(page);
    await expect(page.getByTestId('device-stats').getByTestId('device-name')).toHaveText(
      ['Work laptop', 'Pixel 8'],
      { timeout: 15000 }
    );
    await expect(page.getByTestId('device-banner')).toHaveCount(0);
  });

  test('"Not now" hides the banner in this browser, across reloads', async ({ page }) => {
    await gotoApp(page);
    await readHere(page);
    await readOnPhone(page);
    await openStats(page);
    const banner = page.getByTestId('device-banner');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await banner.getByRole('button', { name: 'Not now' }).click();
    await expect(banner).toHaveCount(0);

    await gotoApp(page);
    await openStats(page);
    // The device list proves the stats are in; the banner still stays away.
    await expect(page.getByTestId('device-stats').getByTestId('device-row')).toHaveCount(2, {
      timeout: 15000
    });
    await expect(page.getByTestId('device-banner')).toHaveCount(0);
  });
});
```

- [ ] **Step 14: Run it**

Run: `E2E_PORT=5199 E2E_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome npx playwright test e2e/devices.spec.ts`
Expected: PASS (2 passed). On any failure, read the whole report and match it by test id, line and assertion before blaming this task. A missing `Phone · Android · Chrome` points at Task 1/3 labelling. A field that stays open after Enter points at Task 4's `onDone`.

- [ ] **Step 15: Type-check and lint**

Run: `npm run check 2>&1 | tail -3 && npx eslint src/lib/components/Stats src/lib/views/__tests__/ReadingSpeedView.devices.test.ts e2e/devices.spec.ts && npx prettier --check src/lib/components/Stats src/lib/views/ReadingSpeedView.svelte src/lib/views/__tests__/ReadingSpeedView.devices.test.ts e2e/devices.spec.ts`
Expected: `svelte-check found 0 errors and 0 warnings`, no ESLint output, and "All matched files use Prettier code style!".

- [ ] **Step 16: Commit**

```bash
git add src/lib/components/Stats/DeviceStatsCard.svelte \
  src/lib/components/Stats/SecondDeviceBanner.svelte \
  src/lib/components/Stats/__tests__/device-fixtures.ts \
  src/lib/components/Stats/__tests__/DeviceNameFieldStub.svelte \
  src/lib/components/Stats/__tests__/DeviceStatsCard.test.ts \
  src/lib/components/Stats/__tests__/SecondDeviceBanner.test.ts \
  src/lib/views/ReadingSpeedView.svelte \
  src/lib/views/__tests__/ReadingSpeedView.devices.test.ts \
  e2e/devices.spec.ts
git commit -m "feat(history): per-device stats and a second-device naming banner on the stats page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Notes for the plan author

**What I verified.** Nothing in the repo was edited. I ran everything above except the e2e in a scratch copy of the worktree (`/tmp/claude-1000/-home-nathan-Projects-mokuro-reader/6f65961f-f765-436a-a0b9-aa680120300c/scratchpad/t5wt`), with throwaway stand-ins for Tasks 1, 3 and 4 written to the interfaces above:

- Steps 2 and 6 produced the RED message quoted.
- 6 files and 30 tests passed, including the existing `ReadingSpeedView.pauses` and `.orphans` suites.
- `svelte-check` gave 0 errors and 0 warnings, and ESLint and Prettier were clean.

The e2e was not run, because it needs the real Tasks 1–4.

**Assumptions about other tasks.** Each needs to be confirmed or the task text adjusted:

1. **Task 3 exports.** The design leaves the location open ("R/stats-store.ts or a new R/device-stats.ts"). This task assumes:
   - `deviceStats: Readable<DeviceStatsRow[]>` from `$lib/reading-history/device-stats`;
   - `devices: Readable<Map<string, DeviceView>>` (and the `DeviceView` type) from `$lib/reading-history/devices`.

   If Task 3 puts them elsewhere, only the import lines and the `vi.mock` paths change.
   - **Rows:** a `'device'` row exists only for a group with at least one native event, keyed by canonical id. `'before-history'` and `'edits'` rows use `id === kind`. `charsPerMinute` is already null under 30 min of samples.
   - **Order:** row order from the store does not matter, because the card orders rows itself (this device, then first seen, then id) so a recount never reorders them.
   - **Hidden rows:** the card also hides zero rows. The design's "hidden when zero" therefore holds whichever side implements it.
   - **No IndexedDB:** the `liveQuery` adapter behind `devices` must emit an empty result instead of throwing (see Step 12).

2. **"This device" across a merge.** The banner and card find this device's group as the view with `isThisDevice && id === canonical`. That needs Task 1's `labelDevices` to set `isThisDevice` on the canonical view of the group that `resolveDevice(own)` lands in, which is what §3 says. It also needs the canonical id to have its own entry in the map. If the merge target is unknown locally and has no view, the banner does not show and the card row reads "Unknown device" and cannot be renamed. Task 3 can avoid that by giving every canonical target a view.
3. **Task 4 `DeviceNameField`.** The design gives the props as `{ device }` only. The inline swap needs an extra `onDone?: () => void`, called after a save (Enter) and after an Escape revert. Without it the field stays open after saving. The unit tests use a stand-in, so only the e2e catches a mismatch. Inline focus is given by the card itself (it focuses the first `<input>`), so no `autofocus` prop is needed.
4. **Task 7 and the e2e file.** This task creates `e2e/devices.spec.ts` with one `test.describe('device views on the stats page')` block, so Task 7 must Modify that file (add its sync, merge and position-offer describes), not Create it.

**Where this goes beyond the design:**

- **Banner after naming.** Instead of vanishing, the banner stays in place and becomes "Saved. You can change it in the Devices list below." with a Close button. This follows the owner's no-layout-motion rule. Next visit it is gone because the device has a name, which matches "naming the device also ends it". Close writes the same dismissal flag as "Not now".
- **Share of time.** It is computed in the card as `row.timeMs / Σ rows.timeMs`. That sum equals the page's Total Time only if Task 3's "Before history" row includes the pre-history baseline (Q3) and the Edits row carries the adjust time (Q4).

## **Remaining layout shift.** The banner and card first appear when the stats and the devices `liveQuery` settle after the page loads, so content below them moves once. I left this as is: the design puts the banner directly under the `<h1>`, and the existing stat cards load the same way.

### Task 6: Position offer banner and chip name the other device

**Files:**

- Modify: `src/lib/reading-history/position-offer.ts`. Add one type import at line 2. Append `offerDeviceName` after `planPosition`, which ends at line 121. `planPosition` itself is not changed (R4).
- Modify: `src/lib/components/Reader/PositionOfferBanner.svelte`. The whole file (lines 1–87) is replaced.
- Modify: `src/lib/components/PositionOfferChip.svelte`. The whole file (lines 1–47) is replaced.
- Modify: `e2e/position-offer.spec.ts`. Change line 11 (header comment) and line 285 (assertion).
- Test: `src/lib/reading-history/position-offer.test.ts`. Change the import at line 2 and append a `describe` after line 236.
- Test: `src/lib/components/Reader/__tests__/PositionOfferBanner.test.ts`. Whole file replaced.
- Test: `src/lib/components/__tests__/PositionOfferChip.test.ts`. Whole file replaced.

**Interfaces:**

- Consumes (from Tasks 1 and 3, as the design names them):
  - `import type { DeviceView } from '$lib/reading-history/devices'`, where `DeviceView = { id: string; label: string; named: boolean; class: DeviceClass; detectedClass: DeviceClass; isThisDevice: boolean; canonical: string; mergedFrom: string[]; firstSeen: string }`.
  - `import { devices } from '$lib/reading-history/devices'`, with `devices: Readable<Map<string, DeviceView>>`. It is keyed by every known raw device id, merged ids included. Each view's `label` is that raw device's own label, and `canonical` is `resolveDevice(id)`.
- Produces:
  - In `position-offer.ts`: `export function offerDeviceName(offer: Pick<PositionOffer, 'device' | 'ownDevice'>, views: ReadonlyMap<string, DeviceView>): string | null`.
  - In `PositionOfferBanner.svelte` (module script): `export const NAME_WAIT_MS = 1500`.
  - `position-store.ts` does not change. `PositionOffer.device` and `PositionOffer.ownDevice` stay raw-id facts, so every `planPosition` comparison is the same as before.

- [ ] **Step 1: Write the failing test for the pure naming rule**

In `src/lib/reading-history/position-offer.test.ts`, replace line 2:

```ts
import { planPosition } from './position-offer';
```

with:

```ts
import { offerDeviceName, planPosition } from './position-offer';
import type { DeviceView } from './devices';
```

Then append at the end of the file, after line 236 `});`:

```ts
const dv = (id: string, label: string, extra: Partial<DeviceView> = {}): DeviceView => ({
  id,
  label,
  named: false,
  class: 'phone',
  detectedClass: 'phone',
  isThisDevice: false,
  canonical: id,
  mergedFrom: [],
  firstSeen: '2026-03-01T00:00:00.000Z',
  ...extra
});
const viewsOf = (...views: DeviceView[]) => new Map(views.map((v) => [v.id, v]));

describe('offerDeviceName', () => {
  it('names the device by its label, chosen or generated', () => {
    expect(
      offerDeviceName(
        { device: 'p', ownDevice: false },
        viewsOf(dv('p', 'Pixel 8', { named: true }))
      )
    ).toBe('Pixel 8');
    expect(
      offerDeviceName(
        { device: 'p', ownDevice: false },
        viewsOf(dv('p', 'Phone · Android · Chrome'))
      )
    ).toBe('Phone · Android · Chrome');
  });

  it('names a merged device as the group it was merged into', () => {
    const views = viewsOf(
      dv('old', 'Phone · Android · Chrome', { canonical: 'new' }),
      dv('new', 'Pixel 8', { named: true, mergedFrom: ['old'] })
    );
    expect(offerDeviceName({ device: 'old', ownDevice: false }, views)).toBe('Pixel 8');
  });

  it('names the device itself when it was merged into this one', () => {
    const views = viewsOf(
      dv('tab', 'Tablet · Android · Chrome', {
        class: 'tablet',
        detectedClass: 'tablet',
        canonical: 'me'
      }),
      dv('me', 'Laptop', { named: true, isThisDevice: true, mergedFrom: ['tab'] })
    );
    expect(offerDeviceName({ device: 'tab', ownDevice: false }, views)).toBe(
      'Tablet · Android · Chrome'
    );
  });

  it('falls back to the device itself when its merge target is not listed', () => {
    const views = viewsOf(dv('old', 'Phone · Android · Chrome', { canonical: 'gone' }));
    expect(offerDeviceName({ device: 'old', ownDevice: false }, views)).toBe(
      'Phone · Android · Chrome'
    );
  });

  it('names nothing for this device, an unlisted id, or an unnamed unknown device', () => {
    expect(
      offerDeviceName(
        { device: 'me', ownDevice: true },
        viewsOf(dv('me', 'Laptop', { named: true, isThisDevice: true }))
      )
    ).toBeNull();
    expect(offerDeviceName({ device: 'nobody', ownDevice: false }, viewsOf())).toBeNull();
    expect(
      offerDeviceName(
        { device: 'old', ownDevice: false },
        viewsOf(
          dv('old', 'Unknown device (since Mar 2026)', {
            class: 'unknown',
            detectedClass: 'unknown'
          })
        )
      )
    ).toBeNull();
  });

  it('names an unknown device once the user named it or set its class', () => {
    expect(
      offerDeviceName(
        { device: 'old', ownDevice: false },
        viewsOf(
          dv('old', 'Old tablet', { named: true, class: 'unknown', detectedClass: 'unknown' })
        )
      )
    ).toBe('Old tablet');
    expect(
      offerDeviceName(
        { device: 'old', ownDevice: false },
        viewsOf(dv('old', 'Tablet', { class: 'tablet', detectedClass: 'unknown' }))
      )
    ).toBe('Tablet');
  });
});
```

- [ ] **Step 2: Run it**

`npx vitest run src/lib/reading-history/position-offer.test.ts --testTimeout=30000`

Expected: FAIL. Every `offerDeviceName` case throws `TypeError: offerDeviceName is not a function`, because the export does not exist yet. The `planPosition` cases still pass.

- [ ] **Step 3: Implement `offerDeviceName`**

In `src/lib/reading-history/position-offer.ts`, replace lines 1–2:

```ts
import { LEGACY_DEVICE_PREFIX } from './paths';
import type { ReadingEvent } from './types';
```

with:

```ts
import type { DeviceView } from './devices';
import { LEGACY_DEVICE_PREFIX } from './paths';
import type { ReadingEvent } from './types';
```

Append at the end of the file, after `planPosition`'s closing `}`:

```ts
/**
 * Which device to name for where an offer's reading happened (phase 4), or
 * null to say "another device". This is wording only. The plan above compares
 * raw ids, so a merge never hides an offer.
 *
 * A merged device is named after its group, as it is shown everywhere else.
 * The exception is a device merged into THIS one: "this device" would be the
 * wrong name for it, so it keeps its own name. A device the list knows only
 * by its id (no facts, no name: "Unknown device") is not named.
 */
export function offerDeviceName(
  offer: Pick<PositionOffer, 'device' | 'ownDevice'>,
  views: ReadonlyMap<string, DeviceView>
): string | null {
  if (offer.ownDevice) return null;
  const view = views.get(offer.device);
  if (!view) return null;
  const group = views.get(view.canonical) ?? view;
  const shown = group.isThisDevice ? view : group;
  if (!shown.named && shown.class === 'unknown') return null;
  return shown.label;
}
```

- [ ] **Step 4: Run it**

`npx vitest run src/lib/reading-history/position-offer.test.ts --testTimeout=30000`

Expected: PASS, with all `planPosition` and `offerDeviceName` cases green.

- [ ] **Step 5: Write the failing banner test**

Replace `src/lib/components/Reader/__tests__/PositionOfferBanner.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable } from 'svelte/store';
import type { DeviceView } from '$lib/reading-history/devices';

const state = vi.hoisted(() => ({
  plan: null as unknown as import('svelte/store').Writable<Record<string, unknown>>,
  devices: null as unknown as import('svelte/store').Writable<
    Map<string, import('$lib/reading-history/devices').DeviceView>
  >,
  prompt: true
}));
const answerPosition = vi.hoisted(() => vi.fn(async () => {}));
const markPrompted = vi.hoisted(() => vi.fn());

vi.mock('$lib/reading-history/position-store', () => ({
  positionPlan: () => state.plan,
  shouldPrompt: () => state.prompt,
  markPrompted,
  answerPosition
}));
vi.mock('$lib/reading-history/devices', () => ({
  devices: {
    subscribe: (run: (value: Map<string, DeviceView>) => void) => state.devices.subscribe(run)
  }
}));

import PositionOfferBanner, { NAME_WAIT_MS } from '../PositionOfferBanner.svelte';

const offer = {
  page: 120,
  chars: 1210,
  at: Date.UTC(2026, 9, 3, 18, 36),
  device: 'phone',
  ownDevice: false
};

const pixel: DeviceView = {
  id: 'phone',
  label: 'Pixel 8',
  named: true,
  class: 'phone',
  detectedClass: 'phone',
  isThisDevice: false,
  canonical: 'phone',
  mergedFrom: [],
  firstSeen: '2026-03-01T00:00:00.000Z'
};

const props = { volumeId: 'v', pageCount: 200, currentPage: 41 };

beforeEach(() => {
  state.plan = writable({});
  state.devices = writable(new Map([['phone', pixel]]));
  state.prompt = true;
  answerPosition.mockClear();
  markPrompted.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PositionOfferBanner', () => {
  it('names the other device, and marks it shown', async () => {
    const { findByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    expect(await findByText(/also read to page 120 on Pixel 8/i)).toBeTruthy();
    expect(markPrompted).toHaveBeenCalledWith('v', offer);
  });

  it('says "this device" for this device’s own reading', async () => {
    const { findByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer: { ...offer, ownDevice: true } });
    expect(await findByText(/on this device/i)).toBeTruthy();
  });

  it('says "another device" once the device list has had time and cannot name it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    state.devices.set(new Map());
    const { queryByTestId, queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await tick();
    expect(queryByTestId('position-offer')).toBeNull();
    expect(markPrompted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(NAME_WAIT_MS);
    await tick();
    expect(queryByText(/also read to page 120 on another device/i)).toBeTruthy();
    expect(markPrompted).toHaveBeenCalledWith('v', offer);
  });

  it('names the device as soon as the list arrives within the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    state.devices.set(new Map());
    const { queryByTestId, queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await tick();
    expect(queryByTestId('position-offer')).toBeNull();
    state.devices.set(new Map([['phone', pixel]]));
    await tick();
    expect(queryByText(/also read to page 120 on Pixel 8/i)).toBeTruthy();
    vi.advanceTimersByTime(NAME_WAIT_MS);
    await tick();
    expect(queryByText(/on Pixel 8/i)).toBeTruthy();
    expect(markPrompted).toHaveBeenCalledTimes(1);
  });

  it('keeps its words while it is up (no text swap under the reader)', async () => {
    const { findByText, queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await findByText(/on Pixel 8/i);
    state.devices.set(new Map([['phone', { ...pixel, label: 'Old phone' }]]));
    await tick();
    expect(queryByText(/on Pixel 8/i)).toBeTruthy();
    expect(queryByText(/Old phone/i)).toBeNull();
  });

  it('Jump and Stay answer it', async () => {
    const { findByRole } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await fireEvent.click(await findByRole('button', { name: /go to page 120/i }));
    expect(answerPosition).toHaveBeenCalledWith('v', offer, 'jump', 200);
    state.plan.set({ offer: { ...offer, at: offer.at + 1 } });
    await fireEvent.click(await findByRole('button', { name: /stay on page 41/i }));
    expect(answerPosition).toHaveBeenLastCalledWith(
      'v',
      { ...offer, at: offer.at + 1 },
      'stay',
      200
    );
  });

  it('stays hidden when its prompts are used up (the volume card carries a chip instead)', async () => {
    state.prompt = false;
    const { queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await Promise.resolve();
    expect(queryByText(/also read to page/i)).toBeNull();
  });

  it('"Later" hides it without answering', async () => {
    const { findByRole, queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await fireEvent.click(await findByRole('button', { name: /later/i }));
    expect(queryByText(/also read to page/i)).toBeNull();
    expect(answerPosition).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it**

`npx vitest run src/lib/components/Reader/__tests__/PositionOfferBanner.test.ts --testTimeout=30000`

Expected: FAIL.

- "names the other device" times out on `findByText(/…on Pixel 8/i)`, because the banner still says "on another device".
- "says another device once…" and "names the device as soon as…" fail on `expect(queryByTestId('position-offer')).toBeNull()`, because the current banner shows at once. `NAME_WAIT_MS` is also `undefined`.
- "keeps its words" fails the same way as the first test.
- "this device", "Jump and Stay", "used up" and "Later" pass.

- [ ] **Step 7: Implement the banner**

Replace `src/lib/components/Reader/PositionOfferBanner.svelte` with:

```svelte
<script lang="ts" module>
  /** How long a new offer waits for the device list before naming no device. */
  export const NAME_WAIT_MS = 1500;
</script>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { devices } from '$lib/reading-history/devices';
  import { offerDeviceName, type PositionOffer } from '$lib/reading-history/position-offer';
  import {
    answerPosition,
    markPrompted,
    positionPlan,
    shouldPrompt
  } from '$lib/reading-history/position-store';

  /**
   * "You also read to page N on Pixel 8" (phase 2c; the device is named since
   * phase 4). Non-modal and keyboard-neutral: reading goes on underneath.
   * Shown at most once a session per offer, in at most two sessions
   * (`shouldPrompt`). After that the volume card carries a chip. "Later"
   * hides it without answering.
   *
   * The device name is fixed when the banner appears, so its text never
   * changes while it is up. The device list loads after the reader opens, so
   * a new offer waits up to NAME_WAIT_MS for a name. After that it says
   * "another device".
   */
  let {
    volumeId,
    pageCount,
    currentPage
  }: { volumeId: string; pageCount: number; currentPage: number } = $props();

  let plan = $derived(positionPlan(volumeId));
  /** The offer (by its `at`) this banner is showing; null when hidden. */
  let showing = $state<number | null>(null);
  /** Offers answered or put off in this banner: never re-shown, even before
   * the recorded answer reaches the plan. */
  let settled = $state<number[]>([]);
  /** Where the shown offer's reading happened, fixed when it appeared. */
  let where = $state('');
  /** The offer (by its `at`) whose wait for a device name ran out. */
  let waited = $state<number | null>(null);
  // Not reactive: device-list emissions must not restart the wait.
  let waitingFor: number | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(waitTimer));

  $effect(() => {
    const offer = $plan.offer;
    if (!offer) {
      showing = null;
      return;
    }
    if (showing === offer.at || settled.includes(offer.at)) return;
    if (!shouldPrompt(volumeId, offer)) return;
    const name = offer.ownDevice ? null : offerDeviceName(offer, $devices);
    if (!offer.ownDevice && name === null && waited !== offer.at) {
      if (waitingFor !== offer.at) {
        waitingFor = offer.at;
        clearTimeout(waitTimer);
        const at = offer.at;
        waitTimer = setTimeout(() => (waited = at), NAME_WAIT_MS);
      }
      return;
    }
    markPrompted(volumeId, offer);
    where = offer.ownDevice ? 'this device' : (name ?? 'another device');
    showing = offer.at;
  });

  let offer = $derived<PositionOffer | null>(
    $plan.offer && showing === $plan.offer.at ? $plan.offer : null
  );

  const when = (at: number) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);

  function answer(kind: 'jump' | 'stay') {
    if (!offer) return;
    const answered = offer;
    settled = [...settled, answered.at];
    showing = null;
    void answerPosition(volumeId, answered, kind, pageCount);
  }

  function later() {
    if (offer) settled = [...settled, offer.at];
    showing = null;
  }
</script>

{#if offer}
  <div
    class="fixed top-16 left-1/2 z-20 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg px-4 py-2 text-sm text-white shadow-lg"
    style="backdrop-filter: blur(8px); background-color: rgba(17, 24, 39, 0.9);"
    role="status"
    data-testid="position-offer"
  >
    <span>
      You also read to page {offer.page} on {where}
      <span class="text-gray-400">({when(offer.at)})</span>
    </span>
    <span class="relative z-10 flex gap-2">
      <button
        class="rounded bg-primary-700 px-2 py-1 font-medium hover:bg-primary-600"
        onclick={() => answer('jump')}>Go to page {offer.page}</button
      >
      <button class="rounded bg-gray-700 px-2 py-1 hover:bg-gray-600" onclick={() => answer('stay')}
        >Stay on page {currentPage}</button
      >
      <button class="rounded px-2 py-1 text-gray-400 hover:text-white" onclick={later}>Later</button
      >
    </span>
  </div>
{/if}
```

`$devices` is read only after the `showing` and `settled` early returns. Once the banner is up, the effect no longer depends on the device list, so new labels cannot change the text.

- [ ] **Step 8: Run it**

`npx vitest run src/lib/components/Reader/__tests__/PositionOfferBanner.test.ts --testTimeout=30000`

Expected: PASS (8 tests).

- [ ] **Step 9: Write the failing chip test**

Replace `src/lib/components/__tests__/PositionOfferChip.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import type { DeviceView } from '$lib/reading-history/devices';

const state = vi.hoisted(() => ({
  plan: null as unknown as import('svelte/store').Writable<Record<string, unknown>>,
  devices: null as unknown as import('svelte/store').Writable<
    Map<string, import('$lib/reading-history/devices').DeviceView>
  >,
  chip: true
}));
const answerPosition = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('$lib/reading-history/position-store', () => ({
  positionPlan: () => state.plan,
  showsChip: () => state.chip,
  answerPosition
}));
vi.mock('$lib/reading-history/devices', () => ({
  devices: {
    subscribe: (run: (value: Map<string, DeviceView>) => void) => state.devices.subscribe(run)
  }
}));

import PositionOfferChip from '../PositionOfferChip.svelte';

const offer = { page: 120, chars: 1210, at: 1000, device: 'phone', ownDevice: false };

const pixel: DeviceView = {
  id: 'phone',
  label: 'Pixel 8',
  named: true,
  class: 'phone',
  detectedClass: 'phone',
  isThisDevice: false,
  canonical: 'phone',
  mergedFrom: [],
  firstSeen: '2026-03-01T00:00:00.000Z'
};

beforeEach(() => {
  state.plan = writable({ offer });
  state.devices = writable(new Map([['phone', pixel]]));
  state.chip = true;
  answerPosition.mockClear();
});
afterEach(cleanup);

describe('PositionOfferChip', () => {
  it('shows once the prompts are used up, and answers without opening the volume', async () => {
    const { getByTestId, getByRole } = render(PositionOfferChip, {
      props: { volumeId: 'v', pageCount: 200 }
    });
    expect(getByTestId('position-offer-chip').textContent).toMatch(/also read to p\.120/i);
    // Default prevented: a card link around it does not navigate. (Svelte 5
    // delegates handlers, so its stopPropagation stops the card's own onclick.)
    const notPrevented = await fireEvent.click(getByRole('button', { name: /go/i }));
    expect(notPrevented).toBe(false);
    expect(answerPosition).toHaveBeenCalledWith('v', offer, 'jump', 200);
  });

  it('Stay answers it too', async () => {
    const { getByRole } = render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } });
    await fireEvent.click(getByRole('button', { name: /stay/i }));
    expect(answerPosition).toHaveBeenCalledWith('v', offer, 'stay', 200);
  });

  it('names the other device in its tooltip, leaving its own text short', () => {
    const chip = render(PositionOfferChip, {
      props: { volumeId: 'v', pageCount: 200 }
    }).getByTestId('position-offer-chip');
    expect(chip.getAttribute('title')).toBe('Read on Pixel 8');
    expect(chip.textContent).not.toMatch(/Pixel 8/);
  });

  it('says "another device" when the list cannot name it, "this device" for its own reading', () => {
    state.devices.set(new Map());
    expect(
      render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } })
        .getByTestId('position-offer-chip')
        .getAttribute('title')
    ).toBe('Read on another device');
    cleanup();
    state.plan = writable({ offer: { ...offer, ownDevice: true } });
    expect(
      render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } })
        .getByTestId('position-offer-chip')
        .getAttribute('title')
    ).toBe('Read on this device');
  });

  it('is absent while the reader may still prompt, or with no offer', () => {
    state.chip = false;
    expect(
      render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } }).queryByTestId(
        'position-offer-chip'
      )
    ).toBeNull();
    cleanup();
    state.chip = true;
    state.plan = writable({});
    expect(
      render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } }).queryByTestId(
        'position-offer-chip'
      )
    ).toBeNull();
  });
});
```

- [ ] **Step 10: Run it**

`npx vitest run src/lib/components/__tests__/PositionOfferChip.test.ts --testTimeout=30000`

Expected: FAIL in exactly one test. "names the other device in its tooltip" fails with `expected 'Read on another device' to be 'Read on Pixel 8'`. The other four pass, because the old wording already matches them.

- [ ] **Step 11: Implement the chip**

Replace `src/lib/components/PositionOfferChip.svelte` with:

```svelte
<script lang="ts">
  import { devices } from '$lib/reading-history/devices';
  import { offerDeviceName } from '$lib/reading-history/position-offer';
  import { answerPosition, positionPlan, showsChip } from '$lib/reading-history/position-store';

  /**
   * The volume card's reminder of an unanswered cross-device position offer,
   * once the reader's prompts for it are used up (phase 2c). Its buttons
   * answer it in place without opening the volume. The tooltip names where
   * that reading happened (phase 4). The chip's own text stays short, so
   * nothing on the card moves when the device list loads.
   */
  let { volumeId, pageCount }: { volumeId: string; pageCount: number } = $props();

  let plan = $derived(positionPlan(volumeId));
  let answered = $state<number | null>(null);
  let offer = $derived(
    $plan.offer && $plan.offer.at !== answered && showsChip(volumeId, $plan.offer)
      ? $plan.offer
      : null
  );
  // Lazy: read (and the device list subscribed) only while a chip is shown.
  let where = $derived(
    !offer
      ? ''
      : offer.ownDevice
        ? 'this device'
        : (offerDeviceName(offer, $devices) ?? 'another device')
  );

  function answer(event: MouseEvent, kind: 'jump' | 'stay') {
    event.stopPropagation();
    event.preventDefault();
    const current = offer;
    if (!current) return;
    answered = current.at;
    void answerPosition(volumeId, current, kind, pageCount);
  }
</script>

{#if offer}
  <span
    data-testid="position-offer-chip"
    class="inline-flex items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
    title="Read on {where}"
  >
    Also read to p.{offer.page}
    <button
      class="rounded px-1 font-medium hover:bg-indigo-200 dark:hover:bg-indigo-800"
      aria-label="Go to page {offer.page}"
      onclick={(e) => answer(e, 'jump')}>Go</button
    >
    <button
      class="rounded px-1 hover:bg-indigo-200 dark:hover:bg-indigo-800"
      aria-label="Stay where you are"
      onclick={(e) => answer(e, 'stay')}>Stay</button
    >
  </span>
{/if}
```

- [ ] **Step 12: Run it, plus the tests that render the chip and banner indirectly**

`npx vitest run src/lib/components/__tests__/PositionOfferChip.test.ts src/lib/components/Reader/__tests__/PositionOfferBanner.test.ts src/lib/reading-history/position-offer.test.ts src/lib/reading-history/position-store.test.ts src/lib/components/__tests__/VolumeItem.test.ts src/lib/components/__tests__/VolumeItem.covers.test.ts src/lib/components/__tests__/PlaceholderVolumeItem.badge.test.ts src/lib/components/__tests__/img-cover-surfaces.covers.test.ts src/lib/views/__tests__/SeriesView.placement.test.ts src/lib/components/Reader/__tests__/RereadPromptModal.test.ts --testTimeout=30000`

Expected: PASS, with zero failures. The VolumeItem and SeriesView tests render the real chip. With no offer, `where` is never read, so the real `devices` store is never subscribed and no history-DB `liveQuery` opens.

Then run `npm run check`. Expected: 0 errors.

- [ ] **Step 13: Update the e2e assertion that pinned the old wording**

The phone context uploads its `device.json` on sync and the laptop imports it. Both are Playwright desktop Chromium (viewport 1920×1080, fine pointer), so the generated label starts with "Desktop · ". Both contexts generate the same base label, so a collision suffix follows it.

In `e2e/position-offer.spec.ts`, replace line 11:

```ts
 * read to page 44 on another device"; "Go to page 44" moves there. The answer
```

with:

```ts
 * read to page 44 on Desktop · …" (the phone's label); "Go to page 44" moves there. The answer
```

Replace line 285:

```ts
await expect(banner).toContainText('You also read to page 44 on another device');
```

with:

```ts
// Named by the phone's label (its device.json arrived with the laptop's sync).
await expect(banner).toContainText('You also read to page 44 on Desktop · ');
await expect(banner).not.toContainText('another device');
```

Run:

`E2E_PORT=5199 E2E_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome npx playwright test e2e/position-offer.spec.ts`

Expected: PASS (1 test). Count failures over the whole output, not just its tail.

- [ ] **Step 14: Commit**

```bash
git -C /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-devices add \
  src/lib/reading-history/position-offer.ts \
  src/lib/reading-history/position-offer.test.ts \
  src/lib/components/Reader/PositionOfferBanner.svelte \
  src/lib/components/Reader/__tests__/PositionOfferBanner.test.ts \
  src/lib/components/PositionOfferChip.svelte \
  src/lib/components/__tests__/PositionOfferChip.test.ts \
  e2e/position-offer.spec.ts
git -C /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-devices commit -m "$(cat <<'EOF'
feat(history): position offers name the other device by its label

The banner says "on Pixel 8" (or the generated label) instead of "on another
device"; the chip's tooltip does the same. Wording only: planPosition still
compares raw ids. The banner fixes its words when it appears, waiting up to
1.5 s for the device list, so its text never changes under the reader.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **Module path assumed.** The `devices` store and the `DeviceView` type are imported from `$lib/reading-history/devices`, the one module that design §3 describes. If Task 3 puts the store elsewhere (for example a `device-store.ts`), change the component import and the `vi.mock(...)` path in both component tests to match. `position-offer.ts` imports `DeviceView` as a type only, so it never pulls in the store module (or `stats-store` / Dexie) at runtime. That avoids an import cycle through `position-store`.
- **Shape assumed from Task 3.** `devices` must hold an entry for every known raw id, merged ids included. Each entry's `label` must be that raw device's own label, and `canonical` must be `resolveDevice(id)`. `isThisDevice` must at least be true on the view whose id is `resolveDevice(own)`. If Task 3 keys the map by group only, `views.get(offer.device)` misses merged devices and the banner falls back to "another device".
- **Naming rule (Q5 as adopted).**
  - A merged device is named after its group's label, the same as in the stats.
  - The exception is a device merged into this device. It keeps its own label, because "on this device" would describe a different physical device (the R4 raw-id offer).
  - An unnamed device with class `unknown` gets the fallback wording. In practice that is an event-only device with no `device.json`, whose label is "Unknown device". The test is `!named && class === 'unknown'`, so it needs no exported label constant from Task 1.
- **No layout motion (my addition, not in the design).** The banner pill is a status UI. Without a guard it would show "another device" and then change to the name once the `liveQuery` over `db.devices` emits, which the owner's no-layout-motion rule forbids. So the banner:
  - fixes its words when it appears;
  - waits at most `NAME_WAIT_MS = 1500` for a name. The wait applies only to other-device offers with no usable name. Own-device and already-named offers show at once.

  Because of this guard, the existing tests that use device `'phone'` need a named device seeded in `beforeEach`. That is why both component test files are replaced in full.

- **Chip.** The chip names the device only in its `title`, where it already said "another device". Its visible text stays "Also read to p.N", so a catalog card never moves or grows by a long generated label. If the owner wants the name visible on the chip, that is a separate decision: it would need a fixed-width truncated slot.
- **E2E overlap with Task 7.** `e2e/position-offer.spec.ts:285` pinned "on another device" and would fail after this task, so this task updates it. The new assertion relies on Task 3 exposing imported `device.json` facts through `devices` (desktop Chromium gives "Desktop · …"). Task 7's `e2e/devices.spec.ts` should not duplicate this check. It can assert a user-chosen name in the banner after a rename syncs.
- **Unchanged.** `position-store.ts` does not change: no new dependency in `positionPlan`, and the memo is untouched, because labels affect wording only. No new user-visible strings beyond "on {label}" and "Read on {label}".

---

### Task 7: e2e device views spec, plus phase 4 docs

**Files:**

- Create: `e2e/devices.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md`. Insert after line 109, the end of the "Labels" entry points, before `### Events` at :111.
- Modify: `CLAUDE.md`
  - "What syncs where" table: add a row after :689 (`Pre-history reading snapshot`).
  - Reading history section: add a new **Devices (phase 4)** block between :936 (end of the "Position across devices" bullets) and :938 (`**Cloud (phase 2a).**`).
- Test: `e2e/devices.spec.ts`. Regression check on its neighbours: `e2e/position-offer.spec.ts`, `e2e/history-sync.spec.ts`, `e2e/reading-stats.spec.ts`, `e2e/long-pauses.spec.ts`.

**Interfaces:**

_Consumes, existing code (checked against the worktree):_

- `e2e/helpers/webdav-stub.ts`: `class WebDavStub { file(path: string, body: Buffer, mtime: string): void; handle: (route: Route) => Promise<void> }`. Its root is `/mokuro-reader`.
- `e2e/helpers/app.ts`: `gotoApp(page: Page): Promise<void>`
- `src/lib/reading-history/segment-codec.ts`: `encodeSegment(device: string, month: string, events: ReadingEvent[], options?: { legacy?: boolean }): Promise<Uint8Array>`
- `src/lib/reading-history/record.ts`:
  - `recordEvent(payload: EventPayload, t?: number, db?: HistoryDexie): Promise<ReadingEvent | null>`
  - `notifyEventsRecorded(events: ReadingEvent[]): void`
  - `getOrCreateDeviceId(db: HistoryDexie): Promise<string>`
- `src/lib/reading-history/history-db.ts`: `historyDb(): HistoryDexie`
- `src/lib/settings/volume-data.ts`: `updateProgress(volume: string, progress: number, chars?: number, completed = false)`
- `src/lib/reading-history/stats-store.ts`: `flushReadingStats(): void`, `readingStats: Readable<ReadingStatsState>`, `figuresFor(stats, volume, record?): VolumeFigures`. `VolumeFigures` has `timeMs` and `chars`.
- `src/lib/reading-history/position-store.ts`: `positionPlanFor(volume: string): PositionPlan`

_Consumes, from Tasks 2 and 3 (names as in the design):_

- `src/lib/settings/tracking-data.ts`: `deviceLabels: Readable<Record<string, DeviceLabel>>`, with `DeviceLabel { name?; class?; merged_into?; lastUpdated }`
- `src/lib/reading-history/devices.ts`: `devices: Readable<Map<string, DeviceView>>`, keyed by **raw** device id.

_Consumes, the DOM contract this spec pins on Tasks 4–6._ Testids marked "design" come from the design. The rest are this task's proposal; the plan author must copy them into Tasks 4–6.

- Second-device banner: `data-testid="device-banner"` (design), `role="status"`.
  - Text: `You read on N devices — name this one?`
  - Holds a `DeviceNameField` and a button `Not now`.
- `DeviceNameField`: one `<input>` with `aria-label="Device name"` (role textbox, name "Device name"). Enter saves.
- Per-device card: `data-testid="device-stats"` (design).
  - Each row is `data-testid="device-stats-row"`, hidden "Before history"/"Edits" rows included.
  - A renamable row shows its label as a `<button>` whose accessible name starts with the label. Clicking it swaps in `DeviceNameField`.
  - The own row carries the text `This device` (Badge).
- Cloud Devices block: `data-testid="devices-settings"`.
  - Each group is `data-testid="device-row"`, showing its label as visible text (not only as an input placeholder) and `This device` on the own row.
  - Each row has a class `<select aria-label="Device type">`, with option labels `Automatic (detected: X)`, `Phone`, `Tablet`, `Laptop`, `Desktop`.
  - Non-own rows have a button `Merge into…`. It opens a flowbite `Modal` (role dialog) containing `<select aria-label="Merge into">` (options = group labels) and a button `Merge`.
  - Merged ids are listed with a button `Unmerge`.
- Position offer banner (`data-testid="position-offer"`, existing): `You also read to page N on <label>` (Task 6, design Q5).

_Produces:_ no source interfaces. It produces one e2e spec and docs.

- [ ] **Step 1: Write the spec.** Create `e2e/devices.spec.ts` with exactly:

```ts
import { test, expect, type Browser, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { WebDavStub } from './helpers/webdav-stub';

/**
 * Device views (phase 4) through the REAL app and sync. Browser contexts (each
 * its own IndexedDB, so its own device id) share an in-memory WebDAV server; a
 * third device — an old tablet that no longer runs — is planted on the server
 * as its `device.json` and one month of events.
 *
 * - A single-device user never sees a device: no banner, no per-device card,
 *   no Devices block. Converted legacy history is not a device.
 * - With three devices the reading-speed page asks to name this one, lists a
 *   row per device (twin generated labels told apart), renames inline; the
 *   cloud screen corrects a class, merges and unmerges; every choice reaches
 *   the other device through `volume-data.json` → `tracking.devices`.
 * - The position offer names the device the reading comes from.
 */

const STUB = 'http://stub.test';
const ROOT = '/mokuro-reader';
const SERIES = 'Devices Series';
const SERIES_UUID = 'e2e-devices-series';
const VOL = 'e2e-devices-volume';
const PAGES = 50;
const TABLET = 'e2e-old-tablet';

async function device(browser: Browser, stub: WebDavStub): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(`${STUB}/**`, stub.handle);
  await gotoApp(page);
  await page.evaluate(async (serverUrl) => {
    const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
    const provider = await providerManager.getOrLoadProvider('webdav');
    await provider.login({ serverUrl, username: '', password: '' });
    await providerManager.setCurrentProvider(provider);
  }, STUB);
  return page;
}

async function sync(page: Page) {
  const result = await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    await unifiedCloudManager.fetchAllCloudVolumes();
    return unifiedCloudManager.syncProgress({ silent: false });
  });
  expect(result.succeeded).toBe(1);
}

async function go(page: Page, hash: string) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

async function deviceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
    const { getOrCreateDeviceId } = await import('/src/lib/reading-history/record.ts');
    return getOrCreateDeviceId(historyDb());
  });
}

/** Raw ids of every device this one knows (the `devices` store's keys). */
async function deviceIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { devices } = await import('/src/lib/reading-history/devices.ts');
    let views = new Map<string, unknown>();
    const stop = devices.subscribe((v) => (views = v));
    await new Promise((r) => setTimeout(r, 200));
    stop();
    return [...views.keys()].sort();
  });
}

/** The name this device's label carries in the synced `tracking.devices`. */
async function ownName(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
    const { getOrCreateDeviceId } = await import('/src/lib/reading-history/record.ts');
    const { deviceLabels } = await import('/src/lib/settings/tracking-data.ts');
    const id = await getOrCreateDeviceId(historyDb());
    let labels: Record<string, { name?: string }> = {};
    deviceLabels.subscribe((v) => (labels = v))();
    return labels[id]?.name;
  });
}

/** Read pages the way the reader records them: a 60 s view each, and the position. */
async function read(page: Page, pages: number[]) {
  await page.evaluate(
    async ({ VOL, pages }) => {
      const { recordEvent } = await import('/src/lib/reading-history/record.ts');
      const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
      for (const p of pages) {
        await recordEvent({
          kind: 'page',
          volume: VOL,
          first_page: p,
          last_page: p,
          page_chars: [300],
          chars_before: (p - 1) * 300,
          dwell_ms: 60_000,
          layout: 'single',
          orientation: 'portrait',
          viewport: { w: 400, h: 800 }
        });
        updateProgress(VOL, p, p * 300);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    { VOL, pages }
  );
}

/** This volume's figures once the stats have counted. */
async function figures(page: Page) {
  return page.evaluate(async (VOL) => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    stats.flushReadingStats();
    let state: Parameters<typeof stats.figuresFor>[0] | undefined;
    stats.readingStats.subscribe((s) => (state = s))();
    let records: Record<string, never> = {};
    volumesWithTrash.subscribe((v) => (records = v as never))();
    return stats.figuresFor(state!, VOL, records[VOL]);
  }, VOL);
}

async function plan(page: Page) {
  return page.evaluate(async (VOL) => {
    const { positionPlanFor } = await import('/src/lib/reading-history/position-store.ts');
    return positionPlanFor(VOL);
  }, VOL);
}

/** Install a 50-page volume locally (as a download would have left it). */
async function installVolume(page: Page) {
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOL, PAGES }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 300;
      canvas.getContext('2d')!.fillRect(0, 0, 200, 300);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const pages = Array.from({ length: PAGES }, (_, i) => ({
        version: '0.2.1',
        img_width: 200,
        img_height: 300,
        img_path: `${String(i + 1).padStart(3, '0')}.png`,
        blocks: []
      }));
      const files: Record<string, File> = {};
      for (const p of pages)
        files[p.img_path] = new File([blob], p.img_path, { type: 'image/png' });
      await db.volumes.put({
        volume_uuid: VOL,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: PAGES,
        character_count: 0,
        page_char_counts: pages.map(() => 0),
        thumbnail: new File([blob], 'thumb.webp', { type: 'image/webp' })
      });
      await db.volume_ocr.put({ volume_uuid: VOL, pages });
      await db.volume_files.put({ volume_uuid: VOL, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
    },
    { SERIES, SERIES_UUID, VOL, PAGES }
  );
}

/**
 * A third device that no longer runs: its facts and one month of its events,
 * planted on the server as it would have uploaded them (encoded in-page by the
 * real codec).
 */
async function plantTablet(page: Page, stub: WebDavStub) {
  const bytes = await page.evaluate(
    async ({ TABLET, VOL }) => {
      const { encodeSegment } = await import('/src/lib/reading-history/segment-codec.ts');
      const events = [1, 2].map((p) => ({
        device: TABLET,
        seq: p,
        t: Date.UTC(2026, 2, 20, 12, p),
        kind: 'page' as const,
        volume: VOL,
        first_page: p,
        last_page: p,
        page_chars: [300],
        chars_before: (p - 1) * 300,
        dwell_ms: 60_000,
        layout: 'single' as const,
        orientation: 'portrait' as const,
        viewport: { w: 800, h: 1280 }
      }));
      return Array.from(await encodeSegment(TABLET, '2026-03', events));
    },
    { TABLET, VOL }
  );
  const mtime = 'Fri, 20 Mar 2026 12:05:00 GMT';
  stub.file(`${ROOT}/history/${TABLET}/2026-03.events`, Buffer.from(bytes), mtime);
  stub.file(
    `${ROOT}/history/${TABLET}/device.json`,
    Buffer.from(
      JSON.stringify({
        device: TABLET,
        class: 'tablet',
        os: 'Android',
        browser: 'Chrome',
        first_seen: '2026-03-02T10:00:00.000Z',
        last_seen: '2026-03-20T12:05:00.000Z'
      })
    ),
    mtime
  );
}

/** A converted page turn (phase 2b): keyed `legacy:<volume>`, never a device. */
async function plantLegacy(page: Page) {
  await page.evaluate(async () => {
    const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
    const { notifyEventsRecorded } = await import('/src/lib/reading-history/record.ts');
    const t = Date.UTC(2026, 5, 1, 12);
    const event = {
      device: 'legacy:e2e-devices-legacy',
      seq: t,
      t,
      kind: 'page' as const,
      volume: 'e2e-devices-legacy',
      first_page: 1,
      last_page: 1,
      page_chars: [300],
      chars_before: 0,
      dwell_ms: 60_000,
      layout: 'unknown' as const,
      orientation: 'unknown' as const,
      viewport: null
    };
    await historyDb().reading_events.put(event);
    notifyEventsRecorded([event]);
  });
}

test('a single-device user sees no device anywhere, legacy history included', async ({
  browser
}) => {
  const stub = new WebDavStub();
  const page = await device(browser, stub);
  await read(page, [1, 2]);
  await plantLegacy(page);
  await sync(page);

  await go(page, '#/reading-speed');
  // The stats have counted and the device list is loaded: exactly this device.
  await expect.poll(async () => (await figures(page)).timeMs, { timeout: 15000 }).toBe(120_000);
  const own = await deviceId(page);
  await expect.poll(() => deviceIds(page), { timeout: 15000 }).toEqual([own]);
  await expect(page.getByRole('heading', { name: 'Reading Speed History' })).toBeVisible();
  await expect(page.getByTestId('device-stats')).toHaveCount(0);
  await expect(page.getByTestId('device-banner')).toHaveCount(0);

  await go(page, '#/cloud');
  await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('devices-settings')).toHaveCount(0);
});

test('three devices: name this one, rename, correct a class, merge and unmerge — all synced', async ({
  browser
}) => {
  test.setTimeout(180_000);
  const stub = new WebDavStub();
  const laptop = await device(browser, stub);
  const phone = await device(browser, stub);
  await plantTablet(laptop, stub);

  await read(phone, [3, 4]);
  await sync(phone);
  await read(laptop, [5, 6]);
  await sync(laptop);
  await sync(phone);

  // The laptop: three devices hold reading, so the page asks to name this one.
  await go(laptop, '#/reading-speed');
  const banner = laptop.getByTestId('device-banner');
  await expect(banner).toContainText('You read on 3 devices — name this one?', {
    timeout: 15000
  });
  const card = laptop.getByTestId('device-stats');
  const rows = card.getByTestId('device-stats-row');
  await expect(rows).toHaveCount(3);
  await expect(
    card.getByRole('button', { name: 'Tablet · Android · Chrome', exact: true })
  ).toBeVisible();
  // Laptop and phone run the same browser: one generated label, told apart.
  const twins = card.getByRole('button', { name: /^Desktop · / });
  await expect(twins).toHaveCount(2);
  const twinLabels = (await twins.allTextContents()).map((l) => l.trim());
  expect(new Set(twinLabels).size).toBe(2);
  for (const label of twinLabels) expect(label).toContain('(since ');
  await expect(rows.filter({ hasText: 'This device' })).toHaveCount(1);

  // Entry point 3: the banner names this device, and goes.
  const bannerField = banner.getByRole('textbox', { name: 'Device name' });
  await bannerField.fill('Work laptop');
  await bannerField.press('Enter');
  await expect(banner).toBeHidden();
  await expect(rows.filter({ hasText: 'This device' })).toContainText('Work laptop');

  // Entry point 2: rename another device in place.
  await card.getByRole('button', { name: 'Tablet · Android · Chrome', exact: true }).click();
  const inline = card.getByRole('textbox', { name: 'Device name' });
  await inline.fill('Old tablet');
  await inline.press('Enter');
  await expect(card.getByRole('button', { name: 'Old tablet', exact: true })).toBeVisible();

  // Entry point 1: the cloud screen corrects the phone's detected class.
  await go(laptop, '#/cloud');
  const settings = laptop.getByTestId('devices-settings');
  await expect(settings).toBeVisible({ timeout: 15000 });
  const phoneRow = settings.getByTestId('device-row').filter({ hasText: 'Desktop · ' });
  await expect(phoneRow).toHaveCount(1);
  await phoneRow.getByRole('combobox', { name: 'Device type' }).selectOption({ label: 'Phone' });
  await expect(settings.getByTestId('device-row').filter({ hasText: 'Phone · ' })).toHaveCount(1);
  await sync(laptop);

  // The phone sees every choice the laptop made.
  await sync(phone);
  await go(phone, '#/reading-speed');
  const phoneCard = phone.getByTestId('device-stats');
  const phoneRows = phoneCard.getByTestId('device-stats-row');
  await expect(phoneCard.getByRole('button', { name: 'Work laptop', exact: true })).toBeVisible({
    timeout: 15000
  });
  await expect(phoneCard.getByRole('button', { name: 'Old tablet', exact: true })).toBeVisible();
  await expect(phoneRows.filter({ hasText: 'This device' })).toContainText('Phone · ');
  const phoneBanner = phone.getByTestId('device-banner');
  await expect(phoneBanner).toContainText('You read on 3 devices — name this one?');

  // The phone merges the old tablet into the laptop.
  await go(phone, '#/cloud');
  const phoneSettings = phone.getByTestId('devices-settings');
  await expect(phoneSettings).toBeVisible({ timeout: 15000 });
  await phoneSettings
    .getByTestId('device-row')
    .filter({ hasText: 'Old tablet' })
    .getByRole('button', { name: 'Merge into…' })
    .click();
  const dialog = phone.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Merge into' }).selectOption({ label: 'Work laptop' });
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(phoneSettings.getByRole('button', { name: 'Unmerge' })).toHaveCount(1);
  await sync(phone);

  await go(phone, '#/reading-speed');
  await expect(phoneRows).toHaveCount(2, { timeout: 15000 });
  await expect(phoneCard.getByRole('button', { name: 'Old tablet', exact: true })).toHaveCount(0);
  await expect(phoneBanner).toContainText('You read on 2 devices — name this one?');

  // "Not now" is remembered by this browser.
  await phoneBanner.getByRole('button', { name: 'Not now' }).click();
  await expect(phoneBanner).toBeHidden();
  await phone.reload();
  await expect(phone.getByTestId('device-stats')).toBeVisible({ timeout: 30000 });
  await expect(phone.getByTestId('device-banner')).toBeHidden();

  // The merge reaches the laptop; unmerging there brings the tablet back.
  await sync(laptop);
  await go(laptop, '#/reading-speed');
  await expect(rows).toHaveCount(2, { timeout: 15000 });
  await go(laptop, '#/cloud');
  await settings.getByRole('button', { name: 'Unmerge' }).click();
  await go(laptop, '#/reading-speed');
  await expect(rows).toHaveCount(3, { timeout: 15000 });
  await expect(card.getByRole('button', { name: 'Old tablet', exact: true })).toBeVisible();
});

test('the position offer names the device it comes from', async ({ browser }) => {
  test.setTimeout(150_000);
  const stub = new WebDavStub();
  const phone = await device(browser, stub);
  const laptop = await device(browser, stub);
  await installVolume(laptop);

  await read(phone, [38, 39, 40]);
  await sync(phone);
  await sync(laptop);
  await sync(phone); // the phone now knows the laptop

  // The phone names itself on the cloud screen.
  await go(phone, '#/cloud');
  const own = phone
    .getByTestId('devices-settings')
    .getByTestId('device-row')
    .filter({ hasText: 'This device' });
  const field = own.getByRole('textbox', { name: 'Device name' });
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.fill('Pixel 8');
  await field.press('Enter');
  await expect.poll(() => ownName(phone), { timeout: 10000 }).toBe('Pixel 8');

  // The phone reads on; the laptop never pulls it, turns one page and syncs.
  await read(phone, [41, 42, 43, 44]);
  await sync(phone);
  await read(laptop, [41]);
  await sync(laptop);
  await expect
    .poll(() => plan(laptop), { timeout: 10000 })
    .toMatchObject({ offer: { page: 44, ownDevice: false } });

  await go(laptop, `#/reader/${SERIES_UUID}/${VOL}`);
  const offer = laptop.getByTestId('position-offer');
  await expect(offer).toBeVisible({ timeout: 20000 });
  await expect(offer).toContainText('You also read to page 44 on Pixel 8');
});
```

- [ ] **Step 2: Run it.**
  - Command: `E2E_PORT=5199 E2E_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome npx playwright test e2e/devices.spec.ts`
  - Expected: **3 passed**. This task lands after Tasks 1–6, so it has no red phase: the spec is the end-to-end check of behaviour those tasks already built.
  - A failure points at the task that owns the failing step:
    - Banner: Task 5.
    - Card rows and inline rename: Tasks 3 and 5.
    - Class, merge and unmerge on `#/cloud`: Task 4.
    - Labels reaching the other context: Task 2 (parse, merge, fold).
    - Offer wording: Task 6.
  - Fix it in that task's code, never by loosening this spec. If one test fails, re-run it alone (`-g "<title>"`) with the machine idle before blaming a branch (night-mode load-flake lesson). Read the whole report, not the tail.

- [ ] **Step 3: Regression run of the neighbouring history specs.**
  - Command: `E2E_PORT=5199 E2E_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome npx playwright test e2e/position-offer.spec.ts e2e/history-sync.spec.ts e2e/reading-stats.spec.ts e2e/long-pauses.spec.ts`
  - Expected: all pass, zero failures.
  - `position-offer.spec.ts:281` currently expects `on another device`. After Task 6 the phone there has known facts, so it gets a generated label. If Task 6 did not update that line, this run fails there. The fix belongs in Task 6's spec edit: `await expect(banner).toContainText(/You also read to page 44 on Desktop · /);`.

- [ ] **Step 4: Spec as-built note.** In `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md`, replace:

```
   banner on the stats view, "You read on 2 devices — name this one?". Never a first-run modal. A
   single-device user never sees a device anywhere.

### Events
```

with:

```
   banner on the stats view, "You read on 2 devices — name this one?". Never a first-run modal. A
   single-device user never sees a device anywhere.

**As built (phase 4, `devices.ts` / `tracking-data.ts` / `DevicesSettings.svelte` /
`DeviceStatsCard.svelte` / `SecondDeviceBanner.svelte`).** Deviations from the design above:

- The label entry is `tracking.devices[<id>]` = `{name?, class?, merged_into?, lastUpdated}` —
  `lastUpdated`, not `updated_at`, like every other `tracking` key (the bogus-stamp check reads that
  name). One stamp per entry, newest wins, a tie keeps local; a future stamp is clamped and forfeits as in
  `series`, detected per id (`devices/<id>` in the tracking section's one bogus set), and the multi-copy
  fold filters per id. The entry is replaced whole, so a cleared name or an unmerge wins by its stamp; a
  rename and a merge of the same device on two devices between syncs keep only the newer. Labels never
  touch `device.json` or the history database.
- A device is any id with a facts row or a native event; `legacy:` ids are never devices. Generated
  labels still equal after the month get " 2", " 3", … by first-seen, then id; the month is UTC so
  every device shows the same suffix. Collisions are counted over every known id, merged ones included,
  so a device keeps one label everywhere. A device with events but no facts is "Unknown device", its
  first-seen taken from its earliest event.
- `merged_into` applies only where reading is grouped by device (the per-device rows and the device
  lists), followed with a cycle guard: two devices merged into each other between syncs both show
  unmerged. Events are never re-keyed, so volume, series and total figures, long-pause answers and
  position offers keep raw ids and do not move on a merge. Merging does not carry the source's name; the
  group shows the target's.
- Entry point 1 is a "Devices" block on the cloud screen (`#/cloud`); the app has no "Settings → Sync".
  It shows once two device ids are known, so an unmerge stays reachable after everything is merged.
  Entry points 2 and 3 show once two device groups hold native reading. "Not now" on the banner is per
  browser (`localStorage`); naming this device ends it too.
- Per device: time, characters read, share of time, last read (its newest event — another device's
  `last_seen` is stale by design, the upload signature leaves it out) and speed once ≥ 30 min of samples.
  "Before history" holds converted legacy views plus the unexplained pre-history snapshot, so the rows
  sum to the page's totals; volume-editor `adjust`s are their own "Edits" row, not the editing
  device's. Both are hidden at zero and cannot be renamed. Per-class and per-layout totals are not built.
- The position offer names the device the reading comes from ("on Pixel 8", the generated label when
  unnamed); a device this one knows nothing about keeps "on another device".

### Events
```

- [ ] **Step 5: CLAUDE.md, the sync table row.** Replace:

```
| Pre-history reading snapshot (`legacyStats`)                       | `volume-data.json` (volume uuid keys)     | later `before` wins                    |
```

with:

```
| Pre-history reading snapshot (`legacyStats`)                       | `volume-data.json` (volume uuid keys)     | later `before` wins                    |
| Device names, class corrections, merges                            | `volume-data.json` → `tracking.devices`   | `lastUpdated` per device id            |
```

- [ ] **Step 6: CLAUDE.md, the Devices block.** Replace:

```
- `positionPlanFor` is memoised per volume on its events version
  (`volumeEventsVersion`) and progress — the chip mounts once per card.

**Cloud (phase 2a).**
```

with:

```
- `positionPlanFor` is memoised per volume on its events version
  (`volumeEventsVersion`) and progress — the chip mounts once per card.

**Devices (phase 4).** A device is a raw id with a facts row (`devices`, from
its `device.json`) or a native event; `legacy:` ids are never devices
(`isDeviceId`, `paths.ts`). What the user chooses about a device lives ONLY in
`volume-data.json` → `tracking.devices[<id>]` (`DeviceLabel {name?, class?,
merged_into?, lastUpdated}`, `tracking-data.ts`) — never in `device.json`,
`pickFacts` or the history DB. Rules that must hold:

- One stamp per entry, newest `lastUpdated` wins, a tie keeps local, with the
  clamp + forfeit-on-bogus of the other `tracking` keys (bogus ids are
  `devices/<id>` in the one bogus set). The entry is replaced whole, so a
  cleared name or an unmerge wins by its stamp. The multi-copy fold filters per
  device id (`foldableTracking`): a bogus copy must never wipe other devices'
  labels.
- Labels (`devices.ts`, pure): a user name verbatim, else `<Class> · <OS> ·
<browser>` (`generatedLabel`). Generated labels that collide over ALL known
  raw ids (merged ones too) get ` (since Mar 2026)` from first-seen (UTC month,
  so every device agrees), then ` 2`, ` 3` by first-seen and id. "This device"
  is a badge on the group holding `resolveDevice(own)`, never in the label. The
  UUID is never shown.
- `merged_into` applies ONLY where reading is grouped by device: `resolveDevice`
  follows it with a visited set, and a cycle leaves every member unmerged.
  Events are never re-keyed — volume/series/total figures, resolve targets and
  `planPosition` use raw ids, so a merge or unmerge never recounts. Merging does
  not carry the source's name.
- Never show another device's `facts.last_seen`: `exportOwnFacts` leaves it out
  of the upload signature, so it is stale by design. "Last read" is the group's
  newest event.
- Per-device stats come from the engine's `byDevice` (raw id; every `legacy:`
  view under one key; characters to the first crediting view's device),
  grouped by `resolveDevice` in `deviceStats` — a label change regroups, never
  recounts. "Before history" = legacy views + the pre-history baseline, so rows
  sum to the page's totals; volume-editor `adjust`s are an "Edits" row. Both
  hidden at zero, neither renamable. Speed shows only with ≥ 30 min of samples.
- One edit component (`DeviceNameField.svelte`), three entry points: the
  "Devices" block on `#/cloud` (`DevicesSettings.svelte`, once ≥ 2 raw ids are
  known, so an unmerge stays reachable), inline rename in the reading-speed
  page's per-device card (`DeviceStatsCard.svelte`, ≥ 2 groups with native
  events) and `SecondDeviceBanner.svelte` under that page's heading (same rule,
  this device unnamed, `localStorage` `device-banner:dismissed` unset — per
  browser). A single-device user sees none of them.
- The position offer names the offering device by its label ("on Pixel 8");
  a device this one knows nothing about keeps "on another device".
- `e2e/devices.spec.ts` drives all of it: two browser contexts plus a third
  device planted on the WebDAV stub (`device.json` + an encoded month).

**Cloud (phase 2a).**
```

- [ ] **Step 7: Format and lint.**
  - Commands: `npx prettier --write e2e/devices.spec.ts CLAUDE.md docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md && npx prettier --check e2e/devices.spec.ts CLAUDE.md docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md && npx eslint e2e/devices.spec.ts`
  - Expected: "All matched files use Prettier code style!" and no ESLint output.
  - If prettier rewrapped anything, re-run Step 2's command. Expected: 3 passed.

- [ ] **Step 8: Commit.** Explicit paths only, no `git add -A`, no stash.

```bash
git add e2e/devices.spec.ts
git commit -m "test(e2e): device views — naming banner, inline rename, class, merge/unmerge, named offer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add CLAUDE.md docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md
git commit -m "docs(history): phase 4 device views as built — labels in tracking.devices, deviations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Notes for the plan author

- **The DOM contract has to go into Tasks 4–6 verbatim.** Only `device-banner`, `device-stats` and the banner text come from the design. These are proposed here:
  - testids `device-stats-row`, `devices-settings`, `device-row`
  - `aria-label`s "Device name", "Device type", "Merge into"
  - button names `Not now`, `Merge into…`, `Merge`, `Unmerge`
  - the class option labels `Automatic (detected: X)` / `Phone` / `Tablet` / `Laptop` / `Desktop`
  - each `device-row` shows its label as visible text, not only as the input placeholder
  - the stats card's label is a `<button>` named by the label
  - merged devices are not shown as label buttons inside the target's stats row

  If those tasks pick other names, change the spec to match rather than the reverse.

- **Merge UI reading.** The design says "'Merge into…' (`Select` of other groups) inside a confirm `Modal size="xs"`". I read that as a row button that opens the modal, with the Select inside it. If Task 4 instead puts the Select in the row and opens the modal on change, the merge steps in the three-device test need rewriting.
- **Task 6 breaks an existing spec.** Under Q5 an unnamed phone with known facts gets a generated label, so `e2e/position-offer.spec.ts:281` (`'… on another device'`) fails unless Task 6 changes it. Step 3 catches it, but the edit belongs in Task 6's steps.
- **Store names assumed from Tasks 2–3.**
  - `devices` is exported from `src/lib/reading-history/devices.ts` as `Readable<Map<string, DeviceView>>` keyed by raw id. It is used by `deviceIds()` for the positive "exactly this device" check before the absence asserts.
  - `deviceLabels` is exported from `src/lib/settings/tracking-data.ts`.
  - The design leaves `deviceStats`'s file open (`stats-store.ts` or `device-stats.ts`). The CLAUDE.md block names it without a path on purpose; add the path once Task 3 settles it.
- **Labels are generated from real detection.** Both real contexts are headless Chromium on a desktop-class machine, so detection gives class `desktop`. The asserts only rely on the `Desktop · ` prefix and `(since `. They never assert the OS/browser part, because Playwright's Chromium reports its brand as "Chromium" or "Chrome" depending on the build.
- **Twin labels and the ordinal suffix.** The two real contexts collide on label and first-seen month, so they need the ordinal fallback. The spec only asserts that the two labels differ and that both carry the month suffix. Whether the first twin gets " 1" or nothing is left to Task 1.
- **"Before history" and "Edits" stay hidden here.** They are hidden because baselines freeze at app start: `baselinesFrozen` is set, so records created later by `updateProgress` get no snapshot, and the volume editor is never used. If Task 3 shows a zero "Before history" row, the `toHaveCount(3)` / `(2)` asserts catch it.
- **Phone reload and the provider.** After `phone.reload()` the spec does not sync the phone again, because restoring the WebDAV provider after a reload is not shown by any existing spec. Every check after that runs on the laptop.
- **"Label in banner"** in the orchestrator's brief is covered both ways: the second-device banner asks to name this device, and the position-offer banner shows the label (Q5).
- **Commit prefixes.** The brief asked for `feat(history): …`. I used the repo's convention for this kind of change instead: `test(e2e): …` for the spec (as in f8bf7a67) and `docs(history): …` for the docs (as in ded5acff). Change them if the plan standardises on `feat`.
- **Spec doc.** Line 4 still says "design, not implemented". Earlier phases left it alone, so this task does too.

---
