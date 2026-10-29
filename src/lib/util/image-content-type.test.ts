import { describe, expect, it } from 'vitest';
import { mayBeImageType } from './image-content-type';

describe('mayBeImageType', () => {
  it('takes image types, an unknown type and octet-stream', () => {
    for (const type of ['image/webp', 'IMAGE/PNG', 'image/jpeg; q=1', '', null, undefined]) {
      expect(mayBeImageType(type)).toBe(true);
    }
    expect(mayBeImageType('application/octet-stream')).toBe(true);
  });

  it('refuses a page, JSON or text', () => {
    for (const type of [
      'text/html; charset=utf-8',
      'text/html',
      'application/json',
      'text/plain'
    ]) {
      expect(mayBeImageType(type)).toBe(false);
    }
  });
});
