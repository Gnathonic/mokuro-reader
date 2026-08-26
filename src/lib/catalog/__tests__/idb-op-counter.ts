const STORE_OPS = [
  'getAll',
  'get',
  'put',
  'add',
  'delete',
  'count',
  'openCursor',
  'getAllKeys'
] as const;
const INDEX_OPS = ['getAll', 'openCursor', 'count', 'getAllKeys'] as const;

/**
 * Counts IndexedDB operations issued while `fn` runs, keyed `"<store>.<op>"`
 * (index reads are keyed `"<store>.idx.<op>"`).
 *
 * These counts are the assertion surface for our performance contracts: the
 * behaviours this suite guards are all "how many times", never "what result",
 * so an ordinary correctness test cannot see a regression in them.
 */
export async function countIdbOps(fn: () => Promise<void>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  const storeProto = IDBObjectStore.prototype as unknown as Record<string, unknown>;
  const indexProto = IDBIndex.prototype as unknown as Record<string, unknown>;
  const saved: Array<[Record<string, unknown>, string, unknown]> = [];

  for (const op of STORE_OPS) {
    const orig = storeProto[op] as ((...a: unknown[]) => unknown) | undefined;
    if (!orig) continue;
    saved.push([storeProto, op, orig]);
    storeProto[op] = function (this: IDBObjectStore, ...a: unknown[]) {
      bump(`${this.name}.${op}`);
      return orig.apply(this, a);
    };
  }
  for (const op of INDEX_OPS) {
    const orig = indexProto[op] as ((...a: unknown[]) => unknown) | undefined;
    if (!orig) continue;
    saved.push([indexProto, `idx.${op}`, orig]);
    indexProto[op] = function (this: IDBIndex, ...a: unknown[]) {
      bump(`${this.objectStore.name}.idx.${op}`);
      return orig.apply(this, a);
    };
  }

  try {
    await fn();
    return counts;
  } finally {
    for (const [proto, key, orig] of saved) {
      proto[key.startsWith('idx.') ? key.slice(4) : key] = orig;
    }
  }
}
