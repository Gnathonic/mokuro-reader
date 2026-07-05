/**
 * Browser/platform detection + verified per-browser instructions for allowing
 * popups, used by the Google Drive auto-re-auth helper.
 *
 * Instruction sources (verified 2026-07 against vendor docs):
 * - Chrome:  support.google.com/chrome/answer/95472 (Desktop/Android/iOS)
 * - Edge:    support.microsoft.com/en-us/microsoft-edge/block-pop-ups-in-microsoft-edge-1d8ba4f8-f385-9a0b-e944-aa47339b6bb5
 * - Firefox: support.mozilla.org/en-US/kb/pop-blocker-settings-exceptions-troubleshooting
 * - Safari:  support.apple.com/guide/safari/block-pop-ups-sfri40696/mac,
 *            support.apple.com/guide/iphone/block-pop-ups-ipha49a83ae8/ios
 * - Brave:   support.brave.app/hc/en-us/articles/360018205431
 *
 * Key facts encoded here:
 * - iOS Safari / Firefox (all platforms' mobile) / mobile Edge only have a
 *   GLOBAL popup toggle — no per-site allow. Chrome mobile allows per-site via
 *   the "Pop-ups blocked → Always show" banner.
 * - chrome://, edge://, brave:// settings URLs work when the USER pastes them
 *   into the address bar; web pages cannot navigate to them.
 * - Popup permission is only needed for UNATTENDED refresh. The app also
 *   retries the OAuth popup inside the next user gesture (see
 *   user-gesture.ts), which works everywhere with no settings changes.
 */

export interface BrowserPlatform {
  browser: 'chrome' | 'edge' | 'brave' | 'opera' | 'firefox' | 'safari' | 'unknown';
  platform: 'desktop' | 'android' | 'ios';
  standalone: boolean;
}

export interface PopupHelp {
  /** Display name, e.g. "Microsoft Edge" */
  name: string;
  /** Numbered steps shown to the user */
  steps: string[];
  /** Copyable settings deep link (user must paste it — pages can't open it) */
  settingsUrl: string | null;
  /** Whether this browser/platform can allow popups for JUST this site */
  supportsPerSiteAllow: boolean;
  /** Extra caveat worth surfacing */
  note?: string;
  /** Shown when hands-off refresh is unreliable here — suggests a better browser */
  recommendation?: string;
}

/** Pure classification from UA/vendor strings — testable without a browser. */
export function classifyBrowser(
  ua: string,
  vendor: string,
  isBrave: boolean
): Omit<BrowserPlatform, 'standalone'> & { standalone: boolean } {
  const platform: BrowserPlatform['platform'] = /iPhone|iPad|iPod/.test(ua)
    ? 'ios'
    : /Android/.test(ua)
      ? 'android'
      : 'desktop';

  let browser: BrowserPlatform['browser'];
  if (isBrave) {
    browser = 'brave';
  } else if (platform === 'ios') {
    // Every iOS browser is WebKit; the skin is identified by its own token.
    browser = /CriOS\//.test(ua)
      ? 'chrome'
      : /FxiOS\//.test(ua)
        ? 'firefox'
        : /EdgiOS\//.test(ua)
          ? 'edge'
          : 'safari';
  } else if (/Edg\//.test(ua)) {
    browser = 'edge';
  } else if (/OPR\//.test(ua)) {
    browser = 'opera';
  } else if (/Firefox\//.test(ua)) {
    browser = 'firefox';
  } else if (/Chrome\//.test(ua)) {
    browser = 'chrome';
  } else if (/Safari\//.test(ua) && /Apple/.test(vendor)) {
    browser = 'safari';
  } else {
    browser = 'unknown';
  }

  return { browser, platform, standalone: false };
}

/** Detect the live environment (async because Brave detection is a promise). */
export async function detectBrowserPlatform(): Promise<BrowserPlatform> {
  let isBrave = false;
  try {
    const nav = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } };
    isBrave = (await nav.brave?.isBrave?.()) ?? false;
  } catch {
    isBrave = false;
  }

  const result = classifyBrowser(navigator.userAgent, navigator.vendor ?? '', isBrave);

  // iPadOS masquerades as macOS but is still touch-first WebKit with the same
  // global-only popup toggle as iPhone.
  if (
    result.platform === 'desktop' &&
    /Apple/.test(navigator.vendor ?? '') &&
    navigator.maxTouchPoints > 1
  ) {
    result.platform = 'ios';
  }

  const standalone =
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  return { ...result, standalone };
}

const GLOBAL_TOGGLE_NOTE =
  'This browser only has an all-sites popup toggle — most people should skip this and rely on the built-in click-to-reconnect instead.';

const CHROMIUM_RECOMMENDATION =
  'For reliable hands-off Google Drive syncing, use a Chromium browser instead — Chrome, Edge, or Brave on desktop, or Chrome on Android, all support allowing popups for just this site.';

