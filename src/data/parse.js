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
  const out = [];

  for (const item of results) {
    if (!item || typeof item !== "object") continue;

    const author = item.author && typeof item.author === "object"
      ? item.author
      : null;
    const authorName = author?.screen_name;
    if (authorName !== h) continue;

    const replying = item.replying_to && typeof item.replying_to === "object"
      ? item.replying_to
      : null;
    if (!replying) continue;
    const targetName = replying.screen_name;
    if (targetName == null) continue;
    if (String(targetName).toLowerCase() === h.toLowerCase()) continue;

    out.push({
      id: item.id ?? null,
      text: item.text ?? null,
      lang: item.lang ?? null,
      targetScreenName: targetName ?? null,
      parentStatusId: item.in_reply_to_status_id ?? null,
      likes: item.likes ?? null,
      replyCount: item.replies ?? null,
      views: item.views ?? null,
      createdAt: item.created_timestamp ?? null,
    });
  }

  return out;
}
