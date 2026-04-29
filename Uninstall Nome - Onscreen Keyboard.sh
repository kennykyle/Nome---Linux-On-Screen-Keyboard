#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

ask_yes_no() {
    local prompt="$1"
    if [[ -r /dev/tty && -w /dev/tty ]]; then
        printf '%s [y/N] ' "$prompt" > /dev/tty
        local reply=""
        if ! read -r reply < /dev/tty; then
            reply=""
        fi
        case "$reply" in
            y|Y|yes|YES|Yes) return 0 ;;
            *)               return 1 ;;
        esac
    fi
    return 1
}

clear 2>/dev/null || true
cat <<'INTRO'
Nome - Onscreen Keyboard uninstaller
====================================

This removes the keyboard from your current desktop user.

INTRO

chmod +x "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/uninstall.sh" 2>/dev/null || true

status=0
if ask_yes_no "Keep learned words and UI settings?"; then
    bash "$SCRIPT_DIR/uninstall.sh" --keep-data || status=$?
else
    bash "$SCRIPT_DIR/uninstall.sh" || status=$?
fi

cat <<'GDM'

Optional: if you installed login-screen support, it can be removed too.
That needs administrator authentication.

GDM

if ask_yes_no "Remove GDM login-screen support?"; then
    if command -v sudo >/dev/null 2>&1; then
        sudo bash "$SCRIPT_DIR/install.sh" gdm-restore || true
    elif command -v pkexec >/dev/null 2>&1; then
        pkexec bash "$SCRIPT_DIR/install.sh" gdm-restore || true
    else
        echo "sudo/pkexec not found. Retry later with: sudo ./install.sh gdm-restore"
    fi
fi

if [[ -r /dev/tty && -w /dev/tty ]]; then
    printf '\nUninstaller finished. Press Enter to close this window...' > /dev/tty
    read -r _ < /dev/tty || true
fi

exit "$status"
