// task5: deploy configuration cannot carry secret material and every
// environment declares its own storage. This parses `worker/wrangler.toml`
// as text on purpose: the failure mode we are testing for is a secret
// appearing in the file itself, so the check must not depend on any helper
// that could be skipped or tricked by a TOML parser upgrade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WRANGLER_TOML = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "wrangler.toml",
);

// Public, non-secret deployment knobs. Anything outside this set in a
// `[vars]` block needs an explicit test update with a reason.
const ALLOWED_VARS_KEYS = [
  "PROXY_ENABLED",
  "BAND_HIGH",
  "BAND_MEDIUM",
  "SHOW_NUMBER",
  "CLOUDFLARE_ACCOUNT_ID",
];

// Names that must never appear with a literal value in the deploy config or
// the Worker source. This list deliberately covers the deploy-side secrets
// of `worker/wrangler.toml` and `worker/src` ONLY: the
// scripts/check-artifacts.mjs scan also names the AMO signing credentials
// (AMO_KEY/AMO_SECRET), which are excluded here because they are a
// release concern and never enter the deploy config or the
// Worker source.
const SECRET_VAR_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "TYPESAFE_API_KEY",
  "INSTALL_TOKEN_SECRET",
];

/**
 * Regex for a hardcoded literal assigned to a known secret name. Matches ANY
 * quoted value, including the empty string: the promise is "no literal value
 * at all", not "no non-empty literal value".
 *
 * @param {string} name
 * @returns {RegExp}
 */
function secretAssignmentRegex(name) {
  return new RegExp(`\\b${name}\\s*=\\s*["'][^"']*["']`, "i");
}

// Generic credential-shaped assignment: a key name mentioning api key /
// secret / password / token assigned a long literal. Shared by the
// wrangler.toml and worker/src checks below so both gates scan the same
// pattern.
const CREDENTIAL_SHAPED_ASSIGNMENT =
  /\b[\w-]*(api[-_]?key|secret|password|token)[\w-]*\s*=\s*["'][^"']{16,}["']/i;

function readWranglerToml() {
  return readFileSync(WRANGLER_TOML, "utf8");
}

/**
 * Extracts kv_namespaces blocks as { section, env, binding, id } records.
 * Handles both top-level `[[kv_namespaces]]` (env === null) and
 * `[[env.<name>.kv_namespaces]]` (env === "<name>").
 *
 * @param {string} toml
 * @returns {Array<{ section: string, env: string | null, binding: string, id: string }>}
 */
function parseKvNamespaces(toml) {
  const blocks = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const env = current.raw === "kv_namespaces"
      ? null
      : current.raw.replace(/^env\./, "").replace(/\.kv_namespaces$/, "");
    blocks.push({
      section: current.raw,
      env,
      binding: current.binding ?? "",
      id: current.id ?? "",
    });
    current = null;
  };
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    const kvSection = /^\[\[(kv_namespaces|env\.[\w.]+\.kv_namespaces)\]\]$/
      .exec(line);
    if (kvSection) {
      flush();
      current = { raw: kvSection[1] };
      continue;
    }
    // Any other table header ends the current namespace block.
    if (/^\[/.test(line)) {
      flush();
      continue;
    }
    if (!current) continue;
    const binding = /^binding\s*=\s*"([^"]*)"$/.exec(line);
    if (binding) {
      current.binding = binding[1];
      continue;
    }
    const id = /^id\s*=\s*"([^"]*)"$/.exec(line);
    if (id) current.id = id[1];
  }
  flush();
  return blocks;
}

/**
 * Extracts `[vars]` / `[env.<name>.vars]` tables as key → literal value
 * maps, keyed by "top" or the environment name.
 *
 * @param {string} toml
 * @returns {Map<string, Record<string, string>>}
 */
function parseVarsTables(toml) {
  const tables = new Map();
  let envKey = null;
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    const section = /^\[(env\.([\w]+)\.)?vars\]$/.exec(line);
    if (section) {
      envKey = section[2] ?? "top";
      tables.set(envKey, tables.get(envKey) ?? {});
      continue;
    }
    if (/^\[/.test(line)) {
      envKey = null;
      continue;
    }
    if (!envKey) continue;
    const assignment = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (assignment) {
      tables.get(envKey)[assignment[1]] = assignment[2];
    }
  }
  return tables;
}

