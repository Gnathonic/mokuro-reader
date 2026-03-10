import { describe, expect, it } from 'vitest';
import {
  getLegacyImageOnlyVolumeUuid,
  shouldReplaceDownloadedVolume
} from './download-volume-repair';

describe('shouldReplaceDownloadedVolume', () => {
  it('saves brand-new downloads', () => {
    expect(shouldReplaceDownloadedVolume(undefined, undefined, undefined, '')).toBe(true);
  });

  it('repairs incomplete stored volumes', () => {
    expect(
      shouldReplaceDownloadedVolume(
        {
          mokuro_version: '',
          series_title: 'Series',
          series_uuid: 'series-uuid',
          volume_title: 'Volume 1',
          volume_uuid: 'canonical-uuid',
          page_count: 10,
          character_count: 0,
          page_char_counts: []
        },
        undefined,
        {
          volume_uuid: 'canonical-uuid',
          files: {}
        },
        ''
      )
    ).toBe(true);
  });

  it('replaces image-only metadata when a downloaded OCR version is richer', () => {
    expect(
      shouldReplaceDownloadedVolume(
        {
          mokuro_version: '',
          series_title: 'Series',
          series_uuid: 'series-uuid',
          volume_title: 'Volume 1',
          volume_uuid: 'canonical-uuid',
          page_count: 10,
          character_count: 0,
          page_char_counts: []
        },
        {
          volume_uuid: 'canonical-uuid',
          pages: []
        },
        {
          volume_uuid: 'canonical-uuid',
          files: {}
        },
        '0.3.0'
      )
    ).toBe(true);
  });

  it('keeps complete local data when the download is not richer', () => {
    expect(
      shouldReplaceDownloadedVolume(
        {
          mokuro_version: '0.3.0',
          series_title: 'Series',
          series_uuid: 'series-uuid',
          volume_title: 'Volume 1',
          volume_uuid: 'canonical-uuid',
          page_count: 10,
          character_count: 100,
          page_char_counts: [100]
        },
        {
          volume_uuid: 'canonical-uuid',
          pages: []
        },
        {
          volume_uuid: 'canonical-uuid',
          files: {}
        },
        ''
      )
    ).toBe(false);
  });
});

describe('getLegacyImageOnlyVolumeUuid', () => {
  it('returns a legacy UUID candidate when the canonical UUID differs', () => {
    expect(
      getLegacyImageOnlyVolumeUuid({
        mokuro_version: '',
        series_title: 'Series',
        series_uuid: 'series-uuid',
        volume_title: 'Volume 1',
        volume_uuid: 'canonical-uuid',
        page_count: 10,
        character_count: 0,
        page_char_counts: []
      })
    ).toBeTruthy();
  });

  it('returns null when the canonical UUID already matches the deterministic one', () => {
    const volume = {
      mokuro_version: '',
      series_title: 'Series',
      series_uuid: 'series-uuid',
      volume_title: 'Volume 1',
      volume_uuid: '',
      page_count: 10,
      character_count: 0,
      page_char_counts: []
    };
    volume.volume_uuid = getLegacyImageOnlyVolumeUuid({
      ...volume,
      volume_uuid: 'placeholder'
    })!;

    expect(getLegacyImageOnlyVolumeUuid(volume)).toBeNull();
  });
});
