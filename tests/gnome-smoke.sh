#!/usr/bin/env bash
# Disposable-VM smoke test for Nome - Onscreen Keyboard.
#
# This intentionally mutates the current GNOME user session by installing,
# enabling, disabling, and re-enabling the extension. Run it inside a GNOME
# VM/snapshot, not on a workstation where you care about the current session.

set -euo pipefail

ROOT="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )/.." &> /dev/null && pwd )"
UUID="gnome-osk@linuxosk.github.io"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  [OK]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

command -v gnome-extensions >/dev/null \
    || die "gnome-extensions CLI not found"
[[ -n "${XDG_CURRENT_DESKTOP:-}" || -n "${GNOME_DESKTOP_SESSION_ID:-}" ]] \
    || die "This smoke test must run inside a GNOME session"

info "Installing extension payload"
"$ROOT/install.sh" --keep-data --no-gdm

info "Enable/disable cycle"
gnome-extensions enable "$UUID"
sleep 2
gnome-extensions info "$UUID" | grep -Eq 'State:[[:space:]]+ENABLED|Enabled:[[:space:]]+Yes' \
    || die "Extension did not report enabled"

gnome-extensions disable "$UUID"
sleep 1
gnome-extensions enable "$UUID"
sleep 2
gnome-extensions info "$UUID" | grep -Eq 'State:[[:space:]]+ENABLED|Enabled:[[:space:]]+Yes' \
    || die "Extension did not re-enable"
ok "User-session enable/disable smoke passed"

info "Launcher D-Bus contract"
gdbus call --session --dest org.gnome.Shell \
    --object-path /io/linuxosk/OSK \
    --method io.linuxosk.OSK.Hide >/dev/null
gdbus call --session --dest org.gnome.Shell \
    --object-path /io/linuxosk/OSK \
    --method io.linuxosk.OSK.Show >/dev/null
ok "D-Bus show/hide smoke passed"

if [[ "${GNOME_OSK_SMOKE_GDM:-0}" -eq 1 ]]; then
    [[ "$(id -u)" -ne 0 ]] || die "Run user smoke as the desktop user, not root"
    command -v sudo >/dev/null || die "sudo not found for GDM smoke"
    info "GDM install/restore smoke"
    sudo "$ROOT/install.sh" gdm-install
    sudo "$ROOT/install.sh" gdm-restore
    ok "GDM smoke passed"
else
    info "Skipping GDM smoke; set GNOME_OSK_SMOKE_GDM=1 in a disposable VM"
fi
