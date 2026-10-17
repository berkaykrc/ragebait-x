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
//   misclassificationEmail: string
//
// Defaults: heuristic, false, DEFAULT_PROXY_URL, "", "", "".

import { DEFAULT_PROXY_URL } from "../config.js";

export const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS = Object.freeze({
  mode: "heuristic",
  consentAccepted: false,
  proxyUrl: DEFAULT_PROXY_URL,
  byokEndpoint: "",
  apiKey: "",
  misclassificationEmail: "",
});

// Re-export the default proxy URL so the UI (and tests) reference one
// constant imported from src/config.js.
export { DEFAULT_PROXY_URL };

const MODES = new Set(["heuristic", "proxy", "byok"]);
const DAILY_LIMIT = 200;

function copySettings(source) {
  return {
    mode: source.mode,
    consentAccepted: !!source.consentAccepted,
    proxyUrl: source.proxyUrl,
    byokEndpoint: source.byokEndpoint,
    apiKey: source.apiKey,
    misclassificationEmail: source.misclassificationEmail,
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
  if (typeof value.misclassificationEmail !== "string") return false;
  return true;
}

// Normalise an arbitrary stored value into a fresh settings object with
// exactly the six fields. Anything invalid falls back to the defaults. A
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

// ---------------------------------------------------------------------------
// UI (extension options page only)
// ---------------------------------------------------------------------------

function isExtensionPage() {
  return typeof browser !== "undefined" && typeof document !== "undefined";
}

/** Read the form state from `doc` (defaults to globalThis.document). */
export function readForm(doc = globalThis.document) {
  const checked = doc.querySelector('input[name="mode"]:checked');
  const proxyUrl = doc.querySelector('input[name="proxyUrl"]');
  const byokEndpoint = doc.querySelector('input[name="byokEndpoint"]');
  const apiKey = doc.querySelector('input[name="apiKey"]');
  const consent = doc.querySelector('input[name="consentAccepted"]');
  const email = doc.getElementById("misclassification-email");
  return {
    mode: checked ? checked.value : "heuristic",
    consentAccepted: !!consent && consent.checked,
    proxyUrl: proxyUrl ? proxyUrl.value : "",
    byokEndpoint: byokEndpoint ? byokEndpoint.value : "",
    apiKey: apiKey ? apiKey.value : "",
    misclassificationEmail: email ? email.value : "",
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
  const email = doc.getElementById("misclassification-email");
  if (email) email.value = settings.misclassificationEmail ?? "";
  updateModeUI(doc, settings.mode);
}

/** Toggle mode UI based on `mode`. */
export function updateModeUI(doc, mode) {
  const isAI = mode === "proxy" || mode === "byok";
  const extra = doc.getElementById("mode-extra");
  const consentAI = doc.getElementById("consent-ai");
  const proxyFields = doc.getElementById("proxy-fields");
  const byokFields = doc.getElementById("byok-fields");
  if (extra) extra.classList.toggle("visible", isAI);
  if (consentAI) consentAI.hidden = !isAI;
  if (proxyFields) proxyFields.style.display = mode === "proxy" ? "" : "none";
  if (byokFields) byokFields.style.display = mode === "byok" ? "" : "none";
}

/** Pure: build a mailto link from an email address. */
export function buildMailto(email) {
  return {
    href: `mailto:${email}?subject=${
      encodeURIComponent("Ragebait Detector misclassification report")
    }&body=${
      encodeURIComponent(
        "Account handle:\nBand (if any):\nWhy you think it is misclassified:\n",
      )
    }`,
    label: `Report by email (${email})`,
  };
}

/** Apply a mailto build result to `#misclassification-mailto` in `doc`. */
export function updateMailto(doc, email) {
  const link = doc.getElementById("misclassification-mailto");
  if (!link) return;
  const to = email || "ragebait-detector@example.com";
  const linkData = buildMailto(to);
  link.href = linkData.href;
  link.textContent = linkData.label;
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
  if (
    typeof browser === "undefined" || !browser.storage || !browser.storage.local
  ) {
    usedEl.textContent = "0";
    return;
  }
  const key = `stats:${new Date().toISOString().slice(0, 10)}`;
  try {
    const res = await browser.storage.local.get(key);
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
    if (status) {
      status.textContent = "Saved.";
      status.className = "";
    }
  } catch {
    if (status) {
      status.textContent = "Failed to save.";
      status.className = "error";
    }
  }
}

/** Boot the options page in the extension page only. */
async function boot() {
  if (!isExtensionPage()) return;

  const settings = await loadAndRender();
  refreshQuota();
  updateMailto(document, settings.misclassificationEmail);

  const saveBtn = document.getElementById("save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      await handleSave();
      const next = await loadAndRender();
      updateMailto(document, next.misclassificationEmail);
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
}

// Auto-boot in the extension options page only. Guarding on `browser` AND
// `document` means importing this module in a Node test (or a background
// content-script world without a document) does not touch the DOM.
if (typeof browser !== "undefined" && typeof document !== "undefined") {
  boot();
}
