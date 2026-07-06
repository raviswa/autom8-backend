#!/bin/bash
# =============================================================================
# rename_in_nodejs.sh
# Replaces all Supabase .from('restaurants') table name strings in src/
# Run from the root of autom8-backend-main/
#
# Usage:
#   chmod +x migrations/rename_in_nodejs.sh
#   ./migrations/rename_in_nodejs.sh
#   ./migrations/rename_in_nodejs.sh --dry-run   ← preview only, no changes
# =============================================================================

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "🔍 DRY RUN — showing matches only, no files will be changed"
fi

# ---------------------------------------------------------------------------
# Table name mappings
# ---------------------------------------------------------------------------
# Only table name STRINGS are replaced — variable names (restaurantId,
# restaurant_id, getRestaurant etc.) are intentionally left unchanged.

declare -A REPLACEMENTS=(
  ["'restaurants'"]="'tenants'"
  ["'restaurant_subscriptions'"]="'tenant_subscriptions'"
  ["'restaurant_integrations'"]="'tenant_integrations'"
)

# ---------------------------------------------------------------------------
# Find all .js files in src/ (excludes node_modules automatically)
# ---------------------------------------------------------------------------

SRC_DIR="./src"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "❌ Error: $SRC_DIR directory not found. Run from autom8-backend-main/ root."
  exit 1
fi

echo ""
echo "=== Autom8 · Table rename: restaurants → tenants ==="
echo "Target directory: $SRC_DIR"
echo ""

TOTAL_FILES=0
TOTAL_HITS=0

for old in "${!REPLACEMENTS[@]}"; do
  new="${REPLACEMENTS[$old]}"

  # Count matches before replacing
  hits=$((grep -rl "$old" "$SRC_DIR" --include="*.js" 2>/dev/null || true) | wc -l | tr -d ' ')
  count=$((grep -r "$old" "$SRC_DIR" --include="*.js" 2>/dev/null || true) | wc -l | tr -d ' ')

  echo "  $old  →  $new"
  echo "  Found in $hits file(s), $count occurrence(s)"

  if [[ "$DRY_RUN" == "true" ]]; then
    grep -rn "$old" "$SRC_DIR" --include="*.js" 2>/dev/null | head -5 || true
    echo ""
    continue
  fi

  if [[ "$count" -gt 0 ]]; then
    # -i '' for macOS, -i for Linux — detect OS
    if [[ "$(uname)" == "Darwin" ]]; then
      find "$SRC_DIR" -name "*.js" -exec sed -i '' "s|${old}|${new}|g" {} +
    else
      find "$SRC_DIR" -name "*.js" -exec sed -i "s|${old}|${new}|g" {} +
    fi
    echo "  ✅ Replaced"
  else
    echo "  ⏭️  No matches — skipped"
  fi

  TOTAL_FILES=$((TOTAL_FILES + hits))
  TOTAL_HITS=$((TOTAL_HITS + count))
  echo ""
done

# ---------------------------------------------------------------------------
# Also fix the one raw SQL text() reference in wait_estimate.py (Python)
# ---------------------------------------------------------------------------

WAIT_ESTIMATE="./chat/tools/wait_estimate.py"

if [[ -f "$WAIT_ESTIMATE" ]]; then
  py_hits=$(grep -c "FROM restaurants WHERE" "$WAIT_ESTIMATE" 2>/dev/null || true)
  if [[ "$py_hits" -gt 0 ]]; then
    echo "  Python: $WAIT_ESTIMATE"
    echo "  FROM restaurants WHERE  →  FROM tenants WHERE"
    if [[ "$DRY_RUN" == "false" ]]; then
      if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s|FROM restaurants WHERE|FROM tenants WHERE|g" "$WAIT_ESTIMATE"
      else
        sed -i "s|FROM restaurants WHERE|FROM tenants WHERE|g" "$WAIT_ESTIMATE"
      fi
      echo "  ✅ Replaced"
    fi
    echo ""
  fi
fi

# ---------------------------------------------------------------------------
# Verify — confirm no stale 'restaurants' strings remain in .from() calls
# ---------------------------------------------------------------------------

if [[ "$DRY_RUN" == "false" ]]; then
  echo "=== Verification ==="
  remaining=$((grep -r "\.from('restaurants')\|\.from('restaurant_subscriptions')\|\.from('restaurant_integrations')" \
    "$SRC_DIR" --include="*.js" 2>/dev/null || true) | wc -l | tr -d ' ')

  if [[ "$remaining" -eq 0 ]]; then
    echo "✅ No stale table name strings remaining in src/"
  else
    echo "⚠️  $remaining stale reference(s) still found — review manually:"
    grep -rn "\.from('restaurants')\|\.from('restaurant_subscriptions')\|\.from('restaurant_integrations')" \
      "$SRC_DIR" --include="*.js" 2>/dev/null
  fi
  echo ""
  echo "Total: ~$TOTAL_HITS string(s) replaced across ~$TOTAL_FILES file(s)"
fi

echo ""
echo "Next steps:"
echo "  1. Run the Supabase SQL migration: migrations/rename_restaurants_to_tenants.sql"
echo "  2. Deploy updated models.py (chat/db/models.py)"
echo "  3. Deploy updated wait_estimate.py (chat/tools/wait_estimate.py)"
echo "  4. Redeploy both Railway services"
echo ""