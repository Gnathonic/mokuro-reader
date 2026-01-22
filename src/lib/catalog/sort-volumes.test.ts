import { describe, it, expect } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import { sortVolumes } from './sort-volumes';

// Helper function to create mock volume metadata
function createMockVolume(title: string): VolumeMetadata {
  return {
    mokuro_version: '0.4.11',
    series_title: 'からかい上手の高木さん',
    series_uuid: 'test-series-uuid',
    volume_title: title,
    volume_uuid: `test-volume-${title}`,
    page_count: 200,
    character_count: 1000,
    page_char_counts: [50, 100, 150, 200]
  };
}

describe('sortVolumes', () => {
  it('should sort Japanese volumes with numbers correctly', () => {
    const volumes = [
      createMockVolume('からかい上手の高木さん　１'),
      createMockVolume('からかい上手の高木さん　10'),
      createMockVolume('からかい上手の高木さん　２')
    ];

    const sorted = volumes.sort(sortVolumes);

    expect(sorted.map((v) => v.volume_title)).toEqual([
      'からかい上手の高木さん　１',
      'からかい上手の高木さん　２',
      'からかい上手の高木さん　10'
    ]);
  });

  it('should sort English volumes with natural number ordering', () => {
    const volumes = [
      createMockVolume('Volume 1'),
      createMockVolume('Volume 2'),
      createMockVolume('Volume 10'),
      createMockVolume('Volume 11'),
      createMockVolume('Volume 3')
    ];

    const sorted = volumes.sort(sortVolumes);

    // Natural sorting correctly orders numbers
    expect(sorted.map((v) => v.volume_title)).toEqual([
      'Volume 1',
      'Volume 2',
      'Volume 3',
      'Volume 10',
      'Volume 11'
    ]);
  });

  it('should handle fixed-width numbers (zero-padded)', () => {
    const volumes = [
      createMockVolume('Chapter 01'),
      createMockVolume('Chapter 02'),
      createMockVolume('Chapter 10'),
      createMockVolume('Chapter 11'),
      createMockVolume('Chapter 03')
    ];

    const sorted = volumes.sort(sortVolumes);
    expect(sorted.map((v) => v.volume_title)).toEqual([
      'Chapter 01',
      'Chapter 02',
      'Chapter 03',
      'Chapter 10',
      'Chapter 11'
    ]);
  });

  it('should handle mixed number formats', () => {
    const volumes = [
      createMockVolume('Vol 1'),
      createMockVolume('Vol 02'),
      createMockVolume('Vol 10'),
      createMockVolume('Vol 3'),
      createMockVolume('Vol 011')
    ];

    const sorted = volumes.sort(sortVolumes);
    expect(sorted.map((v) => v.volume_title)).toEqual([
      'Vol 1',
      'Vol 02',
      'Vol 3',
      'Vol 10',
      'Vol 011'
    ]);
  });

  it('should handle identical titles', () => {
    const volumes = [createMockVolume('Same Title'), createMockVolume('Same Title')];

    const sorted = volumes.sort(sortVolumes);
    expect(sorted.map((v) => v.volume_title)).toEqual(['Same Title', 'Same Title']);
  });

  it('should sort basic alphabetical titles correctly', () => {
    const volumes = [
      createMockVolume('Charlie'),
      createMockVolume('Alpha'),
      createMockVolume('Bravo')
    ];

    const sorted = volumes.sort(sortVolumes);
    expect(sorted.map((v) => v.volume_title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('should handle complex mixed scenarios', () => {
    const volumes = [
      createMockVolume('Series A Vol 2'),
      createMockVolume('Series A Vol 10'),
      createMockVolume('Series A Vol 1'),
      createMockVolume('Series B Vol 1'),
      createMockVolume('Series A Vol 3')
    ];

    const sorted = volumes.sort(sortVolumes);
    expect(sorted.map((v) => v.volume_title)).toEqual([
      'Series A Vol 1',
      'Series A Vol 2',
      'Series A Vol 3',
      'Series A Vol 10',
      'Series B Vol 1'
    ]);
  });
});
