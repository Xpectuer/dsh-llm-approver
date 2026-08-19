#!/usr/bin/env bash
# install.sh — install the dsh-llm-approver bundle into a dsh profile.
#
# Usage:
#   ./install.sh                          # install into the web profile from GitHub
#   ./install.sh --profile tui            # install into another profile
#   ./install.sh --source file:/path/to/dsh-llm-approver   # local source
#
# What it does:
#   1. adds "@dsh-external/dsh-llm-approver" to the profile's bundles list
#   2. adds the package to the profile's dependencies
#   3. runs `pnpm install` in the profile directory
#   4. verifies the composed tree contains the workspace-write-llm preset
#
# You still need to restart the profile process afterwards (no HMR).

set -euo pipefail

PROFILE="web"
SOURCE="github:Xpectuer/dsh-llm-approver"
BUNDLE="@dsh-external/dsh-llm-approver"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$PROFILE" ]] || { echo "error: --profile needs a value" >&2; exit 2; }
[[ -n "$SOURCE" ]] || { echo "error: --source needs a value" >&2; exit 2; }

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[[ -f "$PKG" ]] || { echo "error: profile '$PROFILE' not found at $PROFILE_DIR" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm is not on PATH" >&2; exit 1; }

RESULT="$(node "$SCRIPT_DIR/edit-package-json.mjs" "$PKG" add "$BUNDLE" "$SOURCE")"
if [[ "$RESULT" == "changed" ]]; then
  echo "package.json updated — installing dependencies..."
  (cd "$PROFILE_DIR" && pnpm install)
else
  echo "$BUNDLE already present in $PROFILE — nothing to change"
fi

echo "verifying composed tree..."
if dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q "workspace-write-llm"; then
  echo "OK: workspace-write-llm preset present in the composition"
else
  echo "WARN: workspace-write-llm not found in the composition (check: dsh --profile $PROFILE --dump-config)" >&2
  exit 1
fi

cat <<MSG

Installed into profile "$PROFILE". Restart the profile process to activate:

  dsh --profile "$PROFILE"      # (for the web GUI: dsh web)

Then switch a session to "Workspace Write · LLM Review" in the permission
selector. Escalations for safe operations are auto-approved by an
independent-context LLM; destructive or uncertain ones still ask you.
MSG
