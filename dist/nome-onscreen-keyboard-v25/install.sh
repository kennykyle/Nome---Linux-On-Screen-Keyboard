#!/usr/bin/env bash
# Nome - Onscreen Keyboard -- installer (GNOME Shell extension for GNOME 50).
#
# Usage:
#   ./install.sh                 # install and enable the extension
#   ./install.sh --no-download-prediction-data
#                                # skip vocabulary/network downloads
#   ./install.sh --ask-gdm       # also ask about GDM login-screen support
#   ./install.sh check           # run diagnostics
#   sudo ./install.sh gdm-install # also enable on the GDM login screen
#
# What this installer does:
#   * copies the extension files to ~/.local/share/gnome-shell/extensions/
#   * enables the extension via gnome-extensions enable
#   * prints instructions for the final step (log out / log in, required
#     because GNOME Shell can't load a brand-new extension without a
#     fresh Shell process on Wayland)
#
# Login-screen support is installed separately with `sudo ./install.sh
# gdm-install`, because GDM runs a different GNOME Shell process from
# the normal user session.  The GDM path is intentionally
# conservative: it copies this extension system-wide, sets GDM's GNOME
# Shell extension keys, and creates/appends the standard GDM dconf
# profile entries when they are missing or ordered incorrectly.

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  [OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  [!!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

UUID="gnome-osk@linuxosk.github.io"
INSTALL_USER_HOME="$HOME"
if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER:-root}" != "root" ]]; then
    if command -v getent >/dev/null 2>&1; then
        detected_home="$(getent passwd "$SUDO_USER" | awk -F: '{print $6}' || true)"
        if [[ -n "$detected_home" ]]; then
            INSTALL_USER_HOME="$detected_home"
        fi
    fi
fi
EXT_BASE="$INSTALL_USER_HOME/.local/share/gnome-shell/extensions"
EXT_DIR="$EXT_BASE/$UUID"
DESKTOP_DIR="$INSTALL_USER_HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/nome-onscreen-keyboard.desktop"
LOGS_DESKTOP_FILE="$DESKTOP_DIR/nome-osk-crash-logs.desktop"
SYSTEM_EXT_BASE="/usr/share/gnome-shell/extensions"
SYSTEM_EXT_DIR="$SYSTEM_EXT_BASE/$UUID"
GDM_DCONF_PROFILE="/etc/dconf/profile/gdm"
GDM_DCONF_DIR="/etc/dconf/db/gdm.d"
GDM_DCONF_BACKUP_DIR="/etc/dconf/db/gdm.d.gnome-osk-backups"
GDM_DCONF_FILE="$GDM_DCONF_DIR/99-gnome-osk"
GDM_DCONF_LEGACY_FILE="$GDM_DCONF_DIR/90-gnome-osk"
GDM_DCONF_LOCK_DIR="$GDM_DCONF_DIR/locks"
GDM_DCONF_LOCK_FILE="$GDM_DCONF_LOCK_DIR/99-gnome-osk"
GDM_DCONF_LEGACY_LOCK_FILE="$GDM_DCONF_LOCK_DIR/90-gnome-osk"
GDM_DCONF_EMPTY_STRING_ARRAY="@as []"
GDM_GREETER_DEFAULTS="/usr/share/gdm/greeter-dconf-defaults"
GDM_SERVICE_DROPIN_DIR="/etc/systemd/system/gdm.service.d"
GDM_SERVICE_DROPIN="$GDM_SERVICE_DROPIN_DIR/99-gnome-osk-dconf-profile.conf"
GDM_SCHEMA_OVERRIDE_DIR="/usr/share/glib-2.0/schemas"
GDM_SCHEMA_OVERRIDE_FILE="$GDM_SCHEMA_OVERRIDE_DIR/99-gnome-osk.gschema.override"
LEGACY_RESOURCE_OVERLAY_DIR="/usr/share/gnome-shell/gnome-osk-resource-overlay"
LEGACY_GDM_RESOURCE_DROPIN="$GDM_SERVICE_DROPIN_DIR/99-gnome-osk-resource-overlay.conf"
LEGACY_SHELL_RESOURCE_DROPIN="/etc/systemd/user/org.gnome.Shell@.service.d/99-gnome-osk-resource-overlay.conf"

gdm_profile_has_line() {
    local pattern="$1"
    [[ -f "$GDM_DCONF_PROFILE" ]] || return 1
    grep -Eq "$pattern" "$GDM_DCONF_PROFILE"
}

gdm_profile_first_source() {
    [[ -f "$GDM_DCONF_PROFILE" ]] || return 1
    awk '
        /^[[:space:]]*($|#)/ { next }
        { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); print; exit }
    ' "$GDM_DCONF_PROFILE"
}

gdm_profile_needs_repair() {
    [[ -f "$GDM_DCONF_PROFILE" ]] || return 0

    local first
    first="$(gdm_profile_first_source || true)"
    [[ "$first" == "user-db:user" ]] || return 0
    gdm_profile_has_line '^[[:space:]]*user-db:user[[:space:]]*$' || return 0
    gdm_profile_has_line '^[[:space:]]*system-db:gdm[[:space:]]*$' || return 0
    if [[ -f "$GDM_GREETER_DEFAULTS" ]] \
        && ! gdm_profile_has_line '^[[:space:]]*file-db:/usr/share/gdm/greeter-dconf-defaults[[:space:]]*$'; then
        return 0
    fi
    return 1
}

warn_legacy_gdm_profile() {
    if [[ ! -f "$GDM_DCONF_PROFILE" ]]; then
        warn "GDM profile not found: $GDM_DCONF_PROFILE"
        warn "The login-screen extension key may not be read until"
        warn "that profile exists with user-db:user and system-db:gdm."
        warn "Run: sudo ./install.sh gdm-install"
        return 0
    fi
    local first_source
    first_source="$(gdm_profile_first_source || true)"
    if [[ "$first_source" != "user-db:user" ]]; then
        warn "GDM profile should start with user-db:user:"
        warn "  $GDM_DCONF_PROFILE"
        warn "GNOME 49+ dynamic greeters can ignore the GDM dconf"
        warn "database or fall back to a null profile when this is wrong."
        warn "Run: sudo ./install.sh gdm-install"
    fi
    if ! gdm_profile_has_line '^[[:space:]]*user-db:user[[:space:]]*$'; then
        warn "GDM profile does not list user-db:user:"
        warn "  $GDM_DCONF_PROFILE"
        warn "Run: sudo ./install.sh gdm-install"
    fi
    if ! grep -Eq '^[[:space:]]*system-db:gdm[[:space:]]*$' \
        "$GDM_DCONF_PROFILE"; then
        warn "GDM profile does not list system-db:gdm:"
        warn "  $GDM_DCONF_PROFILE"
        warn "The login-screen extension key may not be read until that"
        warn "profile is repaired. Run: sudo ./install.sh gdm-install"
    fi
    if [[ -f "$GDM_GREETER_DEFAULTS" ]] \
        && ! grep -Eq '^[[:space:]]*file-db:/usr/share/gdm/greeter-dconf-defaults[[:space:]]*$' \
        "$GDM_DCONF_PROFILE"; then
        warn "GDM profile may be missing the distro greeter defaults:"
        warn "  $GDM_DCONF_PROFILE"
        warn "Run sudo ./install.sh gdm-install to append the missing entry."
    fi
}

report_gnome_shell_process_environments() {
    [[ -d /proc ]] || return 0
    [[ "$(id -u)" -eq 0 ]] || return 0

    local proc pid comm cmd found=0
    for proc in /proc/[0-9]*; do
        [[ -r "$proc/comm" ]] || continue
        comm="$(cat "$proc/comm" 2>/dev/null || true)"
        [[ "$comm" == "gnome-shell" ]] || continue
        found=1
        pid="${proc##*/}"
        cmd="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
        info "Current gnome-shell process $pid environment:"
        printf '  cmdline: %s\n' "${cmd:-<unavailable>}"
        if [[ -r "$proc/environ" ]]; then
            tr '\0' '\n' < "$proc/environ" 2>/dev/null \
                | grep -E '^(USER|LOGNAME|HOME|GNOME_SHELL_SESSION_MODE|DCONF_PROFILE|G_RESOURCE_OVERLAYS|XDG_SESSION_CLASS|XDG_SESSION_TYPE|XDG_DATA_DIRS)=' \
                | sed 's/^/  /' || true
        else
            warn "  cannot read /proc/$pid/environ"
        fi
    done
    if [[ "$found" -eq 0 ]]; then
        info "No current gnome-shell processes visible under /proc"
    fi
}

ensure_gdm_profile_reads_gdm_db() {
    install -d -m 0755 "$(dirname "$GDM_DCONF_PROFILE")"

    if ! gdm_profile_needs_repair; then
        ok "GDM profile already has the required dconf sources"
        return 0
    fi

    local tmp backup existed
    existed=0
    if [[ -f "$GDM_DCONF_PROFILE" ]]; then
        existed=1
        backup="$GDM_DCONF_PROFILE.gnome-osk.bak.$(date +%Y%m%d%H%M%S)"
        cp -a "$GDM_DCONF_PROFILE" "$backup"
        warn "Backed up GDM profile before editing: $backup"
    fi

    tmp="$(mktemp)"
    {
        echo "# Created/updated by Nome - Onscreen Keyboard installer."
        echo "# Lets GDM read /etc/dconf/db/gdm.d/*.keyfile overrides."
        echo "user-db:user"
        echo "system-db:gdm"
        if [[ -f "$GDM_GREETER_DEFAULTS" ]]; then
            echo "file-db:/usr/share/gdm/greeter-dconf-defaults"
        fi
        if [[ "$existed" -eq 1 ]]; then
            awk '
                /^[[:space:]]*($|#)/ { next }
                /^[[:space:]]*user-db:user[[:space:]]*$/ { next }
                /^[[:space:]]*system-db:gdm[[:space:]]*$/ { next }
                /^[[:space:]]*file-db:\/usr\/share\/gdm\/greeter-dconf-defaults[[:space:]]*$/ { next }
                { print }
            ' "$GDM_DCONF_PROFILE"
        fi
    } > "$tmp"
    install -m 0644 "$tmp" "$GDM_DCONF_PROFILE"
    rm -f "$tmp"

    if [[ "$existed" -eq 1 ]]; then
        ok "Repaired $GDM_DCONF_PROFILE for the GDM greeter"
    else
        ok "Created $GDM_DCONF_PROFILE"
    fi
}

require_source_files() {
    local file
    for file in "$@"; do
        [[ -f "$SCRIPT_DIR/$file" ]] \
            || die "$file not found next to install.sh."
    done
}

install_extension_payload() {
    local file
    mkdir -p "$EXT_DIR"
    for file in metadata.json extension.js layouts.js lifecycle.js theme.js \
        dataPaths.js modalAuth.js rgbEffects.js keyboard.js indicator.js \
        predictor.js seed-bigrams.txt stylesheet.css; do
        install -m 0644 "$SCRIPT_DIR/$file" "$EXT_DIR/$file"
    done
    install -m 0755 "$SCRIPT_DIR/nome-osk-crash-logs.sh" \
        "$EXT_DIR/nome-osk-crash-logs.sh"
}

download_to_tmp() {
    local url="$1"
    local dest="$2"
    local timeout="$3"
    local range="${4:-}"

    rm -f "$dest"
    if command -v curl >/dev/null 2>&1; then
        local -a curl_args=(-fsSL --max-time "$timeout")
        [[ -z "$range" ]] || curl_args+=(--range "$range")
        if curl "${curl_args[@]}" "$url" -o "$dest" 2>/dev/null \
            && [[ -s "$dest" ]]; then
            return 0
        fi
        rm -f "$dest"
    fi

    if command -v wget >/dev/null 2>&1; then
        local -a wget_args=(-q "--timeout=$timeout")
        [[ -z "$range" ]] || wget_args+=(--header="Range: bytes=$range")
        if wget "${wget_args[@]}" "$url" -O "$dest" 2>/dev/null \
            && [[ -s "$dest" ]]; then
            return 0
        fi
        rm -f "$dest"
    fi

    return 1
}

extract_build_tag() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    sed -nE "s/.*OSK_BUILD_TAG = '([^']+)'.*/\\1/p" "$file" \
        | head -1
}


# ======================================================================
#   check  subcommand
# ======================================================================

cmd_check() {
    info "Nome - Onscreen Keyboard environment check"

    if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
        ok "Session type: Wayland"
    elif [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && -z "${XDG_SESSION_TYPE:-}" ]]; then
        info "Session type is unset under sudo; run ./install.sh check as your user for desktop-session checks"
    else
        warn "Session type: '${XDG_SESSION_TYPE:-unset}' (expected wayland)"
    fi

    if [[ "${XDG_CURRENT_DESKTOP:-}" == *GNOME* ]]; then
        ok "Desktop: $XDG_CURRENT_DESKTOP"
    else
        warn "Desktop: '${XDG_CURRENT_DESKTOP:-unset}' (expected GNOME)"
    fi

    if command -v gnome-shell >/dev/null; then
        local v
        v="$(gnome-shell --version 2>/dev/null || echo unknown)"
        ok "GNOME Shell: $v"
        if [[ "$v" != *" 50"* ]] && [[ "$v" != *" 50." ]]; then
            warn "  This extension declares shell-version 50; other"
            warn "  versions may refuse to load it."
        fi
    else
        warn "gnome-shell binary not found"
    fi

    if command -v gnome-extensions >/dev/null; then
        ok "gnome-extensions CLI available"
    else
        warn "gnome-extensions CLI not found -- install 'gnome-shell' package"
    fi

    if [[ -d "$EXT_DIR" ]]; then
        ok "Extension installed at $EXT_DIR"
        for f in metadata.json extension.js layouts.js lifecycle.js theme.js \
            dataPaths.js modalAuth.js rgbEffects.js keyboard.js indicator.js \
            predictor.js stylesheet.css nome-osk-crash-logs.sh; do
            if [[ -f "$EXT_DIR/$f" ]]; then
                ok "  $f present"
            else
                warn "  $f MISSING from $EXT_DIR"
            fi
        done
    else
        warn "Extension NOT installed at $EXT_DIR"
    fi

    if [[ -d "$SYSTEM_EXT_DIR" ]]; then
        ok "GDM/system extension installed at $SYSTEM_EXT_DIR"
        verify_gdm_system_files || true
        verify_gdm_dconf_state || true
    else
        warn "GDM/system extension NOT installed"
        warn "  Run: sudo ./install.sh gdm-install"
    fi
    warn_legacy_gdm_profile

    if command -v journalctl >/dev/null 2>&1; then
        local gdm_log_hits
        gdm_log_hits="$(journalctl -b _COMM=gnome-shell --no-pager 2>/dev/null \
            | grep -c 'gnome-osk: enable() starting.*session-mode=gdm' \
            || true)"
        if [[ "${gdm_log_hits:-0}" -gt 0 ]]; then
            ok "Current boot has Nome - Onscreen Keyboard GDM enable log entries"
        else
            warn "No current-boot GDM enable log found"
            warn "  After reboot/GDM restart, check:"
            warn "  sudo journalctl -b _COMM=gnome-shell | grep gnome-osk"
            local gdm_system_scan_tail
            gdm_system_scan_tail="$(journalctl -b _COMM=gnome-shell --no-pager 2>/dev/null \
                | grep -F "$UUID" \
                | grep -E '/usr/share/.+will not be loaded|already installed in /usr/share' \
                | tail -n 5 || true)"
            if [[ -n "$gdm_system_scan_tail" && -d "$SYSTEM_EXT_DIR" ]]; then
                warn "GDM appears to see the system extension but not activate it."
                warn "  That points at GDM's org.gnome.shell enabled/disabled extension keys,"
                warn "  not at the keyboard actor being hidden."
                warn "  Run this full root-side diagnosis and send the output:"
                warn "  sudo ./install.sh check"
            fi
        fi
        local gdm_profile_errors
        gdm_profile_errors="$(journalctl -b --no-pager 2>/dev/null \
            | grep -Ei 'dconf.*profile.*gdm|named profile \(gdm\)|null configuration|unable to open.*/profile/gdm' \
            | tail -n 10 || true)"
        if [[ -n "$gdm_profile_errors" ]]; then
            warn "Current boot has GDM dconf profile errors:"
            printf '%s\n' "$gdm_profile_errors"
            warn "  Run: sudo ./install.sh gdm-install"
        fi
        local extension_error_tail
        extension_error_tail="$(journalctl -b _COMM=gnome-shell --no-pager 2>/dev/null \
            | grep -E "$UUID|gnome-osk" \
            | grep -Ei 'error|failed|exception|JS ERROR|traceback' \
            | tail -n 20 || true)"
        if [[ -n "$extension_error_tail" ]]; then
            warn "Current-boot extension error lines:"
            printf '%s\n' "$extension_error_tail"
        fi
        local duplicate_log_tail
        duplicate_log_tail="$(journalctl -b _COMM=gnome-shell --no-pager 2>/dev/null \
            | grep "$UUID" | grep 'will not be loaded' | tail -n 10 || true)"
        if [[ -n "$duplicate_log_tail" ]]; then
            if [[ "${gdm_log_hits:-0}" -gt 0 ]]; then
                info "GNOME Shell logged duplicate extension scans, but GDM did load Nome."
                info "  This is expected when both user and GDM/system copies are installed."
            else
                warn "GNOME Shell skipped duplicate extension scan entries:"
                warn "  If GDM still does not load Nome, send these lines with the check output."
                printf '%s\n' "$duplicate_log_tail"
            fi
        fi
        local osk_log_tail
        osk_log_tail="$(journalctl -b _COMM=gnome-shell --no-pager 2>/dev/null \
            | grep 'gnome-osk:' | tail -n 25 || true)"
        if [[ -n "$osk_log_tail" ]]; then
            info "Last current-boot gnome-osk Shell log lines:"
            printf '%s\n' "$osk_log_tail"
        fi
    fi
    report_gnome_shell_process_environments

    if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" ]]; then
        info "Skipping current-user gnome-extensions state under sudo"
    elif command -v gnome-extensions >/dev/null; then
        local state
        state="$(gnome-extensions info "$UUID" 2>/dev/null \
                 | awk -F': ' '/^State:/ {print $2}' || true)"
        if [[ -n "$state" ]]; then
            ok "Extension state: $state"
        else
            info "Extension state unavailable from gnome-extensions CLI"
        fi
    fi
}


