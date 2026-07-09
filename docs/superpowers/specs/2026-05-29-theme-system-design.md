# Theme System — Design

**Date:** 2026-05-29
**Branch:** `feat/theme-system`
**Supersedes:** PR #86 ("Add light mode" by @oscarwong67) — same intent (light mode for e-ink), rewritten for the post-1.0.0 codebase (Svelte 5 runes, Tailwind v4, Flowbite-Svelte v1).

## Motivation

Dark mode renders poorly on e-ink panels (low refresh, poor grayscale separation — white-on-black ghosts). Users want a light, high-contrast mode. Rather than a bare dark/light toggle, we add a small **theme system**: a handful of presets (including a high-contrast e-ink theme and a softer standard light theme) plus a **Custom** mode, all driven by a deliberately small set of color tokens.

Design goal stated by the maintainer: _"simplify the overall color scheme so there's only a handful of things to adjust."_

## Key Mechanism (why this is cheap)

Tailwind v4 compiles every color utility to a CSS variable:

```
bg-gray-950  →  background-color: var(--color-gray-950)
text-white   →  color: var(--color-white)
```

The app uses `dark:`-variant Tailwind classes across ~41 files, and Flowbite-Svelte components do the same internally. **All of them already read their colors from a shared set of CSS variables.** Therefore a theme does not require editing those files — it redefines the variables in a scope, and every surface (app chrome + Flowbite components) follows.

The dark/light split is the existing `.dark` class on `<html>` (see `src/app.html`, `@custom-variant dark` in `src/app.css`). The light scaffolding already exists (e.g. body is `bg-white dark:bg-gray-950`); it is simply locked on today because `.dark` is hardcoded.

## Theme Model

A theme is:

```ts
type ThemeBase = 'light' | 'dark';

type ThemeTokens = {
  background: string; // app canvas / page; ALSO the reader viewport background
  surface: string; // cards, drawers, navbar, modals
  text: string; // primary text
  muted: string; // secondary text, hints, disabled
  border: string; // dividers, outlines
  accent: string; // primary buttons, links, highlights
};

type Theme = {
  id: string;
  name: string;
  base: ThemeBase;
  tokens: ThemeTokens;
};
```

- **`base`** decides which `dark:` utilities + Flowbite states apply, and sets icon/scrollbar contrast. It toggles `.dark` on `<html>`.
- **`tokens`** are the six semantic colors. They are applied by remapping the underlying Tailwind ramp under a scope (see "Application").

Six tokens + base is the entire surface area the user can adjust. This is the "handful."

### Token → ramp mapping

Presets are authored as concrete CSS-variable overrides (hand-tuned for polish). The six semantic tokens map onto the Tailwind ramp roughly as:

**Light base:**

- `--color-white` ← surface
- `--color-gray-50`, `--color-gray-100` ← background / subtle surface tints (derived)
- `--color-gray-900`, `--color-gray-950` ← text
- `--color-gray-400`/`500`/`600` ← muted (derived ramp)
- `--color-gray-200`/`300`/`700` ← border (derived)

**Dark base:**

- `--color-gray-950`, `--color-gray-900` ← background
- `--color-gray-800`, `--color-gray-700` ← surface
- `--color-white`, `--color-gray-100` ← text
- `--color-gray-400`/`500` ← muted
- `--color-gray-600`/`700` ← border

Accent maps to `--color-primary-500/600/700` (and the Flowbite `--color-brand`).

For **presets**, the exact per-variable values are tuned by hand (a preset may set more ramp stops than the six tokens imply). For **Custom**, the six user-chosen colors are expanded to the ramp by a deterministic derivation helper (lighten/darken steps), so custom themes are functional even if less hand-polished than presets.

> Implementation note: the precise ramp-derivation function and the exact stop values for each preset are an implementation detail to be finalized during the plan/build, validated visually against real screens. The contract this design fixes is: _six tokens + base, applied by scoping CSS-variable overrides._

## Presets

| id       | name   | base        | character                                                                                                      |
| -------- | ------ | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `dark`   | Dark   | dark        | Current look. **Default.** Zero behavior change for existing users.                                            |
| `eink`   | E-ink  | light       | Pure/near-pure white bg, near-black text, crisp borders, **no shadows**. High contrast for low-refresh panels. |
| `paper`  | Paper  | light       | Softer standard light UI (gray-50 surfaces, normal borders/shadows).                                           |
| `sepia`  | Sepia  | light       | Warm paper tones (e.g. `#f4ecd8` bg, dark-brown text). Easy reading.                                           |
| `nord`   | Nord   | dark        | Popular cool-blue dark pastel.                                                                                 |
| `custom` | Custom | user-chosen | Six editable swatches + base toggle.                                                                           |

The preset list is intentionally short. It can be extended later by adding entries to the preset table — no structural change required.

## Storage & State

