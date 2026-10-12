// DOM enrichment store (page world).
//
// Part 1 §2/§11.1 promised "store + merge ship in v1" and v1 omitted it; this
// is the module that keeps that insurance. The Replies-tab scraper that would
// populate it is Phase-5 (D1), so in v1 nothing calls record() and get()
// normally returns null -- a tested seam waiting for its producer, not a
// feature. Task 8's background consumes merge() when both sources exist.
//
// This runs in the PAGE world (untrusted), which is exactly why the store is
// dumb: keyed by lower-case handle, id-keyed union, API copy winning. Every
// trust decision stays in the extension world (src/shared/security.js).

/**
 * @returns {{
 *   record: (handle: string, replies: object[]) => void,
 *   merge: (handle: string, apiReplies: object[]) => object[],
 *   get: (handle: string) => object[]|null,
 * }}
 */
export function createDomStore() {
  /** Lower-cased handle -> normalised Reply[] (Task 4 shape). */
  const byHandle = new Map();

  const keyOf = (handle) => String(handle ?? "").toLowerCase();

  /** Clamp to the Reply[] contract: objects only, parent id null not absent. */
  function normalize(reply) {
    return { ...reply, parentStatusId: reply.parentStatusId ?? null };
  }

  return {
    record(handle, replies) {
      const key = keyOf(handle);
      if (!key) return;
      const list = Array.isArray(replies) ? replies : [];
      byHandle.set(
        key,
        list.filter((r) => r && typeof r === "object").map(normalize),
      );
    },

    /**
     * Union of the stored replies and the API replies, keyed by reply id,
     * API copy winning on conflict. Entries without a usable id cannot be
     * keyed and are skipped -- on either side.
     */
    merge(handle, apiReplies) {
      const stored = byHandle.get(keyOf(handle)) ?? [];
      const api = Array.isArray(apiReplies) ? apiReplies : [];

      const byId = new Map();
      for (const reply of stored) {
        if (typeof reply?.id === "string" && reply.id.length > 0) {
          byId.set(reply.id, reply);
        }
      }
      for (const reply of api) {
        if (typeof reply?.id === "string" && reply.id.length > 0) {
          byId.set(reply.id, reply);
        }
      }
      return [...byId.values()];
    },

    /** A copy, so a caller can never push into the store's array. */
    get(handle) {
      const stored = byHandle.get(keyOf(handle));
      return stored ? [...stored] : null;
    },
  };
}
