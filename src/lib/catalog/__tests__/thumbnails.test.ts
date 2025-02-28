import { describe, it, expect, vi, beforeAll } from 'vitest';
import { generateThumbnail } from '../thumbnails';

describe('Thumbnail Generation', () => {
  const mockFile = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

  // Mock canvas functionality
  beforeAll(() => {
    const mockCanvas = {
      getContext: vi.fn().mockReturnValue({
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        drawImage: vi.fn(),
      }),
      width: 0,
      height: 0,
      toBlob: vi.fn().mockImplementation((callback) => callback(new Blob(['test'], { type: 'image/jpeg' })))
    };

    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag === 'canvas') {
        return mockCanvas as any;
      }
      return document.createElement(tag);
    });

    global.URL = {
      createObjectURL: vi.fn().mockReturnValue('mock-url'),
      revokeObjectURL: vi.fn()
    } as any;

    // Mock Image
    global.Image = class {
      onload: () => void = () => {};
      onerror: () => void = () => {};
      src: string = '';
      width: number = 100;
      height: number = 100;
      constructor() {
        setTimeout(() => this.onload(), 0);
      }
    } as any;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should generate a thumbnail from a file', async () => {
    const thumbnail = await generateThumbnail(mockFile);
    expect(thumbnail).toBeInstanceOf(File);
    expect(thumbnail.name).toContain('thumbnail_');
    expect(thumbnail.type).toBe('image/jpeg');
  });
});