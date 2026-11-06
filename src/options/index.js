// Options page (Task 5).
//
// Pure settings logic (loadSettings / saveSettings) plus the settings UI. The
// UI boots only in the extension options page (`browser` + `document` present);
// importing this module in a Node test does NOT touch the DOM or `browser`.
//
// STORAGE SEAM (same convention as src/data/cache.js and src/background/):
//   storage.get(key) -> stored value | null   (sync or a Promise)
//   storage.set(key, value) -> void           (sync or a Promise)
// Every read is awaited internally so synchronous fakes and a
// Promise-returning browser.storage.local adapter both work. Any storage
// throw, corrupt JSON, or invalid record resolves to the defaults and never
// throws.
//
// Key: "settings" (literal, per the interfaces block).
//
// Fields (no showPercent — the number gate belongs solely to /config
// showNumber, D4):
//   mode:                'heuristic' | 'proxy' | 'byok'
//   consentAccepted:     boolean
//   proxyUrl:            string
//   byokEndpoint:        string
//   apiKey:              string
//
// Defaults: heuristic, false, DEFAULT_PROXY_URL, "", "".

import { DEFAULT_PROXY_URL, ISSUES_URL } from "../config.js";

/** Extension API namespace. Firefox exposes both `browser` and `chrome`;
 *  Chromium MV3 exposes only `chrome`. One helper, one call site pattern.
 *  Resolved per call, not at module load, so tests can swap the globals. */
function getExtensionApi() {
  if (typeof browser !== "undefined") return browser;
  if (typeof chrome !== "undefined") return chrome;
  return null;
}

export const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS = Object.freeze({
  mode: "heuristic",
  consentAccepted: false,
  proxyUrl: DEFAULT_PROXY_URL,
  byokEndpoint: "",
  apiKey: "",
});

// Re-export the shared constants so the UI (and tests) reference one
// constant imported from src/config.js.
export { DEFAULT_PROXY_URL, ISSUES_URL };

const MODES = new Set(["heuristic", "proxy", "byok"]);
const DAILY_LIMIT = 200;

function copySettings(source) {
  return {
    mode: source.mode,
    consentAccepted: !!source.consentAccepted,
    proxyUrl: source.proxyUrl,
    byokEndpoint: source.byokEndpoint,
    apiKey: source.apiKey,
  };
}

function isValidMode(value) {
  return typeof value === "string" && MODES.has(value);
}

function isValidSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!isValidMode(value.mode)) return false;
  if (typeof value.consentAccepted !== "boolean") return false;
  if (typeof value.proxyUrl !== "string") return false;
  if (typeof value.byokEndpoint !== "string") return false;
  if (typeof value.apiKey !== "string") return false;
  return true;
}

// Normalise an arbitrary stored value into a fresh settings object with
// exactly the five fields. Anything invalid falls back to the defaults. A
// raw browser.storage.local result shaped { settings: {...} } is also
// accepted (defensive; the options page adapter unwraps it anyway).
function normalize(raw) {
  let source = null;
  if (isValidSettings(raw)) {
    source = raw;
  } else if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    isValidSettings(raw.settings)
  ) {
    source = raw.settings;
  }
  if (!source) return copySettings(DEFAULT_SETTINGS);
  return copySettings(source);
}

async function readRaw(storage) {
  if (!storage || typeof storage.get !== "function") return undefined;
  try {
    return await storage.get(SETTINGS_KEY);
  } catch {
    return undefined;
  }
}

/** Load settings from `storage`. Never throws; corrupt/invalid -> defaults. */
export async function loadSettings(storage) {
  const raw = await readRaw(storage);
  if (raw === undefined || raw === null) {
    return copySettings(DEFAULT_SETTINGS);
  }
  if (typeof raw === "string") {
    try {
      return normalize(JSON.parse(raw));
    } catch {
      return copySettings(DEFAULT_SETTINGS);
    }
  }
  return normalize(raw);
}

/** Save `settings` to `storage`. Never throws; storage failures are swallowed. */
export async function saveSettings(storage, settings) {
  if (!storage || typeof storage.set !== "function") return;
  const payload = normalize(settings);
  let json;
  try {
    json = JSON.stringify(payload);
  } catch {
    return;
  }
  try {
    await storage.set(SETTINGS_KEY, json);
  } catch {
    // Swallow: a failed write must not throw out of the settings save.
  }
}

/** Adapt real browser.storage.local to the storage seam (unwrap {key: value}). */
export function browserStorageAdapter() {
  const requireLocal = () => {
    // Resolve per call, not at construction: a caller (or a test) that swaps
    // the API globals after this adapter was built must not hit a stale one.
    const api = getExtensionApi();
    if (!api || !api.storage || !api.storage.local) {
      // Thrown inside the async methods, so loadSettings/saveSettings catch it
      // and fall back instead of leaking a TypeError from a null deref.
      throw new Error("ragebait: extension storage API unavailable");
    }
    return api.storage.local;
  };
  return {
    async get(key) {
      const res = await requireLocal().get(key);
      return res && Object.prototype.hasOwnProperty.call(res, key)
        ? res[key]
        : null;
    },
    async set(key, value) {
      await requireLocal().set({ [key]: value });
    },
  };
}

