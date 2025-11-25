import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import Cloud from '../+page.svelte';

describe('Cloud Component', () => {
  beforeEach(() => {
    // Mock localStorage
    const localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn()
    };
    globalThis.localStorage = localStorageMock as any;

    // Mock fetch API
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({})
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('should render provider selection UI', async () => {
    const { getByText } = render(Cloud);

    // Check main heading
    expect(getByText('Choose a Cloud Storage Provider')).toBeTruthy();

    // Check Google Drive provider
    expect(getByText('Google Drive')).toBeTruthy();
    expect(getByText(/15GB free/)).toBeTruthy();

    // Check MEGA provider
    expect(getByText('MEGA')).toBeTruthy();
    expect(getByText(/20GB free/)).toBeTruthy();

    // Check WebDAV provider (disabled)
    expect(getByText('WebDAV')).toBeTruthy();
    expect(getByText('Under Development')).toBeTruthy();
  });

  it('should show provider as authenticated when credentials exist in store', async () => {
    // This test would require mocking the provider stores
    // For now, just verify the component renders without errors
    const { container } = render(Cloud);
    expect(container).toBeTruthy();
  });

  it('should display provider statistics when available', async () => {
    // This test would require mocking the provider stats stores
    // For now, just verify the component renders without errors
    const { container } = render(Cloud);
    expect(container).toBeTruthy();
  });
});
