import { describe, expect, it } from 'vitest';
import { naturalSort } from './natural-sort';

describe('naturalSort', () => {
  it('sorts numbers naturally', () => {
    const files = ['page10.jpg', 'page2.jpg', 'page1.jpg', 'page20.jpg'];
    expect(files.sort(naturalSort)).toEqual(['page1.jpg', 'page2.jpg', 'page10.jpg', 'page20.jpg']);
  });

  it('sorts # prefixed files before their numeric counterparts', () => {
    const files = [
      '最終兵器彼女_4_001.jpg',
      '最終兵器彼女_4_#001.jpg',
      '最終兵器彼女_4_002.jpg',
      '最終兵器彼女_4_#002.jpg',
      '最終兵器彼女_4_003.jpg'
    ];
    expect(files.sort(naturalSort)).toEqual([
      '最終兵器彼女_4_#001.jpg',
      '最終兵器彼女_4_#002.jpg',
      '最終兵器彼女_4_001.jpg',
      '最終兵器彼女_4_002.jpg',
      '最終兵器彼女_4_003.jpg'
    ]);
  });

  it('handles paths with directories', () => {
    const files = ['vol1/page10.jpg', 'vol1/page2.jpg', 'vol1/page1.jpg'];
    expect(files.sort(naturalSort)).toEqual([
      'vol1/page1.jpg',
      'vol1/page2.jpg',
      'vol1/page10.jpg'
    ]);
  });

  it('handles leading zeros consistently', () => {
    const files = ['img003.jpg', 'img001.jpg', 'img002.jpg'];
    expect(files.sort(naturalSort)).toEqual(['img001.jpg', 'img002.jpg', 'img003.jpg']);
  });
});
