// Worker question set for Clef 27B and Jev AI analysis.
//
// Exactly 5 scored questions (4 noul + 1 intensity score).
// As specified by design §5 and decision D2, topic is excluded to minimize cost.
//
// SHAPE: conforms to the published Clef System One input schema
// (developers.cloudflare.com/workers-ai/models/clef):
//   noul  -> criteria is an optional object {true, false}
//   score -> criteria is an ordered array of 2-10 level descriptions, lowest first
// The plan doc (2026-10-12) sketched criteria as prose strings; the model
// validates against its own schema (422 evidence: "Input should be a valid
// dictionary or instance of NoulCriteria").

export const QUESTIONS = {
  is_provocative: {
    type: "noul",
    instructions:
      "Evaluate whether the account's replies carry deliberate anger, hostility, or provocation intended to elicit outraged responses.",
    criteria: {
      true: "The reply is clearly deliberate ragebait or provocation.",
      false: "The reply is calm, neutral, or constructive dialogue.",
    },
  },
  is_engagement_bait: {
    type: "noul",
    instructions:
      "Evaluate whether the account's replies employ engagement-farming tactics or controversy hooks designed to manipulate algorithm reach.",
    criteria: {
      true: "The reply is blatant engagement farming or outrage baiting.",
      false: "The reply is a genuine contribution.",
    },
  },
  targets_group_identity: {
    type: "noul",
    instructions:
      "Evaluate whether the account's replies target group identities (political, cultural, religious, ethnic) with mockery, hostility, or tribal polarization.",
    criteria: {
      true:
        "The reply carries aggressive group-identity targeting or polarization.",
      false: "The reply involves no identity targeting.",
    },
  },
  reply_farms_opponents: {
    type: "noul",
    instructions:
      "Evaluate whether the account repeatedly replies under viral accounts or perceived opponents to farm impressions and spark conflict.",
    criteria: {
      true: "The reply is persistent reply-farming under opposing accounts.",
      false: "The replying behaviour is normal or organic conversation.",
    },
  },
  intensity: {
    type: "score",
    instructions:
      "Rate the overall emotional temperature and hostility level of the reply sample.",
    criteria: [
      "Calm, neutral, or constructive conversation",
      "Provocative or emotionally charged, short of hostility",
      "Inflammatory and hostile, overt ragebaiting",
    ],
  },
};

/**
 * Validates the caller-submitted state object.
 *
 * @param {unknown} state
 * @returns {state is { handle: string, features: Record<string, unknown>, replySample?: string[] }}
 */
export function isValidState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return false;
  }
  const s = /** @type {Record<string, unknown>} */ (state);
  if (typeof s.handle !== "string" || s.handle.length === 0) {
    return false;
  }
  if (
    !s.features || typeof s.features !== "object" || Array.isArray(s.features)
  ) {
    return false;
  }
  return true;
}

/**
 * Builds the outbound question payload from the validated state.
 * Caps the reply sample to 12 items and 400 chars each.
 *
 * @param {{ handle: string, features: Record<string, unknown>, replySample?: string[] }} state
 * @param {string} [model]
 * @returns {{ state: object, questions: typeof QUESTIONS, model?: string }}
 */
export function buildQuestionSet(state, model) {
  if (!isValidState(state)) {
    throw new TypeError(
      "Invalid state: must include handle and features object",
    );
  }

  const rawSample = Array.isArray(state.replySample) ? state.replySample : [];
  const replySample = rawSample.slice(0, 12).map((item) =>
    typeof item === "string" ? item.slice(0, 400) : ""
  );

  const payload = {
    state: {
      handle: state.handle.toLowerCase(),
      features: state.features,
      replySample,
    },
    questions: QUESTIONS,
  };

  if (model) {
    payload.model = model;
  }

  return payload;
}
