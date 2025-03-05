/**
 * Checks if code is running in a browser environment
 * @returns {boolean} True if in browser, false if in Node.js/SSR
 */
function isBrowser() {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

/**
 * Gets an estimate of available memory in the browser with fallbacks
 * for cross-browser compatibility.
 * @returns {number} Estimated available memory in bytes
 */
export function getAvailableMemory() {
  // Memory units in bytes
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;

  // Default for server-side rendering
  if (!isBrowser()) {
    return 2 * GB; // Conservative default for SSR
  }

  try {
    // Method 1: navigator.deviceMemory API (Chrome, Edge, Opera)
    if (typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number') {
      // deviceMemory is in GB, convert to bytes and assume browser can use ~60%
      return Math.floor(navigator.deviceMemory * GB * 0.6);
    }

    // Method 2: performance.memory API (Chrome, Edge, Opera)
    if (typeof performance !== 'undefined' && performance?.memory?.jsHeapSizeLimit) {
      return performance.memory.jsHeapSizeLimit;
    }

    // Method 3: Estimate based on hardware concurrency (logical CPU cores)
    if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
      // Estimate ~0.75GB per logical core
      const coreBasedEstimate = navigator.hardwareConcurrency * 0.5 * GB;

      // Constrain between reasonable limits
      return Math.max(1 * GB, Math.min(coreBasedEstimate, 8 * GB));
    }

    // Method 4: Platform-specific defaults based on user agent
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      const ua = navigator.userAgent.toLowerCase();

      // Mobile devices
      if (
        ua.includes('mobile') ||
        ua.includes('iphone') ||
        ua.includes('ipad') ||
        ua.includes('android')
      ) {
        return 1.5 * GB; // 1.5GB for mobile devices
      }
    }

    // Desktop browsers - conservative default
    return 4 * GB; // 4GB for desktop browsers
  } catch (error) {
    console.warn('Error determining available memory:', error);
    return 2 * GB; // 2GB as a safe fallback
  }
}

/**
 * Formats memory size in a human-readable format
 * @param {number} bytes - Memory size in bytes
 * @returns {string} Formatted memory size with units
 */
function formatMemory(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
