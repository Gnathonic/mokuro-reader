import { describe, expect, it } from 'vitest';
import { PRESETS, deriveVars, resolveTheme, type ThemeTokens } from './theme';

const TOKENS: ThemeTokens = {
  background: '#ffffff',
  surface: '#ffffff',
  text: '#000000',
  muted: '#666666',
  border: '#cccccc',
  accent: '#2563eb',
  secondary: '#0e7490',
  success: '#16a34a',
  danger: '#dc2626'
};

describe('deriveVars (role-based, base-independent)', () => {
  const vars = deriveVars(TOKENS);

  it('maps the app canvas + reader viewport to the background token', () => {
    expect(vars['--app-bg']).toBe('#ffffff');
    expect(vars['--reader-bg']).toBe('#ffffff');
  });

  it('maps --color-white to the TEXT token (.dark is always on, so text-white = body text)', () => {
    expect(vars['--color-white']).toBe('#000000');
    expect(vars['--color-gray-50']).toBe('#000000');
  });

  it('maps the surface slot (gray-800) and page bg slot (gray-950)', () => {
    expect(vars['--color-gray-800']).toBe('#ffffff'); // surface
    expect(vars['--color-gray-950']).toBe('#ffffff'); // background
    expect(vars['--color-black']).toBe('#ffffff'); // deepest bg
  });

  it('maps muted text, borders, and the elevated input fill onto their slots', () => {
    expect(vars['--color-gray-400']).toBe('#666666'); // muted
    expect(vars['--color-gray-600']).toBe('#cccccc'); // border / input outline
    // gray-700 is the elevated input/dropdown fill — distinct from the border,
    // sitting just off the surface so inputs read as recessed, not border-coloured.
    expect(vars['--color-gray-700']).not.toBe('#cccccc');
    expect(vars['--color-gray-700']).toBe('#ebebeb'); // mix(surface #fff, border #ccc, 0.4)
  });

  it('sets the accent onto the primary scale', () => {
    expect(vars['--color-primary-500']).toBe('#2563eb');
    expect(vars['--color-brand']).toBe('#2563eb');
  });

  it('recolours the semantic scales from their tokens', () => {
    expect(vars['--color-blue-500']).toBe('#0e7490'); // secondary -> blue
    expect(vars['--color-green-500']).toBe('#16a34a'); // success -> green
    expect(vars['--color-red-500']).toBe('#dc2626'); // danger -> red
    // ramps span light tints to dark stops
    expect(vars['--color-green-50']).toBeDefined();
    expect(vars['--color-red-900']).toBeDefined();
  });

  it('picks a readable on-accent label colour (white on a dark accent)', () => {
    expect(vars['--color-on-accent']).toBe('#ffffff');
  });

  it('picks a dark on-accent label colour on a light accent', () => {
    const light = deriveVars({ ...TOKENS, accent: '#fde047' }); // light yellow
    expect(light['--color-on-accent']).toBe('#111111');
  });
});

describe('PRESETS', () => {
  it('includes the built-in presets', () => {
    expect(Object.keys(PRESETS).sort()).toEqual([
      'crimson',
      'dark',
      'eink',
      'godzilla',
      'ice',
      'nord',
      'pastel',
      'sakura',
      'sepia'
    ]);
  });
  it('keeps Dark a zero-change theme (no ramp overrides, only canvas/reader bg)', () => {
    const resolved = resolveTheme(PRESETS.dark);
    expect(resolved.vars['--color-gray-950']).toBeUndefined();
    expect(resolved.vars['--color-white']).toBeUndefined();
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
    expect(resolved.vars['--color-white']).toBe('#000000');
    expect(resolved.vars['--app-bg']).toBe('#ffffff');
  });
});
