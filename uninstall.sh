#!/usr/bin/env bash
# Nome - Onscreen Keyboard -- uninstaller for the Shell extension.
#
# Default behaviour deletes EVERYTHING the extension ever wrote to disk
# (extension files, learned words, UI config, app launcher, gsettings
# enabled-extensions entry).  This makes "./uninstall.sh && ./install.sh"
# a true clean reinstall.  Pass --keep-data to retain learned words /
# config across the reinstall.
#
# Usage:
#   ./uninstall.sh             # delete everything
#   ./uninstall.sh --keep-data # keep learned words / UI config

set -euo pipefail

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  [OK]\033[0m %s\n' "$*"; }

[[ "$(id -u)" -ne 0 ]] \
    || { echo "Run as your normal user (extensions install per-user)." >&2; exit 1; }

KEEP_DATA=0
case "${1:-}" in
    --keep-data|-k)         KEEP_DATA=1 ;;
    --purge|-p|"")          KEEP_DATA=0 ;;  # --purge accepted for back-compat
    -h|--help|help)
        cat <<EOF
Usage:
  $0                Delete everything (extension, user data, launcher,
                    gsettings entry).  Use this for a clean reinstall.
  $0 --keep-data    Keep learned words and UI config; remove the rest.
EOF
        exit 0 ;;
    *) warn "Unknown arg: $1 (ignored)." ;;
esac

UUID="gnome-osk@linuxosk.github.io"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/nome-onscreen-keyboard.desktop"
LOGS_DESKTOP_FILE="$DESKTOP_DIR/nome-osk-crash-logs.desktop"
LEGACY_DESKTOP_FILE="$DESKTOP_DIR/gnome-osk.desktop"
# $XDG_DATA_HOME/gnome-osk/ is where the extension stores learned
# words (userdata.json), UI prefs (config.json), wordlist.txt, and
# seed-bigrams.txt.
USER_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-osk"

# ---- 1. Disable in the running Shell + drop from gsettings list -----
# `gnome-extensions disable` flips the gsettings flag AND removes the
# UUID from org.gnome.shell.enabled-extensions; running it before we
# delete the files makes sure the next login doesn't try to load a
# half-deleted extension.
if command -v gnome-extensions >/dev/null; then
    info "Disabling extension"
    gnome-extensions disable "$UUID" 2>/dev/null || true
    ok "Disabled (or wasn't enabled)"
fi

# Belt-and-braces gsettings cleanup: explicitly strip the UUID from
# enabled-extensions and disabled-extensions lists.  gnome-extensions
# disable usually does this, but on some Shell builds it leaves stale
# entries that show up as ghost extensions in the manager UI.
if command -v gsettings >/dev/null; then
    for key in enabled-extensions disabled-extensions; do
        cur="$(gsettings get org.gnome.shell "$key" 2>/dev/null || echo '')"
        if [[ -n "$cur" && "$cur" == *"$UUID"* ]]; then
            info "Removing UUID from org.gnome.shell.$key"
            # Build a new list excluding our UUID.  Python is the
            # safest small-helper available across distros; fall back
            # to a sed cleanup if python isn't present.
            if command -v python3 >/dev/null; then
                new=$(python3 -c "
import sys, ast
cur = ast.literal_eval(sys.argv[1])
new = [x for x in cur if x != sys.argv[2]]
print('[' + ', '.join(repr(x) for x in new) + ']')
" "$cur" "$UUID")
                gsettings set org.gnome.shell "$key" "$new" 2>/dev/null \
                    && ok "  $key cleaned" || warn "  $key set failed"
            else
                # Crude fallback: drop "'UUID', " or ", 'UUID'" or "'UUID'".
                new=$(echo "$cur" \
                    | sed -E "s/'$UUID', ?//g; s/, ?'$UUID'//g; s/'$UUID'//g")
                gsettings set org.gnome.shell "$key" "$new" 2>/dev/null \
                    && ok "  $key cleaned (sed fallback)" \
                    || warn "  $key set failed (install python3 for reliable cleanup)"
            fi
        fi
    done
fi

# ---- 2. Remove the extension files ---------------------------------
if [[ -d "$EXT_DIR" ]]; then
    info "Removing extension directory $EXT_DIR"
    rm -rf "$EXT_DIR"
    ok "Extension files deleted"
fi

# ---- 3. Remove the app launcher ------------------------------------
if [[ -f "$DESKTOP_FILE" || -f "$LOGS_DESKTOP_FILE" || -f "$LEGACY_DESKTOP_FILE" ]]; then
    info "Removing app-grid launcher"
    rm -f "$DESKTOP_FILE" "$LOGS_DESKTOP_FILE" "$LEGACY_DESKTOP_FILE"
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    ok "Launcher deleted"
fi

# ---- 4. Remove user data (config, learned words, wordlists) --------
if [[ -d "$USER_DATA_DIR" ]]; then
    if [[ "$KEEP_DATA" -eq 1 ]]; then
        info "Keeping user data at $USER_DATA_DIR"
        info "  (learned words and UI config will survive reinstall)"
    else
        info "Removing user data at $USER_DATA_DIR"
        info "  (learned words, UI config, downloaded wordlists)"
        rm -rf "$USER_DATA_DIR"
        ok "User data deleted"
    fi
fi

cat <<DONE

================================================================
  Extension uninstalled.

  If the Shell is running on Wayland, the extension is still
  loaded in memory until you log out.  Log out + log back in
  to fully unload it (or reboot).
================================================================
DONE