# ======================================================================
#   install
# ======================================================================

cmd_install() {
    require_source_files \
        metadata.json extension.js layouts.js lifecycle.js theme.js \
        dataPaths.js modalAuth.js rgbEffects.js keyboard.js indicator.js \
        predictor.js seed-bigrams.txt stylesheet.css \
        nome-onscreen-keyboard.desktop nome-osk-crash-logs.sh \
        nome-osk-crash-logs.desktop
    [[ "$(id -u)" -ne 0 ]] \
        || die "Run this as your normal user -- extensions install per-user."
    command -v gnome-extensions >/dev/null \
        || die "gnome-extensions CLI not found.  Install 'gnome-shell' first."

    if [[ "${XDG_SESSION_TYPE:-}" != "wayland" ]]; then
        warn "Current session is '${XDG_SESSION_TYPE:-unset}', not Wayland."
        warn "GNOME 50 is Wayland-only; the extension will install but"
        warn "you need to log into a Wayland session to use it."
    fi

    # ---- Phase 1: show what build we're about to install ---------------
    # Extract OSK_BUILD_TAG from the source dataPaths.js so you can see
    # at a glance whether you copied the latest files or an old cached
    # version from Windows.  If you see the same tag twice in a row, the
    # transfer is stale and no amount of reinstalling will help.
    local src_tag
    src_tag="$(extract_build_tag "$SCRIPT_DIR/dataPaths.js")"
    if [[ -n "$src_tag" ]]; then
        info "Source build tag: $src_tag"
    else
        warn "Source dataPaths.js has no OSK_BUILD_TAG (pre-tagged build?)"
    fi

    # ---- Phase 2: clean wipe of any previous install -------------------
    # Delegate to uninstall.sh (purge mode by default) so every install
    # starts from a true blank slate -- no stale .js files in the
    # extension dir, no leftover gsettings UUID entry, no stale
    # learned-words / config file under $XDG_DATA_HOME.  Pass
    # --keep-data to install.sh to preserve learned vocabulary.
    if [[ -f "$SCRIPT_DIR/uninstall.sh" ]]; then
        if [[ "$KEEP_DATA" -eq 1 ]]; then
            info "Clean wipe (preserving learned words)"
            bash "$SCRIPT_DIR/uninstall.sh" --keep-data || true
        else
            info "Clean wipe (extension + user data + gsettings)"
            bash "$SCRIPT_DIR/uninstall.sh" || true
        fi
    else
        # Fallback when uninstall.sh isn't next to install.sh.
        info "Optional uninstall.sh not present; using built-in cleanup"
        gnome-extensions disable "$UUID" 2>/dev/null || true
        if [[ -d "$EXT_DIR" ]]; then
            info "Removing old installed files at $EXT_DIR"
            rm -rf "$EXT_DIR"
        fi
    fi

    # ---- Phase 3: fresh install ----------------------------------------
    info "Installing fresh files to $EXT_DIR"
    install_extension_payload

    # ---- Phase 4: install English base dictionary ---------------------
    # The word-prediction feature needs a frequency-sorted English
    # word list.  We pull en_full.txt from hermitdave/FrequencyWords
    # (MIT-licensed, ~20 MiB, 1.66M entries sorted by usage frequency
    # in the OpenSubtitles corpus).  Install downloads the whole file
    # by default so prefix prediction works immediately after first
    # login.  Pass --no-download-prediction-data for offline installs.
    #
    # Format is "word count" per line; the predictor reads the first
    # token of each line so the count column is ignored (line order
    # already encodes rank).
    #
    # Download is non-fatal: prediction still has the bundled seed
    # fallback and the user's learned words if the network is down.
    # The menu's "Download prediction data" item re-runs this fetch
    # at runtime too.
    local WORDLIST_URL="https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt"
    local WORDLIST_DEST="$EXT_DIR/wordlist.txt"
    local WORDLIST_MAX_BYTES=$((64 * 1024 * 1024))
    local downloaded=0

    if [[ "${DOWNLOAD_PREDICTION_DATA:-0}" -eq 1 ]]; then
        info "Fetching full English base dictionary (hermitdave/FrequencyWords en_full, MIT)"
        if download_to_tmp "$WORDLIST_URL" "$WORDLIST_DEST.tmp" 180; then
            local wbytes
            wbytes="$(wc -c < "$WORDLIST_DEST.tmp" 2>/dev/null || echo 0)"
            if [[ "${wbytes:-0}" -gt 0 && "${wbytes:-0}" -le "$WORDLIST_MAX_BYTES" ]]; then
                mv "$WORDLIST_DEST.tmp" "$WORDLIST_DEST"
                chmod 0644 "$WORDLIST_DEST"
                downloaded=1
            else
                rm -f "$WORDLIST_DEST.tmp"
                warn "Downloaded wordlist had unexpected size ($wbytes bytes); ignoring it."
            fi
        fi
    else
        info "Skipping prediction-data download during install."
        info "Use the extension menu's 'Download prediction data' item when needed."
    fi
    if [[ "$downloaded" -eq 0 ]] && [[ -f "$SCRIPT_DIR/wordlist.txt" ]]; then
        info "Using bundled wordlist.txt next to install.sh (offline fallback)"
        install -m 0644 "$SCRIPT_DIR/wordlist.txt" "$WORDLIST_DEST"
        downloaded=1
    fi
    if [[ "$downloaded" -eq 1 ]]; then
        local wcount
        wcount="$(wc -l < "$WORDLIST_DEST" 2>/dev/null || echo 0)"
        ok "Wordlist installed ($wcount source entries at $WORDLIST_DEST)"
    else
        warn "No wordlist installed (curl/wget unavailable or network blocked)."
        warn "Word prediction will still toggle on, but the base dictionary"
        warn "will be empty until you manually drop a wordlist at:"
        warn "  $WORDLIST_DEST"
        warn "(one word per line, lowercase, sorted by frequency).  The"
        warn "prediction's learning layer will still record what you type."
    fi

    # ---- Phase 5: fetch English seed bigrams --------------------------
    # Next-word ("phrase") prediction gets a massive quality boost
    # from a real bigram corpus.  Peter Norvig's count_2w.txt is ~5.6
    # MB with ~286 000 bigrams drawn from Google Web 1T.  The file is
    # alphabetically sorted with a "word1 word2\tcount" layout, so we
    # download the whole thing (fast, it's under 6 MiB) and re-sort
    # by count descending, keeping only the top N -- that becomes
    # our effective top-N-most-common English bigrams.
    #
    # If the download fails we fall back to the hand-curated
    # seed-bigrams.txt bundled in the repo (~580 common pairs).
    # Either way, user-learned bigrams always out-rank seeded ones.
    local BIGRAMS_URL="https://norvig.com/ngrams/count_2w.txt"
    local BIGRAMS_DEST="$EXT_DIR/seed-bigrams.txt"
    local BIGRAMS_TOP_N=20000    # cap to keep RAM bounded at ~3 MiB
    local bg_downloaded=0

    # Seed the destination with the hand-curated file FIRST, so a
    # failed network fetch still leaves us with usable seed data.
    install -m 0644 "$SCRIPT_DIR/seed-bigrams.txt" "$BIGRAMS_DEST"

    # sort|head under `set -o pipefail` is a trap: `head` closes the
    # pipe after reading $BIGRAMS_TOP_N lines, sort gets SIGPIPE on
    # its next write and exits non-zero, and pipefail propagates that
    # failure.  Combined with `set -e` up top this silently KILLS the
    # entire install script halfway through -- no launcher, no re-enable,
    # no logout prompt.  That's the "typed ./install.sh and
    # nothing prompted me" symptom.
    #
    # Fix: trap the pipeline in a subshell with pipefail turned off
    # for just that one command.  We still check the output file's
    # size afterwards, so a genuinely bad sort/head still skips the
    # install-step -- we just don't abort the whole script over a
    # mundane SIGPIPE.
    sort_and_trim() {
        ( set +o pipefail
          sort -t$'\t' -k2,2 -n -r "$1" \
              | head -n "$BIGRAMS_TOP_N" > "$2"
        ) 2>/dev/null
    }

    if [[ "${DOWNLOAD_PREDICTION_DATA:-0}" -eq 1 ]]; then
        info "Fetching English seed bigrams (Norvig count_2w, ~5.6 MiB)"
        if download_to_tmp "$BIGRAMS_URL" "$BIGRAMS_DEST.tmp" 120; then
            # Sort by column 2 (count) numerically descending, keep top N.
            sort_and_trim "$BIGRAMS_DEST.tmp" "$BIGRAMS_DEST.clean" || true
            if [[ -s "$BIGRAMS_DEST.clean" ]]; then
                mv "$BIGRAMS_DEST.clean" "$BIGRAMS_DEST"
                chmod 0644 "$BIGRAMS_DEST"
                rm -f "$BIGRAMS_DEST.tmp"
                bg_downloaded=1
            else
                rm -f "$BIGRAMS_DEST.tmp" "$BIGRAMS_DEST.clean"
            fi
        fi
    else
        info "Using bundled seed bigrams; runtime download can upgrade them."
    fi
    if [[ "$bg_downloaded" -eq 1 ]]; then
        local bgcount
        bgcount="$(wc -l < "$BIGRAMS_DEST" 2>/dev/null || echo 0)"
        ok "Seed bigrams installed ($bgcount top pairs from Norvig's corpus)"
    else
        warn "Could not download seed bigrams; using hand-curated"
        warn "seed-bigrams.txt bundled with the extension (~580 pairs)."
        warn "Use the menu's 'Download prediction data' item to retry"
        warn "once networking is available."
    fi

    info "Installed files:"
    ls -la "$EXT_DIR" | sed 's/^/        /'

    # Read back the build tag from the file we just installed, as a
    # self-check.  If this tag doesn't equal $src_tag, the install copy
    # itself silently failed (filesystem quirks, permission, etc.).
    local inst_tag
    inst_tag="$(extract_build_tag "$EXT_DIR/dataPaths.js")"
    if [[ -n "$inst_tag" ]]; then
        ok "Installed build tag: $inst_tag"
    fi
    if [[ -n "$src_tag" && -n "$inst_tag" && "$src_tag" != "$inst_tag" ]]; then
        die "Build tag mismatch after install (src=$src_tag installed=$inst_tag)!"
    fi

    # ---- Phase 6: install app-grid launchers ---------------------------
    # Desktop files so the keyboard and its log collector show up in
    # the app grid.  The keyboard launcher calls `gnome-extensions
    # enable UUID`, which brings up the extension if it is currently
    # disabled.  The error-log launcher opens a terminal and snapshots
    # related GNOME Shell/Mutter/portal/PipeWire errors and crashes.
    info "Installing app-grid launcher at $DESKTOP_FILE"
    mkdir -p "$DESKTOP_DIR"
    install -m 0644 "$SCRIPT_DIR/nome-onscreen-keyboard.desktop" "$DESKTOP_FILE"
    install -m 0644 "$SCRIPT_DIR/nome-osk-crash-logs.desktop" "$LOGS_DESKTOP_FILE"
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

    # ---- Phase 7: re-enable --------------------------------------------
    # Wayland can't hot-reload extension code, so this flag just means
    # "activate on next login."  We flip it anyway so the user doesn't
    # have to remember to.
    info "Re-enabling extension (takes effect after next login)"
    gnome-extensions enable "$UUID" 2>/dev/null || true

    cat <<DONE

================================================================
  Nome - Onscreen Keyboard extension installed cleanly.

  Build: ${inst_tag:-<no tag>}

  LAST STEP: log out and log back in.

  GNOME Shell on Wayland can't hot-load updated extension code --
  the Shell has to rescan its extensions directory on startup.
  Log out through the user menu and log back in, or reboot; the
  keyboard icon will appear in the top bar.

  Click the keyboard icon to toggle the on-screen keyboard.
  Drag the title bar to move it, the "\u2198" in the corner to resize.

  To disable temporarily:
      gnome-extensions disable $UUID
  To re-enable:
      gnome-extensions enable $UUID
  To open Extensions manager:
      gnome-extensions-app
================================================================
DONE

    # ---- Phase 8: optional GDM login-screen support -------------------
    # The double-click installer passes --ask-gdm so users learn about
    # login-screen support before they log out.  Keep it opt-in because
    # GDM install needs administrator privileges and writes system paths.
    print_prompt_box() {
        local width=60
        local field_width=$((width - 2))
        local yellow=$'\033[1;33m'
        local reset=$'\033[0m'
        local border=""
        local text

        printf -v border '%*s' "$width" ''
        border=${border// /-}

        printf '\n%s+%s+%s\n' "$yellow" "$border" "$reset"
        for text in "$@"; do
            printf '%s|%s %-*s %s|%s\n' \
                "$yellow" "$reset" "$field_width" "$text" "$yellow" "$reset"
        done
        printf '%s+%s+%s\n' "$yellow" "$border" "$reset"
    }

    ask_gdm_yes_no() {
        if [[ -r /dev/tty && -w /dev/tty ]]; then
            {
                print_prompt_box \
                    "Install login-screen support too?" \
                    "This needs sudo and will not restart GDM for you." \
                    "Type y then Enter to install it, anything else skips."
                printf '\033[1;36m>\033[0m [y/N] '
            } > /dev/tty
            local reply=""
            if ! read -r reply < /dev/tty; then
                reply=""
            fi
            printf '\n' > /dev/tty
            case "$reply" in
                y|Y|yes|YES|Yes) return 0 ;;
                *)               return 1 ;;
            esac
        fi
        if command -v zenity >/dev/null 2>&1; then
            zenity --question --no-wrap --title='Nome - Onscreen Keyboard' \
                   --text='Install login-screen support too? This requires administrator authentication. The installer will not restart GDM automatically.' \
                   </dev/null >/dev/null 2>&1
            return $?
        fi
        if command -v kdialog >/dev/null 2>&1; then
            kdialog --yesno 'Install login-screen support too? This requires administrator authentication. The installer will not restart GDM automatically.' \
                   </dev/null >/dev/null 2>&1
            return $?
        fi
        return 2
    }

    install_gdm_login_screen_support() {
        if [[ "$(id -u)" -eq 0 ]]; then
            bash "$SCRIPT_DIR/install.sh" gdm-install
            return $?
        fi
        if command -v sudo >/dev/null 2>&1; then
            sudo bash "$SCRIPT_DIR/install.sh" gdm-install
            return $?
        fi
        if command -v pkexec >/dev/null 2>&1; then
            pkexec bash "$SCRIPT_DIR/install.sh" gdm-install
            return $?
        fi
        return 1
    }

    gdm_login_screen_support_installed() {
        if [[ -d "$SYSTEM_EXT_DIR" ]]; then
            return 0
        fi
        if [[ -f "$GDM_DCONF_FILE" ]] && grep -q "$UUID" "$GDM_DCONF_FILE"; then
            return 0
        fi
        if [[ -f "$GDM_DCONF_LEGACY_FILE" ]] && grep -q "$UUID" "$GDM_DCONF_LEGACY_FILE"; then
            return 0
        fi
        if [[ -f "$GDM_SERVICE_DROPIN" ]] && grep -q 'DCONF_PROFILE=gdm' "$GDM_SERVICE_DROPIN"; then
            return 0
        fi
        if [[ -f "$GDM_SCHEMA_OVERRIDE_FILE" ]] && grep -q "$UUID" "$GDM_SCHEMA_OVERRIDE_FILE"; then
            return 0
        fi
        return 1
    }

    update_existing_gdm_login_screen_support() {
        cat <<DONE

================================================================
  Updating existing GDM login-screen support

  A previous GDM/system install was detected, so this installer will
  update that copy automatically. This needs sudo and will not restart
  GDM for you.
================================================================
DONE

        if install_gdm_login_screen_support; then
            ok "GDM login-screen support updated"
            info "Reboot later, or restart GDM from a safe terminal after saving work."
        else
            warn "Could not update GDM login-screen support automatically."
            warn "You can retry later with:"
            warn "  sudo ./install.sh gdm-install"
        fi
    }

    if [[ "$SKIP_GDM" -eq 1 ]]; then
        info "Skipping GDM login-screen support because --no-gdm was passed."
    elif gdm_login_screen_support_installed; then
        update_existing_gdm_login_screen_support
    elif [[ "$ASK_GDM" -eq 1 ]]; then
        cat <<DONE

