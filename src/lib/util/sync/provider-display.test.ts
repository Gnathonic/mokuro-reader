import { describe, it, expect } from 'vitest';
import { PROVIDER_LABELS, PROVIDER_SHORT_LABELS, PROVIDER_BADGE_COLORS } from './provider-display';

const ALL = ['google-drive', 'mega', 'webdav', 'filesystem', 'onedrive'] as const;

describe('provider-display', () => {
  it('covers every provider in every map', () => {
    for (const p of ALL) {
      expect(PROVIDER_LABELS[p]).toBeTruthy();
      expect(PROVIDER_SHORT_LABELS[p]).toBeTruthy();
      expect(PROVIDER_BADGE_COLORS[p]).toBeTruthy();
    }
  });

  it('names the new providers properly (no "Cloud" fallback)', () => {
    expect(PROVIDER_SHORT_LABELS.onedrive).toBe('OneDrive');
    expect(PROVIDER_SHORT_LABELS.filesystem).toBe('Local Folder');
  });
});
