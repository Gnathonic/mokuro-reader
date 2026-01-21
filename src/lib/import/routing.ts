/**
 * Import routing logic
 *
 * Decides whether to process imports directly (single item)
 * or send them to the queue (multiple items).
 *
 * Routing Rules:
 * - Single pairing → process immediately (direct)
 * - Multiple pairings → queue all for sequential processing
 * - Empty pairings → no-op
 */

import type { PairedSource } from './types';

/**
 * Result of the routing decision
 */
export interface ImportDecision {
  /** Item to process immediately (null if using queue) */
  directProcess: PairedSource | null;
  /** Items to send to queue (empty if processing directly) */
  queuedItems: PairedSource[];
}

/**
 * Decide how to route paired sources for processing
 *
 * @param pairings - Paired sources from the pairing phase
 * @returns Decision on whether to process directly or queue
 */
export function decideImportRouting(pairings: PairedSource[]): ImportDecision {
  // Empty input - nothing to do
  if (pairings.length === 0) {
    return {
      directProcess: null,
      queuedItems: []
    };
  }

  // Single item - process directly
  if (pairings.length === 1) {
    return {
      directProcess: pairings[0],
      queuedItems: []
    };
  }

  // Multiple items - queue all
  return {
    directProcess: null,
    queuedItems: [...pairings]
  };
}
