#!/usr/bin/env bash
# Collect recent Nome/GNOME Shell errors and crash evidence into a
# saved log, then keep the launching terminal open long enough to read it.

set -u

UUID="gnome-osk@linuxosk.github.io"
SYSTEM_EXT_DIR="/usr/share/gnome-shell/extensions/$UUID"
GDM_DCONF_PROFILE="/etc/dconf/profile/gdm"
GDM_DCONF_DIR="/etc/dconf/db/gdm.d"
GDM_DCONF_BACKUP_DIR="/etc/dconf/db/gdm.d.gnome-osk-backups"
GDM_DCONF_FILE="/etc/dconf/db/gdm.d/99-gnome-osk"
GDM_DCONF_LOCK_FILE="/etc/dconf/db/gdm.d/locks/99-gnome-osk"
GDM_SCHEMA_OVERRIDE_FILE="/usr/share/glib-2.0/schemas/99-gnome-osk.gschema.override"
GDM_SERVICE_DROPIN="/etc/systemd/system/gdm.service.d/99-gnome-osk-dconf-profile.conf"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/gnome-osk"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$STATE_DIR/error-logs-$STAMP.log"
VERBOSE_LOGS=0
FOLLOW_LOGS=0

mkdir -p "$STATE_DIR" 2>/dev/null || true

section() {
    printf '\n==== %s ====\n' "$1"
}

print_cmd() {
    section "$*"
    "$@" 2>&1 || printf '[command exited with status %s]\n' "$?"
}

related_filter() {
    grep -Ei 'gnome-osk|gnome-osk@linuxosk|OSKKey|needs an allocation'
}

verbose_related_filter() {
    grep -Ei 'gnome-osk|gnome-osk@linuxosk|nome - onscreen|gnome-shell|mutter|gjs|coredump|screencast|screen.?cast|recorder|pipewire|wireplumber|xdg-desktop-portal|portal'
}

error_filter() {
    grep -Ei 'error|warn|warning|critical|failed|failure|denied|exception|trace|segfault|assert|fatal|crash|coredump|panic|oops|allocation|Can.t update stage views'
}

print_readable_file() {
    local file="$1"
    if [[ -r "$file" ]]; then
        printf '\n-- %s --\n' "$file"
        sed 's/^/  /' "$file"
    elif [[ -e "$file" ]]; then
        printf '\n-- %s --\n  exists but is not readable by this user\n' "$file"
    else
        printf '\n-- %s --\n  missing\n' "$file"
    fi
}

print_gdm_dconf_backup_status() {
    local file found
    local patterns=(
        "$GDM_DCONF_DIR"/99-gnome-osk.disabled.*
        "$GDM_DCONF_DIR"/99-gnome-osk.superseded.*
        "$GDM_DCONF_DIR"/90-gnome-osk.disabled.*
        "$GDM_DCONF_DIR"/90-gnome-osk.superseded.*
        "$GDM_DCONF_DIR"/locks/99-gnome-osk.disabled.*
        "$GDM_DCONF_DIR"/locks/99-gnome-osk.superseded.*
        "$GDM_DCONF_DIR"/locks/90-gnome-osk.disabled.*
        "$GDM_DCONF_DIR"/locks/90-gnome-osk.superseded.*
    )

    printf '\n-- Active GDM dconf backup files --\n'
    found=0
    for file in "${patterns[@]}"; do
        [[ -f "$file" ]] || continue
        printf '  %s\n' "$file"
        found=1
    done
    if [[ "$found" -eq 0 ]]; then
        printf '  none found in active dconf database paths\n'
    else
        printf '  These can still be parsed by dconf; run sudo ./install.sh gdm-install to quarantine them.\n'
    fi

    if [[ -d "$GDM_DCONF_BACKUP_DIR" ]]; then
        printf '\n-- Nome inactive GDM dconf backup directory --\n'
        find "$GDM_DCONF_BACKUP_DIR" -maxdepth 1 -type f -printf '  %f\n' 2>/dev/null \
            | sort || true
    fi
}

collect_gdm_install_snapshot() {
    section "GDM login-screen install snapshot"
    if [[ -d "$SYSTEM_EXT_DIR" ]]; then
        printf 'System extension dir exists: %s\n' "$SYSTEM_EXT_DIR"
        if [[ -r "$SYSTEM_EXT_DIR/metadata.json" ]]; then
            printf 'System metadata:\n'
            grep -E '"version"|"session-modes"|"shell-version"' \
                "$SYSTEM_EXT_DIR/metadata.json" 2>/dev/null \
                | sed 's/^/  /' || true
        fi
    else
        printf 'System extension dir missing: %s\n' "$SYSTEM_EXT_DIR"
    fi

    print_readable_file "$GDM_DCONF_PROFILE"
    print_readable_file "$GDM_DCONF_FILE"
    print_readable_file "$GDM_DCONF_LOCK_FILE"
    print_readable_file "$GDM_SCHEMA_OVERRIDE_FILE"
    print_readable_file "$GDM_SERVICE_DROPIN"
    print_gdm_dconf_backup_status

    section "GDM dconf values via DCONF_PROFILE=gdm (current user context)"
    printf 'For authoritative greeter values, run: sudo ./install.sh check\n'
    if command -v gsettings >/dev/null 2>&1; then
        for key in enabled-extensions disabled-extensions disable-user-extensions; do
            printf '%s: ' "$key"
            env DCONF_PROFILE=gdm \
                gsettings get org.gnome.shell "$key" 2>&1 \
                || printf '[command exited with status %s]\n' "$?"
        done
    else
        printf 'gsettings command not found\n'
    fi
}

