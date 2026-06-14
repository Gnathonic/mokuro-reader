import { describe, expect, it } from 'vitest';
import { classifyWriteError } from './webdav-errors';

describe('classifyWriteError', () => {
  it('classifies 401 status codes as auth', () => {
    expect(classifyWriteError('Request failed with status 401')).toBe('auth');
  });

  it('classifies Unauthorized as auth', () => {
    expect(classifyWriteError('Unauthorized')).toBe('auth');
  });

  it('classifies 403 Forbidden as permission', () => {
    expect(classifyWriteError('403 Forbidden')).toBe('permission');
  });

  it('classifies Permission denied as permission', () => {
    expect(classifyWriteError('Permission denied')).toBe('permission');
  });

  it('classifies 405 Method Not Allowed as readonly', () => {
    expect(classifyWriteError('405 Method Not Allowed')).toBe('readonly');
  });

  it('classifies unrelated errors as other', () => {
    expect(classifyWriteError('Network error')).toBe('other');
  });

  it('prefers auth when a message contains both 401 and 403', () => {
    expect(classifyWriteError('upload failed: 401 then 403')).toBe('auth');
  });

  it('does not match digits embedded in larger numbers', () => {
    expect(classifyWriteError('uploaded 14010 bytes')).toBe('other');
  });
});
