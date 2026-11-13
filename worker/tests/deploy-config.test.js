// task5: the Worker source must never contain hardcoded credential
// assignments; the deploy config must keep its documented structure, carry
// no secret material, and declare non-empty public vars and distinct
// non-empty CACHE_KV ids. `wrangler.toml` is operator-local and gitignored,
// so the tracked `wrangler.toml.example` is the file CI can read; CI does
// not deploy the Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WRANGLER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WRANGLER_EXAMPLE = path.join(WRANGLER_DIR, "wrangler.toml.example");
const WRANGLER_LOCAL = path.join(WRANGLER_DIR, "wrangler.toml");

// Names that must never appear with a literal value in the deploy config or
// the Worker source. The scripts/check-artifacts.mjs scan also names the AMO
// signing credentials (AMO_KEY/AMO_SECRET), which are excluded here because
// they are a release concern and never enter the deploy config or the
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
// secret / password / token assigned a long literal.
const CREDENTIAL_SHAPED_ASSIGNMENT =
  /\b[\w-]*(api[-_]?key|secret|password|token)[\w-]*\s*=\s*["'][^"']{16,}["']/i;

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
    // Accept lowercase keys and trailing `# comment` so an empty value
    // cannot hide behind an inline comment.
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"(?:\s*#.*)?$/
      .exec(line);
    if (assignment) {
      tables.get(envKey)[assignment[1]] = assignment[2];
    }
  }
  return tables;
}

/**
 * Normalizes a wrangler file to its tables: each table header plus its key
 * names. Values and comments are ignored.
 *
 * @param {string} toml
 * @returns {Array<{ header: string, keys: string[] }>}
 */
function parseStructure(toml) {
  const tables = [];
  let current = null;
  const flush = () => {
    if (current) {
      current.keys.sort();
      tables.push(current);
    }
    current = null;
  };
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    const header = /^\[\[?[^\]]+\]\]?$/.exec(line);
    if (header) {
      flush();
      current = { header: line, keys: [] };
      continue;
    }
    if (!current) continue;
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (key) current.keys.push(key[1]);
  }
  flush();
  return tables;
}

/**
 * Extracts `[[env.<name>.kv_namespaces]]` blocks as { env, binding, id }.
 *
 * @param {string} toml
 * @returns {Array<{ env: string, binding: string, id: string }>}
 */
function parseKvNamespaces(toml) {
  const blocks = [];
  let current = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    const header = /^\[\[env\.([\w-]+)\.kv_namespaces\]\]$/.exec(line);
    if (header) {
      flush();
      current = { env: header[1], binding: "", id: "" };
      continue;
    }
    if (/^\[/.test(line)) {
      flush();
      continue;
    }
    if (!current) continue;
    const binding = /^binding\s*=\s*"([^"]*)"(?:\s*#.*)?$/.exec(line);
    if (binding) {
      current.binding = binding[1];
      continue;
    }
    const id = /^id\s*=\s*"([^"]*)"(?:\s*#.*)?$/.exec(line);
    if (id) current.id = id[1];
  }
  flush();
  return blocks;
}

// Tables the deploy config must provide. The key lists are minimums: an
// operator may add public vars, extra bindings, or extra tables without
// changing anything in this file.
const REQUIRED_TABLES = [
  {
    header: "[env.production]",
    keys: ["compatibility_date", "main", "name"],
  },
  { header: "[[env.production.kv_namespaces]]", keys: ["binding", "id"] },
  { header: "[env.production.vars]", keys: [] },
  { header: "[env.staging]", keys: ["compatibility_date", "main", "name"] },
  { header: "[[env.staging.kv_namespaces]]", keys: ["binding", "id"] },
  { header: "[env.staging.vars]", keys: [] },
];

// Top-level Worker keys must stay absent: a bare `wrangler deploy` has no
// entry point and must fail instead of overwriting a Worker.
const TOP_LEVEL_WORKER_KEYS = ["name", "main", "compatibility_date"];

/**
 * Asserts the tables and keys the deploy config must provide. Extra tables
 * and extra keys are allowed.
 *
 * @param {string} toml
 * @param {string} label
 */
