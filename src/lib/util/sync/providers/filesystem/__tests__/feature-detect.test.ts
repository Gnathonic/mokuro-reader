import { describe, it, expect, afterEach } from 'vitest';
import { isFilesystemProviderSupported } from '../feature-detect';

describe('isFilesystemProviderSupported', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker');

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(window, 'showDirectoryPicker', originalDescriptor);
    } else {
      // @ts-expect-error — cleanup
      delete window.showDirectoryPicker;
    }
  });

  it('returns true when showDirectoryPicker is present on window', () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: () => {},
      configurable: true
    });
    expect(isFilesystemProviderSupported()).toBe(true);
  });

  it('returns false when showDirectoryPicker is absent', () => {
    // @ts-expect-error — deliberate delete for test
    delete window.showDirectoryPicker;
    expect(isFilesystemProviderSupported()).toBe(false);
  });
});