Theme is stored **per-profile** in the `Settings` type (`src/lib/settings/settings.ts`), so a user's chosen theme and custom palette are **saved with their profile and travel between devices via profile sync**. This aligns with PR #86's placement, and keeps theme in the same object as the reader `backgroundColor` it migrates (same-scope migration).

```ts
// src/lib/settings/settings.ts — Settings additions
theme: string; // preset id, default 'dark'
customTheme: ThemeTokens & { base: ThemeBase }; // edited by Custom mode
```

Defaults (in `defaultSettings`): `theme: 'dark'`, `customTheme` seeded from the E-ink preset (a neutral starting point for editing). These flow through the existing three-tier resolution (global default → profile → volume) and through profile import/export + cloud sync automatically, since they are ordinary `Settings` fields. Theme is resolved from the active profile's settings; switching profiles switches theme.

A derived store (off `currentSettings`) resolves the active `Theme`: if `theme === 'custom'`, build from `customTheme`; else look up the preset table.

## Application

A small reactive controller component, modeled on the existing `NightModeFilter.svelte`:

- `src/lib/components/ThemeController.svelte` (mounted once in `+layout.svelte`).
- Subscribes to the active theme. On change it:
  1. toggles `.dark` on `document.documentElement` per `base`;
  2. writes the resolved ramp variables onto `document.documentElement.style` (or a `<style data-theme>` block).
- Replaces the ad-hoc `onMount`/`classList` block that PR #86 added to `+layout.svelte`.

The root container in `+layout.svelte` keeps `text-black dark:text-white` style scaffolding (already partly present) so non-themed fallbacks are correct.

## Reader Viewport Background (migration)

Today the manga reading area uses a per-profile `Settings.backgroundColor` (default `#030712`, ~`gray-950`). This is **migrated into the theme system**:

- The reader viewport background follows the theme's **`background`** token (so E-ink → white, Sepia → warm, Dark → near-black as today).
- Reader components currently binding `style:background-color={$settings.backgroundColor}` (`HorizontalScrollReader.svelte`, `VerticalScrollReader.svelte`, `Reader.svelte`) switch to the theme background variable.
- **Migration of existing data:** on load, if a profile's `backgroundColor` is **non-default** (user deliberately changed it), seed `customTheme.background` with that value and set `theme = 'custom'` so the user keeps their look. If it equals the default, do nothing (they get `dark`). The `backgroundColor` field is retained in the type for sync/back-compat but no longer surfaced as a standalone control.

## Settings UI

New **Appearance** accordion section in `src/lib/components/Settings/Settings.svelte`:

- `src/lib/components/Settings/AppearanceSettings.svelte` — preset picker (visual swatches/radio list) + Custom editor.
- Custom editor: six color inputs (Background, Surface, Text, Muted, Border, Accent) + a light/dark base toggle. Live preview via the reactive controller.
- Follows the modal button z-index rule from CLAUDE.md where applicable.

## Orthogonal Effects (unchanged)

The existing **night-mode grayscale filter** (`NightModeFilter.svelte`, SVG filter in `app.html`) and **invert colors** are reader-time effects that compose **on top** of the theme. They are not touched by this work. A user can run E-ink theme without night mode, or Dark theme with night mode, etc.

## Out of Scope (YAGNI)

- System/`prefers-color-scheme` auto mode (e-ink browsers report it unreliably; can add later as another preset-like option).
- Per-volume theme overrides.
- Importing/exporting custom themes.
- Theming the manga page images themselves (that is what invert/night-mode already do).

## Testing

- Unit: active-theme derived store (preset lookup + custom build), ramp-derivation helper (monotonic light→dark stops), migration of `backgroundColor`.
- Manual: each preset across catalog, reader, settings drawer, modals — **with night mode ON** (per CLAUDE.md, to catch stacking-context/filter issues) and with the Migaku extension if available.
- Visual: confirm Flowbite components (buttons, toggles, accordions, drawers, range sliders, radios) re-color correctly under each base.

## Files (anticipated)

- `src/lib/settings/settings.ts` — `theme`, `customTheme` in `Settings`, `defaultSettings`, profile migration hook (alongside the existing `migrateProfile` logic that already touches `backgroundColor`/`nightModeSchedule`).
- `src/lib/settings/theme.ts` (new) — `Theme`/`ThemeTokens` types, preset table, active-theme derived store, ramp-derivation helper.
- `src/lib/components/ThemeController.svelte` (new) — applies base class + variables.
- `src/lib/components/Settings/AppearanceSettings.svelte` (new) — UI.
- `src/lib/components/Settings/Settings.svelte` — mount Appearance section.
- `src/routes/+layout.svelte` — mount `ThemeController`, drop PR-style onMount block.
- `src/lib/components/Reader/{HorizontalScrollReader,VerticalScrollReader,Reader}.svelte` — reader bg → theme background.
- `src/app.css` — any base-layer variable scaffolding needed for the ramp overrides.
- Spot fixes: components with hardcoded `text-white`/colors lacking a light counterpart (audit during build; e.g. `CatalogListItem.svelte`, `VolumeItem.svelte` per PR #86).
