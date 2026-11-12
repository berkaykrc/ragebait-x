// Local daily profile quota (Task 8).
//
// `consumeDailyProfile(storage, now, limit)` is the single chokepoint for the
// per-install daily profile cap. It never touches the network; it only reads
// and writes the `stats:{YYYY-MM-DD}` counter in `storage`.
//
// `storage` follows the cache seam: get(key) -> stored value (sync or Promise),
// set(key, value) -> void (sync or Promise). The counter may be stored as a
// plain number or as `{count}` / `{profiles}`; we accept all three so a
// storage adapter and a test fake can both drive it.

export const MAX_DAILY_PROFILES = 200;
export const DEFAULT_RETENTION_DAYS = 7;

// The literal template the Interfaces block names. The concrete key is
// `stats:` + the ISO date derived from `now()`.
export const DAILY_KEY = "stats:{YYYY-MM-DD}";

function dayKey(nowMs) {
  const d = new Date(nowMs);
  // UTC date keeps the counter stable across time zones.
  return d.toISOString().slice(0, 10);
}

function readCount(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (typeof raw.count === "number" && Number.isFinite(raw.count)) {
      return raw.count;
    }
    if (typeof raw.profiles === "number" && Number.isFinite(raw.profiles)) {
      return raw.profiles;
    }
  }
  return 0;
}

export async function consumeDailyProfile(
  storage,
  now,
  limit = MAX_DAILY_PROFILES,
) {
  const nowMs = typeof now === "function"
    ? now()
    : (typeof now === "number" ? now : Date.now());
  const key = `stats:${dayKey(nowMs)}`;
  const lim = typeof limit === "number" && Number.isFinite(limit)
    ? limit
    : MAX_DAILY_PROFILES;

  let current = 0;
  try {
    const raw = storage && typeof storage.get === "function"
      ? await storage.get(key)
      : null;
    current = readCount(raw);
  } catch {
    current = 0;
  }

  if (current >= lim) {
    return { allowed: false, remaining: 0 };
  }

  const next = current + 1;
  try {
    if (storage && typeof storage.set === "function") {
      await storage.set(key, next);
    }
  } catch {
    // Swallow: a failed write must not throw out of the quota check.
  }

  return { allowed: true, remaining: Math.max(0, lim - next) };
}

/**
 * Prune historical `stats:YYYY-MM-DD` counters older than `retentionDays`.
 * Respects data minimisation by evicting stale quota counters.
 * Tolerates storage adapters that lack bulk-read or removal capabilities.
 *
 * @param {object} storage
 * @param {(() => number)|number} [now]
 * @param {number} [retentionDays]
 * @returns {Promise<string[]>} list of pruned keys
 */
export async function pruneOldDailyStats(
  storage,
  now,
  retentionDays = DEFAULT_RETENTION_DAYS,
) {
  if (!storage) return [];
  if (
    typeof retentionDays !== "number" ||
    !Number.isFinite(retentionDays) ||
    retentionDays < 1
  ) {
    return [];
  }
  const nowMs = typeof now === "function"
    ? now()
    : (typeof now === "number" ? now : Date.now());
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    return [];
  }
  let cutoffKey;
  try {
    const cutoffMs = nowMs - retentionDays * 24 * 3600 * 1000;
    cutoffKey = `stats:${dayKey(cutoffMs)}`;
  } catch {
    return [];
  }

  let keys = [];
  try {
    if (typeof storage.keys === "function") {
      keys = await storage.keys();
    } else if (typeof storage.getAll === "function") {
      const all = await storage.getAll();
      keys = all ? Object.keys(all) : [];
    }
    // No `get(null)` fallback: this seam is key -> value, so `get(null)`
    // would return a single value, not all keys. Require keys()/getAll().
  } catch {
    return [];
  }

  if (!Array.isArray(keys) || keys.length === 0) return [];

  // Keep exactly `retentionDays` dates: cutoff day itself is expired,
  // so `<=` prunes it (keeps today - (retentionDays - 1) .. today).
  const toRemove = keys.filter((k) =>
    typeof k === "string" &&
    k.startsWith("stats:") &&
    k <= cutoffKey &&
    /^stats:\d{4}-\d{2}-\d{2}$/.test(k)
  );

  if (toRemove.length === 0) return [];

  const removed = [];
  try {
    if (typeof storage.remove === "function") {
      await storage.remove(toRemove);
      removed.push(...toRemove);
    } else if (typeof storage.delete === "function") {
      for (const k of toRemove) {
        try {
          await storage.delete(k);
          removed.push(k);
        } catch {
          // Per-key fail-safe: one bad key must not stop the rest.
        }
      }
    }
  } catch {
    // Fail-safe: pruning error must never disrupt operations.
    return removed;
  }

  return removed;
}
