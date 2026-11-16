import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mode the module under test sees: production unless a test says dev.
const env = vi.hoisted(() => ({ dev: false }));
vi.mock('$app/env', () => ({
  get dev() {
    return env.dev;
  }
}));
vi.mock('$app/paths', () => ({ resolve: (path: string) => `/${path}` }));

let register: ReturnType<typeof vi.fn>;
let readyState: DocumentReadyState;

beforeEach(() => {
  vi.resetModules();
  env.dev = false;
  register = vi.fn(async () => ({}));
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register }
  });
  readyState = 'complete';
  vi.spyOn(document, 'readyState', 'get').mockImplementation(() => readyState);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

async function registerServiceWorker() {
  const mod = await import('./sw-register');
  mod.registerServiceWorker();
}

describe('registerServiceWorker', () => {
  it('registers a production worker as a CLASSIC script', async () => {
    // SvelteKit 3 registers `{ type: 'module' }` in every build; a browser
    // without module service workers rejects that, losing offline use and the
    // update banner. SvelteKit 2 registered production workers classic.
    await registerServiceWorker();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/service-worker.js', { type: 'classic' });
  });

  it('registers the dev worker as a module (the dev server serves it as one)', async () => {
    env.dev = true;
    await registerServiceWorker();
    expect(register).toHaveBeenCalledWith('/service-worker.js', { type: 'module' });
  });

  it('waits for the load event while the page is still loading', async () => {
    readyState = 'interactive';
    await registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('load'));
    expect(register).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('load'));
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('does nothing where the browser has no service workers', async () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    await expect(registerServiceWorker()).resolves.toBeUndefined();
  });

  it('a rejected registration is logged, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    register.mockRejectedValueOnce(new TypeError('module service workers unsupported'));
    await registerServiceWorker();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });
});
