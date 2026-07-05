import { describe, it, expect } from 'vitest';
import { classifyBrowser, getPopupHelp, type BrowserPlatform } from './popup-help';

const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  operaWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
};

describe('classifyBrowser', () => {
  it('detects desktop Chromium-family browsers, most-specific token first', () => {
    expect(classifyBrowser(UA.edgeWin, 'Google Inc.', false).browser).toBe('edge');
    expect(classifyBrowser(UA.operaWin, 'Google Inc.', false).browser).toBe('opera');
    expect(classifyBrowser(UA.chromeWin, 'Google Inc.', false).browser).toBe('chrome');
  });

  it('detects Brave via the isBrave flag despite a plain-Chrome UA', () => {
    expect(classifyBrowser(UA.chromeWin, 'Google Inc.', true).browser).toBe('brave');
  });

  it('detects Firefox and Safari on desktop', () => {
    expect(classifyBrowser(UA.firefoxLinux, '', false).browser).toBe('firefox');
    const safari = classifyBrowser(UA.safariMac, 'Apple Computer, Inc.', false);
    expect(safari.browser).toBe('safari');
    expect(safari.platform).toBe('desktop');
  });

  it('detects platforms: android and ios (including iOS browser skins)', () => {
    expect(classifyBrowser(UA.chromeAndroid, 'Google Inc.', false).platform).toBe('android');
    expect(classifyBrowser(UA.firefoxAndroid, '', false).platform).toBe('android');
    expect(classifyBrowser(UA.chromeIos, 'Apple Computer, Inc.', false)).toMatchObject({
      browser: 'chrome',
      platform: 'ios'
    });
    expect(classifyBrowser(UA.firefoxIos, 'Apple Computer, Inc.', false)).toMatchObject({
      browser: 'firefox',
      platform: 'ios'
    });
    expect(classifyBrowser(UA.safariIphone, 'Apple Computer, Inc.', false)).toMatchObject({
      browser: 'safari',
      platform: 'ios'
    });
  });
});

describe('getPopupHelp', () => {
  const origin = 'https://reader.example.com';

  function help(browser: BrowserPlatform['browser'], platform: BrowserPlatform['platform']) {
    return getPopupHelp({ browser, platform, standalone: false }, origin);
  }

  it('returns non-empty numbered steps for every browser/platform combination', () => {
    const browsers = ['chrome', 'edge', 'brave', 'opera', 'firefox', 'safari', 'unknown'] as const;
    const platforms = ['desktop', 'android', 'ios'] as const;
    for (const b of browsers) {
      for (const p of platforms) {
        const h = help(b, p);
        expect(h.steps.length, `${b}/${p}`).toBeGreaterThan(0);
        expect(h.name, `${b}/${p}`).toBeTruthy();
      }
    }
  });

  it('provides copyable settings deep links only on desktop Chromium browsers', () => {
    expect(help('chrome', 'desktop').settingsUrl).toContain('chrome://settings');
    expect(help('edge', 'desktop').settingsUrl).toContain('edge://settings');
    expect(help('brave', 'desktop').settingsUrl).toContain('brave://settings');
    expect(help('firefox', 'desktop').settingsUrl).toBeNull();
    expect(help('safari', 'desktop').settingsUrl).toBeNull();
    expect(help('chrome', 'android').settingsUrl).toBeNull();
    expect(help('safari', 'ios').settingsUrl).toBeNull();
  });

  it('marks per-site unattended refresh as unavailable where the browser only has a global toggle', () => {
    // Desktop browsers + Chrome mobile support per-site allow.
    expect(help('chrome', 'desktop').supportsPerSiteAllow).toBe(true);
    expect(help('firefox', 'desktop').supportsPerSiteAllow).toBe(true);
    expect(help('safari', 'desktop').supportsPerSiteAllow).toBe(true);
    expect(help('chrome', 'android').supportsPerSiteAllow).toBe(true);
    // Global-toggle-only platforms.
    expect(help('safari', 'ios').supportsPerSiteAllow).toBe(false);
    expect(help('firefox', 'android').supportsPerSiteAllow).toBe(false);
    expect(help('firefox', 'ios').supportsPerSiteAllow).toBe(false);
    expect(help('edge', 'android').supportsPerSiteAllow).toBe(false);
  });

  it('embeds the site origin into instructions that reference it', () => {
    const h = help('chrome', 'desktop');
    expect(h.settingsUrl).toContain(encodeURIComponent(origin));
  });

  it('adds the standalone (installed PWA) warning on iOS', () => {
    const h = getPopupHelp({ browser: 'safari', platform: 'ios', standalone: true }, origin);
    expect(h.note).toMatch(/home screen/i);
  });

  it('recommends a Chromium browser where hands-off refresh is unreliable', () => {
    expect(help('safari', 'ios').recommendation).toMatch(/chromium/i);
    expect(help('firefox', 'android').recommendation).toMatch(/chromium/i);
    expect(help('edge', 'ios').recommendation).toMatch(/chromium/i);
    expect(help('chrome', 'ios').recommendation).toMatch(/chromium/i);
    // Reliable platforms get no nag.
    expect(help('chrome', 'desktop').recommendation).toBeUndefined();
    expect(help('firefox', 'desktop').recommendation).toBeUndefined();
    expect(help('safari', 'desktop').recommendation).toBeUndefined();
  });
});
