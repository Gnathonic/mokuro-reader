import { describe, expect, it } from 'vitest';
import { imageOnlyNamingPreview } from '../image-only-naming';

describe('imageOnlyNamingPreview (#285)', () => {
  const pairings = [
    { basePath: 'Chained Soldier (Semi-Color)/02' },
    { basePath: 'Chained Soldier (Semi-Color)/10' },
    { basePath: 'Chained Soldier (Semi-Color)/01' },
    { basePath: 'Killing Bites/Killing Bites 01' }
  ];

  it('groups by series and lists volume names in natural order, per mode', () => {
    const preview = imageOnlyNamingPreview(pairings);
    expect(preview.folder).toEqual([
      {
        seriesName: 'Chained Soldier (Semi-Color)',
        volumeCount: 3,
        volumeNames: [
          'Chained Soldier (Semi-Color) 01',
          'Chained Soldier (Semi-Color) 02',
          'Chained Soldier (Semi-Color) 10'
        ]
      },
      { seriesName: 'Killing Bites', volumeCount: 1, volumeNames: ['Killing Bites 01'] }
    ]);
    expect(preview.cleaned).toEqual([
      {
        seriesName: 'Chained Soldier (Semi-Color)',
        volumeCount: 3,
        volumeNames: ['Volume 01', 'Volume 02', 'Volume 10']
      },
      { seriesName: 'Killing Bites', volumeCount: 1, volumeNames: ['Volume 01'] }
    ]);
  });

  it('names folder mode by where an archive sat (titlePath) over its inside path', () => {
    const preview = imageOnlyNamingPreview([{ basePath: 'Vol 1', titlePath: 'Pack/Vol 1' }]);
    expect(preview.folder).toEqual([
      { seriesName: 'Pack', volumeCount: 1, volumeNames: ['Pack Vol 1'] }
    ]);
  });

  it('shows the sanitized names that will be stored', () => {
    const preview = imageOnlyNamingPreview([{ basePath: 'Re: Zero?/Vol 1.' }]);
    expect(preview.folder[0].seriesName).toBe('Re： Zero？');
    expect(preview.folder[0].volumeNames).toEqual(['Re： Zero？ Vol 1․']);
  });
});
