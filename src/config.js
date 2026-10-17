// Version constants shared by the extension and the Worker.
//
// MODEL_VERSION identifies the scoring model; FEATURE_VERSION identifies the
// feature vector and its normalisations. Both are pinned here (never fetched
// from the network) and are part of the cache key.

export const MODEL_VERSION = "h1";

export const FEATURE_VERSION = "f1";

// Default endpoint used in proxy mode. Users can override it on the settings
// page. It is not a secret; it is the public analysis endpoint the extension
// sends reply data to when proxy mode is selected. Task 11 pins this value.
export const DEFAULT_PROXY_URL = "https://api.ragebait-detector.test/analyze";
