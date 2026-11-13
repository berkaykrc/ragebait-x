#!/usr/bin/env node
//
// Deploy the Worker with wrangler.
//
// `worker/wrangler.toml` is operator-local and gitignored: the repository
// ships only `worker/wrangler.toml.example`. Without the local config,
// wrangler fails with a missing-config error that says nothing about where
// the template is. This guard names the file and the copy step instead.
//
//   npm run deploy:production
//   npm run deploy:staging

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(ROOT, "worker");
const CONFIG = path.join(WORKER_DIR, "wrangler.toml");
const EXAMPLE = path.join(WORKER_DIR, "wrangler.toml.example");

const deployEnv = process.argv[2];
if (!deployEnv) {
  process.stderr.write(
    "usage: node scripts/deploy-worker.mjs <environment>\n",
  );
  process.exit(1);
}

if (!existsSync(CONFIG)) {
  process.stderr.write(
    "error: worker/wrangler.toml is missing.\n" +
      "copy worker/wrangler.toml.example to worker/wrangler.toml and replace " +
      "the placeholder IDs and Worker names with your own values.\n",
  );
  process.exit(1);
}

if (!existsSync(EXAMPLE)) {
  process.stderr.write(
    "error: worker/wrangler.toml.example is missing from the repository.\n",
  );
  process.exit(1);
}

execFileSync(
  "npx",
  ["--no-install", "wrangler", "deploy", "--env", deployEnv],
  { cwd: WORKER_DIR, stdio: "inherit" },
);
