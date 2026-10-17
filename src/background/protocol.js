// Wire protocol for the background <-> page bridge (Task 8, D14).
//
// One request, one response, one render. There is no staged/intermediate
// response: a fetch that pages three times still produces exactly ONE
// makeScoreResponse call, and every response carries a requestId so the page
// can drop a result whose card has since closed.

import { ALLOWED_MSG_TYPES } from "../shared/security.js";

// Single source of truth: the same Set the content-world gate uses.
export const MSG = ALLOWED_MSG_TYPES;

export const SCORE_RESPONSE_TYPE = "rb:score-response";

/**
 * Build the one and only response shape. `requestId` correlates the
 * response to the card that asked for it; `handle` is echoed for the page's
 * routing convenience; `result` is the Task 8 `Result`.
 */
export function makeScoreResponse(
  { requestId = null, result = null, handle = null } = {},
) {
  const out = {
    type: SCORE_RESPONSE_TYPE,
    requestId: requestId == null ? null : String(requestId),
    result,
  };
  if (handle != null) {
    out.handle = String(handle).toLowerCase();
  }
  return out;
}
