import { describe, expect, it, vi } from 'vitest';
import { cancelProviderUploads, registerUploadCanceller } from './upload-cancellation';

describe('cancelProviderUploads', () => {
  it('runs every registered canceller with the provider and reason, and waits for them', async () => {
    const order: string[] = [];
    const offA = registerUploadCanceller(async (provider, reason) => {
      await Promise.resolve();
      order.push(`a:${provider}:${reason}`);
    });
    const offB = registerUploadCanceller((provider) => {
      order.push(`b:${provider}`);
    });

    await cancelProviderUploads('mega', 'logged out');

    expect(order).toEqual(['a:mega:logged out', 'b:mega']);
    offA();
    offB();
  });

  it('a canceller that throws does not stop the others, nor the caller', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = vi.fn();
    const offA = registerUploadCanceller(() => {
      throw new Error('broken');
    });
    const offB = registerUploadCanceller(second);

    await expect(cancelProviderUploads('mega')).resolves.toBeUndefined();

    expect(second).toHaveBeenCalledWith('mega', expect.any(String));
    offA();
    offB();
    error.mockRestore();
  });

  it('an unregistered canceller is not called', async () => {
    const canceller = vi.fn();
    registerUploadCanceller(canceller)();

    await cancelProviderUploads('mega');

    expect(canceller).not.toHaveBeenCalled();
  });
});
