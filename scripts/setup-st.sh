#!/usr/bin/env bash
# Prepares a slim, local-only SillyTavern instance that acts as the preset parser/runtime.
# Usage: scripts/setup-st.sh [ST_DIR]   (default: ./.st)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ST_DIR="${1:-${ST_DIR:-$ROOT/.st}}"
ST_COMMIT="$(sed -n "s/^export const ST_COMMIT = '\(.*\)';/\1/p" "$ROOT/extension/src/rules.js")"

if [ ! -d "$ST_DIR/.git" ]; then
  git clone --filter=blob:none https://github.com/SillyTavern/SillyTavern.git "$ST_DIR"
fi
git -C "$ST_DIR" fetch --quiet origin "$ST_COMMIT" || true
git -C "$ST_DIR" -c advice.detachedHead=false checkout --quiet "$ST_COMMIT"
(cd "$ST_DIR" && npm ci --no-audit --no-fund --loglevel=error)

# config.yaml: loopback only, no browser launch, no auto-updates, no downloads.
cd "$ST_DIR"
node -e '
const fs = require("fs"); const YAML = require("yaml");
const doc = YAML.parseDocument(fs.readFileSync("default/config.yaml", "utf8"));
doc.set("listen", false);
doc.setIn(["browserLaunch", "enabled"], false);
doc.setIn(["extensions", "autoUpdate"], false);
doc.setIn(["extensions", "models", "autoDownload"], false);
doc.set("enableDownloadableTokenizers", false);
fs.writeFileSync("config.yaml", String(doc));
'

# Install the extension (symlink so edits are live).
mkdir -p public/scripts/extensions/third-party
ln -sfn "$ROOT/extension" public/scripts/extensions/third-party/st-preset-dismantle

# First-run settings: Chat Completion API, every built-in extension except Regex disabled.
USER_DIR="data/default-user"
if [ ! -f "$USER_DIR/settings.json" ]; then
  mkdir -p "$USER_DIR"
  node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync("default/content/settings.json", "utf8"));
s.main_api = "openai";
const keep = new Set(["regex", "third-party"]);
const builtIn = fs.readdirSync("public/scripts/extensions", { withFileTypes: true }).filter(d => d.isDirectory() && !keep.has(d.name)).map(d => d.name);
s.extension_settings = s.extension_settings || {};
s.extension_settings.disabledExtensions = builtIn;
s.extension_settings.notifyUpdates = false;
fs.writeFileSync(process.argv[1], JSON.stringify(s, null, 4));
' "$USER_DIR/settings.json"
fi
echo "SillyTavern $ST_COMMIT ready in $ST_DIR. Start with: (cd $ST_DIR && node server.js)"
