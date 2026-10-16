// Version constants shared by the extension and the Worker.
//
// MODEL_VERSION identifies the scoring model; FEATURE_VERSION identifies the
// feature vector and its normalisations. Both are pinned here (never fetched
// from the network) and are part of the cache key.

export const MODEL_VERSION = "h1";

export const FEATURE_VERSION = "f1";
