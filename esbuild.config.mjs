// esbuild build for both extension roots.
//
// Each target gets its OWN build root containing its OWN manifest.json, copied
// in as manifest.json (never `manifest.mv2.json`) so that `dist-mv2/` can be
// loaded directly by Firefox via about:debugging.
//
// manifest.mv3.json does not exist until Task 20. A missing MV3 manifest is
// NOT an error before then: the mv3 root is still built (JS + options.html),
// it just carries no manifest. See Task 1 ruling in the ledger.

import { build } from "esbuild";
import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Explicit named entries: the emitted filenames (content.js, page.js,
// background.js, options.js) must match what the manifests reference.
const entries = {
  content: "src/content.js",
  page: "src/page/index.js",
  background: "src/background/index.js",
  options: "src/options/index.js",
};

const TARGETS = ["mv2", "mv3"];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Copy the target's manifest into the build root as manifest.json. */
function copyManifestPlugin(target, outdir) {
  const src = path.join(rootDir, `manifest.${target}.json`);
  const dest = path.join(outdir, "manifest.json");
  return {
    name: "copy-manifest",
    setup(buildApi) {
      buildApi.onEnd(async () => {
        if (!(await exists(src))) return; // optional until Task 20
        await copyFile(src, dest);
      });
    },
  };
}

/** Copy the options HTML page into the build root as options.html. */
function copyOptionsHtmlPlugin(outdir) {
  const src = path.join(rootDir, "src/options/index.html");
  const dest = path.join(outdir, "options.html");
  return {
    name: "copy-options-html",
    setup(buildApi) {
      buildApi.onEnd(async () => {
        await mkdir(outdir, { recursive: true });
        await copyFile(src, dest);
      });
    },
  };
}

/** Copy the generated assets/ (mark + icons) into the build root. */
function copyAssetsPlugin(outdir) {
  const srcDir = path.join(rootDir, "assets");
  return {
    name: "copy-assets",
    setup(buildApi) {
      buildApi.onEnd(async () => {
        await mkdir(outdir, { recursive: true });
        const files = await readdir(srcDir);
        await Promise.all(
          files.map((file) =>
            copyFile(path.join(srcDir, file), path.join(outdir, file))
          ),
        );
      });
    },
  };
}

/** Copy brand.css into the build root as brand.css. */
function copyBrandCssPlugin(outdir) {
  const src = path.join(rootDir, "src", "brand", "brand.css");
  const dest = path.join(outdir, "brand.css");
  return {
    name: "copy-brand-css",
    setup(buildApi) {
      buildApi.onEnd(async () => {
        await copyFile(src, dest);
      });
    },
  };
}

for (const target of TARGETS) {
  const outdir = path.join(rootDir, `dist-${target}`);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await build({
    entryPoints: entries,
    bundle: true,
    format: "iife",
    outdir,
    target: ["firefox128"],
    logLevel: "warning",
    plugins: [
      copyOptionsHtmlPlugin(outdir),
      copyManifestPlugin(target, outdir),
      copyAssetsPlugin(outdir),
      copyBrandCssPlugin(outdir),
    ],
  });

  const hasManifest = await exists(path.join(outdir, "manifest.json"));
  console.log(
    `built dist-${target}/ (manifest: ${hasManifest ? "yes" : "absent"})`,
  );
}
