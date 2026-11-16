/**
 * The informational `sidecar_rule` mokuro-bunko reports in `/login/api/me` and
 * in its cloud marker (`.mokuro-bunko.json`): the sidecar names rule it
 * classifies files by. This reader implements rule {@link SIDECAR_RULE}; a
 * higher rule (a newer fold, a newer UCD) means some crafted or new-script
 * names may be read differently by the two. It is never a gate — the reader
 * classifies by its own rule either way and no data is at risk — so all it
 * does is say so, once per source and rule.
 */
/**
 * The sidecar names rule this reader implements (`sidecar-names.json`'s
 * `rule`). Here, not in `syncable-file.ts`, so dependency-free modules
 * (`webdav/identity.ts`) can note a server's rule; `syncable-file.ts`
 * re-exports it.
 */
export const SIDECAR_RULE = 2;

const noted = new Set<string>();

/**
 * Note the `sidecar_rule` a Bunko reported via `source` (`login-me`,
 * `marker`). Returns the rule when it is a positive integer, else undefined
 * (an older Bunko sends none). Logs once when it is higher than this reader's.
 */
export function noteSidecarRule(source: string, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  if (value > SIDECAR_RULE) {
    const key = `${source}\u0000${value}`;
    if (!noted.has(key)) {
      noted.add(key);
      console.info(
        `[sync] mokuro-bunko names files by sidecar names rule ${value} (${source}); ` +
          `this reader implements rule ${SIDECAR_RULE}. Update the reader to read every ` +
          `name as the server does.`
      );
    }
  }
  return value;
}

/** For tests: forget what was noted. */
export function resetNotedSidecarRules(): void {
  noted.clear();
}