// ---------------------------------------------------------------------------
// UI (extension options page only)
// ---------------------------------------------------------------------------

function isExtensionPage() {
  return getExtensionApi() !== null && typeof document !== "undefined";
}

/** Read the form state from `doc` (defaults to globalThis.document). */
export function readForm(doc = globalThis.document) {
  const checked = doc.querySelector('input[name="mode"]:checked');
  const proxyUrl = doc.querySelector('input[name="proxyUrl"]');
  const byokEndpoint = doc.querySelector('input[name="byokEndpoint"]');
  const apiKey = doc.querySelector('input[name="apiKey"]');
  const consent = doc.querySelector('input[name="consentAccepted"]');
  return {
    mode: checked ? checked.value : "heuristic",
    consentAccepted: !!consent && consent.checked,
    proxyUrl: proxyUrl ? proxyUrl.value : "",
    byokEndpoint: byokEndpoint ? byokEndpoint.value : "",
    apiKey: apiKey ? apiKey.value : "",
  };
}

/** Fill the form from `settings`, then update mode UI. */
export function applySettings(doc, settings) {
  const radios = doc.querySelectorAll('input[name="mode"]');
  for (const radio of radios) {
    radio.checked = radio.value === settings.mode;
  }
  const proxyUrl = doc.querySelector('input[name="proxyUrl"]');
  if (proxyUrl) proxyUrl.value = settings.proxyUrl ?? "";
  const byokEndpoint = doc.querySelector('input[name="byokEndpoint"]');
  if (byokEndpoint) byokEndpoint.value = settings.byokEndpoint ?? "";
  const apiKey = doc.querySelector('input[name="apiKey"]');
  if (apiKey) apiKey.value = settings.apiKey ?? "";
  const consent = doc.querySelector('input[name="consentAccepted"]');
  if (consent) consent.checked = !!settings.consentAccepted;
  updateModeUI(doc, settings.mode);
}

function noteHost(doc, name) {
  const input = doc.querySelector(`input[name="${name}"]`);
  return input && typeof input.value === "string" ? input.value.trim() : "";
}

/** Host (or best-effort text) for the endpoint the AI path would use. */
function targetHost(doc, mode) {
  const raw = mode === "proxy"
    ? noteHost(doc, "proxyUrl") || DEFAULT_PROXY_URL
    : noteHost(doc, "byokEndpoint");
  try {
    return new URL(raw).host;
  } catch {
    return raw || "the configured endpoint";
  }
}

/** Reflect the effective analysis route: AI on, or heuristic fallback.
 *  Shown only in AI modes (the card itself is hidden otherwise). */
export function renderAiStatus(doc) {
  const status = doc.getElementById("ai-mode-status");
  if (!status) return;
  const checked = doc.querySelector('input[name="mode"]:checked');
  const mode = checked ? checked.value : "heuristic";
  const consented = isConsentAccepted(doc);
  const isAI = mode === "proxy" || mode === "byok";
  status.hidden = !isAI;
  status.classList.remove("rb-ai-status--on", "rb-ai-status--off");
  if (!isAI) return;
  if (!consented) {
    status.textContent =
      "AI analysis OFF — scoring runs on this device (heuristic) until you accept";
    status.classList.add("rb-ai-status--off");
    return;
  }
  if (mode === "byok" && noteHost(doc, "byokEndpoint").length === 0) {
    status.textContent = "AI analysis unavailable — set your BYOK endpoint";
    status.classList.add("rb-ai-status--off");
    return;
  }
  status.textContent = `AI analysis ON — scoring via ${targetHost(doc, mode)}`;
  status.classList.add("rb-ai-status--on");
}

/** Whether the AI data notice is accepted (gates all AI configuration). */
export function isConsentAccepted(doc) {
  const consent = doc.querySelector('input[name="consentAccepted"]');
  return !!consent && consent.checked;
}

