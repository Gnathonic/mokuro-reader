import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from '$lib/util/base64';
import { webdavAuthOptions } from './webdav-auth';

describe('webdavAuthOptions', () => {
  it('always sets authType none so the webdav lib never writes its own header', () => {
    expect(webdavAuthOptions('user', 'pass').authType).toBe('none');
    expect(webdavAuthOptions('user', '').authType).toBe('none');
    expect(webdavAuthOptions(undefined, undefined).authType).toBe('none');
  });

  it('sets Authorization to the UTF-8-safe basic header when a password is given', () => {
    const options = webdavAuthOptions('user', 'päss');
    expect(options.headers?.Authorization).toBe(basicAuthHeader('user', 'päss'));
    expect(options.headers?.Authorization).toBe('Basic dXNlcjpww6Rzcw==');
  });

  it('sends no Authorization header when password is empty, even with a username', () => {
    const options = webdavAuthOptions('user', '');
    expect(options.headers ?? {}).not.toHaveProperty('Authorization');

    const optionsUndefined = webdavAuthOptions('user', undefined);
    expect(optionsUndefined.headers ?? {}).not.toHaveProperty('Authorization');
  });

  it('sends no Authorization header when no credentials at all', () => {
    const options = webdavAuthOptions(undefined, undefined);
    expect(options.headers ?? {}).not.toHaveProperty('Authorization');
  });

  it('supports password-only auth (Basic :pw)', () => {
    const options = webdavAuthOptions('', 'pw');
    expect(options.headers?.Authorization).toBe('Basic ' + btoa(':pw'));
  });

  it('treats missing username with a password as empty username', () => {
    const options = webdavAuthOptions(undefined, 'pw');
    expect(options.headers?.Authorization).toBe('Basic ' + btoa(':pw'));
  });

  it('preserves extra options and extra headers', () => {
    const options = webdavAuthOptions('user', 'pw', {
      maxBodyLength: 123,
      headers: { 'X-Custom': 'yes' }
    });
    expect(options.maxBodyLength).toBe(123);
    expect(options.headers?.['X-Custom']).toBe('yes');
    expect(options.headers?.Authorization).toBe(basicAuthHeader('user', 'pw'));
  });
});