export function getPopupHelp(bp: BrowserPlatform, origin: string): PopupHelp {
  const encodedOrigin = encodeURIComponent(origin);

  let help: PopupHelp;

  switch (`${bp.browser}/${bp.platform}`) {
    case 'chrome/desktop':
      help = {
        name: 'Chrome',
        steps: [
          'Click "Test popup permission" below — Chrome will block the test and show a "Pop-up blocked" icon at the right end of the address bar',
          'Click that icon, choose "Always allow pop-ups and redirects from this site", then click Done',
          'Or copy the settings link below, paste it into the address bar, and set "Pop-ups and redirects" to Allow'
        ],
        settingsUrl: `chrome://settings/content/siteDetails?site=${encodedOrigin}`,
        supportsPerSiteAllow: true
      };
      break;
    case 'chrome/android':
      help = {
        name: 'Chrome',
        steps: [
          'Tap "Test popup permission" below — Chrome shows "Pop-ups blocked" at the bottom of the screen',
          'Tap "Always show" to allow popups for this site'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: true
      };
      break;
    case 'chrome/ios':
      help = {
        name: 'Chrome',
        steps: [
          'Tap "Test popup permission" below — Chrome shows "Pop-ups blocked" at the bottom of the screen',
          'Tap "Always show" to allow popups for this site'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: true,
        note: 'Background popups are unreliable on iOS — expect to reconnect with a tap now and then even after allowing.'
      };
      break;
    case 'edge/desktop':
      help = {
        name: 'Microsoft Edge',
        steps: [
          'Click "Test popup permission" below — Edge will block the test and show a blocked-popup icon at the right end of the address bar',
          'Click that icon and choose "Always allow pop-ups and redirects from this site"',
          'Or: Settings and more (⋯) → Settings → Privacy, search, and services → Site permissions → All permissions → Pop-ups and redirects → add this site under "Allowed"',
          'Or copy the settings link below and paste it into the address bar'
        ],
        settingsUrl: `edge://settings/content/siteDetails?site=${encodedOrigin}`,
        supportsPerSiteAllow: true
      };
      break;
    case 'brave/desktop':
      help = {
        name: 'Brave',
        steps: [
          'Open Settings → Privacy and security → Site and Shields Settings → Pop-ups and redirects',
          'Under "Customized behavior", click Add next to the allowed list and enter this site',
          'Or copy the settings link below and paste it into the address bar'
        ],
        settingsUrl: 'brave://settings/content/pop-ups',
        supportsPerSiteAllow: true,
        note: 'If sign-in still fails, click the Brave lion icon in the address bar and relax Shields for this site.'
      };
      break;
    case 'brave/android':
      help = {
        name: 'Brave',
        steps: [
          'Menu (⋮) → Settings → Site settings → Pop-ups and redirects',
          'Allow popups, or add this site to the allowed list'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: true,
        note: 'The Brave lion icon → Advanced controls also has a per-site popup setting.'
      };
      break;
    case 'opera/desktop':
      help = {
        name: 'Opera',
        steps: [
          'Open Settings → Privacy & security → Site settings → Pop-ups and redirects',
          'Click Add next to the Allow list and enter this site'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: true
      };
      break;
    case 'firefox/desktop':
      help = {
        name: 'Firefox',
        steps: [
          'Click "Test popup permission" below — Firefox will show a notification bar saying it prevented a pop-up',
          'In that bar, choose "Allow pop-ups for this site" (this is permanent)',
          'Or: Menu (☰) → Settings → Privacy & Security → scroll to Permissions → next to the pop-up blocker setting click "Manage Exceptions…" → add this site → Allow → Save Changes'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: true
      };
      break;
    case 'firefox/android':
      help = {
        name: 'Firefox',
        steps: [
          'Menu (⋮) → Settings → Privacy and security',
          'Turn off "Block pop-up windows" (applies to all sites)'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: false,
        note: GLOBAL_TOGGLE_NOTE
      };
      break;
    case 'firefox/ios':
      help = {
        name: 'Firefox',
        steps: [
          'Open the tab tray, tap the gear (Settings) icon',
          'Turn off "Block Pop-up Windows" (applies to all sites)'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: false,
        note: GLOBAL_TOGGLE_NOTE
      };
      break;
    case 'safari/desktop':
      help = {
        name: 'Safari',
        steps: [
          'Right-click the address bar and choose "Settings for This Website…", then set "Pop-up Windows" to Allow',
          'Or: Safari menu → Settings… → Websites → Pop-up Windows → find this site → Allow'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: true
      };
      break;
    case 'safari/ios':
      help = {
        name: 'Safari',
        steps: [
          'Open the Settings app → Apps → Safari',
          'Turn off "Block Pop-ups" (applies to all sites)'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: false,
        note: GLOBAL_TOGGLE_NOTE
      };
      break;
    case 'edge/android':
    case 'edge/ios':
      help = {
        name: 'Microsoft Edge',
        steps: [
          'Menu (⋯) → Settings → Privacy and security',
          'Turn off the popup blocker (applies to all sites)'
        ],
        settingsUrl: null,
        supportsPerSiteAllow: false,
        note: GLOBAL_TOGGLE_NOTE
      };
      break;
    default:
      help =
        bp.platform === 'desktop'
          ? {
              name: 'your browser',
              steps: [
                'Click "Test popup permission" below — look for a popup-blocked icon in the address bar',
                'Click it and choose "Always allow pop-ups from this site"'
              ],
              settingsUrl: null,
              supportsPerSiteAllow: true
            }
          : {
              name: 'your browser',
              steps: [
                'Look for a "popup blocked" notice after using the test button below',
                'Allow popups for this site if offered, or find the popup blocker in your browser settings'
              ],
              settingsUrl: null,
              supportsPerSiteAllow: false
            };
  }

  if (bp.standalone && bp.platform === 'ios') {
    help = {
      ...help,
      note: 'This app is installed to the Home Screen — iOS often blocks sign-in popups entirely in this mode. If reconnecting fails, open the site in Safari itself.'
    };
  }

  // Hands-off refresh is unreliable wherever per-site allow doesn't exist,
  // and on all of iOS (WebKit popup behavior) — steer users to a Chromium
  // browser for the smooth experience.
  if (!help.supportsPerSiteAllow || bp.platform === 'ios') {
    help = { ...help, recommendation: CHROMIUM_RECOMMENDATION };
  }

  return help;
}
