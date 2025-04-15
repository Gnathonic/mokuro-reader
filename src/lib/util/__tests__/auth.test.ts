import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  saveToken, 
  getToken, 
  isTokenExpired, 
  clearTokens, 
  saveRefreshToken, 
  getRefreshToken 
} from '../auth';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    }
  };
})();

describe('Auth utilities', () => {
  beforeEach(() => {
    // Setup localStorage mock
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      writable: true
    });
    
    // Clear localStorage before each test
    localStorage.clear();
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });
  
  it('should save and retrieve access token', () => {
    const token = 'test-access-token';
    const expiresIn = 3600; // 1 hour
    
    saveToken(token, expiresIn);
    
    expect(getToken()).toBe(token);
  });
  
  it('should save and retrieve refresh token', () => {
    const refreshToken = 'test-refresh-token';
    
    saveRefreshToken(refreshToken);
    
    expect(getRefreshToken()).toBe(refreshToken);
  });
  
  it('should correctly identify expired tokens', () => {
    const token = 'test-access-token';
    const expiresIn = 3600; // 1 hour
    
    // Mock Date.now to return a fixed timestamp
    const now = 1617984000000; // Some fixed timestamp
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    
    saveToken(token, expiresIn);
    
    // Token should not be expired yet
    expect(isTokenExpired()).toBe(false);
    
    // Move time forward to just before expiry (with 5 min buffer)
    vi.spyOn(Date, 'now').mockImplementation(() => now + (expiresIn - 6 * 60) * 1000);
    expect(isTokenExpired()).toBe(false);
    
    // Move time forward to after expiry (with 5 min buffer)
    vi.spyOn(Date, 'now').mockImplementation(() => now + (expiresIn - 4 * 60) * 1000);
    expect(isTokenExpired()).toBe(true);
  });
  
  it('should clear all tokens', () => {
    saveToken('test-access-token', 3600);
    saveRefreshToken('test-refresh-token');
    
    expect(getToken()).not.toBeNull();
    expect(getRefreshToken()).not.toBeNull();
    
    clearTokens();
    
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });
});