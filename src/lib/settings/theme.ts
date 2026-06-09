// Pure leaf module: imports only ./color. Do NOT import from ./settings here —
// the active-theme store lives in settings.ts to keep this dependency one-way.
import { mix, shade, parseHex } from './color';

export type ThemeBase = 'light' | 'dark';

export type ThemeTokens = {
  background: string; // app canvas + reader viewport
  surface: string; // cards, drawers, navbar, modals
  text: string; // primary text
  muted: string; // secondary text
  border: string; // dividers, outlines
  accent: string; // primary buttons, links, highlights
  secondary: string; // second tone: download / cloud buttons & icons (the blue scale)
  success: string; // mark-as-read, sync badge, completed indicators (the green scale)
  danger: string; // warnings, delete / destructive buttons (the red scale)
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

/** Perceived brightness (0-255) — used to pick a readable on-accent label color. */
function brightness(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

/**
 * Build a full Tailwind colour ramp (50..950) for `prefix` from a single `base`
 * token, used to recolour the saturated semantic scales (blue/green/red).
 *
 * Components hardcode stop 400 (and 300) as *accent text* (e.g. download labels,
 * "mark as read"). Those were authored for dark backgrounds, so a plain lightened
 * tint is unreadable on a light theme. We orient those text stops by the theme
 * background: lighter on dark themes, darker on light themes — so the text always
 * contrasts the page it sits on. `bg` is the theme background token.
 */
function colorRamp(prefix: string, base: string, bg: string): Record<string, string> {
  const onLight = brightness(bg) >= 128;
  const text300 = onLight ? shade(base, -0.08) : mix(base, '#ffffff', 0.5);
  const text400 = onLight ? shade(base, -0.24) : mix(base, '#ffffff', 0.34);
  return {
    [`${prefix}-50`]: mix(base, '#ffffff', 0.9),
    [`${prefix}-100`]: mix(base, '#ffffff', 0.8),
    [`${prefix}-200`]: mix(base, '#ffffff', 0.6),
    [`${prefix}-300`]: text300,
    [`${prefix}-400`]: text400,
    [`${prefix}-500`]: base,
    [`${prefix}-600`]: shade(base, -0.15),
    [`${prefix}-700`]: shade(base, -0.28),
    [`${prefix}-800`]: shade(base, -0.4),
    [`${prefix}-900`]: shade(base, -0.52),
    [`${prefix}-950`]: shade(base, -0.62)
  };
}

/**
 * Expand the six semantic tokens into Tailwind CSS-variable overrides.
 *
 * The app is dark-first: `.dark` is kept active at all times (see ThemeController),
 * so every component — whether it uses a `dark:` variant pair or a bare dark utility
 * — reads from the SAME dark-mode colour slots. We repaint those slots per theme by
 * role rather than relying on each component to provide a light counterpart. This is
 * why a single mapping flips the whole app (including bare-utility components) and is
 * independent of any light/dark "base".
 */
export function deriveVars(tokens: ThemeTokens): Record<string, string> {
  const { background, surface, text, muted, border, accent, secondary, success, danger } = tokens;
  const vars: Record<string, string> = {};

  // Primary text + icons  (text-white, text-gray-50..200 in dark-designed UI)
  vars['--color-white'] = text;
  vars['--color-gray-50'] = text;
  vars['--color-gray-100'] = text;
  vars['--color-gray-200'] = mix(text, muted, 0.3);
  vars['--color-gray-300'] = mix(text, muted, 0.6);

  // Secondary / muted text  (text-gray-400/500)
  vars['--color-gray-400'] = muted;
  vars['--color-gray-500'] = muted;
  vars['--color-body'] = muted; // Flowbite form helper colour

  // gray-700 is overwhelmingly an *elevated fill* (input / dropdown / radio /
  // code-chip / range-track backgrounds), while borders & input outlines use
  // gray-600. Keep them distinct: the fill reads as a recessed surface (near the
  // card surface), NOT the border colour. gray-700 sits just off the surface
  // toward the border so inputs are distinguishable from the card behind them.
  vars['--color-gray-700'] = mix(surface, border, 0.4); // elevated fill
  vars['--color-gray-600'] = border; // borders, dividers, input outlines

  // Surfaces  (bg-gray-800 cards/navbar, gray-900 deeper, gray-950 page bg)
  vars['--color-gray-800'] = surface;
  vars['--color-gray-900'] = mix(surface, background, 0.5);
  vars['--color-gray-950'] = background;
  vars['--color-black'] = background;

  // Accent -> primary scale (buttons, links, focus rings, Flowbite --color-brand)
  vars['--color-primary-300'] = shade(accent, 0.2);
  vars['--color-primary-400'] = shade(accent, 0.1);
  vars['--color-primary-500'] = accent;
  vars['--color-primary-600'] = shade(accent, -0.1);
  vars['--color-primary-700'] = shade(accent, -0.18);
  vars['--color-primary-800'] = shade(accent, -0.28);
  vars['--color-brand'] = accent;

  // Semantic scales recoloured from their tokens, so every button/icon/badge that
  // uses them follows the theme:
  //   secondary -> blue  (download / cloud actions, info states, focus rings)
  //   success   -> green (mark-as-read, sync badge, completed indicators)
  //   danger    -> red   (warnings, delete / destructive buttons)
  Object.assign(
    vars,
    colorRamp('--color-blue', secondary, background),
    colorRamp('--color-green', success, background),
    colorRamp('--color-red', danger, background)
  );

  // Label colour forced onto strong coloured buttons/badges (see app.css), so a
  // remapped `text-white` (= theme text colour) never collides with the accent fill.
  vars['--color-on-accent'] = brightness(accent) > 150 ? '#111111' : '#ffffff';

  // App canvas + reader viewport background.
  vars['--app-bg'] = background;
  vars['--reader-bg'] = background;

  return vars;
}

export function resolveTheme(preset: ThemePreset): ResolvedTheme {
  return {
    id: preset.id,
    base: preset.base,
    vars: preset.vars ?? deriveVars(preset.tokens)
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
      accent: '#ef562f',
      secondary: '#1c64f2',
      success: '#22c55e',
      danger: '#ef4444'
    },
    // Zero-change: keep Tailwind's default ramp + primary + blue, only drive the canvas/reader bg.
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
      muted: '#404040',
      border: '#bcbcbc',
      accent: '#000000',
      secondary: '#3f4756',
      success: '#15803d',
      danger: '#b91c1c'
    }
  },
  ice: {
    id: 'ice',
    name: 'Ice',
    base: 'light',
    tokens: {
      // Light-mode counterpart to Nord: Nord snow-storm backgrounds, polar-night
      // text, frost-blue accent, with a frost-teal second tone and deepened
      // aurora green/red so they read on the pale surface.
      background: '#eceff4',
      surface: '#dce4ef',
      text: '#2e3440',
      muted: '#4c566a',
      border: '#c6d2e0',
      accent: '#5e81ac',
      secondary: '#3d9aa8',
      success: '#6f8f4e',
      danger: '#b34b56'
    }
  },
  sepia: {
    id: 'sepia',
    name: 'Sepia',
    base: 'light',
    tokens: {
      background: '#f1e7d0',
      surface: '#fbf5e6',
      text: '#3a2c1c',
      muted: '#6f5f48',
      border: '#d8c9a8',
      accent: '#9a6a3a',
      secondary: '#5c7a99',
      success: '#5f7a3a',
      danger: '#a8432f'
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
      accent: '#88c0d0',
      secondary: '#5e81ac',
      success: '#a3be8c',
      danger: '#bf616a'
    }
  },
  sakura: {
    id: 'sakura',
    name: 'Sakura',
    base: 'light',
    tokens: {
      // Ported from the Codigrate "Sakura" IntelliJ theme (codigrate/jetbrains-themes):
      // pale-pink page, pinker surface panels, dark-maroon text, mauve muted text,
      // rose accent, blue info (secondary), green success, red error. Border is a
      // soft rose (their theme reuses the surface colour for borders, but our inputs
      // and dividers need a visible outline).
      background: '#fcf4f7', // windowBackground
      surface: '#f8dbe6', // surface (panels / navbar)
      text: '#3d0013', // primaryForeground
      muted: '#94667d', // secondaryForeground
      border: '#e9b4c6', // derived (their borderColor == surface)
      accent: '#b54b66', // accentColor
      secondary: '#397fb7', // info (blue)
      success: '#30a25e', // success
      danger: '#ce5e5e' // error
    }
  },
  pastel: {
    id: 'pastel',
    name: 'Pastel',
    base: 'light',
    tokens: {
      // Cohesive soft-lilac pastel: palest page, a defined lilac panel surface
      // (so the title bar reads as a panel), deepened text/accents for legibility.
      background: '#f7f4fd',
      surface: '#e8e1f5',
      text: '#3a3357',
      muted: '#6f6892',
      border: '#d5cbec',
      accent: '#8b6fd6',
      secondary: '#4e9fd4',
      success: '#3f9d6b',
      danger: '#d85a78'
    }
  },
  crimson: {
    id: 'crimson',
    name: 'Crimson',
    base: 'dark',
    tokens: {
      // Proper crimson: red-dominant dark surfaces (not muddy burgundy/wine) lit by
      // the canonical crimson accent (#dc143c), with a cool steel-blue second tone
      // for contrast and a brighter red for danger.
      background: '#1c060d',
      surface: '#310b16',
      text: '#f8e9eb',
      muted: '#d199a4',
      border: '#5a1a29',
      accent: '#dc143c',
      secondary: '#6d8bb0',
      success: '#4caf6a',
      danger: '#ff5a5a'
    }
  },
  godzilla: {
    id: 'godzilla',
    name: 'Godzilla',
    base: 'dark',
    tokens: {
      // Scaly green-black monster hide (the whole UI is green-cast, not neutral
      // charcoal) lit by a glowing atomic-cyan accent and radioactive-lime second
      // tone, with heat-ray orange-red danger.
      background: '#0a130c',
      surface: '#16271a',
      text: '#d7ead5',
      muted: '#7d9a80',
      border: '#2b4631',
      accent: '#2ad4e6',
      secondary: '#9bd83f',
      success: '#54c95a',
      danger: '#ff6234'
    }
  }
};

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  base: PRESETS.eink.base,
  ...PRESETS.eink.tokens
};
