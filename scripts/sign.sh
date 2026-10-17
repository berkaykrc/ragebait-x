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

# The current version is the artifact filename AMO will produce. Print it so
# a signing run is identifiable in the shell history without printing secrets.
version="$(
  node -p 'JSON.parse(require("fs").readFileSync("manifest.mv2.json","utf8")).version'
)"
echo "signing ragebait-detector ${version} from dist-mv2/"

# AMO can take a few minutes to process the upload. web-ext polls for us.
npx web-ext sign \
  --api-key="$AMO_KEY" \
  --api-secret="$AMO_SECRET" \
  --source-dir dist-mv2 \
  --artifacts-dir web-ext-artifacts \
  --overwrite-dest

echo
echo "done. signed artifact:"
ls -la web-ext-artifacts/*.xpi