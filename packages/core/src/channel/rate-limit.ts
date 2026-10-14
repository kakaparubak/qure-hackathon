/**
 * Per-phone outbound pacing.
 *
 * Rapid identical sends are what spam heuristics look for, and the number is
 * the demo. Sends are delayed, never dropped: a patient waiting on their
 * emergency reply must not have it silently discarded.
 */

export interface RateLimiter {
  wait(phone: string): Promise<void>;
}

export function createRateLimiter(minIntervalMs: number): RateLimiter {
  const lastSentAt = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();

  async function pace(phone: string): Promise<void> {
    const previous = lastSentAt.get(phone);
    const now = Date.now();

    if (previous !== undefined) {
      const remaining = minIntervalMs - (now - previous);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }

    lastSentAt.set(phone, Date.now());
  }

  return {
    wait(phone: string): Promise<void> {
      // Chain onto this phone's tail so concurrent sends serialise instead of
      // all reading the same "last sent" timestamp.
      const tail = queues.get(phone) ?? Promise.resolve();
      const next = tail.then(() => pace(phone));
      queues.set(
        phone,
        next.catch(() => undefined),
      );
      return next;
    },
  };
}
