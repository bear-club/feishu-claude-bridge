const queues = new Map<string, Promise<void>>();
const depths = new Map<string, number>();
const cancelled = new Set<string>();

const MAX_QUEUE_DEPTH = 3;

export function enqueue(key: string, fn: () => Promise<void>): Promise<void> | null {
  const depth = depths.get(key) || 0;
  if (depth >= MAX_QUEUE_DEPTH) return null;

  depths.set(key, depth + 1);
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(
    () => cancelled.has(key) ? undefined : fn(),
    () => cancelled.has(key) ? undefined : fn(),
  );
  queues.set(key, next);
  next.finally(() => {
    const d = (depths.get(key) || 1) - 1;
    if (d <= 0) depths.delete(key); else depths.set(key, d);
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
  depths.delete(key);
}
