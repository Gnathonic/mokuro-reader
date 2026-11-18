/**
 * Delete a megajs node permanently, never throwing: the cleanup after an
 * upload whose receipt did not confirm it (#288), where the upload's own
 * error is the one to report. Main thread (`MegaProvider.uploadFile`) and the
 * backup worker (`mega-core.ts`) alike.
 */
export function deleteMegaNodeBestEffort(node: unknown): Promise<void> {
  const target = node as { delete?: (permanent: boolean, cb: (e: Error | null) => void) => void };
  return new Promise<void>((resolve) => {
    if (typeof target?.delete !== 'function') return resolve();
    try {
      target.delete(true, (error) => {
        if (error) console.warn('MEGA could not remove an unconfirmed upload:', error.message);
        resolve();
      });
    } catch (error) {
      console.warn('MEGA could not remove an unconfirmed upload:', error);
      resolve();
    }
  });
}
