// Reply extraction for FxTwitter profiles.
//
// Pure, side-effect-free. Runs in both the extension and Node tests. The
// rule (Part 1 §4): only records where author.screen_name === handle,
// replying_to is non-null, and replying_to.screen_name !== handle.

/**
 * @typedef {{id:any,text:any,lang:any,targetScreenName:any,parentStatusId:any,likes:any,replyCount:any,views:any,createdAt:any}} Reply
 */

/**
 * Extract qualifying replies from a FxTwitter profile-statuses response.
 * @param {any} responseJson
 * @param {string} handle
 * @returns {Reply[]}
 */
export function extractProfileReplies(responseJson, handle) {
  const results = responseJson?.results;
  if (!Array.isArray(results)) return [];

  const h = String(handle ?? "");
  const hLower = h.toLowerCase();
  const out = [];

  for (const item of results) {
    if (!item || typeof item !== "object") continue;

    const author = item.author && typeof item.author === "object"
      ? item.author
      : null;
    const authorName = author?.screen_name;
    // FxTwitter returns the handle with its original case, and the caller
    // asks with the lower-case handle. Compare without regard to case.
    if (typeof authorName !== "string") continue;
    if (authorName.toLowerCase() !== hLower) continue;

    const replying = item.replying_to && typeof item.replying_to === "object"
      ? item.replying_to
      : null;
    if (!replying) continue;
    const targetName = replying.screen_name;
    if (targetName == null) continue;
    if (String(targetName).toLowerCase() === hLower) continue;

    out.push({
      id: item.id ?? null,
      text: item.text ?? null,
      lang: item.lang ?? null,
      targetScreenName: targetName ?? null,
      parentStatusId: replying.status ?? null,
      likes: item.likes ?? null,
      replyCount: item.replies ?? null,
      views: item.views ?? null,
      createdAt: item.created_timestamp ?? null,
    });
  }

  return out;
}
