import { installCspViolationBuffer } from '$lib/security/csp-violations';

// The first client code SvelteKit runs: start counting CSP violations before
// any route, provider or extension-facing UI loads (`csp-violations.ts`).
installCspViolationBuffer();
