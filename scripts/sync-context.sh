#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/sync-context.sh
# Generates .claude/context.md — a daily snapshot of the repo state.
# Run via:  npm run claude:sync
# Then open Claude Code and type:  /sync
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.claude/context.md"
mkdir -p "$ROOT/.claude"

echo "🔄  Generating Claude context snapshot → .claude/context.md"

# ── helpers ──────────────────────────────────────────────────────────────────
src_tree() {
  find "$ROOT/src" -type f -name "*.ts" | sort | sed "s|$ROOT/||"
}

list_entities() {
  find "$ROOT/src" -name "*.entity.ts" | sort | sed "s|$ROOT/||"
}

list_modules() {
  find "$ROOT/src" -name "*.module.ts" | sort | sed "s|$ROOT/||"
}

list_dtos() {
  find "$ROOT/src" -name "*.dto.ts" | sort | sed "s|$ROOT/||"
}

list_migrations() {
  find "$ROOT/src/database/migrations" -name "*.ts" 2>/dev/null | sort | sed "s|$ROOT/||"
}

dep_versions() {
  node -e "
    const p = require('./package.json');
    const deps = { ...p.dependencies };
    Object.entries(deps).forEach(([k,v]) => console.log('  ' + k + ': ' + v));
  " 2>/dev/null || echo "  (could not read package.json)"
}

# ── write context file ────────────────────────────────────────────────────────
cat > "$OUT" <<EOF
# Earth DNA — Daily Context Snapshot
> Generated: $(date "+%Y-%m-%d %H:%M:%S %Z")

---

## Git Status
\`\`\`
$(git -C "$ROOT" status --short 2>/dev/null || echo "not a git repo")
\`\`\`

## Recent Commits (last 20)
\`\`\`
$(git -C "$ROOT" log --oneline -20 2>/dev/null || echo "no commits yet")
\`\`\`

## Active Branch
\`\`\`
$(git -C "$ROOT" branch --show-current 2>/dev/null || echo "unknown")
\`\`\`

---

## Source Tree (src/)
\`\`\`
$(src_tree)
\`\`\`

---

## Modules
$(list_modules | while IFS= read -r f; do echo "- \`$f\`"; done)

## Entities
$(entities=$(list_entities); if [ -z "$entities" ]; then echo "_(none yet)_"; else echo "$entities" | while IFS= read -r f; do echo "- \`$f\`"; done; fi)

## DTOs
$(dtos=$(list_dtos); if [ -z "$dtos" ]; then echo "_(none yet)_"; else echo "$dtos" | while IFS= read -r f; do echo "- \`$f\`"; done; fi)

## Migrations
$(migs=$(list_migrations); if [ -z "$migs" ]; then echo "_(none yet)_"; else echo "$migs" | while IFS= read -r f; do echo "- \`$f\`"; done; fi)

---

## Runtime Dependencies
\`\`\`
$(dep_versions)
\`\`\`

## Environment Variables (keys only)
\`\`\`
$(grep -v '^#' "$ROOT/.env" 2>/dev/null | grep '=' | cut -d= -f1 | sort | sed 's/^/  /' || echo "  (no .env found)")
\`\`\`

---

## Docker Services
\`\`\`
$(docker ps --filter "name=earth_dna" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "docker not available")
\`\`\`

---
_End of snapshot. Run \`npm run claude:sync\` again to refresh._
EOF

echo "✅  Context written to .claude/context.md"
echo "👉  Now open Claude Code and type: /sync"
