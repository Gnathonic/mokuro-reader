# B&W (Grayscale) Filter — Design

**Issue:** [#221 — \[Feature\] B&W filter](https://github.com/Gnathonic/mokuro-reader/issues/221)
**Date:** 2026-06-06
**Branch:** `feat/bw-filter` (based on `develop`)

## Problem

Readers want to apply a black-and-white (grayscale) filter to pages. Use cases
from the issue:

- A scan is "mostly" grayscale but not pure grayscale, and the color tint is
  distracting.
- A colored scan is higher quality than the available B&W scan, but the reader
  prefers to read in black and white.

The reader already has a **night mode** filter and an **invert colors** filter,
each with a Manual/Scheduled control and (for invert) a hotkey. B&W should fit
in as a third member of that family.

## Goals

1. Add a B&W (grayscale) filter that mirrors the existing invert filter exactly:
   Manual toggle **and** time-based Scheduled mode, an "(active)" indicator, and
   a keyboard shortcut.
2. Refactor the duplicated settings control so night mode, invert colors, and
   B&W all share **one reusable component** instead of three hand-written copies.
3. Centralize the manga-panel CSS filter string so it lives in one place rather
   than being duplicated across the three reader components.

## Non-Goals

- Changing how **night mode** is _applied_. Night mode uses a separate global
  mechanism (`NightModeFilter.svelte`, the `<dialog>` filter trick). Only its
  _settings card_ is unified with invert/B&W; its application is untouched.
- Adjustable filter intensity (e.g. partial grayscale). The filter is on/off,
  matching invert.
- Per-volume B&W overrides beyond what the existing profile/volume settings
  system already provides for every setting.

## Approach

Chosen: **reusable card component + centralized filter store + DRY'd hotkey
handler.** This adds the feature and removes the duplication in the same change,
which is cleaner than copy-pasting a third filter card/handler/filter-string.

### 1. New setting (`src/lib/settings/settings.ts`)

Mirror `invertColors` / `invertColorsSchedule`:

- Add to the `Settings` type:
  - `grayscale: boolean`
  - `grayscaleSchedule: TimeSchedule`
- Add to `defaultSettings`:
  - `grayscale: false`
  - `grayscaleSchedule: { enabled: false, startTime: '21:00', endTime: '06:00' }`
- Add `'grayscaleSchedule'` to the `ScheduleSettingKey` union.
- Add a migration block mirroring the `invertColorsSchedule` one so existing
  profiles get the new schedule object:
  ```ts
  migratedProfile.grayscaleSchedule = {
    ...defaultSettings.grayscaleSchedule,
    ...(profile.grayscaleSchedule || {})
  };
  ```
- Add a derived store mirroring `invertColorsActive`:
  ```ts
  export const grayscaleActive = derived([settings, currentMinute], ([$settings, _]) => {
    if (!$settings) return false;
    if ($settings.grayscaleSchedule?.enabled) {
      return isWithinSchedule($settings.grayscaleSchedule);
    }
    return $settings.grayscale ?? false;
  });
  ```

### 2. New reusable component — `src/lib/components/Settings/Reader/ScheduledFilterCard.svelte`

Encapsulates the bordered card currently duplicated for night mode and invert:
title + "(active)" badge, Manual/Scheduled radio pair (with hotkey hint on the
Manual label), and either the enable toggle (manual) or the Start/End time
pickers (scheduled).

Props:

| Prop          | Type                 | Example                  |
| ------------- | -------------------- | ------------------------ |
| `title`       | `string`             | `'Black & white'`        |
| `enableLabel` | `string`             | `'Enable black & white'` |
| `hotkeyHint`  | `string`             | `'G'`                    |
| `settingKey`  | `SettingsKey`        | `'grayscale'`            |
| `scheduleKey` | `ScheduleSettingKey` | `'grayscaleSchedule'`    |
| `active`      | `boolean`            | `$grayscaleActive`       |

Internally it owns the `mode` derivation (`$settings[scheduleKey].enabled ?
'scheduled' : 'manual'`) and the `setMode` logic that currently lives in
`ReaderToggles.svelte` (switching to scheduled turns off the manual boolean).
The radio-group `name` is derived from `scheduleKey` so the three card instances
remain independent.

### 3. `src/lib/components/Settings/Reader/ReaderToggles.svelte`

Replace the two hand-written cards (night, invert) with **three**
`<ScheduledFilterCard>` instances:

- Night mode — `settingKey="nightMode"`, `scheduleKey="nightModeSchedule"`,
  `hotkeyHint="N"`, `active={$nightModeActive}`
- Invert colors — `settingKey="invertColors"`,
  `scheduleKey="invertColorsSchedule"`, `hotkeyHint="I"`,
  `active={$invertColorsActive}`
- Black & white — `settingKey="grayscale"`,
  `scheduleKey="grayscaleSchedule"`, `hotkeyHint="G"`, `active={$grayscaleActive}`

Removes the now-unused `nightModeMode`, `invertMode`, `setNightModeMode`, and
`setInvertMode` locals (moved into the component).

### 4. Centralized filter store (`settings.ts` + 3 readers)

Add a derived store combining the manga-panel filters:

```ts
export const imageFilter = derived(
  [invertColorsActive, grayscaleActive],
  ([$inv, $gray]) => `invert(${$inv ? 1 : 0}) grayscale(${$gray ? 1 : 0})`
);
```

`invert()` and `grayscale()` commute (grayscale is linear, invert is `1 − x`),
so combining them in one string is correct regardless of order.

Replace the three inline usages of
`style:filter={`invert(${$invertColorsActive ? 1 : 0})`}` with
`style:filter={$imageFilter}` in:

- `src/lib/components/Reader/Reader.svelte`
- `src/lib/components/Reader/HorizontalScrollReader.svelte`
- `src/lib/components/Reader/VerticalScrollReader.svelte`

### 5. Hotkey (`src/lib/components/Reader/Reader.svelte`)

The `KeyN` and `KeyI` handlers share an identical shape: if the schedule is
enabled, show an "on automatic schedule" notification; otherwise toggle the
manual boolean and show an On/Off notification. Extract a helper:

```ts
function toggleScheduledFilter(
  settingKey: 'nightMode' | 'invertColors' | 'grayscale',
  scheduleKey: ScheduleSettingKey,
  label: string,      // e.g. 'Black & white', 'Invert', 'Night mode'
  notifPrefix: string // e.g. 'grayscale'
) { ... }
```

Route `KeyN`, `KeyI`, and the new **`KeyG`** through it. Keeps the three
behaviors identical and adds B&W with one line.

Hotkey choice: **G** (grayscale). `B` was the alternative; `G` chosen.

## Testing

No tests currently cover `invertColorsActive` / `nightModeActive`. Add Vitest
unit tests (TDD) for the new logic:

- `grayscaleActive`: returns the manual boolean when the schedule is disabled;
  returns the schedule result when enabled.
- `imageFilter`: produces the correct combined string for each of the four
  invert/grayscale on/off combinations.

Manual verification:

- Toggle B&W via the settings card and via the **G** hotkey; both reflect each
  other and show the correct notification.
- Filter applies in all three reader modes (paged, horizontal scroll, vertical
  scroll).
- B&W combines correctly with invert (both on = inverted grayscale).
- Scheduled mode activates/deactivates by time, and the "G" hotkey shows the
  "on automatic schedule" notice when scheduled.
- Setting persists across reload and is included in profile export/sync like
  other settings.

## Files Touched

- `src/lib/settings/settings.ts` — type, defaults, `ScheduleSettingKey`,
  migration, `grayscaleActive`, `imageFilter`
- `src/lib/components/Settings/Reader/ScheduledFilterCard.svelte` — **new**
- `src/lib/components/Settings/Reader/ReaderToggles.svelte` — use the component ×3
- `src/lib/components/Reader/Reader.svelte` — hotkey helper + `KeyG` + `imageFilter`
- `src/lib/components/Reader/HorizontalScrollReader.svelte` — `imageFilter`
- `src/lib/components/Reader/VerticalScrollReader.svelte` — `imageFilter`
- Test file(s) for `grayscaleActive` / `imageFilter`
