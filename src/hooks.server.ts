import type { Handle } from '@sveltejs/kit';
import { INTEROP_BUILD, hermeticShell } from '$lib/interop/hermetic';

// An interop build serves a shell that names no host off the machine
// ($lib/interop/hermetic.ts). Everywhere else the shell goes out as it is.
export const handle: Handle = INTEROP_BUILD
  ? ({ event, resolve }) =>
      resolve(event, { transformPageChunk: ({ html }) => hermeticShell(html) })
  : ({ event, resolve }) => resolve(event);
