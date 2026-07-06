import { describe, expect, it } from 'vitest';
import {
  getMegaReferralUrl,
  shouldOfferMegaUpgrade,
  MEGA_UPGRADE_OFFER_THRESHOLD
} from './referral';

describe('getMegaReferralUrl', () => {
  it('returns null when the env var is unset or empty', () => {
    expect(getMegaReferralUrl({})).toBeNull();
    expect(getMegaReferralUrl({ VITE_MEGA_REFERRAL_URL: '' })).toBeNull();
    expect(getMegaReferralUrl({ VITE_MEGA_REFERRAL_URL: undefined })).toBeNull();
  });

  it('returns the URL for https MEGA domains', () => {
    expect(getMegaReferralUrl({ VITE_MEGA_REFERRAL_URL: 'https://mega.nz/aff=AbCd1234' })).toBe(
      'https://mega.nz/aff=AbCd1234'
    );
    expect(getMegaReferralUrl({ VITE_MEGA_REFERRAL_URL: 'https://mega.io/pro?aff=x' })).toBe(
      'https://mega.io/pro?aff=x'
    );
  });

  it('rejects non-MEGA hosts and non-https URLs (misconfiguration guard)', () => {
    expect(getMegaReferralUrl({ VITE_MEGA_REFERRAL_URL: 'https://example.com/aff=x' })).toBeNull();
    expect(
      getMegaReferralUrl({ VITE_MEGA_REFERRAL_URL: 'https://mega.nz.evil.com/aff=x' })
    ).toBeNull();
    expect(getMegaReferralUrl({ VITE_MEGA_REFERRAL_URL: 'http://mega.nz/aff=x' })).toBeNull();
    expect(getMegaReferralUrl({ VITE_MEGA_REFERRAL_URL: 'not a url' })).toBeNull();
  });
});

describe('shouldOfferMegaUpgrade', () => {
  const url = 'https://mega.nz/aff=x';

  it('is false without a referral URL, without quota data, or with an unknown total', () => {
    expect(shouldOfferMegaUpgrade({ used: 100, total: 100, available: 0 }, null)).toBe(false);
    expect(shouldOfferMegaUpgrade(null, url)).toBe(false);
    expect(shouldOfferMegaUpgrade({ used: 100, total: null, available: null }, url)).toBe(false);
  });

  it('is true at or above the offer threshold and false below it', () => {
    const total = 1000;
    const atThreshold = Math.ceil(total * MEGA_UPGRADE_OFFER_THRESHOLD);
    expect(
      shouldOfferMegaUpgrade({ used: atThreshold, total, available: total - atThreshold }, url)
    ).toBe(true);
    expect(shouldOfferMegaUpgrade({ used: total, total, available: 0 }, url)).toBe(true);
    expect(shouldOfferMegaUpgrade({ used: 500, total, available: 500 }, url)).toBe(false);
  });
});
