/* Nome - Onscreen Keyboard persistent data paths and sources. */

import GLib from 'gi://GLib';

// ========================================================================
//  Build tag
// ========================================================================

// Bump this when you make user-visible behaviour changes -- it shows
// up in the journal so we can tell at a glance whether the installed
// files actually match the build we're trying to ship.
export const OSK_BUILD_TAG = 'v25';


// ========================================================================
//  Config / user data paths
// ========================================================================
//
// We keep two files under $XDG_DATA_HOME/gnome-osk/ (defaults to
// ~/.local/share/gnome-osk/):
//   - config.json    -- UI prefs that should outlive a session.  Right
//                       now that's just the word-prediction toggle, but
//                       this is the right place for any future ones.
//   - userdata.json  -- the predictor's learned user-word / bigram
//                       state.  Owned by WordPredictor; the extension
//                       only tells it the path.
//   - prediction-data.json -- small manifest written after menu-driven
//                       wordlist / bigram downloads.
// Using $XDG_DATA_HOME keeps user state out of the extension install
// dir so reinstalling doesn't wipe it and uninstalling doesn't touch
// it (users can opt in to deletion via uninstall.sh).
export function _oskDataDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-osk']);
}
export function _oskConfigPath() {
    return GLib.build_filenamev([_oskDataDir(), 'config.json']);
}
export function _oskUserDataPath() {
    return GLib.build_filenamev([_oskDataDir(), 'userdata.json']);
}
// User-owned wordlist / seed bigrams: both live under $XDG_DATA_HOME
// so they survive a reinstall of the extension (install.sh wipes
// the extension dir but does NOT touch this directory).  Also where
// the "Download vocabulary" menu item writes its fetched results.
export function _oskUserWordlistPath() {
    return GLib.build_filenamev([_oskDataDir(), 'wordlist.txt']);
}
export function _oskUserSeedBigramsPath() {
    return GLib.build_filenamev([_oskDataDir(), 'seed-bigrams.txt']);
}
export function _oskPredictionManifestPath() {
    return GLib.build_filenamev([_oskDataDir(), 'prediction-data.json']);
}

// Source URLs for the bundled English base dictionary and seed
// bigrams.  Used by BOTH install.sh (first install) and the menu's
// "Download vocabulary" button (refresh / repair).  Kept as
// module-level constants so the two download paths agree on what's
// being fetched.
//
// Wordlist: hermitdave/FrequencyWords ships frequency-sorted lists
// derived from the OpenSubtitles corpus.  en_full.txt is the whole
// corpus -- 1.66 million entries, ~20 MiB.  We download the full file
// so first-run installs get the whole local vocabulary.  The predictor
// still filters out unsupported/non-ASCII tokens at load time.
export const WORDLIST_SOURCE_URL =
    'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt';
// 0 means keep every downloaded line.  Left as a named constant so the
// manifest can report whether a build intentionally capped the list.
export const WORDLIST_TOP_N = 0;
// 0 disables HTTP Range requests and downloads the full source file.
export const WORDLIST_DOWNLOAD_BYTES = 0;
// Hard cap with room above the current ~20 MiB source file, but small
// enough to stop a bad server response from filling disk.
export const WORDLIST_MAX_BYTES = 64 * 1024 * 1024;

// Seed bigrams: Peter Norvig's count_2w.txt is ~5.6 MiB with ~286 000
// entries drawn from Google Web 1T.  The file is alphabetically
// sorted (not by frequency), so we download the whole thing and
// re-sort client-side by count descending, keeping only the top N
// most-common pairs.  That becomes our seed corpus.
export const SEED_BIGRAMS_SOURCE_URL =
    'https://norvig.com/ngrams/count_2w.txt';
// Hard cap on downloaded bigram file size -- 10 MiB lets the ~5.6
// MiB source through with headroom, but stops a misbehaving server
// streaming forever from filling the disk.
export const SEED_BIGRAMS_MAX_BYTES = 10 * 1024 * 1024;
// After download we sort the file by count descending and keep this
// many entries.  20 000 matches install.sh's cap and bounds the
// predictor's in-memory Map at a few megabytes.
export const SEED_BIGRAMS_TOP_N = 20000;
export const PREDICTION_DATA_VERSION = 1;
