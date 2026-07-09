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
