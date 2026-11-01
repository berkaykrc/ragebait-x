import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  findSecretLikeValues,
  scanArtifactDirectories,
} from "../../scripts/check-artifacts.mjs";

const execFileAsync = promisify(execFile);

test("artifact scanner rejects credential-shaped values", () => {
  const matches = findSecretLikeValues(
    'const key = "sk-123456789012345678901234";\n' +
      "-----BEGIN PRIVATE KEY-----",
  );
  assert.deepEqual(matches, ["private key", "OpenAI-style key"]);
});

test("artifact scanner permits public identifiers", () => {
  const matches = findSecretLikeValues(
    'const url = "https://ragebait-proxy.dontseemyass.workers.dev/analyze";\n' +
      'const accountId = "fe941e04eee6db1835c906a459435c1f";\n' +
      'headers["X-Install-Token"] = token;',
  );
  assert.deepEqual(matches, []);
});

test("artifact scanner rejects known deployment secret names", () => {
  const matches = findSecretLikeValues(
    "CLOUDFLARE_API_TOKEN=abcdefghijklmnop\n" +
      "INSTALL_TOKEN_SECRET=`1234567890123456`",
  );
  assert.deepEqual(matches, ["known deployment secret assignment"]);
});

test("artifact directory scan reports the file and finding", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ragebait-artifacts-"),
  );
  try {
    await mkdir(path.join(directory, "nested"));
    await writeFile(
      path.join(directory, "nested", "bundle.js"),
      'const apiKey = "abcdefghijklmnop";',
    );
    const findings = await scanArtifactDirectories([directory]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].match, "literal secret assignment");
    assert.match(findings[0].file, /bundle\.js$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact directory scan inspects compressed XPI members", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ragebait-artifacts-"),
  );
  const source = path.join(directory, "bundle.js");
  const archive = path.join(directory, "extension.xpi");
  try {
    await writeFile(source, 'const token = "sk-123456789012345678901234";');
    await execFileAsync("zip", ["-j", archive, source]);
    await rm(source);
    const findings = await scanArtifactDirectories([directory]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].match, "OpenAI-style key");
    assert.match(findings[0].file, /extension[.]xpi$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
