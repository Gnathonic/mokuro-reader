import { describe, expect, it } from 'vitest';
import {
  isMfaRequiredError,
  isSessionExpiredError,
  isAuthRejectionError,
  sanitizeSessionBlob,
  encodeMegaKey
} from './mega-session';

describe('mega-session error classifiers', () => {
  it('detects 2FA-required from the EMFAREQUIRED message', () => {
    expect(
      isMfaRequiredError(new Error('EMFAREQUIRED (-26): Multi-Factor Authentication Required'))
    ).toBe(true);
    expect(isMfaRequiredError(new Error('wrong password'))).toBe(false);
  });

  it('detects expired session from the ESID message', () => {
    expect(
      isSessionExpiredError(
        new Error('ESID (-15): Invalid or expired user session, please relogin')
      )
    ).toBe(true);
    expect(isSessionExpiredError(new Error('EAGAIN congestion'))).toBe(false);
  });

  it('detects genuine auth rejection but not transient errors', () => {
    expect(isAuthRejectionError(new Error('wrong password'))).toBe(true);
    expect(isAuthRejectionError(new Error('ENOENT'))).toBe(true);
    expect(isAuthRejectionError(new Error('network timeout'))).toBe(false);
  });
});

describe('sanitizeSessionBlob', () => {
  it('keeps sid/key/user/name and strips password + secondFactorCode from options', () => {
    const blob = sanitizeSessionBlob({
      key: 'KEY',
      sid: 'SID',
      name: 'n',
      user: 'u',
      options: { email: 'a@b.c', password: 'p', secondFactorCode: '123456', autoload: true }
    });
    expect(blob).toEqual({
      key: 'KEY',
      sid: 'SID',
      name: 'n',
      user: 'u',
      options: { email: 'a@b.c', autoload: true }
    });
    expect(blob.options).not.toHaveProperty('password');
    expect(blob.options).not.toHaveProperty('secondFactorCode');
  });
});

describe('encodeMegaKey', () => {
  it('produces URL-safe base64 without padding (matches megajs e64)', () => {
    // btoa('\xff\xff\xff') === '////'  -> '____'
    expect(encodeMegaKey(new Uint8Array([255, 255, 255]))).toBe('____');
    // btoa('\x00') === 'AA==' -> strip padding -> 'AA'
    expect(encodeMegaKey(new Uint8Array([0]))).toBe('AA');
  });
});