================================================================
  Optional: GDM login-screen support

  The normal install above is for your signed-in desktop session.
  If you also want this keyboard available at the GNOME login
  screen, the installer can copy it to the system extension path
  and enable it for GDM.

  This requires administrator authentication.  The installer will
  NOT restart GDM automatically, because doing that immediately
  ends graphical login sessions.  Rebooting later is the safest
  way to make login-screen support visible.
================================================================
DONE

        set +e
        ask_gdm_yes_no
        local gdm_ans=$?
        set -e
        case "$gdm_ans" in
            0)
                if install_gdm_login_screen_support; then
                    ok "GDM login-screen support installed"
                    info "Reboot later, or restart GDM from a safe terminal after saving work."
                else
                    warn "Could not install GDM login-screen support automatically."
                    warn "You can retry later with:"
                    warn "  sudo ./install.sh gdm-install"
                fi
                ;;
            1)
                info "Skipping GDM login-screen support."
                info "You can add it later with: sudo ./install.sh gdm-install"
                ;;
            *)
                info "No terminal or GUI dialog available for the GDM prompt."
                info "You can add login-screen support later with: sudo ./install.sh gdm-install"
                ;;
        esac
    fi

    # ---- Phase 9: optional immediate logout ---------------------------
    # The new / updated extension won't load until the Shell restarts,
    # which on Wayland means the session has to end.  Offer to do
    # that now so the user doesn't have to remember; default is N so
    # hitting Enter (or piping nothing to stdin) never logs them out
    # by accident.
    #
    # Make the prompt loud and obvious.  The preceding DONE heredoc
    # is a wall of text about next steps -- a fish/alacritty user
    # can easily scroll past it and miss a quiet "[y/N]" line at the
    # bottom.  A boxed, single-line prompt directly on /dev/tty (so
    # it paints even if stdout is being piped / tee'd) fixes that.
    #
    # Prompt channel selection (in order):
    #
    #   1) /dev/tty -- always works when the user ran this from any
    #      terminal emulator (alacritty, kitty, wezterm, foot,
    #      gnome-terminal, konsole, xterm, ...) under any shell
    #      (bash, fish, zsh, ...).  The shebang at the top of this
    #      script forces bash for the script body itself, so the
    #      user's login shell is irrelevant -- but fish/zsh users
    #      invoking `./install.sh` in a piped or background context
    #      can leave stdin closed, which would silently EOF a plain
    #      `read`.  Reading from /dev/tty bypasses stdin entirely
    #      and talks straight to the controlling terminal.
    #
    #   2) zenity / kdialog GUI dialog -- fallback for contexts with
    #      no controlling terminal: launchers, systemd-run,
    #      desktop-file Exec=, cron-style invocations, etc.  Even
    #      without a terminal the user is on a graphical session
    #      (that's why they installed an OSK), so a GUI prompt is
    #      a reasonable substitute.
    #
    #   3) Nothing -- print a message telling the user to log out
    #      themselves and carry on.
    ask_logout_yes_no() {
        if [[ -r /dev/tty && -w /dev/tty ]]; then
            {
                print_prompt_box \
                    "Log out now to finish loading the extension?" \
                    "Type y then Enter to log out, anything else to skip."
                printf '\033[1;36m>\033[0m [y/N] '
            } > /dev/tty
            local reply=""
            # Wrap the read in an `if !` so set -e doesn't abort the
            # whole script if the user closes the terminal mid-prompt.
            if ! read -r reply < /dev/tty; then
                reply=""
            fi
            printf '\n' > /dev/tty
            case "$reply" in
                y|Y|yes|YES|Yes) return 0 ;;
                *)               return 1 ;;
            esac
        fi
        # No TTY -- try zenity / kdialog.  Both return 0 for Yes and
        # non-zero for No / Cancel, which matches our contract.
        if command -v zenity >/dev/null 2>&1; then
            zenity --question --no-wrap --title='Nome - Onscreen Keyboard' \
                   --text='Log out now to finish loading the extension?' \
                   </dev/null >/dev/null 2>&1
            return $?
        fi
        if command -v kdialog >/dev/null 2>&1; then
            kdialog --yesno 'Log out now to finish loading the extension?' \
                   </dev/null >/dev/null 2>&1
            return $?
        fi
        return 2   # undecidable: no TTY and no GUI dialog available
    }

    # Dispatch the actual logout.
    #
    # We deliberately do NOT background (`&`) the logout command.
    # The previous version did, with the reasoning that the script
    # should exit cleanly before session tear-down -- but a
    # backgrounded process inherits the script's pgroup and on some
    # terminals (notably when fish or zsh cleans up after a script
    # exits) gets a SIGHUP that silently kills the logout dispatcher
    # before its DBus call completes.  That's exactly the "I typed y
    # and nothing happened" symptom.  A foreground call returns as
    # soon as the DBus message is accepted (gnome-session-quit does
    # not wait for the session to finish tearing down), so the script
    # still exits cleanly after -- just without the SIGHUP race.
    #
    # `setsid` runs the command in a new session so it's detached
    # from our controlling terminal entirely; `nohup` stops any
    # parent-shell SIGHUP from reaching it as a belt-and-braces
    # measure.  Either tool alone is sufficient on most systems;
    # together they cover every variation of job-control teardown
    # we've seen in fish / zsh / tmux / etc.
    #
    # Arguments are passed as a bash array so a weird $USER (spaces,
    # quotes, etc) can't break quoting.
    perform_logout() {
        local -a cmd=()
        if command -v gnome-session-quit >/dev/null 2>&1; then
            cmd=(gnome-session-quit --logout --no-prompt)
        elif command -v loginctl >/dev/null 2>&1; then
            cmd=(loginctl terminate-user "$USER")
        else
            return 1
        fi
        info "Logging out: ${cmd[*]}"
        if command -v setsid >/dev/null 2>&1; then
            # setsid detaches from our controlling TTY; redirect I/O
            # so it doesn't block on closed fds after we exit.
            setsid "${cmd[@]}" </dev/null >/dev/null 2>&1 || true
        elif command -v nohup >/dev/null 2>&1; then
            nohup "${cmd[@]}" </dev/null >/dev/null 2>&1 || true
        else
            "${cmd[@]}" </dev/null >/dev/null 2>&1 || true
        fi
        return 0
    }

    set +e
    ask_logout_yes_no
    local ans=$?
    set -e
    case "$ans" in
        0)
            if perform_logout; then
                exit 0
            else
                warn "Neither gnome-session-quit nor loginctl found."
                warn "Please log out manually via the user menu."
            fi
            ;;
        1)
            info "Log out at your convenience to finish loading the extension."
            ;;
        *)
            info "No terminal or GUI dialog available; log out manually when convenient."
            ;;
    esac
}


