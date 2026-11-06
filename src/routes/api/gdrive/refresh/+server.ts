import { env } from '$env/dynamic/private';
import type { Config } from '@sveltejs/adapter-vercel';
import type { RequestHandler } from './$types';
import { handleRefresh, methodNotAllowed } from '$lib/server/gdrive-auth';

// Google is given 5 s (AbortSignal.timeout); nothing here should run longer.
export const config: Config = { maxDuration: 10 };

export const POST: RequestHandler = (event) => handleRefresh(event, { env });

// Every other method: the same JSON, no-store answer as the rest of the route.
export const fallback: RequestHandler = () => methodNotAllowed();
