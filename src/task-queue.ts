const queues = new Map<string, Promise<void>>();
const cancelled = new Set<string>();

export function enqueue(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(
    () => cancelled.has(key) ? undefined : fn(),
    () => cancelled.has(key) ? undefined : fn(),
  );
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) {
      queues.delete(key);
      cancelled.delete(key);
    }
  });
  return next;
}

export function cancelQueue(key: string): void {
  cancelled.add(key);
  queues.delete(key);
}