detect_gdm_user() {
    command -v getent >/dev/null 2>&1 || return 1
    if [[ -n "${GDM_USER:-}" ]] && getent passwd "$GDM_USER" >/dev/null 2>&1; then
        printf '%s\n' "$GDM_USER"
        return 0
    fi
    local user
    for user in gdm gdm3; do
        if getent passwd "$user" >/dev/null 2>&1; then
            printf '%s\n' "$user"
            return 0
        fi
    done
    return 1
}

gdm_user_home() {
    local user
    user="$(detect_gdm_user)" || return 1
    getent passwd "$user" | awk -F: '{print $6}'
}

duplicate_gdm_extension_dirs() {
    printf '%s\n' "/usr/local/share/gnome-shell/extensions/$UUID"
    printf '%s\n' "/var/lib/gdm/.local/share/gnome-shell/extensions/$UUID"
    local home
    if home="$(gdm_user_home 2>/dev/null)" && [[ -n "$home" ]]; then
        printf '%s\n' "$home/.local/share/gnome-shell/extensions/$UUID"
    fi
}

remove_duplicate_gdm_extension_dirs() {
    local target_real dir dir_real
    target_real="$(readlink -f "$SYSTEM_EXT_DIR" 2>/dev/null || printf '%s\n' "$SYSTEM_EXT_DIR")"
    while IFS= read -r dir; do
        [[ -n "$dir" && -e "$dir" ]] || continue
        dir_real="$(readlink -f "$dir" 2>/dev/null || printf '%s\n' "$dir")"
        if [[ "$dir_real" != "$target_real" ]]; then
            warn "Removing duplicate GDM/system extension copy: $dir"
            rm -rf "$dir"
            ok "  removed duplicate $dir"
        fi
    done < <(duplicate_gdm_extension_dirs)
}

