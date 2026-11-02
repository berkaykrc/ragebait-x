// task5: deploy configuration cannot carry secret material and every
// environment declares its own storage. This parses `worker/wrangler.toml`
// as text on purpose: the failure mode we are testing for is a secret
// appearing in the file itself, so the check must not depend on any helper
// that could be skipped or tricked by a TOML parser upgrade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// Names that must never appear with a literal value in the deploy config.
const SECRET_VAR_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "TYPESAFE_API_KEY",
  "JEV_API_KEY",
  "INSTALL_TOKEN_SECRET",
];

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

  for (const deployEnv of ["top", "production", "staging"]) {
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
    3,
    "exactly one CACHE_KV namespace per deploy environment (top, production, staging)",
  );
});

test("task5: production environment reuses the top-level (production) KV namespace", () => {
  const toml = readWranglerToml();
  const blocks = parseKvNamespaces(toml).filter((b) =>
    b.binding === "CACHE_KV"
  );
  const top = blocks.find((b) => b.env === null);
  const production = blocks.find((b) => b.env === "production");

  assert.ok(
    top && production,
    "top-level and [env.production] namespaces exist",
  );
  assert.equal(
    production.id,
    top.id,
    "--env production must deploy against the same data as the top-level config",
  );
});

test("task5: staging KV namespace differs from production and is a labelled placeholder", () => {
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
  // The staging id is deliberately NOT a real namespace id: inventing one in
  // the repo would let a careless deploy write to unknown infrastructure.
  assert.match(
    staging.id,
    /REPLACE_WITH_STAGING/,
    "the staging id stays an operator placeholder until a staging namespace is created",
  );
});

test("task5: [vars] tables hold only the documented public keys", () => {
  const toml = readWranglerToml();
  const tables = parseVarsTables(toml);

  assert.ok(tables.size >= 1, "at least the top-level [vars] table exists");
  for (const [env, vars] of tables) {
    const keys = Object.keys(vars).sort();
    assert.deepEqual(
      keys,
      [...ALLOWED_VARS_KEYS].sort(),
      `the ${env} [vars] table must stay within the documented public key set`,
    );
  }
});

test("task5: no secret-shaped assignment appears anywhere in wrangler.toml", () => {
  const toml = readWranglerToml();

  // Known secret names must never carry a literal value, even commented out.
  for (const name of SECRET_VAR_NAMES) {
    assert.doesNotMatch(
      toml,
      new RegExp(`\\b${name}\\s*=\\s*["'][^"']+`, "i"),
      `${name} must only be set through "npx wrangler secret put", never written into wrangler.toml`,
    );
  }
  // Generic credential-shaped assignment: a key name mentioning api key /
  // secret / password / token assigned a long literal.
  assert.doesNotMatch(
    toml,
    /\b[\w-]*(api[-_]?key|secret|password|token)[\w-]*\s*=\s*["'][^"']{16,}["']/i,
    "wrangler.toml must not contain credential-shaped assignments",
  );
});