test("task5: every deploy environment declares its own CACHE_KV id", () => {
  const toml = readWranglerToml();
  const blocks = parseKvNamespaces(toml).filter((b) =>
    b.binding === "CACHE_KV"
  );
  const byEnv = new Map(blocks.map((b) => [b.env ?? "top", b]));

  for (const deployEnv of ["production", "staging"]) {
    const block = byEnv.get(deployEnv);
    assert.ok(
      block,
      `wrangler.toml must declare CACHE_KV for the ${deployEnv} environment`,
    );
    assert.match(
      block.id,
      /\S/,
      `the ${deployEnv} environment's CACHE_KV id must not be empty`,
    );
  }
  assert.equal(
    blocks.length,
    2,
    "exactly one CACHE_KV namespace per deploy environment (production, staging); no top-level default",
  );
});

test("task5: staging KV namespace differs from production and is a real id", () => {
  const toml = readWranglerToml();
  const blocks = parseKvNamespaces(toml).filter((b) =>
    b.binding === "CACHE_KV"
  );
  const production = blocks.find((b) => b.env === "production");
  const staging = blocks.find((b) => b.env === "staging");

  assert.ok(production && staging, "production and staging namespaces exist");
  assert.notEqual(
    staging.id,
    production.id,
    "staging must never share production's KV namespace",
  );
  // Staging must use a real namespace ID (32 hex chars) created via
  // `npx wrangler kv namespace create CACHE_KV --env staging`. A placeholder
  // or invented value here would let a careless deploy write to unknown
  // infrastructure; the format check fails fast in that case.
  assert.match(
    staging.id,
    /^[0-9a-f]{32}$/i,
    "the staging id must be a real KV namespace id (32 hex chars) created with wrangler, not a placeholder",
  );
});

test("task5: no top-level Worker config — only named environments are deployable", () => {
  const toml = readWranglerToml();
  const prefix = toml.split(/^\[env\./m)[0];
  for (const key of ["name", "main", "compatibility_date"]) {
    assert.doesNotMatch(
      prefix,
      new RegExp(`^${key}\\s*=`, "m"),
      `top-level ${key} must not exist; a bare wrangler deploy must fail (deploy with --env production|staging)`,
    );
  }
  assert.match(toml, /^\[env\.production\]/m, "production env must exist");
  assert.match(toml, /^\[env\.staging\]/m, "staging env must exist");
});

test("task5: all deploy environments declare a [vars] table", () => {
  const toml = readWranglerToml();
  const tables = parseVarsTables(toml);

  // Wrangler does not inherit [vars] into named environments: a dropped
  // staging/production vars block would leave that environment on code
  // defaults (proxyEnabled false etc.) with a green gate. Every deploy
  // environment must declare the full public table explicitly.
  for (const deployEnv of ["production", "staging"]) {
    assert.ok(
      tables.has(deployEnv),
      `wrangler.toml must declare a [vars] table for the ${deployEnv} environment`,
    );
    const keys = Object.keys(tables.get(deployEnv)).sort();
    assert.deepEqual(
      keys,
      [...ALLOWED_VARS_KEYS].sort(),
      `the ${deployEnv} [vars] table must stay within the documented public key set`,
    );
  }
});

test("task5: no secret-shaped assignment appears anywhere in wrangler.toml", () => {
  const toml = readWranglerToml();

  // Known secret names must never carry a literal value, even commented out
  // — including the empty-string trap that a 1+-chars regex would pass.
  for (const name of SECRET_VAR_NAMES) {
    assert.doesNotMatch(
      toml,
      secretAssignmentRegex(name),
      `${name} must only be set through "npx wrangler secret put", never written into wrangler.toml`,
    );
  }
  // Generic credential-shaped assignment (shared constant above).
  assert.doesNotMatch(
    toml,
    CREDENTIAL_SHAPED_ASSIGNMENT,
    "wrangler.toml must not contain credential-shaped assignments",
  );
});

test("task5: worker source contains no hardcoded credential assignments", () => {
  // The artifacts gate (scripts/check-artifacts.mjs) covers build output;
  // deno lint is not a credential scanner; nothing else reviews worker/src.
  // Same two patterns as the wrangler.toml check so a future hardcoded
  // credential in the Worker fails this suite instead of shipping green.
  const sourceDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
  );

  const files = readdirSync(sourceDir, {
    recursive: true,
    encoding: "utf8",
  }).filter((file) => /\.js$/.test(file));
  assert.ok(files.length > 0, "worker/src must contain JS source to scan");

  for (const file of files) {
    const source = readFileSync(path.join(sourceDir, file), "utf8");
    for (const name of SECRET_VAR_NAMES) {
      assert.doesNotMatch(
        source,
        secretAssignmentRegex(name),
        `${file}: ${name} must never be hardcoded in worker/src; read it from \`env\` only (set via wrangler secret)`,
      );
    }
    assert.doesNotMatch(
      source,
      CREDENTIAL_SHAPED_ASSIGNMENT,
      `${file}: credential-shaped literal assignment in worker/src`,
    );
  }
});