function assertRequiredStructure(toml, label) {
  const tables = parseStructure(toml);

  for (const required of REQUIRED_TABLES) {
    const table = tables.find((t) => t.header === required.header);
    assert.ok(table, `${label} must declare ${required.header}`);
    for (const key of required.keys) {
      assert.ok(
        table.keys.includes(key),
        `${label}: ${required.header} must declare ${key}`,
      );
    }
  }

  const prefix = toml.split(/^\[env\./m)[0];
  for (const key of TOP_LEVEL_WORKER_KEYS) {
    assert.doesNotMatch(
      prefix,
      new RegExp(`^${key}\\s*=`, "m"),
      `${label}: top-level ${key} must not exist; deploy with --env production|staging`,
    );
  }
}

test("task5: deploy template keeps the documented structure", () => {
  assertRequiredStructure(
    readFileSync(WRANGLER_EXAMPLE, "utf8"),
    "wrangler.toml.example",
  );

  // `wrangler.toml` is operator-local; when present it must provide the
  // same tables, so the checks below describe the real config too.
  if (existsSync(WRANGLER_LOCAL)) {
    assertRequiredStructure(
      readFileSync(WRANGLER_LOCAL, "utf8"),
      "wrangler.toml",
    );
  }
});

test("task5: every deploy environment declares non-empty [vars]", () => {
  const toml = readFileSync(WRANGLER_EXAMPLE, "utf8");
  const tables = parseVarsTables(toml);

  for (const deployEnv of ["production", "staging"]) {
    const vars = tables.get(deployEnv);
    assert.ok(
      vars,
      `wrangler.toml.example must declare [env.${deployEnv}.vars]`,
    );
    assert.ok(
      Object.keys(vars).length > 0,
      `[env.${deployEnv}.vars] must not be empty`,
    );
    for (const [key, value] of Object.entries(vars)) {
      assert.ok(
        value.trim().length > 0,
        `${deployEnv} ${key} must not be empty`,
      );
    }
  }
});

test("task5: every deploy environment declares a non-empty CACHE_KV id", () => {
  const toml = readFileSync(WRANGLER_EXAMPLE, "utf8");
  const blocks = parseKvNamespaces(toml);
  const ids = new Map();

  for (const deployEnv of ["production", "staging"]) {
    const block = blocks.find((b) =>
      b.env === deployEnv && b.binding === "CACHE_KV"
    );
    assert.ok(
      block,
      `wrangler.toml.example must declare CACHE_KV for ${deployEnv}`,
    );
    assert.ok(
      block.id.trim().length > 0,
      `the ${deployEnv} CACHE_KV id must not be empty`,
    );
    ids.set(deployEnv, block.id);
  }

  assert.notEqual(
    ids.get("staging"),
    ids.get("production"),
    "staging must never share production's CACHE_KV namespace",
  );
});

test("task5: the deploy config carries no secret-shaped assignment", () => {
  const files = [
    { path: WRANGLER_EXAMPLE, label: "wrangler.toml.example" },
  ];
  if (existsSync(WRANGLER_LOCAL)) {
    files.push({ path: WRANGLER_LOCAL, label: "wrangler.toml" });
  }

  for (const file of files) {
    const toml = readFileSync(file.path, "utf8");
    for (const name of SECRET_VAR_NAMES) {
      assert.doesNotMatch(
        toml,
        secretAssignmentRegex(name),
        `${file.label}: ${name} must only be set through "npx wrangler secret put", never written into the deploy config`,
      );
    }
    assert.doesNotMatch(
      toml,
      CREDENTIAL_SHAPED_ASSIGNMENT,
      `${file.label}: credential-shaped assignment in the deploy config`,
    );
  }
});

test("task5: worker source contains no hardcoded credential assignments", () => {
  // The artifacts gate (scripts/check-artifacts.mjs) covers build output;
  // deno lint is not a credential scanner; nothing else reviews worker/src.
  // Same two patterns as the artifact scan so a future hardcoded credential
  // in the Worker fails this suite instead of shipping green.
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