collect_gdm_activation_diagnosis() {
    command -v journalctl >/dev/null 2>&1 || return 0

    section "Current boot: GDM activation diagnosis"
    local gdm_enable_hits system_scan_tail
    gdm_enable_hits="$(journalctl -b _COMM=gnome-shell --no-pager 2>/dev/null \
        | grep -c 'gnome-osk: enable() starting.*session-mode=gdm' \
        || true)"
    printf 'GDM enable log count: %s\n' "${gdm_enable_hits:-0}"

    system_scan_tail="$(journalctl -b _COMM=gnome-shell --no-pager 2>/dev/null \
        | grep -F "$UUID" \
        | grep -E '/usr/share/.+will not be loaded|already installed in /usr/share' \
        | tail -n 10 || true)"
    if [[ -n "$system_scan_tail" ]]; then
        printf '\nGDM/system extension scan lines:\n'
        printf '%s\n' "$system_scan_tail"
    fi

    if [[ "${gdm_enable_hits:-0}" -eq 0 && -n "$system_scan_tail" ]]; then
        printf '\nDiagnosis: GDM saw the system extension path but did not activate Nome.\n'
        printf 'That usually means the greeter did not see %s in org.gnome.shell enabled-extensions,\n' "$UUID"
        printf 'or it still has disable-user-extensions/disabled-extensions blocking it.\n'
    elif [[ "${gdm_enable_hits:-0}" -eq 0 ]]; then
        printf '\nDiagnosis: no evidence that the GDM greeter loaded Nome this boot.\n'
    else
        printf '\nDiagnosis: GDM did call Nome enable(); if the keyboard was invisible, the next suspect is actor placement/layering.\n'
    fi
}

collect_logs() {
    section "Nome OSK error and crash log snapshot"
    date -Is
    printf 'UUID: %s\n' "$UUID"
    printf 'Saved log: %s\n' "$OUT"

    section "Session"
    printf 'User: %s\n' "${USER:-unknown}"
    printf 'Desktop: %s\n' "${XDG_CURRENT_DESKTOP:-unset}"
    printf 'Session type: %s\n' "${XDG_SESSION_TYPE:-unset}"
    printf 'Shell: '
    if command -v gnome-shell >/dev/null 2>&1; then
        gnome-shell --version 2>/dev/null || printf 'unknown\n'
    else
        printf 'gnome-shell command not found\n'
    fi

    if command -v gnome-extensions >/dev/null 2>&1; then
        print_cmd gnome-extensions info "$UUID"
    else
        section "Extension state"
        printf 'gnome-extensions command not found\n'
    fi

    collect_gdm_install_snapshot

    if command -v journalctl >/dev/null 2>&1; then
        collect_gdm_activation_diagnosis

        section "Current boot: Nome messages"
        journalctl -b -o short-iso --no-pager 2>/dev/null \
            | grep -Ei 'gnome-osk|gnome-osk@linuxosk' \
            | tail -n 180

        section "Current boot: focused Nome/Shell warnings"
        journalctl -b -o short-iso --no-pager _COMM=gnome-shell 2>/dev/null \
            | grep -Ei 'gnome-osk|gnome-osk@linuxosk|OSKKey|needs an allocation|JS ERROR|Extension .*gnome-osk' \
            | error_filter \
            | tail -n 180 \
            || printf 'No focused Nome/GNOME Shell warnings found.\n'

        if [[ "$VERBOSE_LOGS" -eq 1 ]]; then
            section "Current boot: verbose related warnings/errors/crashes"
            journalctl -b -o short-iso --no-pager 2>/dev/null \
                | verbose_related_filter \
                | error_filter \
                | tail -n 400

            section "Previous boot: verbose related warnings/errors/crashes"
            journalctl -b -1 -o short-iso --no-pager 2>/dev/null \
                | verbose_related_filter \
                | error_filter \
                | tail -n 250 \
                || printf 'No previous boot journal available to this user.\n'
        fi
    else
        section "Journal"
        printf 'journalctl command not found\n'
    fi

    if command -v coredumpctl >/dev/null 2>&1; then
        section "Recent coredumps"
        coredumpctl list --since "-24h" 2>/dev/null \
            | grep -Ei 'gnome-shell|mutter|gnome-osk' \
            | tail -n 20 \
            || printf 'No matching coredumps visible to this user.\n'
    else
        section "Recent coredumps"
        printf 'coredumpctl command not found\n'
    fi

    section "Useful manual commands"
    printf 'Current boot focused Nome errors:\n'
    printf '  journalctl -b -o short-iso --no-pager _COMM=gnome-shell | grep -Ei "gnome-osk|OSKKey|needs an allocation|JS ERROR"\n'
    printf 'Verbose local snapshot:\n'
    printf '  ./nome-osk-crash-logs.sh --verbose\n'
    printf 'If GDM/login-screen crashed, run with sudo:\n'
    printf '  sudo journalctl -b _COMM=gnome-shell --no-pager | grep -Ei "gnome-osk|error|warn|failed|crash|segfault|coredump"\n'
    printf 'Full GDM install/activation diagnosis:\n'
    printf '  sudo ./install.sh check\n'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --verbose) VERBOSE_LOGS=1; shift ;;
        --follow) FOLLOW_LOGS=1; shift ;;
        *) shift ;;
    esac
done

if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
    if command -v journalctl >/dev/null 2>&1; then
        section "Live Nome/GNOME Shell related error follow"
        printf 'Press Ctrl+C to stop.\n'
        journalctl -f -o short-iso _COMM=gnome-shell 2>/dev/null \
            | related_filter \
            | error_filter
    else
        printf 'journalctl command not found\n'
    fi
else
    collect_logs | tee "$OUT"
    printf '\nSaved error/crash log snapshot to:\n  %s\n' "$OUT"
fi

if [[ -t 0 ]]; then
    printf '\nPress Enter to close this terminal...'
    IFS= read -r _
fi
