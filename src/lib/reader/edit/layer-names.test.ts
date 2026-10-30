import { describe, expect, it } from 'vitest';
import {
  CURATED_LAYER_ID,
  isCuratedLayerId,
  isPersonalLayerId,
  isReservedLayerId,
  isServerKeepsakeLayerId,
  layerNameForId
} from './layer-names';

describe('layerNameForId: the shared and personal correction layers', () => {
  it('names curated and every personal edit layer', () => {
    expect(CURATED_LAYER_ID).toBe('curated');
    expect(layerNameForId('curated')).toBe('Shared corrections');
    expect(layerNameForId('edit')).toBe('Your corrections');
    expect(layerNameForId('edit-2')).toBe('Your corrections 2');
    expect(layerNameForId('edit-13')).toBe('Your corrections 13');
    // Not personal: a slug that merely starts with `edit`.
    expect(layerNameForId('edit-x')).toBe('Edit X');
    expect(layerNameForId('editorial')).toBe('Editorial');
    // Reserved, but not a class of its own: named like any other id.
    expect(layerNameForId('curated-2')).toBe('Curated 2');
  });
});

describe('layer roles by id', () => {
  it('personal = edit and edit-<n>, exact case', () => {
    for (const id of ['edit', 'edit-2', 'edit-10']) expect(isPersonalLayerId(id)).toBe(true);
    for (const id of ['Edit', 'edit-', 'edit-x', 'edit-2-3', 'editor', 'my-edit', 'curated']) {
      expect(isPersonalLayerId(id)).toBe(false);
    }
  });

  it('curated = curated alone', () => {
    expect(isCuratedLayerId('curated')).toBe(true);
    for (const id of ['curated-2', 'Curated', 'curate', 'edit']) {
      expect(isCuratedLayerId(id)).toBe(false);
    }
  });

  it('a server keepsake = bunko’s pre-upgrade layers', () => {
    expect(isServerKeepsakeLayerId('pre-upgrade')).toBe(true);
    expect(isServerKeepsakeLayerId('pre-upgrade-3')).toBe(true);
    expect(isServerKeepsakeLayerId('pre-upgraded')).toBe(false);
  });
});

describe('isReservedLayerId (bunko’s reserved set)', () => {
  it.each([
    'original',
    'gcv',
    'updated-ocr',
    'edit',
    'edit-2',
    'edit-40',
    'curated',
    'curated-2',
    'tr-en',
    'tr-',
    'pre-upgrade',
    'pre-upgrade-2',
    'pre-upgraded',
    'previous-ocr',
    'previous-ocr-3'
  ])('%s is reserved', (id) => {
    expect(isReservedLayerId(id)).toBe(true);
  });

  it.each([
    'layer',
    'layer-edit',
    'my-fixes',
    'edit-x',
    'editorial',
    'curated-x',
    'tr',
    'trans',
    'pre',
    'previous',
    'updated-ocr-2',
    'gcv-2',
    'original-2',
    'hayai-nova',
    'replaced-20261029-1200'
  ])('%s is not reserved', (id) => {
    expect(isReservedLayerId(id)).toBe(false);
  });
});
