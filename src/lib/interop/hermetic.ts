/**
 * An interop build (`vite build --mode interop`, the reader mokuro-bunko's rig
 * drives) reaches no host off the machine but the ones `__mokuroInteropConfig`
 * points it at. The rig refuses every other request and fails the spec that
 * made it, so the run never needs the network and never talks to a real
 * service. Such a build therefore leaves out what a production page loads from
 * a third party: the Noto Sans JP web font (`loadWebFonts`; text lays out in
 * the fallback font) and the absolute addresses in `app.html` (`hermeticShell`,
 * applied by `hooks.server.ts`). The two Google scripts are not in the shell
 * at all: they are injected on demand (`google-scripts.ts`: an active Drive at
 * boot, or the cloud page), and the rig answers them with an empty script.
 *
 * A compile-time constant, false in production and under Vitest, so a
 * production build keeps all of it.
 */
export const INTEROP_BUILD: boolean = import.meta.env.MODE === 'interop';

/**
 * The page shell without its off-machine addresses: the `<link>`s to another
 * host (the font host's preconnects) are dropped, and a CSS `url()` to one (the
 * jidoujisho icon's background) becomes `none`. `<script src>` is left alone.
 */
export function hermeticShell(html: string): string {
  return html
    .replace(/<link\b[^>]*\bhref="https?:\/\/[^"]*"[^>]*>[ \t]*\r?\n?/g, '')
    .replace(/url\((['"]?)https?:\/\/[^'")]*\1\)/g, 'none');
}
