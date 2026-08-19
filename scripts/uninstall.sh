#!/usr/bin/env bash
# uninstall.sh — remove the dsh-llm-approver bundle from a dsh profile.
#
# Usage:
#   ./uninstall.sh                         # remove from the web profile
#   ./uninstall.sh --profile tui           # remove from another profile
#
# What it does:
#   1. removes "@dsh-external/dsh-llm-approver" from the profile's bundles
#   2. removes the package from the profile's dependencies
#   3. runs `pnpm install` to prune the lockfile and node_modules
#   4. verifies the composed tree no longer has the preset
#
# The plugin directory (or GitHub repo) is left untouched — only the profile
# wiring is removed. Restart the profile process afterwards to unload it.

set -euo pipefail

PROFILE="web"
BUNDLE="@dsh-external/dsh-llm-approver"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$PROFILE" ]] || { echo "error: --profile needs a value" >&2; exit 2; }

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[[ -f "$PKG" ]] || { echo "error: profile '$PROFILE' not found at $PROFILE_DIR" >&2; exit 1; }

RESULT="$(node "$SCRIPT_DIR/edit-package-json.mjs" "$PKG" remove "$BUNDLE")"
if [[ "$RESULT" == "changed" ]]; then
  echo "package.json updated — pruning dependencies..."
  (cd "$PROFILE_DIR" && pnpm install)
else
  echo "$BUNDLE is not installed in $PROFILE — nothing to change"
fi

echo "verifying composed tree..."
if dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q "workspace-write-llm"; then
  echo "WARN: workspace-write-llm is still present in the composition (check: dsh --profile $PROFILE --dump-config)" >&2
  exit 1
else
  echo "OK: workspace-write-llm no longer present"
fi

cat <<MSG

Uninstalled from profile "$PROFILE". Restart the profile process to unload it:

  dsh --profile "$PROFILE"      # (for the web GUI: dsh web)
MSG
