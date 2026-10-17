import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * `deno fmt`'s output is not stable across Deno releases. 2.9.x reformats
 * embedded <style> CSS in a way 2.6.x does not, so a `deno-version: 2.x` in CI
 * silently installs a different formatter than the one the repo was formatted
 * with, and `fmt:check` fails on a commit that is green locally. Pin it.
 */
test("toolchain: .deno-version pins an exact Deno version", async () => {
  const raw = await readFile(path.join(rootDir, ".deno-version"), "utf8");
  const pinned = raw.trim();

  assert.match(
    pinned,
    /^\d+\.\d+\.\d+$/,
    `.deno-version must be an exact version like "2.6.10", not "${pinned}". ` +
      `A range such as "2.x" is what caused CI to fail fmt:check on a commit ` +
      `that was green locally.`,
  );
});

test("toolchain: ci.yml installs Deno from .deno-version", async () => {
  const ci = await readFile(
    path.join(rootDir, ".github", "workflows", "ci.yml"),
    "utf8",
  );

  assert.match(
    ci,
    /deno-version-file:\s*\.deno-version/,
    "ci.yml must read the pin from .deno-version so the two cannot drift apart",
  );
  assert.doesNotMatch(
    ci,
    /deno-version:\s*["']?2\.x/,
    'a hardcoded "2.x" defeats the pin and reintroduces formatter drift',
  );
});

test("toolchain: the release workflow never depends on a Deno formatter", async () => {
  // Release signs with AMO. It must not be able to fail on a formatting drift
  // that the CI workflow already guards, and it should not install Deno at all.
  const release = await readFile(
    path.join(rootDir, ".github", "workflows", "release.yml"),
    "utf8",
  );

  assert.doesNotMatch(
    release,
    /setup-deno|deno-version|deno-version-file/,
    "the release job runs build + test + sign only; it needs no Deno formatter",
  );
  assert.doesNotMatch(
    release,
    /fmt:check/,
    "fmt is gated in ci.yml; duplicating it in the release path only adds a " +
      "second place to fail for a non-release concern",
  );
});