verify_no_duplicate_gdm_extension_dirs() {
    local status=0
    local target_real dir dir_real
    target_real="$(readlink -f "$SYSTEM_EXT_DIR" 2>/dev/null || printf '%s\n' "$SYSTEM_EXT_DIR")"
    while IFS= read -r dir; do
        [[ -n "$dir" && -e "$dir" ]] || continue
        dir_real="$(readlink -f "$dir" 2>/dev/null || printf '%s\n' "$dir")"
        if [[ "$dir_real" != "$target_real" ]]; then
            warn "Duplicate GDM/system extension copy found: $dir"
            status=1
        fi
    done < <(duplicate_gdm_extension_dirs)
    if [[ "$status" -eq 0 ]]; then
        ok "No duplicate GDM/system extension copies found"
    fi
    return "$status"
}

install_gdm_service_profile_dropin() {
    install -d -m 0755 "$GDM_SERVICE_DROPIN_DIR"
    cat > "$GDM_SERVICE_DROPIN" <<EOF
[Service]
Environment=DCONF_PROFILE=gdm
EOF
    chmod 0644 "$GDM_SERVICE_DROPIN" || return 1
    if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload || true
    fi
    ok "GDM service now exports DCONF_PROFILE=gdm"
}

write_gdm_schema_override() {
    command -v glib-compile-schemas >/dev/null 2>&1 \
        || { warn "glib-compile-schemas not found; cannot write schema default fallback"; return 1; }
    install -d -m 0755 "$GDM_SCHEMA_OVERRIDE_DIR"
    cat > "$GDM_SCHEMA_OVERRIDE_FILE" <<EOF
[org.gnome.shell]
enabled-extensions=['$UUID']
disabled-extensions=$GDM_DCONF_EMPTY_STRING_ARRAY
disable-user-extensions=false
EOF
    chmod 0644 "$GDM_SCHEMA_OVERRIDE_FILE" || return 1
    glib-compile-schemas "$GDM_SCHEMA_OVERRIDE_DIR" || return 1
    ok "GNOME Shell schema default fallback now includes $UUID"
}

remove_gdm_service_profile_dropin() {
    if [[ -f "$GDM_SERVICE_DROPIN" ]]; then
        rm -f "$GDM_SERVICE_DROPIN"
        ok "Removed GDM service DCONF_PROFILE drop-in"
    fi
    if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload || true
    fi
}

remove_gdm_schema_override() {
    if [[ -f "$GDM_SCHEMA_OVERRIDE_FILE" ]]; then
        rm -f "$GDM_SCHEMA_OVERRIDE_FILE"
        ok "Removed GNOME Shell schema default fallback"
        if command -v glib-compile-schemas >/dev/null 2>&1; then
            glib-compile-schemas "$GDM_SCHEMA_OVERRIDE_DIR" || true
        fi
    fi
}

remove_legacy_resource_overlay() {
    local removed=0
    if [[ -f "$LEGACY_GDM_RESOURCE_DROPIN" ]]; then
        rm -f "$LEGACY_GDM_RESOURCE_DROPIN"
        removed=1
        ok "Removed legacy GDM resource-overlay drop-in"
    fi
    if [[ -f "$LEGACY_SHELL_RESOURCE_DROPIN" ]]; then
        rm -f "$LEGACY_SHELL_RESOURCE_DROPIN"
        removed=1
        ok "Removed legacy GNOME Shell resource-overlay drop-in"
    fi
    if [[ -d "$LEGACY_RESOURCE_OVERLAY_DIR" ]]; then
        rm -rf "$LEGACY_RESOURCE_OVERLAY_DIR"
        removed=1
        ok "Removed legacy GNOME Shell resource-overlay files"
    fi
    if [[ "$removed" -eq 1 ]] && command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload || true
    fi
}

