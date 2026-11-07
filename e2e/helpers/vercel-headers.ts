import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The headers `vercel.json` adds to a response for `pathname`, as Vercel would:
 * `vite preview` serves the build without them, so a spec that wants the real
 * deployment's headers (the worker CSP, framing, Permissions-Policy) re-applies
 * them on the way into the browser. Matching is the source as an anchored
 * regexp — exact for the shapes `vercel.json` uses, which
 * `src/lib/security/vercel-headers.test.ts` pins.
 */

interface Rule {
  source: string;
  headers: { key: string; value: string }[];
}

const rules: Rule[] = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')).headers;

export function vercelHeadersFor(pathname: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (!new RegExp(`^${rule.source}$`).test(pathname)) continue;
    for (const { key, value } of rule.headers) out[key.toLowerCase()] = value;
  }
  return out;
}
