import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from '$lib/util/base64';
import {
  authFromCredentials,
  bearerOf,
  webdavAuthHeaders,
  webdavAuthorization
} from './webdav-authorization';
import { webdavAuthOptions } from './webdav-auth';

describe('webdavAuthorization (the one header of a WebDAV session)', () => {
  it('sends the bearer token when one is held, never the password beside it', () => {
    expect(webdavAuthorization({ username: 'alice', password: 'pw', token: 'tok' })).toBe(
      'Bearer tok'
    );
  });

  it('falls back to UTF-8-safe Basic when no token is held', () => {
    expect(webdavAuthorization({ username: 'alice', password: 'päss' })).toBe(
      basicAuthHeader('alice', 'päss')
    );
    expect(webdavAuthorization({ username: 'alice', password: 'päss', token: '' })).toBe(
      basicAuthHeader('alice', 'päss')
    );
  });

  it('is password-only Basic without a username (copyparty)', () => {
    expect(webdavAuthorization({ password: 'pw' })).toBe('Basic ' + btoa(':pw'));
  });

  it('is anonymous for a username without a password, or nothing at all', () => {
    expect(webdavAuthorization({ username: 'alice' })).toBeNull();
    expect(webdavAuthorization({ username: 'alice', password: null, token: null })).toBeNull();
    expect(webdavAuthorization({})).toBeNull();
    expect(webdavAuthHeaders({})).toEqual({});
  });

  it('builds the header object', () => {
    expect(webdavAuthHeaders({ token: 't' })).toEqual({ Authorization: 'Bearer t' });
  });
});

describe('bearerOf', () => {
  it('reads the token of a Bearer header only', () => {
    expect(bearerOf('Bearer abc')).toBe('abc');
    expect(bearerOf('Basic YTpi')).toBeNull();
    expect(bearerOf('Bearer ')).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
  });
});

describe('authFromCredentials (worker credential spelling)', () => {
  it('reads token, username and password, ignoring non-strings', () => {
    expect(
      authFromCredentials({
        webdavUrl: 'https://host',
        webdavUsername: 'alice',
        webdavPassword: null,
        webdavToken: 'tok'
      })
    ).toEqual({ username: 'alice', password: '', token: 'tok' });
  });

  it('feeds the same header the main thread builds', () => {
    expect(
      webdavAuthorization(
        authFromCredentials({ webdavUsername: 'alice', webdavPassword: 'pw', webdavToken: 'tok' })
      )
    ).toBe('Bearer tok');
    expect(
      webdavAuthorization(authFromCredentials({ webdavUsername: 'alice', webdavPassword: 'pw' }))
    ).toBe(basicAuthHeader('alice', 'pw'));
  });
});

describe('webdavAuthOptions with a token', () => {
  it('puts the bearer header on the client, keeping authType none', () => {
    const options = webdavAuthOptions('alice', 'pw', { headers: { 'X-Custom': '1' } }, 'tok');
    expect(options.authType).toBe('none');
    expect(options.headers).toEqual({ 'X-Custom': '1', Authorization: 'Bearer tok' });
  });
});