verify_gdm_service_profile_dropin() {
    local status=0
    if [[ -f "$GDM_SERVICE_DROPIN" ]] \
        && grep -qx 'Environment=DCONF_PROFILE=gdm' "$GDM_SERVICE_DROPIN"; then
        ok "  GDM service exports DCONF_PROFILE=gdm"
    else
        warn "  GDM service does NOT export DCONF_PROFILE=gdm"
        warn "    file: $GDM_SERVICE_DROPIN"
        status=1
    fi
    if [[ -f "$GDM_SCHEMA_OVERRIDE_FILE" ]] && grep -q "$UUID" "$GDM_SCHEMA_OVERRIDE_FILE"; then
        ok "  GNOME Shell schema default fallback includes $UUID"
    else
        warn "  GNOME Shell schema default fallback missing $UUID"
        warn "    file: $GDM_SCHEMA_OVERRIDE_FILE"
        status=1
    fi
    return "$status"
}

gdm_user_cmd() {
    local user
    user="$(detect_gdm_user)" || return 127
    if command -v runuser >/dev/null 2>&1; then
        runuser -u "$user" -- "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo -u "$user" "$@"
    else
        return 1
    fi
}

merge_uuid_into_list() {
    local cur="$1"
    local uuid="$2"
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$cur" "$uuid" <<'PY'
import ast, sys
cur, uuid = sys.argv[1], sys.argv[2]
try:
    vals = ast.literal_eval(cur.replace('@as ', ''))
    if not isinstance(vals, list):
        vals = []
except Exception:
    vals = []
vals = [v for v in vals if v != uuid]
vals.append(uuid)
print('[' + ', '.join(repr(v) for v in vals) + ']')
PY
        return $?
    fi
    cur="$(remove_uuid_from_list "$cur" "$uuid")"
    if [[ "$cur" == "@as []" || "$cur" == "[]" || -z "$cur" ]]; then
        printf "['%s']\n" "$uuid"
    else
        printf "%s\n" "${cur%]}, '$uuid']"
    fi
}

remove_uuid_from_list() {
    local cur="$1"
    local uuid="$2"
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$cur" "$uuid" <<'PY'
import ast, sys
cur, uuid = sys.argv[1], sys.argv[2]
try:
    vals = ast.literal_eval(cur.replace('@as ', ''))
    if not isinstance(vals, list):
        vals = []
except Exception:
    vals = []
vals = [v for v in vals if v != uuid]
print('[' + ', '.join(repr(v) for v in vals) + ']')
PY
        return $?
    fi
    printf '%s\n' "$cur" \
        | sed -E "s/'$uuid', ?//g; s/, ?'$uuid'//g; s/'$uuid'//g"
}

enable_gdm_extension_user_setting() {
    local uuid="$1"
    local cur new
    detect_gdm_user >/dev/null || return 2
    cur="$(gdm_user_cmd dbus-run-session -- \
        gsettings get org.gnome.shell enabled-extensions 2>/dev/null \
        || printf '[]')"
    new="$(merge_uuid_into_list "$cur" "$uuid")" || return 1
    gdm_user_cmd dbus-run-session -- \
        gsettings set org.gnome.shell enabled-extensions "$new" || return 1
    gdm_user_cmd dbus-run-session -- \
        gsettings set org.gnome.shell disabled-extensions "[]" \
        >/dev/null 2>&1 || true
    gdm_user_cmd dbus-run-session -- \
        gsettings set org.gnome.shell disable-user-extensions false \
        >/dev/null 2>&1 || true
}

disable_gdm_extension_user_setting() {
    local uuid="$1"
    local cur new
    detect_gdm_user >/dev/null || return 2
    cur="$(gdm_user_cmd dbus-run-session -- \
        gsettings get org.gnome.shell enabled-extensions 2>/dev/null \
        || printf '[]')"
    new="$(remove_uuid_from_list "$cur" "$uuid")" || return 1
    gdm_user_cmd dbus-run-session -- \
        gsettings set org.gnome.shell enabled-extensions "$new" || return 1
}

move_gdm_file_to_inactive_backup() {
    local file="$1"
    local label="$2"
    local prefix="${3:-}"
    local quiet="${4:-}"
    local name dest

    [[ -f "$file" ]] || return 0
    install -d -m 0755 "$GDM_DCONF_BACKUP_DIR" || return 1

    name="$(basename "$file")"
    if [[ -n "$prefix" ]]; then
        name="$prefix-$name"
    fi
    dest="$GDM_DCONF_BACKUP_DIR/$name.$(date +%Y%m%d%H%M%S)"
    if [[ -e "$dest" ]]; then
        dest="$dest.$$"
    fi

    mv "$file" "$dest" || return 1
    GDM_LAST_BACKUP_DEST="$dest"
    if [[ "$quiet" != "--quiet" ]]; then
        info "$label: $dest"
    fi
}

quarantine_gdm_dconf_backups() {
    local file
    local moved=0
    local first_dest=""
    local dconf_patterns=(
        "$GDM_DCONF_DIR"/99-gnome-osk.disabled.*
        "$GDM_DCONF_DIR"/99-gnome-osk.superseded.*
        "$GDM_DCONF_DIR"/90-gnome-osk.disabled.*
        "$GDM_DCONF_DIR"/90-gnome-osk.superseded.*
    )
    local lock_patterns=(
        "$GDM_DCONF_LOCK_DIR"/99-gnome-osk.disabled.*
        "$GDM_DCONF_LOCK_DIR"/99-gnome-osk.superseded.*
        "$GDM_DCONF_LOCK_DIR"/90-gnome-osk.disabled.*
        "$GDM_DCONF_LOCK_DIR"/90-gnome-osk.superseded.*
    )

    for file in "${dconf_patterns[@]}"; do
        [[ -f "$file" ]] || continue
        move_gdm_file_to_inactive_backup \
            "$file" \
            "Moved stale GDM dconf backup out of active database" \
            "dconf" \
            "--quiet"
        moved=$((moved + 1))
        if [[ -z "$first_dest" ]]; then
            first_dest="$GDM_LAST_BACKUP_DEST"
        fi
    done

    for file in "${lock_patterns[@]}"; do
        [[ -f "$file" ]] || continue
        move_gdm_file_to_inactive_backup \
            "$file" \
            "Moved stale GDM dconf lock backup out of active database" \
            "lock" \
            "--quiet"
        moved=$((moved + 1))
        if [[ -z "$first_dest" ]]; then
            first_dest="$GDM_LAST_BACKUP_DEST"
        fi
    done

    if [[ "$moved" -gt 0 ]]; then
        info "Moved $moved stale GDM dconf backup file(s) out of active database paths"
        info "  Backup directory: $GDM_DCONF_BACKUP_DIR"
        if [[ -n "$first_dest" ]]; then
            info "  First moved file: $first_dest"
        fi
    fi
}

write_gdm_dconf_extension_override() {
    local uuid="$1"
    local cur new
    if detect_gdm_user >/dev/null; then
        cur="$(gdm_user_cmd dbus-run-session -- \
            gsettings get org.gnome.shell enabled-extensions 2>/dev/null \
            || printf '[]')"
    else
        cur="[]"
    fi
    new="$(merge_uuid_into_list "$cur" "$uuid")" || return 1

    install -d -m 0755 "$GDM_DCONF_DIR"
    quarantine_gdm_dconf_backups || return 1
    if [[ -f "$GDM_DCONF_LEGACY_FILE" && "$GDM_DCONF_LEGACY_FILE" != "$GDM_DCONF_FILE" ]]; then
        move_gdm_file_to_inactive_backup \
            "$GDM_DCONF_LEGACY_FILE" \
            "Disabled older lower-priority GDM dconf file" \
            "dconf" || return 1
    fi
    if [[ -f "$GDM_DCONF_FILE" ]]; then
        move_gdm_file_to_inactive_backup \
            "$GDM_DCONF_FILE" \
            "Backed up previous Nome - Onscreen Keyboard GDM dconf file" \
            "dconf" || return 1
    fi
    cat > "$GDM_DCONF_FILE" <<EOF
[org/gnome/shell]
enabled-extensions=$new
disabled-extensions=$GDM_DCONF_EMPTY_STRING_ARRAY
disable-user-extensions=false
EOF
    chmod 0644 "$GDM_DCONF_FILE"
    if command -v dconf >/dev/null 2>&1; then
        dconf update || return 1
    else
        warn "dconf command not found; could not compile /etc/dconf/db/gdm"
        return 1
    fi
}

write_gdm_dconf_extension_lock() {
    install -d -m 0755 "$GDM_DCONF_LOCK_DIR"
    quarantine_gdm_dconf_backups || return 1
    if [[ -f "$GDM_DCONF_LEGACY_LOCK_FILE" && "$GDM_DCONF_LEGACY_LOCK_FILE" != "$GDM_DCONF_LOCK_FILE" ]]; then
        move_gdm_file_to_inactive_backup \
            "$GDM_DCONF_LEGACY_LOCK_FILE" \
            "Disabled older lower-priority GDM dconf lock" \
            "lock" || return 1
    fi
    cat > "$GDM_DCONF_LOCK_FILE" <<EOF
/org/gnome/shell/enabled-extensions
/org/gnome/shell/disabled-extensions
/org/gnome/shell/disable-user-extensions
EOF
    chmod 0644 "$GDM_DCONF_LOCK_FILE"
    if command -v dconf >/dev/null 2>&1; then
        dconf update || return 1
    else
        warn "dconf command not found; could not compile /etc/dconf/db/gdm"
        return 1
    fi
}

