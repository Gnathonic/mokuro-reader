import { installCspViolationBuffer } from '$lib/security/csp-violations';
import { registerServiceWorker } from '$lib/util/sw-register';

// The first client code SvelteKit runs: start counting CSP violations before
// any route, provider or extension-facing UI loads (`csp-violations.ts`).
installCspViolationBuffer();

// The app registers its own service worker, as a classic script in production
// (`sw-register.ts` says why SvelteKit's registration is switched off).
registerServiceWorker();
