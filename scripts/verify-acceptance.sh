#!/bin/bash
set -e

echo "=== Pre-Merge Acceptance Checks ==="
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

CHECKS_PASSED=0
CHECKS_FAILED=0

# Function to report check result
report_check() {
  local name=$1
  local status=$2
  if [ "$status" -eq 0 ]; then
    echo -e "${GREEN}✓${NC} $name"
    CHECKS_PASSED=$((CHECKS_PASSED + 1))
  else
    echo -e "${RED}✗${NC} $name"
    CHECKS_FAILED=$((CHECKS_FAILED + 1))
  fi
}

# Check 1: DATABASE_URL existence
echo "Checking environment setup..."
if [ -z "$DATABASE_URL" ]; then
  echo -e "${YELLOW}⚠ DATABASE_URL not set. Real DB tests will be skipped.${NC}"
  SKIP_REAL_DB=1
  report_check "DATABASE_URL environment guard" 1
else
  echo -e "${GREEN}✓ DATABASE_URL is set${NC}"
  report_check "DATABASE_URL environment guard" 0
fi

echo ""
echo "Running real database tests..."

# Check 2: Real DB test suite
if [ -z "$SKIP_REAL_DB" ]; then
  if npm run test:real-db; then
    report_check "Real database test suite" 0
  else
    report_check "Real database test suite" 1
  fi
else
  echo -e "${YELLOW}⚠ Skipping real DB tests (DATABASE_URL not set)${NC}"
fi

echo ""
echo "Running mobile UI visual regression tests..."

# Check 3: Mobile UI snapshots
if npm run test:mobile-ui; then
  report_check "Mobile UI visual regression" 0
else
  report_check "Mobile UI visual regression" 1
fi

echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}${CHECKS_PASSED}${NC} | Failed: ${RED}${CHECKS_FAILED}${NC}"

if [ "$CHECKS_FAILED" -gt 0 ]; then
  echo -e "${RED}Some checks failed. Please fix before merging.${NC}"
  exit 1
else
  echo -e "${GREEN}All checks passed!${NC}"
  exit 0
fi