verify_gdm_system_files() {
    local status=0
    local f
    verify_no_duplicate_gdm_extension_dirs || status=1
    for f in metadata.json extension.js layouts.js lifecycle.js theme.js \
        dataPaths.js modalAuth.js rgbEffects.js keyboard.js indicator.js \
        predictor.js seed-bigrams.txt stylesheet.css; do
        if [[ ! -f "$SYSTEM_EXT_DIR/$f" ]]; then
            warn "  $f MISSING from $SYSTEM_EXT_DIR"
            status=1
            continue
        fi
        if [[ -f "$SCRIPT_DIR/$f" ]] && cmp -s "$SCRIPT_DIR/$f" "$SYSTEM_EXT_DIR/$f"; then
            ok "  $f present and matches installer source"
        elif [[ -f "$SCRIPT_DIR/$f" ]]; then
            warn "  $f present but DOES NOT match installer source"
            warn "    source: $SCRIPT_DIR/$f"
            warn "    system: $SYSTEM_EXT_DIR/$f"
            status=1
        else
            ok "  $f present"
        fi
    done
    if [[ -f "$SYSTEM_EXT_DIR/metadata.json" ]] \
        && grep -q '"gdm"' "$SYSTEM_EXT_DIR/metadata.json"; then
        ok "  metadata declares gdm session mode"
    else
        warn "  metadata does NOT declare gdm session mode"
        status=1
    fi
    verify_gdm_service_profile_dropin || status=1
    return "$status"
}

verify_gdm_dconf_state() {
    local status=0
    if [[ -f "$GDM_DCONF_PROFILE" ]]; then
        ok "GDM dconf profile exists at $GDM_DCONF_PROFILE"
        local first_source
        first_source="$(gdm_profile_first_source || true)"
        if [[ "$first_source" == "user-db:user" ]]; then
            ok "  profile starts with user-db:user"
        else
            warn "  profile does NOT start with user-db:user"
            warn "    first source: ${first_source:-none}"
            status=1
        fi
        if gdm_profile_has_line '^[[:space:]]*user-db:user[[:space:]]*$'; then
            ok "  profile reads user-db:user"
        else
            warn "  profile does NOT read user-db:user"
            status=1
        fi
        if grep -Eq '^[[:space:]]*system-db:gdm[[:space:]]*$' \
            "$GDM_DCONF_PROFILE"; then
            ok "  profile reads system-db:gdm"
        else
            warn "  profile does NOT read system-db:gdm"
            status=1
        fi
        if [[ -f "$GDM_GREETER_DEFAULTS" ]]; then
            if gdm_profile_has_line '^[[:space:]]*file-db:/usr/share/gdm/greeter-dconf-defaults[[:space:]]*$'; then
                ok "  profile reads distro greeter defaults"
            else
                warn "  profile does NOT read distro greeter defaults"
                status=1
            fi
        fi
    else
        warn "GDM dconf profile missing: $GDM_DCONF_PROFILE"
        status=1
    fi

    if [[ -f "$GDM_DCONF_FILE" ]]; then
        if grep -q "$UUID" "$GDM_DCONF_FILE"; then
            ok "GDM dconf extension key mentions $UUID"
        else
            warn "GDM dconf file exists but does not mention $UUID:"
            warn "  $GDM_DCONF_FILE"
            status=1
        fi
        if grep -Fxq "disabled-extensions=$GDM_DCONF_EMPTY_STRING_ARRAY" \
            "$GDM_DCONF_FILE"; then
            ok "GDM dconf disabled-extensions value is typed"
        else
            warn "GDM dconf disabled-extensions value may fail dconf update"
            warn "  expected: disabled-extensions=$GDM_DCONF_EMPTY_STRING_ARRAY"
            status=1
        fi
    else
        warn "GDM dconf extension key NOT installed"
        warn "  Run: sudo ./install.sh gdm-install"
        status=1
    fi

    if [[ -f "$GDM_DCONF_LOCK_FILE" ]]; then
        if grep -qx '/org/gnome/shell/enabled-extensions' "$GDM_DCONF_LOCK_FILE" \
            && grep -qx '/org/gnome/shell/disabled-extensions' "$GDM_DCONF_LOCK_FILE" \
            && grep -qx '/org/gnome/shell/disable-user-extensions' "$GDM_DCONF_LOCK_FILE"; then
            ok "GDM dconf lock forces extension enable/disable keys for the greeter"
        else
            warn "GDM dconf lock exists but is incomplete:"
            warn "  $GDM_DCONF_LOCK_FILE"
            status=1
        fi
    else
        warn "GDM dconf lock NOT installed"
        warn "  A stale greeter user-db can override /etc/dconf/db/gdm.d without this lock"
        warn "  Run: sudo ./install.sh gdm-install"
        status=1
    fi

    local stale_backup reported_stale_backup
    reported_stale_backup=0
    local stale_patterns=(
        "$GDM_DCONF_DIR"/99-gnome-osk.disabled.*
        "$GDM_DCONF_DIR"/99-gnome-osk.superseded.*
        "$GDM_DCONF_DIR"/90-gnome-osk.disabled.*
        "$GDM_DCONF_DIR"/90-gnome-osk.superseded.*
        "$GDM_DCONF_LOCK_DIR"/99-gnome-osk.disabled.*
        "$GDM_DCONF_LOCK_DIR"/99-gnome-osk.superseded.*
        "$GDM_DCONF_LOCK_DIR"/90-gnome-osk.disabled.*
        "$GDM_DCONF_LOCK_DIR"/90-gnome-osk.superseded.*
    )
    for stale_backup in "${stale_patterns[@]}"; do
        [[ -f "$stale_backup" ]] || continue
        if [[ "$reported_stale_backup" -eq 0 ]]; then
            warn "Stale GDM dconf backup files are still in active database paths"
            warn "  Run: sudo ./install.sh gdm-install to quarantine them"
            reported_stale_backup=1
            status=1
        fi
        warn "  active backup: $stale_backup"
    done

    if [[ -f /etc/dconf/db/gdm ]]; then
        ok "Compiled GDM dconf database exists at /etc/dconf/db/gdm"
    else
        warn "Compiled GDM dconf database missing at /etc/dconf/db/gdm"
        warn "  dconf update may have failed or dconf may be missing"
        status=1
    fi

    if command -v gsettings >/dev/null 2>&1; then
        local profiled_enabled profiled_disabled profiled_disable_user
        if profiled_enabled="$(env DCONF_PROFILE=gdm \
            gsettings get org.gnome.shell enabled-extensions 2>/dev/null)"; then
            if [[ "$profiled_enabled" == *"$UUID"* ]]; then
                ok "DCONF_PROFILE=gdm enabled-extensions contains $UUID"
            else
                warn "DCONF_PROFILE=gdm enabled-extensions lacks $UUID"
                warn "  value: $profiled_enabled"
                status=1
            fi
        else
            warn "Could not query enabled-extensions with DCONF_PROFILE=gdm"
        fi
        if profiled_disabled="$(env DCONF_PROFILE=gdm \
            gsettings get org.gnome.shell disabled-extensions 2>/dev/null)"; then
            if [[ "$profiled_disabled" == *"$UUID"* ]]; then
                warn "DCONF_PROFILE=gdm disabled-extensions still blocks $UUID"
                warn "  value: $profiled_disabled"
                status=1
            else
                ok "DCONF_PROFILE=gdm disabled-extensions does not block $UUID"
            fi
        else
            warn "Could not query disabled-extensions with DCONF_PROFILE=gdm"
        fi
        if profiled_disable_user="$(env DCONF_PROFILE=gdm \
            gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)"; then
            if [[ "$profiled_disable_user" == "false" ]]; then
                ok "DCONF_PROFILE=gdm disable-user-extensions is false"
            else
                warn "DCONF_PROFILE=gdm disable-user-extensions blocks dconf enabled-extensions"
                warn "  value: $profiled_disable_user"
                status=1
            fi
        else
            warn "Could not query disable-user-extensions with DCONF_PROFILE=gdm"
        fi
    else
        warn "gsettings not found; cannot query GDM enabled-extensions"
    fi

    if [[ "$(id -u)" -eq 0 ]]; then
        local gdm_enabled gdm_disabled gdm_disable_user gdm_user
        if gdm_user="$(detect_gdm_user)"; then
            if gdm_enabled="$(gdm_user_cmd dbus-run-session -- \
                gsettings get org.gnome.shell enabled-extensions 2>/dev/null)"; then
                if [[ "$gdm_enabled" == *"$UUID"* ]]; then
                    ok "GDM user '$gdm_user' enabled-extensions contains $UUID"
                else
                    warn "GDM user '$gdm_user' enabled-extensions lacks $UUID"
                    warn "  value: $gdm_enabled"
                    status=1
                fi
            else
                warn "Could not query GDM user '$gdm_user' enabled-extensions"
            fi
            if gdm_disabled="$(gdm_user_cmd dbus-run-session -- \
                gsettings get org.gnome.shell disabled-extensions 2>/dev/null)"; then
                if [[ "$gdm_disabled" == *"$UUID"* ]]; then
                    warn "GDM user '$gdm_user' disabled-extensions blocks $UUID"
                    warn "  value: $gdm_disabled"
                    status=1
                else
                    ok "GDM user '$gdm_user' disabled-extensions does not block $UUID"
                fi
            fi
            if gdm_disable_user="$(gdm_user_cmd dbus-run-session -- \
                gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)"; then
                if [[ "$gdm_disable_user" == "false" ]]; then
                    ok "GDM user '$gdm_user' disable-user-extensions is false"
                else
                    warn "GDM user '$gdm_user' disable-user-extensions blocks dconf enabled-extensions"
                    warn "  value: $gdm_disable_user"
                    status=1
                fi
            fi
        else
            info "No static GDM user account found; relying on the GDM dconf profile"
            info "  This is expected on GNOME 49+ systems with dynamic greeter users."
        fi
    else
        info "Skipping GDM user's enabled-extensions query (requires root)"
        info "  Run sudo ./install.sh check for that extra check"
    fi

    return "$status"
}

