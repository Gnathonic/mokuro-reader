# Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-profile theme system (presets: Dark/E-ink/Paper/Sepia/Nord + Custom) that re-colors the whole app — including Flowbite components and the reader viewport — by overriding Tailwind v4 CSS color variables, replacing the bare light/dark idea from PR #86.

**Architecture:** A theme is `{ base: 'light' | 'dark', tokens: 6 colors }`. `base` toggles the `.dark` class on `<html>` (drives all existing `dark:` utilities + Flowbite). `tokens` are expanded by a pure `deriveVars()` helper into a map of Tailwind CSS variables (`--color-gray-*`, `--color-white`, `--color-primary-*`, plus `--app-bg`) which a reactive `ThemeController` writes onto `document.documentElement.style`. Themes live in the per-profile `Settings` object so they sync across devices via the existing profile sync; the legacy reader `backgroundColor` is migrated into the theme.

**Tech Stack:** SvelteKit 5 (runes + legacy `$:` for the controller, matching `NightModeFilter.svelte`), Tailwind CSS v4 (CSS-variable theme), Flowbite-Svelte v1, Dexie, Vitest.

---

## Background: why variable overrides work

Tailwind v4 compiles `bg-gray-950` → `background-color: var(--color-gray-950)` and emits the variable defaults to `:root` (see `@theme` in `src/app.css`). Setting `--color-gray-950` as an **inline style on `<html>`** (which is `:root`) overrides the `:root` rule and cascades to every descendant — including Flowbite components. So a theme = a set of inline CSS-variable overrides + the `.dark` class. No need to touch the ~41 files that use `dark:` utilities.

