#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIRECTORIES = ["dist-mv2", "dist-mv3", "web-ext-artifacts"];
const execFileAsync = promisify(execFile);

const SECRET_PATTERNS = [
  { name: "private key", pattern: /-----BEGIN [^-]*PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  {
    name: "literal secret assignment",
    pattern:
      /\b(?:api[_-]?key|secret|password|access[_-]?token)\b\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/i,
  },
  {
    name: "known deployment secret assignment",
    pattern:
      /\b(?:CLOUDFLARE_API_TOKEN|CLEF_API_KEY|TYPESAFE_API_KEY|JEV_API_KEY|INSTALL_TOKEN_SECRET|AMO_KEY|AMO_SECRET)\b\s*[:=]\s*["'`]?[^\s"'`]{16,}["'`]?/,
  },
];

// Public URLs, account IDs, and generated install tokens are identifiers, not
// credentials, and are intentionally allowed.
export function findSecretLikeValues(text) {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map((
    { name },
  ) => name);
}

async function contentsToScan(file) {
  if (!/[.]xpi$|[.]zip$/i.test(file)) return [await readFile(file, "utf8")];

  const { stdout } = await execFileAsync("unzip", ["-Z1", file], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const members = stdout.split("\n").filter(Boolean);
  return Promise.all(members.map(async (member) => {
    const result = await execFileAsync("unzip", ["-p", file, member], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  }));
}

async function filesUnder(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await filesUnder(fullPath));
      else if (entry.isFile()) files.push(fullPath);
    }
    return files;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function scanArtifactDirectories(directories) {
  const findings = [];
  for (const directory of directories) {
    for (const file of await filesUnder(directory)) {
      for (const contents of await contentsToScan(file)) {
        const matches = findSecretLikeValues(contents);
        for (const match of matches) findings.push({ file, match });
      }
    }
  }
  return findings;
}

async function main() {
  const directories = DEFAULT_DIRECTORIES.map((directory) =>
    path.join(ROOT, directory)
  );
  const findings = await scanArtifactDirectories(directories);
  if (findings.length > 0) {
    for (const { file, match } of findings) {
      console.error(
        `artifact security check failed: ${match} in ${
          path.relative(ROOT, file)
        }`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log("artifact security check passed: no secret-like values found");
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
