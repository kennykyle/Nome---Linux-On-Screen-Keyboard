#!/usr/bin/env bash
# Developer validation for Nome - Onscreen Keyboard.
# This script is intentionally dependency-light: Node.js is used when
# present for JavaScript syntax checks and predictor unit tests, while
# shellcheck remains optional.

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  [OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  [!!]\033[0m %s\n' "$*"; }

NODE_BIN="${NODE:-node}"

if command -v "$NODE_BIN" >/dev/null 2>&1; then
    info "Checking JavaScript syntax"
    "$NODE_BIN" --check extension.js
    "$NODE_BIN" --check layouts.js
    "$NODE_BIN" --check lifecycle.js
    "$NODE_BIN" --check theme.js
    "$NODE_BIN" --check dataPaths.js
    "$NODE_BIN" --check modalAuth.js
    "$NODE_BIN" --check rgbEffects.js
    "$NODE_BIN" --check keyboard.js
    "$NODE_BIN" --check indicator.js
    "$NODE_BIN" --check predictor.js
    ok "JavaScript parses"

    info "Checking metadata.json"
    "$NODE_BIN" -e "JSON.parse(require('fs').readFileSync('metadata.json', 'utf8'))"
    ok "metadata.json parses"

    info "Running predictor unit tests"
    "$NODE_BIN" tests/predictor.test.mjs
    ok "Predictor tests passed"

    info "Checking package consistency"
    "$NODE_BIN" tests/package-consistency.mjs
    ok "Package consistency passed"
else
    warn "Node.js not found; skipped JS syntax, metadata, and predictor tests"
    if command -v python3 >/dev/null 2>&1; then
        info "Checking metadata.json with python3"
        python3 -m json.tool metadata.json >/dev/null
        ok "metadata.json parses"
    fi
fi

if command -v eslint >/dev/null 2>&1; then
    info "Running ESLint"
    eslint extension.js layouts.js lifecycle.js theme.js dataPaths.js modalAuth.js \
        rgbEffects.js keyboard.js indicator.js predictor.js tests/predictor.test.mjs
    ok "ESLint passed"
else
    warn "eslint not found; skipped JS lint"
fi

info "Checking shell syntax"
bash -n install.sh
bash -n uninstall.sh
bash -n nome-osk-crash-logs.sh
bash -n tests/gnome-smoke.sh
bash -n "Install Nome - Onscreen Keyboard.sh"
bash -n "Uninstall Nome - Onscreen Keyboard.sh"
ok "Shell scripts parse"

if [[ "${GNOME_OSK_SMOKE:-0}" -eq 1 ]]; then
    info "Running GNOME VM smoke test"
    bash tests/gnome-smoke.sh
    ok "GNOME smoke test passed"
else
    warn "GNOME VM smoke skipped; set GNOME_OSK_SMOKE=1 inside a disposable GNOME VM"
fi

if command -v shellcheck >/dev/null 2>&1; then
    info "Running shellcheck"
    shellcheck install.sh uninstall.sh nome-osk-crash-logs.sh \
        tests/gnome-smoke.sh \
        "Install Nome - Onscreen Keyboard.sh" \
        "Uninstall Nome - Onscreen Keyboard.sh"
    ok "shellcheck passed"
else
    warn "shellcheck not found; skipped shell lint"
fi

info "Checking for removed modal-debug leftovers"
if grep -R -n -E 'modal-debug|OSK_MODAL_DEBUG' extension.js nome-osk-crash-logs.sh; then
    warn "Found stale modal-debug references"
    exit 1
fi
ok "No stale modal-debug references"

info "All available checks passed"