/** Toggle mode UI based on `mode`. */
export function updateModeUI(doc, mode) {
  const isAI = mode === "proxy" || mode === "byok";
  const consented = isConsentAccepted(doc);
  const extra = doc.getElementById("mode-extra");
  const consentAI = doc.getElementById("consent-ai");
  const proxyFields = doc.getElementById("proxy-fields");
  const byokFields = doc.getElementById("byok-fields");
  const quotaCard = doc.getElementById("quota-card");
  const notes = doc.querySelectorAll("[data-mode-note]");
  if (extra) extra.classList.toggle("visible", isAI);
  if (extra) extra.hidden = !isAI;
  if (consentAI) consentAI.hidden = !isAI;
  // Endpoint configuration stays hidden until the notice is accepted.
  if (proxyFields) {
    proxyFields.hidden = !(mode === "proxy" && consented);
  }
  if (byokFields) {
    byokFields.hidden = !(mode === "byok" && consented);
  }
  if (quotaCard) quotaCard.hidden = mode !== "proxy";
  for (const note of notes) {
    note.hidden = note.dataset.modeNote !== mode;
  }
  renderAiStatus(doc);
}

/** Load settings from storage and render the form. */
async function loadAndRender() {
  const storage = isExtensionPage() ? browserStorageAdapter() : null;
  let settings;
  try {
    settings = await loadSettings(storage);
  } catch {
    settings = copySettings(DEFAULT_SETTINGS);
  }
  applySettings(document, settings);
  return settings;
}

/** Update quota readouts. */
async function refreshQuota() {
  const usedEl = document.getElementById("quota-used");
  const limitEl = document.getElementById("quota-limit");
  if (!usedEl || !limitEl) return;
  limitEl.textContent = String(DAILY_LIMIT);
  const api = getExtensionApi();
  if (!api || !api.storage || !api.storage.local) {
    usedEl.textContent = "0";
    return;
  }
  const key = `stats:${new Date().toISOString().slice(0, 10)}`;
  try {
    const res = await api.storage.local.get(key);
    const raw = res && Object.prototype.hasOwnProperty.call(res, key)
      ? res[key]
      : null;
    let count = 0;
    if (typeof raw === "number") count = raw;
    else if (raw && typeof raw.count === "number") count = raw.count;
    else if (raw && typeof raw.profiles === "number") count = raw.profiles;
    usedEl.textContent = String(count);
  } catch {
    usedEl.textContent = "\u2013";
  }
}

/** Handle the save button click. */
async function handleSave() {
  const status = document.getElementById("status");
  const settings = readForm(document);
  const storage = browserStorageAdapter();
  try {
    await saveSettings(storage, settings);
    // Success is the button's own state; the status span is reserved for
    // failures so idle rows stay quiet.
    if (status) {
      status.textContent = "";
      status.classList.remove("error");
    }
    markSaved(document.getElementById("save-btn"));
  } catch {
    if (status) {
      status.textContent = "Failed to save.";
      status.classList.add("error");
    }
  }
}

/** The button carries the success feedback itself: label and fill flip to the
 * saved state, then settle back after a beat. */
const SAVE_CONFIRM_MS = 1600;
let saveResetTimer = undefined;

function markSaved(btn) {
  if (!btn) return;
  clearTimeout(saveResetTimer);
  btn.classList.add("rb-btn-saved");
  btn.textContent = "Saved";
  saveResetTimer = setTimeout(() => {
    btn.classList.remove("rb-btn-saved");
    btn.textContent = "Save";
  }, SAVE_CONFIRM_MS);
}

/** Show the report link with the configured URL, or keep it hidden. */
export function wireReportLink(doc, issuesUrl) {
  const report = doc.getElementById("misclassification-report");
  if (!report) return;
  const link = report.querySelector("a");
  if (!link || typeof issuesUrl !== "string" || issuesUrl.length === 0) {
    return; // stays hidden: no tracker configured for this build
  }
  link.href = issuesUrl;
  report.hidden = false;
}

/** Boot the options page in the extension page only. */
async function boot() {
  if (!isExtensionPage()) return;

  await loadAndRender();
  refreshQuota();
  wireReportLink(document, ISSUES_URL);

  const saveBtn = document.getElementById("save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      await handleSave();
      await loadAndRender();
      refreshQuota();
    });
  }

  const radios = document.querySelectorAll('input[name="mode"]');
  for (const radio of radios) {
    radio.addEventListener("change", () => {
      const checked = document.querySelector('input[name="mode"]:checked');
      updateModeUI(document, checked ? checked.value : "heuristic");
    });
  }
  const consent = document.querySelector('input[name="consentAccepted"]');
  if (consent) {
    consent.addEventListener("change", () => {
      const checked = document.querySelector('input[name="mode"]:checked');
      updateModeUI(document, checked ? checked.value : "heuristic");
    });
  }
  for (const name of ["proxyUrl", "byokEndpoint"]) {
    const endpoint = document.querySelector(`input[name="${name}"]`);
    if (endpoint) {
      endpoint.addEventListener("input", () => renderAiStatus(document));
    }
  }
}

// Auto-boot in the extension options page only. Guarding on the API AND
// `document` means importing this module in a Node test (or a background
// content-script world without a document) does not touch the DOM.
if (getExtensionApi() && typeof document !== "undefined") {
  boot();
}
