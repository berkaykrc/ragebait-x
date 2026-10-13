import { fetchReplies as fetchFxtwitterReplies } from "./fxtwitter.js";

export const fxtwitterAdapter = {
  name: "fxtwitter",
  fetchReplies(handle, deps) {
    return fetchFxtwitterReplies(handle, deps);
  },
};

export function domAdapter(store) {
  const obj = {
    name: "dom",
    fetchReplies(handle) {
      const replies = store && typeof store.get === "function"
        ? store.get(handle)
        : null;
      if (Array.isArray(replies) && replies.length > 0) {
        return { ok: true, replies: [...replies] };
      }
      return { ok: false, reason: "not_found", replies: [] };
    },
  };
  return obj;
}

export const createDomAdapter = domAdapter;
export const makeDomAdapter = domAdapter;

export function mergeAdapters(primary, fallback) {
  return {
    name: `${primary?.name ?? "primary"}+${fallback?.name ?? "fallback"}`,
    async fetchReplies(handle, deps) {
      const first = await (primary?.fetchReplies?.(handle, deps) ??
        { ok: false, reason: "network", replies: [] });
      if (first && first.ok) return first;
      return (fallback?.fetchReplies?.(handle, deps)) ??
        { ok: false, reason: "network", replies: [] };
    },
  };
}
