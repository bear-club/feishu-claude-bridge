const queues = new Map<string, Promise<void>>();
const depths = new Map<string, number>();
const cancelled = new Set<string>();

const MAX_QUEUE_DEPTH = 3;

export function enqueue(key: string, fn: () => Promise<void>): Promise<void> | null {
  if (cancelled.has(key) && !queues.has(key)) {
    console.log(`[queue] 清除残留 cancelled 状态 key=${key.slice(-8)}`);
    cancelled.delete(key);
  }

  const depth = depths.get(key) || 0;
  if (depth >= MAX_QUEUE_DEPTH) {
    console.log(`[queue] 队列已满 key=${key.slice(-8)} depth=${depth}`);
    return null;
  }

  depths.set(key, depth + 1);
  console.log(`[queue] 入队 key=${key.slice(-8)} depth=${depth + 1} cancelled=${cancelled.has(key)}`);
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(
    () => {
      if (cancelled.has(key)) {
        console.log(`[queue] 跳过已取消任务 key=${key.slice(-8)}`);
        return undefined;
      }
      return fn();
    },
    () => {
      if (cancelled.has(key)) {
        console.log(`[queue] 跳过已取消任务(err) key=${key.slice(-8)}`);
        return undefined;
      }
      return fn();
    },
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
  console.log(`[queue] cancelQueue key=${key.slice(-8)} queues=${queues.has(key)} depth=${depths.get(key)}`);
  cancelled.add(key);
  queues.delete(key);
  depths.delete(key);
}
