import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Reset cover" takes the first real page. Generated missing-page placeholders
 * are skipped by `missing_page_paths`. Every stored page is typed by its bytes,
 * so a real PNG page named `001.jpg` is `image/png`: the old type/name
 * mismatch guess must not take it for a placeholder.
 */

vi.mock('$app/environment', () => ({ browser: true }));

const { volumes, volumeFiles, volumeOcr, generateThumbnail } = vi.hoisted(() => ({
  volumes: { get: vi.fn(), update: vi.fn(async () => 1) },
  volumeFiles: { get: vi.fn() },
  volumeOcr: { get: vi.fn(async () => undefined) },
  generateThumbnail: vi.fn(async (file: File) => ({
    file: new File([file], 'thumb.webp', { type: 'image/webp' }),
    width: 10,
    height: 10,
    source: file
  }))
}));

vi.mock('$lib/catalog/db', () => ({
  db: { volumes, volume_files: volumeFiles, volume_ocr: volumeOcr }
}));
vi.mock('$lib/catalog/thumbnails', () => ({
  convertToWebP: vi.fn(async () => new Blob(['webp'], { type: 'image/webp' })),
  generateThumbnail
}));
vi.mock('$lib/catalog/thumbnail-cache', () => ({ thumbnailCache: { invalidate: vi.fn() } }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider: () => null, uploadFile: vi.fn() }
}));

import { resetVolumeCover } from './volume-editor';

const pngNamedJpg = (name: string) => new File(['png bytes'], name, { type: 'image/png' });
const jpeg = (name: string) => new File(['jpeg bytes'], name, { type: 'image/jpeg' });

function givenVolume(row: Record<string, unknown>, files: Record<string, File>) {
  volumes.get.mockResolvedValue({
    volume_uuid: 'v1',
    series_title: 'Series',
    volume_title: 'Volume 1',
    ...row
  });
  volumeFiles.get.mockResolvedValue({ volume_uuid: 'v1', files });
}

function coverSource(): string {
  return (generateThumbnail.mock.calls.at(-1)?.[0] as File).name;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resetVolumeCover', () => {
  it('takes a real PNG page named .jpg when the row lists no placeholders', async () => {
    givenVolume({}, { '001.jpg': pngNamedJpg('001.jpg'), '002.jpg': jpeg('002.jpg') });
    await resetVolumeCover('v1');
    expect(coverSource()).toBe('001.jpg');
  });

  it('takes it with an empty missing_page_paths too', async () => {
    givenVolume(
      { missing_page_paths: [] },
      { '001.jpg': pngNamedJpg('001.jpg'), '002.jpg': jpeg('002.jpg') }
    );
    await resetVolumeCover('v1');
    expect(coverSource()).toBe('001.jpg');
  });

  it('resets a volume whose pages are all PNG bytes named .jpg', async () => {
    givenVolume({}, { '001.jpg': pngNamedJpg('001.jpg'), '002.jpg': pngNamedJpg('002.jpg') });
    await expect(resetVolumeCover('v1')).resolves.toBeUndefined();
    expect(coverSource()).toBe('001.jpg');
  });

  it('skips the placeholders the row lists', async () => {
    givenVolume(
      { missing_pages: 1, missing_page_paths: ['001.jpg'] },
      { '001.jpg': pngNamedJpg('001.jpg'), '002.jpg': pngNamedJpg('002.jpg') }
    );
    await resetVolumeCover('v1');
    expect(coverSource()).toBe('002.jpg');
  });

  it('still guesses on a row that reports missing pages it does not name', async () => {
    givenVolume(
      { missing_pages: 1 },
      { '001.jpg': pngNamedJpg('001.jpg'), '002.jpg': jpeg('002.jpg') }
    );
    await resetVolumeCover('v1');
    expect(coverSource()).toBe('002.jpg');
  });
});