verify_gdm_installation() {
    local status=0
    info "Verifying GDM/system extension files"
    verify_gdm_system_files || status=1
    info "Verifying GDM dconf state"
    verify_gdm_dconf_state || status=1
    if command -v journalctl >/dev/null 2>&1; then
        info "After restarting GDM, confirm the greeter loaded the extension with:"
        info "  sudo journalctl -b _COMM=gnome-shell --no-pager | grep gnome-osk"
    fi
    return "$status"
}


# ======================================================================
#   gdm-install  subcommand
# ======================================================================

cmd_gdm_install() {
    [[ "$(id -u)" -eq 0 ]] \
        || die "Run this with sudo/root: sudo $0 gdm-install"
    require_source_files \
        metadata.json extension.js layouts.js lifecycle.js theme.js \
        dataPaths.js modalAuth.js rgbEffects.js keyboard.js indicator.js \
        predictor.js seed-bigrams.txt stylesheet.css

    info "Installing system extension for GDM login screen"
    remove_duplicate_gdm_extension_dirs
    install -d -m 0755 "$SYSTEM_EXT_DIR"
    install -m 0644 "$SCRIPT_DIR/metadata.json" "$SYSTEM_EXT_DIR/metadata.json"
    install -m 0644 "$SCRIPT_DIR/extension.js" "$SYSTEM_EXT_DIR/extension.js"
    install -m 0644 "$SCRIPT_DIR/layouts.js" "$SYSTEM_EXT_DIR/layouts.js"
    install -m 0644 "$SCRIPT_DIR/lifecycle.js" "$SYSTEM_EXT_DIR/lifecycle.js"
    install -m 0644 "$SCRIPT_DIR/theme.js" "$SYSTEM_EXT_DIR/theme.js"
    install -m 0644 "$SCRIPT_DIR/dataPaths.js" "$SYSTEM_EXT_DIR/dataPaths.js"
    install -m 0644 "$SCRIPT_DIR/modalAuth.js" "$SYSTEM_EXT_DIR/modalAuth.js"
    install -m 0644 "$SCRIPT_DIR/rgbEffects.js" "$SYSTEM_EXT_DIR/rgbEffects.js"
    install -m 0644 "$SCRIPT_DIR/keyboard.js" "$SYSTEM_EXT_DIR/keyboard.js"
    install -m 0644 "$SCRIPT_DIR/indicator.js" "$SYSTEM_EXT_DIR/indicator.js"
    install -m 0644 "$SCRIPT_DIR/predictor.js" "$SYSTEM_EXT_DIR/predictor.js"
    install -m 0644 "$SCRIPT_DIR/seed-bigrams.txt" "$SYSTEM_EXT_DIR/seed-bigrams.txt"
    install -m 0644 "$SCRIPT_DIR/stylesheet.css" "$SYSTEM_EXT_DIR/stylesheet.css"
    if [[ -f "$SCRIPT_DIR/wordlist.txt" ]]; then
        install -m 0644 "$SCRIPT_DIR/wordlist.txt" "$SYSTEM_EXT_DIR/wordlist.txt"
    fi
    ok "System extension files installed at $SYSTEM_EXT_DIR"

    ensure_gdm_profile_reads_gdm_db
    info "Ensuring GDM uses the gdm dconf profile"
    install_gdm_service_profile_dropin \
        || warn "Could not install the GDM service dconf-profile drop-in."
    info "Writing GNOME Shell schema fallback for dynamic greeter users"
    write_gdm_schema_override \
        || warn "Could not write the GNOME Shell schema fallback."
    remove_legacy_resource_overlay

    info "Updating GDM user enabled-extensions when that account exists"
    if enable_gdm_extension_user_setting "$UUID"; then
        ok "GDM user setting updated"
    else
        gdm_rc=$?
        if [[ "$gdm_rc" -eq 2 ]]; then
            info "No GDM user account found; using system dconf override only"
        else
            warn "Could not update GDM user setting automatically."
        fi
    fi
    info "Writing minimal GDM dconf key override for extension loading"
    write_gdm_dconf_extension_override "$UUID" \
        && ok "GDM dconf key updated at $GDM_DCONF_FILE" \
        || warn "Could not update the GDM dconf key automatically."
    info "Locking the GDM dconf extension keys against stale greeter overrides"
    write_gdm_dconf_extension_lock \
        && ok "GDM dconf lock updated at $GDM_DCONF_LOCK_FILE" \
        || warn "Could not update the GDM dconf lock automatically."
    warn_legacy_gdm_profile

    if verify_gdm_installation; then
        ok "GDM install verification passed"
    else
        warn "GDM install verification found problems."
        warn "Run this and send the output:"
        warn "  sudo ./install.sh check"
        return 1
    fi

    cat <<DONE

================================================================
  GDM login-screen support installed.

  The extension is now available to the GDM greeter. The installer
  copied the system extension, ensured GDM starts with DCONF_PROFILE=gdm,
  ensured GDM reads /etc/dconf/db/gdm.d, added a GNOME Shell schema
  fallback for dynamic greeter users, cleared disabled-extensions, and
  locked those GDM-only keys so a stale greeter user-db cannot shadow
  them. To see it on the login screen, reboot or restart GDM from a safe
  terminal:

      sudo systemctl restart gdm

  Restarting GDM immediately ends graphical login sessions, so save
  work first.
================================================================
DONE
}

cmd_gdm_restore() {
    [[ "$(id -u)" -eq 0 ]] \
        || die "Run this with sudo/root: sudo $0 gdm-restore"

    info "Removing Nome - Onscreen Keyboard from GDM user setting"
    if disable_gdm_extension_user_setting "$UUID"; then
        ok "GDM enabled-extensions cleaned"
    else
        gdm_rc=$?
        if [[ "$gdm_rc" -eq 2 ]]; then
            info "No GDM user account found; only system dconf will be removed"
        else
            warn "Could not update GDM user setting automatically."
        fi
    fi

    quarantine_gdm_dconf_backups || true

    local file
    for file in "$GDM_DCONF_FILE" "$GDM_DCONF_LEGACY_FILE"; do
        [[ -f "$file" ]] || continue
        move_gdm_file_to_inactive_backup \
            "$file" \
            "Disabled GDM dconf override" \
            "dconf" || true
    done
    for file in "$GDM_DCONF_LOCK_FILE" "$GDM_DCONF_LEGACY_LOCK_FILE"; do
        [[ -f "$file" ]] || continue
        move_gdm_file_to_inactive_backup \
            "$file" \
            "Disabled GDM dconf lock" \
            "lock" || true
    done
    if command -v dconf >/dev/null 2>&1; then
        dconf update || true
    fi
    warn_legacy_gdm_profile
    remove_gdm_service_profile_dropin
    remove_gdm_schema_override
    remove_legacy_resource_overlay

    if [[ -d "$SYSTEM_EXT_DIR" ]]; then
        rm -rf "$SYSTEM_EXT_DIR"
        ok "Removed system extension files at $SYSTEM_EXT_DIR"
    fi
    remove_duplicate_gdm_extension_dirs

    cat <<DONE

================================================================
  GDM login-screen integration removed.

  Reboot or restart GDM after saving work:

      sudo systemctl restart gdm
================================================================
DONE
}


# ======================================================================
#   dispatch
# ======================================================================
#
# Default behaviour is a CLEAN install: every run wipes the previous
# extension files, user data (config + learned words), and gsettings
# entry before installing.  Pass `--keep-data` to preserve the user's
# learned vocabulary across the reinstall.

KEEP_DATA=0
ASK_GDM=0
SKIP_GDM=0
DOWNLOAD_PREDICTION_DATA=1
SUBCMD="install"

while [[ $# -gt 0 ]]; do
    case "$1" in
        check)              SUBCMD="check"; shift ;;
        gdm-install)        SUBCMD="gdm-install"; shift ;;
        gdm-restore|gdm-uninstall)
                            SUBCMD="gdm-restore"; shift ;;
        install|"")         SUBCMD="install"; shift ;;
        --keep-data|-k)     KEEP_DATA=1; shift ;;
        --ask-gdm)          ASK_GDM=1; shift ;;
        --no-gdm)           SKIP_GDM=1; shift ;;
        --download-prediction-data)
                            DOWNLOAD_PREDICTION_DATA=1; shift ;;
        --no-download-prediction-data)
                            DOWNLOAD_PREDICTION_DATA=0; shift ;;
        -h|--help|help)
            cat <<EOF
Usage:
  $0                   Clean install (wipes previous extension + user data)
  $0 --keep-data       Reinstall but preserve learned words / UI config
  $0 --ask-gdm         Ask whether to install GDM login-screen support
  $0 --no-gdm          Reinstall desktop extension only; skip GDM updates
  $0 --no-download-prediction-data
                       Skip vocabulary/network downloads during install
  sudo $0 gdm-install  Add the keyboard to the GDM login screen
  sudo $0 gdm-restore  Remove GDM integration / old dconf override
  $0 check             Diagnose the environment and the install
EOF
            exit 0 ;;
        *)
            die "Unknown arg: $1 (try: install, gdm-install, gdm-restore, check, help)"
            ;;
    esac
done

case "$SUBCMD" in
    install)     cmd_install ;;
    check)       cmd_check ;;
    gdm-install) cmd_gdm_install ;;
    gdm-restore) cmd_gdm_restore ;;
esac
