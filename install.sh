#!/usr/bin/env bash
# Nome - Onscreen Keyboard -- installer (GNOME Shell extension for GNOME 50).
#
# Usage:
#   ./install.sh                 # install and enable the extension
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
# Shell enabled-extensions keys, and creates/appends the standard GDM
# dconf profile entries only when they are missing.

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  [OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  [!!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

UUID="gnome-osk@linuxosk.github.io"
EXT_BASE="$HOME/.local/share/gnome-shell/extensions"
EXT_DIR="$EXT_BASE/$UUID"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/nome-onscreen-keyboard.desktop"
SYSTEM_EXT_BASE="/usr/share/gnome-shell/extensions"
SYSTEM_EXT_DIR="$SYSTEM_EXT_BASE/$UUID"
GDM_DCONF_PROFILE="/etc/dconf/profile/gdm"
GDM_DCONF_DIR="/etc/dconf/db/gdm.d"
GDM_DCONF_FILE="$GDM_DCONF_DIR/90-gnome-osk"
GDM_GREETER_DEFAULTS="/usr/share/gdm/greeter-dconf-defaults"

warn_legacy_gdm_profile() {
    if [[ ! -f "$GDM_DCONF_PROFILE" ]]; then
        warn "GDM profile not found: $GDM_DCONF_PROFILE"
        warn "The login-screen extension key may not be read until"
        warn "that profile exists and lists system-db:gdm."
        warn "Run: sudo ./install.sh gdm-install"
        return 0
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

ensure_gdm_profile_reads_gdm_db() {
    install -d -m 0755 "$(dirname "$GDM_DCONF_PROFILE")"

    if [[ ! -f "$GDM_DCONF_PROFILE" ]]; then
        info "Creating minimal GDM dconf profile"
        {
            echo "# Created by Nome - Onscreen Keyboard installer."
            echo "# Lets GDM read /etc/dconf/db/gdm.d/*.keyfile overrides."
            echo "user-db:user"
            echo "system-db:gdm"
            if [[ -f "$GDM_GREETER_DEFAULTS" ]]; then
                echo "file-db:/usr/share/gdm/greeter-dconf-defaults"
            fi
        } > "$GDM_DCONF_PROFILE"
        chmod 0644 "$GDM_DCONF_PROFILE"
        ok "Created $GDM_DCONF_PROFILE"
        return 0
    fi

    local changed=0
    local backup="$GDM_DCONF_PROFILE.gnome-osk.bak.$(date +%Y%m%d%H%M%S)"

    if ! grep -Eq '^[[:space:]]*system-db:gdm[[:space:]]*$' \
        "$GDM_DCONF_PROFILE"; then
        cp -a "$GDM_DCONF_PROFILE" "$backup"
        warn "Backed up GDM profile before editing: $backup"
        printf '\n# Added by Nome - Onscreen Keyboard installer\nsystem-db:gdm\n' \
            >> "$GDM_DCONF_PROFILE"
        changed=1
    fi

    if [[ -f "$GDM_GREETER_DEFAULTS" ]] \
        && ! grep -Eq '^[[:space:]]*file-db:/usr/share/gdm/greeter-dconf-defaults[[:space:]]*$' \
            "$GDM_DCONF_PROFILE"; then
        if [[ "$changed" -eq 0 ]]; then
            cp -a "$GDM_DCONF_PROFILE" "$backup"
            warn "Backed up GDM profile before editing: $backup"
        fi
        printf 'file-db:/usr/share/gdm/greeter-dconf-defaults\n' \
            >> "$GDM_DCONF_PROFILE"
        changed=1
    fi

    if [[ "$changed" -eq 1 ]]; then
        chmod 0644 "$GDM_DCONF_PROFILE"
        ok "Updated $GDM_DCONF_PROFILE so GDM reads system-db:gdm"
    else
        ok "GDM profile already reads system-db:gdm"
    fi
}


# ======================================================================
#   check  subcommand
# ======================================================================

cmd_check() {
    info "Nome - Onscreen Keyboard environment check"

    if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
        ok "Session type: Wayland"
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
        for f in metadata.json extension.js stylesheet.css; do
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
        for f in metadata.json extension.js predictor.js stylesheet.css; do
            if [[ -f "$SYSTEM_EXT_DIR/$f" ]]; then
                ok "  $f present"
            else
                warn "  $f MISSING from $SYSTEM_EXT_DIR"
            fi
        done
        if [[ -f "$SYSTEM_EXT_DIR/metadata.json" ]] \
            && grep -q '"gdm"' "$SYSTEM_EXT_DIR/metadata.json"; then
            ok "  metadata declares gdm session mode"
        else
            warn "  metadata does NOT declare gdm session mode"
        fi
        if [[ -f "$GDM_DCONF_FILE" ]]; then
            if grep -q "$UUID" "$GDM_DCONF_FILE"; then
                ok "GDM dconf extension key present at $GDM_DCONF_FILE"
            else
                warn "GDM dconf file exists but does not mention this UUID:"
                warn "  $GDM_DCONF_FILE"
            fi
        else
            warn "GDM dconf extension key NOT installed"
            warn "  Run: sudo ./install.sh gdm-install"
        fi
    else
        warn "GDM/system extension NOT installed"
        warn "  Run: sudo ./install.sh gdm-install"
    fi
    warn_legacy_gdm_profile

    if [[ -d "$SYSTEM_EXT_DIR" ]]; then
        if [[ "$(id -u)" -ne 0 ]]; then
            info "Skipping GDM user's enabled-extensions query (requires root)"
            info "  Run sudo ./install.sh check for that extra check"
        else
            local gdm_enabled
            if gdm_enabled="$(gdm_user_cmd dbus-run-session -- \
                gsettings get org.gnome.shell enabled-extensions 2>/dev/null)"; then
                if [[ "$gdm_enabled" == *"$UUID"* ]]; then
                    ok "GDM user's enabled-extensions contains $UUID"
                else
                    warn "GDM user's enabled-extensions does NOT contain $UUID"
                    warn "  Run: sudo ./install.sh gdm-install"
                fi
            else
                warn "Could not query GDM user's enabled-extensions"
                warn "  Try: sudo ./install.sh gdm-install"
            fi
        fi
    fi

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
        fi
    fi

    if command -v gnome-extensions >/dev/null; then
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
    [[ -f "$SCRIPT_DIR/metadata.json" ]] \
        || die "metadata.json not found next to install.sh (looked in $SCRIPT_DIR)."
    [[ -f "$SCRIPT_DIR/extension.js" ]] \
        || die "extension.js not found next to install.sh."
    [[ -f "$SCRIPT_DIR/predictor.js" ]] \
        || die "predictor.js not found next to install.sh."
    [[ -f "$SCRIPT_DIR/seed-bigrams.txt" ]] \
        || die "seed-bigrams.txt not found next to install.sh."
    [[ -f "$SCRIPT_DIR/stylesheet.css" ]] \
        || die "stylesheet.css not found next to install.sh."
    [[ -f "$SCRIPT_DIR/nome-onscreen-keyboard.desktop" ]] \
        || die "nome-onscreen-keyboard.desktop not found next to install.sh."
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
    # Extract OSK_BUILD_TAG from the SOURCE extension.js so you can see
    # at a glance whether you copied the latest files or an old cached
    # version from Windows.  If you see the same tag twice in a row, the
    # transfer is stale and no amount of reinstalling will help.
    local src_tag
    src_tag="$(grep -oE "OSK_BUILD_TAG = '[^']+'" "$SCRIPT_DIR/extension.js" \
               | head -1 | sed -E "s/.*= '([^']+)'.*/\\1/")"
    if [[ -n "$src_tag" ]]; then
        info "Source extension.js build tag: $src_tag"
    else
        warn "Source extension.js has no OSK_BUILD_TAG (pre-tagged build?)"
    fi

    # ---- Phase 2: clean wipe of any previous install -------------------
    # Delegate to uninstall.sh (purge mode by default) so every install
    # starts from a true blank slate -- no stale .js files in the
    # extension dir, no leftover gsettings UUID entry, no stale
    # learned-words / config file under $XDG_DATA_HOME.  Pass
    # --keep-data to install.sh to preserve learned vocabulary.
    if [[ -x "$SCRIPT_DIR/uninstall.sh" ]]; then
        if [[ "$KEEP_DATA" -eq 1 ]]; then
            info "Clean wipe (preserving learned words)"
            "$SCRIPT_DIR/uninstall.sh" --keep-data || true
        else
            info "Clean wipe (extension + user data + gsettings)"
            "$SCRIPT_DIR/uninstall.sh" || true
        fi
    else
        # Fallback when uninstall.sh isn't next to install.sh.
        warn "uninstall.sh not found; doing minimal cleanup"
        gnome-extensions disable "$UUID" 2>/dev/null || true
        if [[ -d "$EXT_DIR" ]]; then
            info "Removing old installed files at $EXT_DIR"
            rm -rf "$EXT_DIR"
        fi
    fi

    # ---- Phase 3: fresh install ----------------------------------------
    info "Installing fresh files to $EXT_DIR"
    mkdir -p "$EXT_DIR"
    install -m 0644 "$SCRIPT_DIR/metadata.json"   "$EXT_DIR/metadata.json"
    install -m 0644 "$SCRIPT_DIR/extension.js"    "$EXT_DIR/extension.js"
    install -m 0644 "$SCRIPT_DIR/predictor.js"    "$EXT_DIR/predictor.js"
    install -m 0644 "$SCRIPT_DIR/seed-bigrams.txt" "$EXT_DIR/seed-bigrams.txt"
    install -m 0644 "$SCRIPT_DIR/stylesheet.css"  "$EXT_DIR/stylesheet.css"

    # ---- Phase 4: fetch English base dictionary -----------------------
    # The word-prediction feature needs a frequency-sorted English
    # word list.  We pull en_full.txt from hermitdave/FrequencyWords
    # (MIT-licensed, ~20 MiB, 1.66M entries sorted by usage frequency
    # in the OpenSubtitles corpus), but only the first 2 MiB via a
    # Range-GET (captures the top ~150k lines for fast download), then
    # truncate to the top 100 000 lines -- below that, hermitdave's
    # tail starts including typos, rare proper nouns, and OCR noise.
    #
    # Format is "word count" per line; the predictor reads the first
    # token of each line so the count column is ignored (line order
    # already encodes rank).
    #
    # Download is non-fatal: prediction is OFF by default and a
    # missing base dictionary simply means the user's learned words
    # are the only source once they enable it.  The menu's "Download
    # prediction data" item re-runs this fetch at runtime too.
    local WORDLIST_URL="https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt"
    local WORDLIST_DEST="$EXT_DIR/wordlist.txt"
    local WORDLIST_RANGE_BYTES=2097151   # 2 MiB - 1 (inclusive)
    local WORDLIST_TOP_N=100000
    local downloaded=0

    info "Fetching English base dictionary (hermitdave/FrequencyWords en_full, top 100k, MIT)"
    if command -v curl >/dev/null 2>&1; then
        if curl -fsSL --max-time 60 --range "0-$WORDLIST_RANGE_BYTES" \
             "$WORDLIST_URL" -o "$WORDLIST_DEST.tmp" 2>/dev/null; then
            if [[ -s "$WORDLIST_DEST.tmp" ]]; then
                # head -n N keeps first N complete lines and drops
                # anything past it (including a partial last line at
                # the 2 MiB cut, which is well past line 100k).
                head -n "$WORDLIST_TOP_N" "$WORDLIST_DEST.tmp" > "$WORDLIST_DEST"
                chmod 0644 "$WORDLIST_DEST"
                rm -f "$WORDLIST_DEST.tmp"
                downloaded=1
            else
                rm -f "$WORDLIST_DEST.tmp"
            fi
        else
            rm -f "$WORDLIST_DEST.tmp"
        fi
    fi
    if [[ "$downloaded" -eq 0 ]] && command -v wget >/dev/null 2>&1; then
        # wget needs a full Range header to avoid pulling all 20 MiB.
        if wget -q --timeout=60 --header="Range: bytes=0-$WORDLIST_RANGE_BYTES" \
             "$WORDLIST_URL" -O "$WORDLIST_DEST.tmp" 2>/dev/null; then
            if [[ -s "$WORDLIST_DEST.tmp" ]]; then
                head -n "$WORDLIST_TOP_N" "$WORDLIST_DEST.tmp" > "$WORDLIST_DEST"
                chmod 0644 "$WORDLIST_DEST"
                rm -f "$WORDLIST_DEST.tmp"
                downloaded=1
            else
                rm -f "$WORDLIST_DEST.tmp"
            fi
        else
            rm -f "$WORDLIST_DEST.tmp"
        fi
    fi
    if [[ "$downloaded" -eq 0 ]] && [[ -f "$SCRIPT_DIR/wordlist.txt" ]]; then
        info "Using bundled wordlist.txt next to install.sh (offline fallback)"
        install -m 0644 "$SCRIPT_DIR/wordlist.txt" "$WORDLIST_DEST"
        downloaded=1
    fi
    if [[ "$downloaded" -eq 1 ]]; then
        local wcount
        wcount="$(wc -l < "$WORDLIST_DEST" 2>/dev/null || echo 0)"
        ok "Wordlist installed ($wcount words at $WORDLIST_DEST)"
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

    info "Fetching English seed bigrams (Norvig count_2w, ~5.6 MiB)"
    if command -v curl >/dev/null 2>&1; then
        if curl -fsSL --max-time 120 "$BIGRAMS_URL" \
             -o "$BIGRAMS_DEST.tmp" 2>/dev/null; then
            if [[ -s "$BIGRAMS_DEST.tmp" ]]; then
                # Sort by column 2 (count) numerically descending, keep
                # top N.  Norvig's file is tab-separated so we pass
                # -t$'\t' explicitly; -k2,2 restricts sort key to the
                # count column (stops sort from recursing into word2).
                sort_and_trim "$BIGRAMS_DEST.tmp" "$BIGRAMS_DEST.clean" || true
                if [[ -s "$BIGRAMS_DEST.clean" ]]; then
                    mv "$BIGRAMS_DEST.clean" "$BIGRAMS_DEST"
                    chmod 0644 "$BIGRAMS_DEST"
                    rm -f "$BIGRAMS_DEST.tmp"
                    bg_downloaded=1
                else
                    rm -f "$BIGRAMS_DEST.tmp" "$BIGRAMS_DEST.clean"
                fi
            else
                rm -f "$BIGRAMS_DEST.tmp"
            fi
        else
            rm -f "$BIGRAMS_DEST.tmp"
        fi
    fi
    if [[ "$bg_downloaded" -eq 0 ]] && command -v wget >/dev/null 2>&1; then
        if wget -q --timeout=120 "$BIGRAMS_URL" \
             -O "$BIGRAMS_DEST.tmp" 2>/dev/null; then
            if [[ -s "$BIGRAMS_DEST.tmp" ]]; then
                sort_and_trim "$BIGRAMS_DEST.tmp" "$BIGRAMS_DEST.clean" || true
                if [[ -s "$BIGRAMS_DEST.clean" ]]; then
                    mv "$BIGRAMS_DEST.clean" "$BIGRAMS_DEST"
                    chmod 0644 "$BIGRAMS_DEST"
                    rm -f "$BIGRAMS_DEST.tmp"
                    bg_downloaded=1
                else
                    rm -f "$BIGRAMS_DEST.tmp" "$BIGRAMS_DEST.clean"
                fi
            else
                rm -f "$BIGRAMS_DEST.tmp"
            fi
        else
            rm -f "$BIGRAMS_DEST.tmp"
        fi
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
    inst_tag="$(grep -oE "OSK_BUILD_TAG = '[^']+'" "$EXT_DIR/extension.js" \
                | head -1 | sed -E "s/.*= '([^']+)'.*/\\1/")"
    if [[ -n "$inst_tag" ]]; then
        ok "Installed build tag: $inst_tag"
    fi
    if [[ -n "$src_tag" && -n "$inst_tag" && "$src_tag" != "$inst_tag" ]]; then
        die "Build tag mismatch after install (src=$src_tag installed=$inst_tag)!"
    fi

    # ---- Phase 6: install app-grid launcher ----------------------------
    # .desktop file so the keyboard shows up in the app grid like any
    # other app.  Its Exec line calls `gnome-extensions enable UUID`,
    # which brings up the extension (and thus the keyboard) if it's
    # currently disabled.  If already enabled, it's a no-op -- use the
    # panel icon to toggle.
    info "Installing app-grid launcher at $DESKTOP_FILE"
    mkdir -p "$DESKTOP_DIR"
    install -m 0644 "$SCRIPT_DIR/nome-onscreen-keyboard.desktop" "$DESKTOP_FILE"
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

    if [[ "$ASK_GDM" -eq 1 ]]; then
        cat <<DONE

================================================================
  Optional: GDM login-screen support

  The normal install above is for your signed-in desktop session.
  If you also want this keyboard available at the GNOME login
  screen, the installer can copy it to the system extension path
  and enable it for GDM.

  If you are updating and previously installed login-screen support,
  choose yes here so the GDM/system copy gets updated too.

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


gdm_user_cmd() {
    if command -v runuser >/dev/null 2>&1; then
        runuser -u gdm -- "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo -u gdm "$@"
    else
        return 1
    fi
}

merge_uuid_into_list() {
    local cur="$1"
    local uuid="$2"
    if [[ "$cur" == *"$uuid"* ]]; then
        printf '%s\n' "$cur"
        return 0
    fi
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
if uuid not in vals:
    vals.append(uuid)
print('[' + ', '.join(repr(v) for v in vals) + ']')
PY
        return $?
    fi
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
    cur="$(gdm_user_cmd dbus-run-session -- \
        gsettings get org.gnome.shell enabled-extensions 2>/dev/null \
        || printf '[]')"
    new="$(merge_uuid_into_list "$cur" "$uuid")" || return 1
    gdm_user_cmd dbus-run-session -- \
        gsettings set org.gnome.shell enabled-extensions "$new" || return 1
    gdm_user_cmd dbus-run-session -- \
        gsettings set org.gnome.shell disable-user-extensions false \
        >/dev/null 2>&1 || true
}

disable_gdm_extension_user_setting() {
    local uuid="$1"
    local cur new
    cur="$(gdm_user_cmd dbus-run-session -- \
        gsettings get org.gnome.shell enabled-extensions 2>/dev/null \
        || printf '[]')"
    new="$(remove_uuid_from_list "$cur" "$uuid")" || return 1
    gdm_user_cmd dbus-run-session -- \
        gsettings set org.gnome.shell enabled-extensions "$new" || return 1
}

write_gdm_dconf_extension_override() {
    local uuid="$1"
    local cur new
    cur="$(gdm_user_cmd dbus-run-session -- \
        gsettings get org.gnome.shell enabled-extensions 2>/dev/null \
        || printf '[]')"
    new="$(merge_uuid_into_list "$cur" "$uuid")" || return 1

    install -d -m 0755 "$GDM_DCONF_DIR"
    if [[ -f "$GDM_DCONF_FILE" ]]; then
        local backup="$GDM_DCONF_FILE.disabled.$(date +%Y%m%d%H%M%S)"
        mv "$GDM_DCONF_FILE" "$backup"
        warn "Backed up previous Nome - Onscreen Keyboard GDM dconf file: $backup"
    fi
    cat > "$GDM_DCONF_FILE" <<EOF
[org/gnome/shell]
enabled-extensions=$new
disable-user-extensions=false
EOF
    chmod 0644 "$GDM_DCONF_FILE"
    if command -v dconf >/dev/null 2>&1; then
        dconf update || return 1
    fi
}


# ======================================================================
#   gdm-install  subcommand
# ======================================================================

cmd_gdm_install() {
    [[ "$(id -u)" -eq 0 ]] \
        || die "Run this with sudo/root: sudo $0 gdm-install"
    [[ -f "$SCRIPT_DIR/metadata.json" ]] \
        || die "metadata.json not found next to install.sh."
    [[ -f "$SCRIPT_DIR/extension.js" ]] \
        || die "extension.js not found next to install.sh."
    [[ -f "$SCRIPT_DIR/predictor.js" ]] \
        || die "predictor.js not found next to install.sh."
    [[ -f "$SCRIPT_DIR/seed-bigrams.txt" ]] \
        || die "seed-bigrams.txt not found next to install.sh."
    [[ -f "$SCRIPT_DIR/stylesheet.css" ]] \
        || die "stylesheet.css not found next to install.sh."

    info "Installing system extension for GDM login screen"
    install -d -m 0755 "$SYSTEM_EXT_DIR"
    install -m 0644 "$SCRIPT_DIR/metadata.json" "$SYSTEM_EXT_DIR/metadata.json"
    install -m 0644 "$SCRIPT_DIR/extension.js" "$SYSTEM_EXT_DIR/extension.js"
    install -m 0644 "$SCRIPT_DIR/predictor.js" "$SYSTEM_EXT_DIR/predictor.js"
    install -m 0644 "$SCRIPT_DIR/seed-bigrams.txt" "$SYSTEM_EXT_DIR/seed-bigrams.txt"
    install -m 0644 "$SCRIPT_DIR/stylesheet.css" "$SYSTEM_EXT_DIR/stylesheet.css"
    if [[ -f "$SCRIPT_DIR/wordlist.txt" ]]; then
        install -m 0644 "$SCRIPT_DIR/wordlist.txt" "$SYSTEM_EXT_DIR/wordlist.txt"
    fi
    ok "System extension files installed at $SYSTEM_EXT_DIR"

    ensure_gdm_profile_reads_gdm_db

    info "Merging extension into GDM user's enabled-extensions"
    enable_gdm_extension_user_setting "$UUID" \
        && ok "GDM user setting updated" \
        || warn "Could not update GDM user setting automatically."
    info "Writing minimal GDM dconf key override for extension loading"
    write_gdm_dconf_extension_override "$UUID" \
        && ok "GDM dconf key updated at $GDM_DCONF_FILE" \
        || warn "Could not update the GDM dconf key automatically."
    warn_legacy_gdm_profile

    cat <<DONE

================================================================
  GDM login-screen support installed.

  The extension is now available to the GDM greeter. The installer
  copied the system extension, ensured GDM reads /etc/dconf/db/gdm.d,
  and added this extension UUID to GDM's GNOME Shell enabled-extensions
  setting. To see it on the login screen, reboot or restart GDM from
  a safe terminal:

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
    disable_gdm_extension_user_setting "$UUID" \
        && ok "GDM enabled-extensions cleaned" \
        || warn "Could not update GDM user setting automatically."

    if [[ -f "$GDM_DCONF_FILE" ]]; then
        local backup="$GDM_DCONF_FILE.disabled.$(date +%Y%m%d%H%M%S)"
        mv "$GDM_DCONF_FILE" "$backup"
        warn "Disabled legacy GDM dconf override: $backup"
        if command -v dconf >/dev/null 2>&1; then
            dconf update || true
        fi
    fi
    warn_legacy_gdm_profile

    if [[ -d "$SYSTEM_EXT_DIR" ]]; then
        rm -rf "$SYSTEM_EXT_DIR"
        ok "Removed system extension files at $SYSTEM_EXT_DIR"
    fi

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
        -h|--help|help)
            cat <<EOF
Usage:
  $0                   Clean install (wipes previous extension + user data)
  $0 --keep-data       Reinstall but preserve learned words / UI config
  $0 --ask-gdm         Ask whether to install GDM login-screen support
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
