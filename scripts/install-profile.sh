#!/usr/bin/env bash
# Install or refresh the board profile for a DeepSeek Harness installation.
#
# Usage:
#   scripts/install-profile.sh [workspace-path]
#
# env:
#   DSH_HOME            Harness home (default: ~/.dsh)
#   DSH_BOARD_PROFILE   profile name (default: board)
#
# The script is idempotent: it edits an existing profile's package.json instead
# of overwriting it, and never overwrites an existing cordis.patch.yml.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_BOARD_PROFILE:-board}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
WORKSPACE="${1:-}"

command -v pnpm >/dev/null 2>&1 || {
  echo "pnpm is required (Harness plugin management uses it)" >&2
  exit 1
}

mkdir -p "$PROFILE_DIR"

node - "$PROFILE_DIR/package.json" "$REPO_DIR" <<'NODE'
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const [file, repo] = process.argv.slice(2)
let pkg
if (existsSync(file)) {
  pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.dependencies = pkg.dependencies ?? {}
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? []
} else {
  pkg = {
    name: `dsh-profile-${process.env.DSH_BOARD_PROFILE || 'board'}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }
}
pkg.dependencies['dsh-board'] = `link:${repo}`
if (!pkg.dsh.profile.bundles.includes('dsh-board')) pkg.dsh.profile.bundles.push('dsh-board')
if (!pkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-base')) pkg.dsh.profile.bundles.unshift('@deepseek-ai/dsh-base')
if (!pkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app')) {
  pkg.dsh.profile.bundles.splice(pkg.dsh.profile.bundles.indexOf('dsh-board'), 0, '@deepseek-ai/dsh-web-app')
}
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
NODE

PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  cat > "$PATCH" <<'YAML'
# Board profile user layer. The dsh-board bundle inserts its own row; this layer
# configures the run controller.
#   workspace: defaults to the directory dsh is launched from (your Git repo).
#   Set DSH_BOARD_WORKSPACE to override, or edit the !!js expression below.
- id: board
  config:
    workspace: !!js process.env.DSH_BOARD_WORKSPACE || process.cwd()
    maxWorkers: 2
    agentPreset: standard
    worktrees: true

# Per-ticket Git worktree isolation (experimental package shipped with Harness).
- insert:
    - id: worktrees
      name: '@deepseek-ai/dsh-experimental-worktree'
YAML
  echo "wrote $PATCH"
else
  echo "kept existing $PATCH (merge the board config manually if needed)"
fi

(
  cd "$PROFILE_DIR"
  pnpm install --silent
)

echo
echo "profile ready: $PROFILE_DIR"
if [ -n "$WORKSPACE" ]; then
  echo "launch from your repo:  cd \"$WORKSPACE\" && dsh --profile $PROFILE"
else
  echo "launch from your repo:  cd /path/to/your/repo && dsh --profile $PROFILE"
fi
echo "the startup URL carries a token; open it once to authenticate the browser"
