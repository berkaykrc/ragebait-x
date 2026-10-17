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
