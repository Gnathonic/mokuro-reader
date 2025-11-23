import { browser } from '$app/environment';

/**
 * Detects if the current platform is mobile (phone or tablet) or desktop
 * Uses multiple detection methods for better accuracy
 */
export function isMobilePlatform(): boolean {
  if (!browser) {
    return false; // SSR fallback - assume desktop
  }

  // Method 1: Check for touch support (primary indicator)
  const hasTouchScreen = 'maxTouchPoints' in navigator && navigator.maxTouchPoints > 0;

  // Method 2: Check user agent for mobile keywords
  const userAgent = navigator.userAgent.toLowerCase();
  const mobileKeywords = [
    'mobile',
    'iphone',
    'ipad',
    'ipod',
    'android',
    'blackberry',
    'windows phone',
    'webos'
  ];
  const hasMobileUA = mobileKeywords.some((keyword) => userAgent.includes(keyword));

  // Method 3: Check screen size (mobile typically <= 768px wide)
  const hasSmallScreen = window.innerWidth <= 768;

  // Combine signals: Touch + (mobile UA or small screen) = likely mobile
  // OR: Touch + small screen (catches tablets in portrait)
  return hasTouchScreen && (hasMobileUA || hasSmallScreen);
}

/**
 * Gets a platform-appropriate label for UI display
 */
export function getPlatformLabel(): string {
  return isMobilePlatform() ? 'Mobile' : 'Desktop';
}
