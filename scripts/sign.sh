#!/usr/bin/env bash
#
# Sign the extension with AMO. Produces web-ext-artifacts/*.xpi.
#
# WHY THIS SCRIPT EXISTS: the AMO API key and secret are read from the
# environment, never from a file in the repo and never from a command-line
# argument (argv is world-readable via /proc on Linux, and it lands in shell
# history). Export them in YOUR OWN terminal and run this script there.
#
#   export AMO_KEY='user:12345678:987'
#   export AMO_SECRET='<64 hex chars>'
#   ./scripts/sign.sh
#
# Do NOT export these in the shell that launches the agent -- a child process
# inherits the environment, and anything exported there becomes readable by
# every tool call the agent makes. Use a separate terminal for signing.
#
# The values are never echoed, logged, or written anywhere by this script.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${AMO_KEY:-}" || -z "${AMO_SECRET:-}" ]]; then
  cat >&2 <<'EOF'
error: AMO_KEY and AMO_SECRET are not set.

Get them from addons.mozilla.org -> Tools -> Developer -> API Key.
The secret is shown only once, so copy it when you generate it.

Then, in this terminal:

  export AMO_KEY='user:12345678:987'
  export AMO_SECRET='<the secret>'
  ./scripts/sign.sh

Do not put the values in a file inside this repository, and do not pass them
as command-line arguments.
EOF
  exit 1
fi

if [[ ! -f dist-mv2/manifest.json ]]; then
  echo "error: dist-mv2/manifest.json is missing -- run 'npm run build' first." >&2
  exit 1
fi

# `web-ext sign` has no --overwrite-dest, and it names the artifact after the
# AMO slug plus the version, so re-signing the same version collides with the
# previous file. These are gitignored build artifacts, so clearing them is safe:
# the current one is always re-downloaded from AMO by this script.
shopt -s nullglob
stale=(web-ext-artifacts/*.xpi)
if ((${#stale[@]})); then
  echo "clearing ${#stale[@]} stale signed artifact(s) from a previous run"
  rm -f -- "${stale[@]}"
fi
shopt -u nullglob

# The current version is the artifact filename AMO will produce. Print it so
# a signing run is identifiable in the shell history without printing secrets.
version="$(
  node -p 'JSON.parse(require("fs").readFileSync("manifest.mv2.json","utf8")).version'
)"
echo "signing ragebait-detector ${version} from dist-mv2/"

# AMO can take a few minutes to process the upload. web-ext polls for us.
#
# Flags verified against `web-ext sign --help` (web-ext 8.10.0):
#   --channel is REQUIRED on sign. `unlisted` = signed and installable, but
#   not publicly listed or searchable, which is what this project wants.
#   There is no --overwrite-dest here; that flag belongs to `web-ext build`.
#   Re-signing the same version reuses the same artifact filename, so remove
#   web-ext-artifacts/*.xpi first if web-ext refuses to overwrite.
npx web-ext sign \
  --api-key="$AMO_KEY" \
  --api-secret="$AMO_SECRET" \
  --source-dir dist-mv2 \
  --artifacts-dir web-ext-artifacts \
  --channel unlisted

echo
echo "done. signed artifact:"
ls -la web-ext-artifacts/*.xpi