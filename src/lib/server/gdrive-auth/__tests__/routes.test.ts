/**
 * The route modules themselves: POST wired to its handler with the server's
 * private env, every other method answered by `fallback`, and the function's
 * time limit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

import * as session from '../../../../routes/api/gdrive/session/+server';
import * as refresh from '../../../../routes/api/gdrive/refresh/+server';
import * as logout from '../../../../routes/api/gdrive/logout/+server';
import { authEvent, bodyOf, testEnv } from './helpers';

const routes = { session, refresh, logout };

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

describe.each(Object.entries(routes))('/api/gdrive/%s', (name, route) => {
  it('caps the function at 10 s', () => {
    expect(route.config).toEqual({ maxDuration: 10 });
  });

  it('answers 501 not_configured while the server env lacks the secrets', async () => {
    for (const key of Object.keys(env)) delete env[key];
    const event = authEvent({ path: `/api/gdrive/${name}` }) as unknown as RequestEvent;
    const response = await route.POST(event as never);
    expect(response.status).toBe(501);
    expect(await bodyOf(response)).toEqual({ error: 'not_configured' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reads the env at request time', async () => {
    Object.assign(env, testEnv());
    const event = authEvent({ path: `/api/gdrive/${name}` }) as unknown as RequestEvent;
    const response = await route.POST(event as never);
    // Configured now: past the 501 (no cookie / no code → the route's own answer).
    expect(response.status).not.toBe(501);
    for (const key of Object.keys(env)) delete env[key];
  });

  it('answers every other method with JSON 405, no-store', async () => {
    const response = await route.fallback({} as never);
    expect(response.status).toBe(405);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await bodyOf(response)).toEqual({ error: 'method_not_allowed' });
  });
});
