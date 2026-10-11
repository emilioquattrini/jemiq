import { createHash } from 'node:crypto';
import type { D1Database } from './storage/d1-r2';

export interface RateBudget { take(scope: string, key: string, limit: number, windowMs: number): Promise<boolean> }

export function createMemoryBudget(): RateBudget {
  const entries = new Map<string, { start: number; count: number }>();
  return { async take(scope, key, limit, windowMs) {
    const now = Date.now();
    const id = `${scope}:${key}`;
    for (const [name, entry] of entries) if (now - entry.start >= 86_400_000) entries.delete(name);
    let entry = entries.get(id);
    if (!entry || now - entry.start >= windowMs) {
      if (!entry && entries.size >= 5000) return false;
      entry = { start: now, count: 0 }; entries.set(id, entry);
    }
    return ++entry.count <= limit;
  } };
}

/** Atomic SQL counters survive Worker restarts and are shared by every isolate. */
export function createD1Budget(db: D1Database): RateBudget {
  let lastCleanup = 0;
  return { async take(scope, key, limit, windowMs) {
    const now = Date.now();
    const id = createHash('sha256').update(`${scope}\0${key}`).digest('hex');
    if (now - lastCleanup > 60_000) {
      await db.prepare('DELETE FROM request_budgets WHERE window_start < ?').bind(now - 86_400_000).run();
      lastCleanup = now;
    }
    const result = await db.prepare(`INSERT INTO request_budgets (key, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END
      RETURNING count`).bind(id, now, now, windowMs, now, windowMs, now).first<{ count: number }>();
    // A persistence error must never turn into an unlimited paid request.
    if (!result) throw new Error('Rate budget unavailable');
    return result.count <= limit;
  } };
}
