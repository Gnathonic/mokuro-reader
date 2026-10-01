import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerAuthRefresh,
  createWorkerAuthRefresher,
  isAuthRefreshRequest,
  registerWorkerAuthRefresher,
  refreshInto,
  resetWorkerAuthRefreshersForTest,
  TransientAuthRefreshError,
  type AuthRefreshRequest
} from './worker-auth-refresh';

afterEach(() => resetWorkerAuthRefreshersForTest());

/** A worker and the main thread joined by in-memory "postMessage" channels. */
function wire() {
  const toWorker: Array<(data: unknown) => void> = [];
  const refresher = createWorkerAuthRefresher(
    'webdav',
    // worker -> main: the pool answers it and posts the result back
    (message) => {
      expect(isAuthRefreshRequest(message)).toBe(true);
      void answerAuthRefresh(message as AuthRefreshRequest).then((result) => {
        for (const listener of toWorker) listener(result);
      });
    },
    (handler) => toWorker.push(handler)
  );
  return refresher;
}

describe('worker credential refresh', () => {
  it('round-trips to the main thread and returns its fresh credentials', async () => {
    const mainThread = vi.fn(async (stale: string) => ({
      webdavUrl: 'https://host',
      webdavToken: stale === 'Bearer old' ? 'new' : 'other'
    }));
    registerWorkerAuthRefresher('webdav', mainThread);
    const refresh = wire();
    await expect(refresh('Bearer old')).resolves.toEqual({
      webdavUrl: 'https://host',
      webdavToken: 'new'
    });
    expect(mainThread).toHaveBeenCalledWith('Bearer old');
  });

  it('answers null without a registered refresher, or when it throws', async () => {
    const refresh = wire();
    await expect(refresh('Bearer old')).resolves.toBeNull();
    registerWorkerAuthRefresher('webdav', async () => {
      throw new Error('boom');
    });
    await expect(refresh('Bearer old')).resolves.toBeNull();
  });

  it('matches concurrent answers to their own requests', async () => {
    let n = 0;
    registerWorkerAuthRefresher('webdav', async (stale) => ({ stale, n: ++n }));
    const refresh = wire();
    const [a, b] = await Promise.all([refresh('Bearer a'), refresh('Bearer b')]);
    expect(a).toMatchObject({ stale: 'Bearer a' });
    expect(b).toMatchObject({ stale: 'Bearer b' });
  });

  it('a TRANSIENT failure on the main thread rejects the worker with it, not null (no 401)', async () => {
    registerWorkerAuthRefresher('webdav', async () => {
      throw new TransientAuthRefreshError();
    });
    const answer = await answerAuthRefresh({
      type: 'auth-refresh',
      requestId: 1,
      provider: 'webdav',
      staleAuthorization: 'Bearer old'
    });
    expect(answer).toMatchObject({ credentials: null, transient: true });
    // survives the structured clone a real postMessage applies
    expect(structuredClone(answer).transient).toBe(true);

    const refresh = wire();
    await expect(refresh('Bearer old')).rejects.toBeInstanceOf(TransientAuthRefreshError);
  });

  it('writes fresh credentials back WHOLESALE: a fallback to Basic drops the dead token', async () => {
    const credentials: Record<string, unknown> = {
      webdavUrl: 'https://host',
      webdavUsername: 'alice',
      webdavToken: 'dead'
    };
    const refresh = refreshInto(
      async () => ({ webdavUrl: 'https://host', webdavUsername: 'alice', webdavPassword: 'pw' }),
      credentials
    );
    await refresh('Bearer dead');
    expect(credentials).toEqual({
      webdavUrl: 'https://host',
      webdavUsername: 'alice',
      webdavPassword: 'pw'
    });
    expect(credentials).not.toHaveProperty('webdavToken');
  });

  it('a fresh token replaces the password the message carried, and null changes nothing', async () => {
    const credentials: Record<string, unknown> = {
      webdavUrl: 'https://host',
      webdavPassword: 'pw'
    };
    await refreshInto(async () => null, credentials)('Bearer x');
    expect(credentials).toEqual({ webdavUrl: 'https://host', webdavPassword: 'pw' });
    await refreshInto(
      async () => ({ webdavUrl: 'https://host', webdavToken: 'new' }),
      credentials
    )('Bearer x');
    expect(credentials).toEqual({ webdavUrl: 'https://host', webdavToken: 'new' });
  });
});