**Canvas vs surface:** The page canvas background is driven by a dedicated `--app-bg` variable (set on `body` via `src/app.css`), NOT by the gray ramp — this avoids fighting the surface/background ordering. Cards/drawers/navbar that use `bg-white` follow `--color-white` (remapped to the theme's `surface` in light themes; in dark themes those elements use their `dark:bg-gray-*` pair instead).

## File Structure

- **Create** `src/lib/settings/color.ts` — pure hex color helpers (`mix`, `shade`, `parseHex`, `toHex`). One responsibility: color math.
- **Create** `src/lib/settings/color.test.ts` — unit tests for color math.
- **Create** `src/lib/settings/theme.ts` — `ThemeBase`/`ThemeTokens`/`ThemePreset`/`ResolvedTheme` types, `PRESETS` table, `deriveVars()`, `resolveTheme()`, `DEFAULT_CUSTOM_THEME`. **Pure leaf module** (imports only `./color`); the `activeTheme` store lives in `settings.ts` to avoid a circular import. One responsibility: theme model + resolution.
- **Create** `src/lib/settings/theme.test.ts` — unit tests for `deriveVars`/`resolveTheme`.
- **Create** `src/lib/components/ThemeController.svelte` — applies base class + variables reactively (sibling to `NightModeFilter.svelte`).
- **Create** `src/lib/components/Settings/AppearanceSettings.svelte` — preset picker + custom editor UI.
- **Modify** `src/lib/settings/settings.ts` — add `theme`/`customTheme` to `Settings` + `defaultSettings`; migrate in `migrateProfiles`; export theme module.
- **Modify** `src/lib/settings/settings.test.ts` (create if absent) — migration tests.
- **Modify** `src/routes/+layout.svelte` — mount `<ThemeController />`; canvas text color.
- **Modify** `src/app.html` — body uses `--app-bg`; e-ink shadow suppression already via `src/app.css`.
- **Modify** `src/app.css` — `body { background-color: var(--app-bg) }`, `:root` default, `[data-theme='eink']` shadow rule.
- **Modify** `src/lib/components/Reader/{Reader,VerticalScrollReader,HorizontalScrollReader}.svelte` — reader bg uses `var(--app-bg)`.
- **Modify** `src/lib/components/Settings/Settings.svelte` — mount `<AppearanceSettings />`.
- **Modify** `src/lib/components/Settings/Reader/ReaderSelects.svelte` — remove the now-migrated background-color control.
- **Spot fixes** — components with hardcoded light-on-dark colors lacking a light counterpart (audit task).

---

## Task 1: Color math helpers

**Files:**

- Create: `src/lib/settings/color.ts`
- Test: `src/lib/settings/color.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/settings/color.test.ts
import { describe, expect, it } from 'vitest';
import { parseHex, toHex, mix, shade } from './color';

describe('parseHex', () => {
  it('parses 6-digit hex', () => {
    expect(parseHex('#ff8000')).toEqual([255, 128, 0]);
  });
  it('parses 3-digit shorthand', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
  });
});

describe('toHex', () => {
  it('formats rgb to lowercase 6-digit hex', () => {
    expect(toHex([255, 128, 0])).toBe('#ff8000');
  });
  it('clamps and rounds channels', () => {
    expect(toHex([-5, 127.5, 300])).toBe('#0080ff');
  });
});

describe('mix', () => {
  it('returns a at t=0 and b at t=1', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
  });
  it('blends at the midpoint', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

describe('shade', () => {
  it('darkens with a negative amount', () => {
    expect(shade('#808080', -0.5)).toBe('#404040');
  });
  it('lightens with a positive amount', () => {
    expect(shade('#808080', 0.5)).toBe('#c0c0c0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/settings/color.test.ts`
Expected: FAIL — `Cannot find module './color'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/settings/color.ts

export type RGB = [number, number, number];

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function parseHex(hex: string): RGB {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const num = parseInt(h, 16);
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

export function toHex(rgb: RGB): string {
  return '#' + rgb.map((c) => clampChannel(c).toString(16).padStart(2, '0')).join('');
}

/** Linear blend: t=0 returns a, t=1 returns b. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex([0, 1, 2].map((i) => ca[i] + (cb[i] - ca[i]) * t) as unknown as RGB);
}

/** Lighten (amount > 0) toward white or darken (amount < 0) toward black. */
export function shade(hex: string, amount: number): string {
  return amount >= 0 ? mix(hex, '#ffffff', amount) : mix(hex, '#000000', -amount);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/settings/color.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/color.ts src/lib/settings/color.test.ts
git commit -m "feat(theme): add hex color math helpers"
```

---

## Task 2: Theme model, presets, and resolution

**Files:**

- Create: `src/lib/settings/theme.ts`
- Test: `src/lib/settings/theme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/settings/theme.test.ts
import { describe, expect, it } from 'vitest';
import { PRESETS, deriveVars, resolveTheme, type ThemeTokens } from './theme';

const TOKENS: ThemeTokens = {
  background: '#ffffff',
  surface: '#ffffff',
  text: '#000000',
  muted: '#666666',
  border: '#cccccc',
  accent: '#2563eb'
};

describe('deriveVars (light base)', () => {
  const vars = deriveVars(TOKENS, 'light');
  it('maps the app canvas to the background token', () => {
    expect(vars['--app-bg']).toBe('#ffffff');
  });
  it('maps --color-white to the surface token', () => {
    expect(vars['--color-white']).toBe('#ffffff');
  });
  it('drives the reader viewport from the background token', () => {
    expect(vars['--reader-bg']).toBe('#ffffff');
  });
  it('sets the accent onto the primary scale', () => {
    expect(vars['--color-primary-500']).toBe('#2563eb');
    expect(vars['--color-brand']).toBe('#2563eb');
  });
  it('pins the border token to gray-200 in light base', () => {
    expect(vars['--color-gray-200']).toBe('#cccccc');
  });
});

describe('deriveVars (dark base)', () => {
  const vars = deriveVars(
    { ...TOKENS, background: '#111111', surface: '#222222', text: '#eeeeee' },
    'dark'
  );
  it('maps --color-white to the (light) text token so text-white stays readable', () => {
    expect(vars['--color-white']).toBe('#eeeeee');
  });
  it('pins the border token to gray-700 in dark base', () => {
    expect(vars['--color-gray-700']).toBe('#cccccc');
  });
});

describe('PRESETS', () => {
  it('includes the five built-in presets', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['dark', 'eink', 'nord', 'paper', 'sepia']);
  });
  it('keeps Dark a zero-change theme (no ramp overrides, only reader bg)', () => {
    const resolved = resolveTheme(PRESETS.dark);
    expect(resolved.base).toBe('dark');
    expect(resolved.vars['--color-gray-950']).toBeUndefined();
    expect(resolved.vars['--app-bg']).toBe('#030712');
  });
});

describe('resolveTheme (custom)', () => {
  it('derives a full var map from tokens when no explicit vars are given', () => {
    const resolved = resolveTheme({
      id: 'custom',
      name: 'Custom',
      base: 'light',
      tokens: TOKENS
    });
    expect(resolved.id).toBe('custom');
    expect(resolved.vars['--color-white']).toBe('#ffffff');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/settings/theme.test.ts`
Expected: FAIL — `Cannot find module './theme'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/settings/theme.ts
// Pure leaf module: imports only ./color. Do NOT import from ./settings here —
// the active-theme store lives in settings.ts to keep this dependency one-way.
import { mix, shade } from './color';

export type ThemeBase = 'light' | 'dark';

export type ThemeTokens = {
  background: string; // app canvas + reader viewport
  surface: string; // cards, drawers, navbar, modals
  text: string; // primary text
  muted: string; // secondary text
  border: string; // dividers, outlines
  accent: string; // primary buttons, links, highlights
};

export type CustomTheme = ThemeTokens & { base: ThemeBase };

export type ThemePreset = {
  id: string;
  name: string;
  base: ThemeBase;
  tokens: ThemeTokens; // shown as swatches; basis for custom editing
  /** If set, used verbatim instead of deriveVars() — used to keep Dark a zero-change theme. */
  vars?: Record<string, string>;
};

export type ResolvedTheme = {
  id: string;
  base: ThemeBase;
  vars: Record<string, string>;
};

const STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/** Expand the six semantic tokens into Tailwind CSS-variable overrides. */
export function deriveVars(tokens: ThemeTokens, base: ThemeBase): Record<string, string> {
  const isDark = base === 'dark';
  // The gray ramp runs 50 (lightest) -> 950 (darkest).
  const lightEnd = isDark ? tokens.text : tokens.surface;
  const darkEnd = isDark ? tokens.background : tokens.text;

  const vars: Record<string, string> = {};
  STOPS.forEach((stop, i) => {
    vars[`--color-gray-${stop}`] = mix(lightEnd, darkEnd, i / (STOPS.length - 1));
  });

  // text-white / bg-white anchors. In dark themes "white" is the light text color;
  // in light themes it is the light surface color.
  vars['--color-white'] = isDark ? tokens.text : tokens.surface;
  vars['--color-black'] = isDark ? tokens.background : tokens.text;

  // Pin the surface, border and muted tokens onto plausible ramp stops.
  if (isDark) {
    vars['--color-gray-800'] = tokens.surface;
    vars['--color-gray-700'] = tokens.border;
    vars['--color-gray-400'] = tokens.muted;
  } else {
    vars['--color-gray-50'] = tokens.surface;
    vars['--color-gray-200'] = tokens.border;
    vars['--color-gray-500'] = tokens.muted;
  }
  vars['--color-body'] = tokens.muted; // Flowbite form helper color

  // Accent -> primary scale (+ Flowbite --color-brand used by range sliders).
  vars['--color-primary-400'] = shade(tokens.accent, 0.12);
  vars['--color-primary-500'] = tokens.accent;
  vars['--color-primary-600'] = shade(tokens.accent, -0.12);
  vars['--color-primary-700'] = shade(tokens.accent, -0.24);
  vars['--color-brand'] = tokens.accent;

  // App canvas + reader viewport background.
  vars['--app-bg'] = tokens.background;
  vars['--reader-bg'] = tokens.background;

  return vars;
}

export function resolveTheme(preset: ThemePreset): ResolvedTheme {
  return {
    id: preset.id,
    base: preset.base,
    vars: preset.vars ?? deriveVars(preset.tokens, preset.base)
  };
}

export const PRESETS: Record<string, ThemePreset> = {
  dark: {
    id: 'dark',
    name: 'Dark',
    base: 'dark',
    tokens: {
      background: '#030712',
      surface: '#1f2937',
      text: '#ffffff',
      muted: '#9ca3af',
      border: '#374151',
      accent: '#ef562f'
    },
    // Zero-change: keep Tailwind's default ramp + primary, only drive the canvas/reader bg.
    vars: { '--app-bg': '#030712', '--reader-bg': '#030712' }
  },
  eink: {
    id: 'eink',
    name: 'E-ink',
    base: 'light',
    tokens: {
      background: '#ffffff',
      surface: '#ffffff',
      text: '#000000',
      muted: '#3f3f3f',
      border: '#000000',
      accent: '#000000'
    }
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    base: 'light',
    tokens: {
      background: '#f4f4f5',
      surface: '#ffffff',
      text: '#111827',
      muted: '#6b7280',
      border: '#d1d5db',
      accent: '#2563eb'
    }
  },
  sepia: {
    id: 'sepia',
    name: 'Sepia',
    base: 'light',
    tokens: {
      background: '#f4ecd8',
      surface: '#faf6ec',
      text: '#433422',
      muted: '#7a6a52',
      border: '#d8c9a8',
      accent: '#9a6a3a'
    }
  },
  nord: {
    id: 'nord',
    name: 'Nord',
    base: 'dark',
    tokens: {
      background: '#2e3440',
      surface: '#3b4252',
      text: '#d8dee9',
      muted: '#81a1c1',
      border: '#4c566a',
      accent: '#88c0d0'
    }
  }
};

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  base: PRESETS.eink.base,
  ...PRESETS.eink.tokens
};
```

> The `activeTheme` derived store is intentionally **not** defined here — it depends on `settings`, and defining it here would create a `theme ⇄ settings` import cycle. It is added in `settings.ts` in Task 3, where `settings` already exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/settings/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/theme.ts src/lib/settings/theme.test.ts
git commit -m "feat(theme): add theme presets, token derivation, and active-theme store"
```

---

## Task 3: Settings type, defaults, migration, and barrel export

**Files:**

- Modify: `src/lib/settings/settings.ts` (type ~133, defaults ~251, migration ~426, end of file)
- Test: `src/lib/settings/settings.test.ts` (create)

- [ ] **Step 1: Add the type fields**

In `src/lib/settings/settings.ts`, in the `Settings` type, immediately after the `backgroundColor: string;` line (currently line 133), add:

```ts
backgroundColor: string;
theme: string; // preset id ('dark' | 'eink' | 'paper' | 'sepia' | 'nord' | 'custom')
customTheme: import('./theme').CustomTheme; // edited by the Custom theme mode
```

- [ ] **Step 2: Add the defaults**

In `defaultSettings`, immediately after the `backgroundColor: '#030712',` line (currently line 251), add:

```ts
  backgroundColor: '#030712',
  theme: 'dark',
  customTheme: {
    base: 'light',
    background: '#ffffff',
    surface: '#ffffff',
    text: '#000000',
    muted: '#3f3f3f',
    border: '#000000',
    accent: '#000000'
  },
```

> The `customTheme` literal mirrors `DEFAULT_CUSTOM_THEME` (the E-ink preset). It is written inline here (rather than referencing the imported constant) so `defaultSettings` stays a self-contained literal; `theme.ts` is a pure leaf module so either form is safe, but keeping the default literal avoids any import-ordering subtlety in this large module.

- [ ] **Step 3: Add the migration**

In `migrateProfiles`, after the `migratedProfile.catalogSettings = { ... }` block and before the `// Add timestamp if missing` comment (currently ~line 430), add:

```ts
// Theme migration. The `...defaultSettings, ...profile` spread above already
// applies `theme`/`customTheme` defaults or carries existing values forward.
migratedProfile.customTheme = {
  ...defaultSettings.customTheme,
  ...(profile.customTheme || {})
};
// Legacy: a profile predating themes that deliberately changed the reader
// background keeps its look via a seeded Custom theme.
if (
  profile.theme === undefined &&
  typeof profile.backgroundColor === 'string' &&
  profile.backgroundColor !== defaultSettings.backgroundColor
) {
  migratedProfile.theme = 'custom';
  migratedProfile.customTheme = {
    ...migratedProfile.customTheme,
    base: 'dark',
    background: profile.backgroundColor
  };
}
```

- [ ] **Step 4: Import theme helpers and define the active-theme store**

At the top of `src/lib/settings/settings.ts`, add to the imports (after the existing `import { isMobilePlatform } from '$lib/util/platform';` line):

```ts
import { PRESETS, resolveTheme, type ResolvedTheme } from './theme';
```

Then, immediately after the `settings` derived store definition (the block ending at line ~511, just before the `catalogSettings` derived store), add:

```ts
/** Resolve the active profile's theme into applied CSS variables. */
export const activeTheme = derived(settings, ($settings): ResolvedTheme => {
  if (!$settings) return resolveTheme(PRESETS.dark);
  const id = $settings.theme ?? 'dark';
  if (id === 'custom' && $settings.customTheme) {
    const { base, ...tokens } = $settings.customTheme;
    return resolveTheme({ id: 'custom', name: 'Custom', base, tokens });
  }
  return resolveTheme(PRESETS[id] ?? PRESETS.dark);
});
```

(`derived` is already imported at the top of `settings.ts`.)

- [ ] **Step 4b: Re-export the theme module**

At the very end of `src/lib/settings/settings.ts`, add:

```ts
export * from './theme';
```

This re-exports the pure helpers/types (`PRESETS`, `resolveTheme`, `deriveVars`, `ThemeTokens`, …). `activeTheme` is exported above directly from `settings.ts`. The dependency stays one-way: `settings.ts` → `theme.ts`. The barrel `src/lib/settings/index.ts` already does `export * from './settings';`, so `$lib/settings` exposes `activeTheme`, `PRESETS`, etc.

- [ ] **Step 5: Write the migration test**

```ts
// src/lib/settings/settings.test.ts
import { describe, expect, it } from 'vitest';
import { migrateProfiles } from './settings';

describe('theme migration', () => {
  it('defaults a profile with no theme to the Dark preset', () => {
    const out = migrateProfiles({ Test: { backgroundColor: '#030712' } as any });
    expect(out.Test.theme).toBe('dark');
    expect(out.Test.customTheme.base).toBe('light');
  });

  it('preserves an explicit theme choice', () => {
    const out = migrateProfiles({ Test: { theme: 'sepia' } as any });
    expect(out.Test.theme).toBe('sepia');
  });

  it('seeds a custom theme from a non-default legacy backgroundColor', () => {
    const out = migrateProfiles({ Test: { backgroundColor: '#123456' } as any });
    expect(out.Test.theme).toBe('custom');
    expect(out.Test.customTheme.background).toBe('#123456');
    expect(out.Test.customTheme.base).toBe('dark');
  });

  it('merges customTheme over defaults', () => {
    const out = migrateProfiles({
      Test: { theme: 'custom', customTheme: { accent: '#abcdef' } } as any
    });
    expect(out.Test.customTheme.accent).toBe('#abcdef');
    expect(out.Test.customTheme.background).toBeDefined();
  });
});
```

- [ ] **Step 6: Run the test**

Run: `npm test -- src/lib/settings/settings.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check**

Run: `npm run check`
Expected: No new errors referencing `theme`/`customTheme`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/settings/settings.ts src/lib/settings/settings.test.ts
git commit -m "feat(theme): store theme per-profile with backgroundColor migration"
```

---

## Task 4: ThemeController and global CSS wiring

**Files:**

- Create: `src/lib/components/ThemeController.svelte`
- Modify: `src/app.css` (after the `@theme { ... }` block)
- Modify: `src/app.html` (`<body>` class, line 39)
- Modify: `src/routes/+layout.svelte` (import + mount + canvas text color)

- [ ] **Step 1: Create the controller**

```svelte
<!-- src/lib/components/ThemeController.svelte -->
<script lang="ts">
  import { activeTheme } from '$lib/settings';
  import { browser } from '$app/environment';
  import { onDestroy } from 'svelte';

  // Track which custom properties we set last time so we can clear stale ones
  // when switching to a theme that defines fewer variables (e.g. Dark).
  let appliedKeys = new Set<string>();

  function applyTheme(theme: { id: string; base: 'light' | 'dark'; vars: Record<string, string> }) {
    if (!browser) return;
    const root = document.documentElement;

    if (theme.base === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');

    root.dataset.theme = theme.id;

    const nextKeys = new Set(Object.keys(theme.vars));
    // Remove variables from the previous theme that the new one does not set.
    for (const key of appliedKeys) {
      if (!nextKeys.has(key)) root.style.removeProperty(key);
    }
    for (const [key, value] of Object.entries(theme.vars)) {
      root.style.setProperty(key, value);
    }
    appliedKeys = nextKeys;
  }

  // Legacy reactive syntax matches NightModeFilter.svelte (also a controller component).
  $: if (browser) applyTheme($activeTheme);

  onDestroy(() => {
    if (!browser) return;
    const root = document.documentElement;
    for (const key of appliedKeys) root.style.removeProperty(key);
  });
</script>

<!-- No visible output: applies theme variables to <html>. -->
```

- [ ] **Step 2: Wire global CSS**

In `src/app.css`, immediately after the closing `}` of the `@theme { ... }` block, add:

```css
/* Theme system: canvas background + e-ink shadow suppression.
   Default matches the Dark preset so there is no flash before ThemeController mounts. */
:root {
  --app-bg: #030712;
}

body {
  background-color: var(--app-bg);
}

/* E-ink: flat, shadow-free surfaces for low-refresh panels. */
:root[data-theme='eink'] *,
:root[data-theme='eink'] *::before,
:root[data-theme='eink'] *::after {
  box-shadow: none !important;
}
```

- [ ] **Step 3: Point the body background at the variable**

In `src/app.html`, change the `<body>` tag (line 39) from:

```html
<body data-sveltekit-preload-data="hover" class="bg-white dark:bg-gray-950 dark:text-white"></body>
```

to:

```html
<body data-sveltekit-preload-data="hover" class="dark:text-white"></body>
```

(The `bg-white dark:bg-gray-950` classes are removed because `body { background-color: var(--app-bg) }` now owns the canvas color across all themes.)

- [ ] **Step 4: Mount the controller and fix canvas text color**

In `src/routes/+layout.svelte`:

Add the import alongside the other component imports (after the `NightModeFilter` import on line 18):

```ts
import NightModeFilter from '$lib/components/NightModeFilter.svelte';
import ThemeController from '$lib/components/ThemeController.svelte';
```

Change the main content wrapper (line 117) from:

```svelte
  <div class="h-full min-h-[100svh] text-white">
```

to:

```svelte
  <div class="h-full min-h-[100svh] text-gray-900 dark:text-white">
```

Add the controller next to `<NightModeFilter />` (line 123):

```svelte
<NightModeFilter />
<ThemeController />
```

- [ ] **Step 5: Manual verification**

Run: `npm run dev`

- App still loads in Dark (default) with no visible change vs. before.
- In the browser console: `document.documentElement.style.setProperty('--app-bg', '#ffffff'); document.documentElement.classList.remove('dark')` → canvas turns white, text/components switch to light styling. Re-add `dark` and reset to confirm reversibility.

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/ThemeController.svelte src/app.css src/app.html src/routes/+layout.svelte
git commit -m "feat(theme): apply themes via ThemeController and canvas background var"
```

---

## Task 5: Reader viewport follows the theme

**Files:**

- Modify: `src/lib/components/Reader/Reader.svelte:1386`
- Modify: `src/lib/components/Reader/VerticalScrollReader.svelte:573`
- Modify: `src/lib/components/Reader/HorizontalScrollReader.svelte:635`

- [ ] **Step 1: Reader.svelte**

Change line 1386 from:

```svelte
    <div class="flex" style:background-color={$settings.backgroundColor}>
```

to:

```svelte
    <div class="flex" style:background-color="var(--reader-bg)">
```

- [ ] **Step 2: VerticalScrollReader.svelte**

Change line 573 from:

```svelte
style:background-color={$settings.backgroundColor}
```

to:

```svelte
style:background-color="var(--reader-bg)"
```

- [ ] **Step 3: HorizontalScrollReader.svelte**

Change line 635 from:

```svelte
style:background-color={$settings.backgroundColor}
```

to:

```svelte
style:background-color="var(--reader-bg)"
```

- [ ] **Step 4: Verify**

Run: `npm run dev`, open a volume in the reader. Background should still be the dark default. Then (console) set `--reader-bg` to `#ffffff` and confirm the reading area turns white without reloading.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/Reader/Reader.svelte src/lib/components/Reader/VerticalScrollReader.svelte src/lib/components/Reader/HorizontalScrollReader.svelte
git commit -m "feat(theme): drive reader viewport background from theme"
```

---

## Task 6: Remove the migrated background-color control

**Files:**

- Modify: `src/lib/components/Settings/Reader/ReaderSelects.svelte` (fn ~52, control ~95-96)

- [ ] **Step 1: Remove the control markup**

Delete these two lines (currently 95-96):

```svelte
<Label class="text-gray-900 dark:text-white">Background color:</Label>
<Input type="color" onchange={onBackgroundColor} value={$settings.backgroundColor} />
```

- [ ] **Step 2: Remove the now-unused handler**

Delete the function (currently lines 52-54):

```ts
function onBackgroundColor(event: Event) {
  updateSetting('backgroundColor', (event.target as HTMLInputElement).value);
}
```

- [ ] **Step 3: Check for unused imports**

Run: `npm run check`
Expected: No "unused" errors. If `Input` is no longer used elsewhere in the file, remove it from the import; if still used, leave it. (Confirm by grepping `Input` within the file before deleting.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/Settings/Reader/ReaderSelects.svelte
git commit -m "feat(theme): drop standalone reader background-color control (migrated to theme)"
```

---

## Task 7: Appearance settings UI

**Files:**

- Create: `src/lib/components/Settings/AppearanceSettings.svelte`
- Modify: `src/lib/components/Settings/Settings.svelte` (import + mount in the Accordion)

- [ ] **Step 1: Create the Appearance section**

```svelte
<!-- src/lib/components/Settings/AppearanceSettings.svelte -->
<script lang="ts">
  import { AccordionItem, Label, Toggle } from 'flowbite-svelte';
  import { settings, updateSetting, PRESETS, type ThemeTokens } from '$lib/settings';
  import { get } from 'svelte/store';

  const presetList = Object.values(PRESETS);

  type TokenField = { key: keyof ThemeTokens; label: string };
  const tokenFields: TokenField[] = [
    { key: 'background', label: 'Background' },
    { key: 'surface', label: 'Surface' },
    { key: 'text', label: 'Text' },
    { key: 'muted', label: 'Muted' },
    { key: 'border', label: 'Border' },
    { key: 'accent', label: 'Accent' }
  ];

  let current = $derived($settings?.theme ?? 'dark');
  let custom = $derived(
    $settings?.customTheme ?? { base: 'light' as const, ...PRESETS.eink.tokens }
  );

  function selectPreset(id: string) {
    updateSetting('theme', id);
  }

  function editCustom() {
    // Switching to Custom seeds the editor from whatever preset is active now,
    // so users start from a familiar palette instead of a blank one.
    const active = PRESETS[get(settings)?.theme ?? 'dark'];
    if ((get(settings)?.theme ?? 'dark') !== 'custom' && active) {
      updateSetting('customTheme', { base: active.base, ...active.tokens });
    }
    updateSetting('theme', 'custom');
  }

  function setToken(key: keyof ThemeTokens, value: string) {
    updateSetting('customTheme', { ...get(settings).customTheme, [key]: value });
  }

  function setBase(isDark: boolean) {
    updateSetting('customTheme', {
      ...get(settings).customTheme,
      base: isDark ? 'dark' : 'light'
    });
  }
</script>

<AccordionItem>
  {#snippet header()}Appearance{/snippet}
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-2 gap-2">
      {#each presetList as preset (preset.id)}
        <button
          type="button"
          class="relative z-10 flex items-center gap-2 rounded-lg border p-2 text-left text-sm
            {current === preset.id
            ? 'border-primary-500 ring-2 ring-primary-500'
            : 'border-gray-300 dark:border-gray-600'}"
          onclick={() => selectPreset(preset.id)}
        >
          <span
            class="h-6 w-6 shrink-0 rounded-full border border-gray-400"
            style:background-color={preset.tokens.background}
          ></span>
          <span
            class="h-6 w-6 shrink-0 rounded-full border border-gray-400"
            style:background-color={preset.tokens.accent}
          ></span>
          <span class="text-gray-900 dark:text-white">{preset.name}</span>
        </button>
      {/each}
      <button
        type="button"
        class="relative z-10 flex items-center gap-2 rounded-lg border p-2 text-left text-sm
          {current === 'custom'
          ? 'border-primary-500 ring-2 ring-primary-500'
          : 'border-gray-300 dark:border-gray-600'}"
        onclick={editCustom}
      >
        <span class="text-gray-900 dark:text-white">Custom…</span>
      </button>
    </div>

    {#if current === 'custom'}
      <div class="flex flex-col gap-3 rounded-lg border border-gray-300 p-3 dark:border-gray-600">
        <Toggle checked={custom.base === 'dark'} onchange={(e) => setBase(e.currentTarget.checked)}>
          Dark base (light text & icons)
        </Toggle>
        {#each tokenFields as field (field.key)}
          <div class="flex items-center justify-between gap-3">
            <Label class="text-gray-900 dark:text-white">{field.label}</Label>
            <input
              type="color"
              value={custom[field.key]}
              oninput={(e) => setToken(field.key, e.currentTarget.value)}
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>
</AccordionItem>
```

> **Flowbite v1 note:** `AccordionItem` headers use the `{#snippet header()}` form in this codebase's Flowbite version. Before finalizing, open one existing section (e.g. `src/lib/components/Settings/CatalogSettings.svelte`) and copy its exact header pattern (`{#snippet header()}` vs `slot="header"`); use whichever that file uses so this section matches.

- [ ] **Step 2: Mount it in Settings.svelte**

In `src/lib/components/Settings/Settings.svelte`, add the import after the `QuickAccess` import:

```ts
import QuickAccess from './QuickAccess.svelte';
import AppearanceSettings from './AppearanceSettings.svelte';
```

Add the section to the `<Accordion>` after `<CatalogSettings />` and before `<Stats />`:

```svelte
<CatalogSettings />
<AppearanceSettings />
<Stats />
```

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: No errors in `AppearanceSettings.svelte`.

- [ ] **Step 4: Manual verification (the core of this feature)**

Run: `npm run dev`. Open Settings → Appearance:

- Click each preset (Dark, E-ink, Paper, Sepia, Nord) → entire UI re-colors live: navbar, drawer, accordion, buttons, toggles, range sliders, the catalog, and the reader viewport.
- Click **Custom…** → editor appears seeded from the active preset; changing each of the six swatches and the base toggle updates the UI live.
- Switch profiles → theme follows the profile.
- **Toggle night mode ON** (per CLAUDE.md) and re-check each preset + open a modal — confirm buttons remain clickable and dialogs render (filter/stacking-context check).

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/Settings/AppearanceSettings.svelte src/lib/components/Settings/Settings.svelte
git commit -m "feat(theme): add Appearance settings with presets and custom editor"
```

---

## Task 8: Light-mode contrast audit (spot fixes)

Light themes expose components that hardcode light-on-dark colors with **no light counterpart**. Fix only the ones that break. The transformation rule: a bare `text-white` / `text-gray-100` (meant as light text on a dark surface) that sits on a now-light surface becomes `text-gray-900 dark:text-white`; a bare light `bg-*`/`border-*` similarly gains its `dark:` pair. **Do not** touch `text-white` that sits on an accent/colored button (it should stay light on accent).

**Files:** discovered via audit; known starting hits below.

- [ ] **Step 1: Find candidates**

Run:

```bash
grep -rn "text-white" src/lib/components src/routes | grep -v "dark:text-white" | grep -v "bg-primary\|bg-blue\|bg-green\|bg-red\|hover:"
```

and

```bash
grep -rn "class:text-white" src/lib/components src/routes
```

- [ ] **Step 2: Fix the known breakers**

- `src/lib/components/VolumeItem.svelte:549` — change
  `<p class="font-semibold" class:text-white={!isComplete}>{volName}</p>`
  to
  `<p class="font-semibold" class:text-gray-900={!isComplete} class:dark:text-white={!isComplete}>{volName}</p>`
- `src/lib/components/VolumeItem.svelte:632` — the `DotsVerticalOutline` icon `class="h-4 w-4 text-white"` sits on a colored menu button trigger; verify against the actual button background in the browser under the E-ink theme. If the trigger is a light surface, change to `text-gray-700 dark:text-white`; if it is an accent/dark button, leave it.

For every other hit from Step 1: open it in the E-ink theme in the browser; if the text/element is invisible or low-contrast on the light surface, apply the `dark:`-pairing rule; otherwise leave it.

- [ ] **Step 3: Verify across presets**

Run: `npm run dev`. With the **E-ink** theme active, walk catalog → series → reader → settings and confirm no invisible/low-contrast text. Repeat a quick pass in **Sepia** (warm surfaces catch different cases).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix(theme): add light-mode color counterparts where missing"
```

---

## Task 9: Full verification and changelog

**Files:**

- Modify: changelog file (check repo for `CHANGELOG.md` or the pattern used by recent releases, e.g. commit `1a50b3d`).

- [ ] **Step 1: Test suite**

Run: `npm test`
Expected: All tests pass, including the new `color`, `theme`, and `settings` migration tests.

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: No new errors.

- [ ] **Step 3: Lint/format**

Run: `npm run lint` (and `npm run format` if it flags formatting).
Expected: Clean.

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: Builds successfully.

- [ ] **Step 5: Full manual matrix**

`npm run preview`, then for each preset (Dark, E-ink, Paper, Sepia, Nord) and one Custom config, with night mode both OFF and ON:

- Catalog grid + list, series view, reader (page + continuous scroll modes), settings drawer, and at least one modal (e.g. Volume Editor) — confirm legible, correctly themed, buttons clickable.
- Confirm a legacy profile with a custom `backgroundColor` (simulate by editing localStorage `profiles` to add `backgroundColor: "#123456"` and removing `theme`, then reload) migrates to a Custom theme preserving that background.

- [ ] **Step 6: Changelog + version**

Add a changelog entry describing the new theme system (presets + custom, e-ink light mode), crediting PR #86 / @oscarwong67 as the originating idea. Match the format of the most recent entry.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs(theme): changelog entry for theme system"
```

---

## Self-Review Notes (coverage vs spec)

- **6 tokens + base** → Tasks 2 (`ThemeTokens`, `deriveVars`) + 7 (editor with exactly six swatches + base toggle). ✓
- **Variable-override mechanism** → Tasks 2 (`deriveVars`) + 4 (`ThemeController`). ✓
- **Presets Dark/E-ink/Paper/Sepia/Nord + Custom** → Task 2 `PRESETS` + Task 7 picker. ✓
- **Dark = zero behavior change** → Task 2 `dark` preset uses verbatim `vars` (Tailwind defaults untouched), default `theme: 'dark'` (Task 3), app.css `:root` default + `app.html` body change keep the dark canvas with no flash (Task 4). ✓
- **Per-profile storage + sync** → Task 3 (`Settings` fields flow through existing profile sync/import/export). ✓
- **Reader bg follows theme + legacy migration** → Task 5 (`--reader-bg`) + Task 3 (backgroundColor seeding). ✓
- **Settings UI / Appearance section** → Task 7; modal z-index rule applied via `relative z-10` on preset buttons. ✓
- **Night-mode/invert untouched & composes** → no changes to `NightModeFilter` or invert logic; verified in Tasks 7 & 9 with night mode ON. ✓
- **Remove standalone backgroundColor control** → Task 6. ✓
- **Out of scope** (system auto, per-volume, import/export themes) → not implemented. ✓
