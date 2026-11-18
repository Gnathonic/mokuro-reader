import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  closePageAdjustPanel,
  openPageAdjustPanel,
  pageAdjustPanelOpen,
  togglePageAdjustPanel
} from './page-adjust-panel';

afterEach(() => closePageAdjustPanel());

describe('page image panel state (#363)', () => {
  it('starts closed, opens, closes and toggles', () => {
    expect(get(pageAdjustPanelOpen)).toBe(false);
    openPageAdjustPanel();
    expect(get(pageAdjustPanelOpen)).toBe(true);
    openPageAdjustPanel();
    expect(get(pageAdjustPanelOpen)).toBe(true);
    togglePageAdjustPanel();
    expect(get(pageAdjustPanelOpen)).toBe(false);
    togglePageAdjustPanel();
    expect(get(pageAdjustPanelOpen)).toBe(true);
    closePageAdjustPanel();
    expect(get(pageAdjustPanelOpen)).toBe(false);
  });

  it('is read-only from outside: only the three functions move it', () => {
    expect('set' in pageAdjustPanelOpen).toBe(false);
  });
});
