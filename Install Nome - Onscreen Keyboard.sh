#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

clear 2>/dev/null || true
cat <<'INTRO'
Nome - Onscreen Keyboard installer
==================================

This installs the keyboard for your current user and keeps existing
learned words/settings if you are reinstalling.

After the install, you can optionally add login-screen support for GDM.
That part needs administrator authentication and is safe to skip.

If you are updating and previously installed GDM/login-screen support,
the installer will detect it and update the login-screen copy too.

The installer downloads the full English prediction vocabulary when
network access is available. If that fails, install still continues and
you can retry from the extension menu later.

INTRO

chmod +x "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/uninstall.sh" 2>/dev/null || true
status=0
bash "$SCRIPT_DIR/install.sh" --keep-data --ask-gdm || status=$?

if [[ "$status" -ne 0 ]]; then
    echo
    echo "Install failed with exit code $status."
fi

if [[ -r /dev/tty && -w /dev/tty ]]; then
    printf '\nInstaller finished. Press Enter to close this window...' > /dev/tty
    read -r _ < /dev/tty || true
fi

exit "$status"
