/**
 * Shared memory manager for coordinating memory usage across multiple worker pools
 * Prevents different pools from independently exceeding system memory limits
 */

class SharedMemoryManager {
  private currentUsage = 0;
  private maxUsage = 500 * 1024 * 1024; // 500 MB default
  private reservations = new Map<string, number>(); // poolId -> reserved memory

  /**
   * Initialize the memory limit based on user's RAM configuration
   */
  setMemoryLimit(memoryLimitMB: number): void {
    this.maxUsage = memoryLimitMB * 1024 * 1024;
    console.log(`[Shared Memory] Memory limit set to ${memoryLimitMB}MB`);
  }

  /**
   * Check if we can start a new task
   * Returns true if current usage is within limits (or if we have no active tasks)
   *
   * Note: We check CURRENT usage, not projected usage after adding a new task.
   * This allows large single tasks to run even if they exceed the conservative limit.
   */
  canStartNewTask(hasActiveTasks: boolean): boolean {
    // Always allow at least one task to run, even if it exceeds the limit
    if (!hasActiveTasks) {
      return true;
    }

    // Only block if we're already over the limit
    return this.currentUsage <= this.maxUsage;
  }

  /**
   * Reserve memory for a task
   * Always succeeds - just tracks the allocation
   */
  reserve(poolId: string, taskId: string, amount: number): void {
    const key = `${poolId}:${taskId}`;

    // Reserve the memory (always succeeds)
    this.reservations.set(key, amount);
    this.currentUsage += amount;

    console.log(
      `[Shared Memory] Reserved ${(amount / (1024 * 1024)).toFixed(1)}MB for ${poolId}:${taskId}. Total: ${(this.currentUsage / (1024 * 1024)).toFixed(1)}MB / ${(this.maxUsage / (1024 * 1024)).toFixed(1)}MB (${((this.currentUsage / this.maxUsage) * 100).toFixed(1)}%)`
    );
  }

  /**
   * Release memory when a task completes
   */
  release(poolId: string, taskId: string): void {
    const key = `${poolId}:${taskId}`;
    const amount = this.reservations.get(key);

    if (amount !== undefined) {
      this.currentUsage = Math.max(0, this.currentUsage - amount);
      this.reservations.delete(key);

      console.log(
        `[Shared Memory] Released ${(amount / (1024 * 1024)).toFixed(1)}MB from ${poolId}:${taskId}. Total: ${(this.currentUsage / (1024 * 1024)).toFixed(1)}MB / ${(this.maxUsage / (1024 * 1024)).toFixed(1)}MB (${((this.currentUsage / this.maxUsage) * 100).toFixed(1)}%)`
      );
    }
  }

  /**
   * Get current memory usage statistics
   */
  getStats() {
    return {
      current: this.currentUsage,
      max: this.maxUsage,
      percentUsed: (this.currentUsage / this.maxUsage) * 100,
      reservationCount: this.reservations.size
    };
  }

  /**
   * Reset all memory tracking (useful for testing or pool termination)
   */
  reset(): void {
    this.currentUsage = 0;
    this.reservations.clear();
    console.log('[Shared Memory] Reset all memory tracking');
  }
}

// Export singleton instance
export const sharedMemoryManager = new SharedMemoryManager();
