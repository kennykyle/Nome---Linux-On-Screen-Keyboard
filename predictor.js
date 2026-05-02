/* Nome - Onscreen Keyboard -- word predictor.
 *
 * A deliberately small, fully-local, non-ML predictor in the
 * tradition of Windows' OSK / the pre-neural SwiftKey engine:
 *
 *   score(candidate | prevWord) = baseFreq(candidate)
 *                               + userBoost(candidate) * W_BOOST
 *                               + bigramCount(prevWord, candidate) * W_BIGRAM
 *
 *   baseFreq     -- read once from a frequency-sorted wordlist shipped
 *                   alongside the extension (install.sh pulls it from
 *                   first20hours/google-10000-english).  Rank zero is
 *                   the commonest word; we linearise the rank so the
 *                   tail doesn't underflow to zero.
 *   userBoost    -- simple counter: +1 every time the user commits the
 *                   word (space / enter / punctuation).  Multiplied by
 *                   W_BOOST so even a handful of repetitions beats
 *                   mid-tier base frequency.
 *   bigramCount  -- Map<prevWord, Map<nextWord, count>>.  Captures
 *                   personal phrase context without needing an LM.  A
 *                   big weight here is what makes suggestions feel
 *                   "smart" after a few sessions of learning.
 *
 * Lookup is bucketed by first letter.  For ~10k words that's ~400
 * candidates per bucket worst case; a linear scan with a prefix
 * startsWith check is well under a millisecond in GJS.
 *
 * Persistence: userBoost + bigrams -> a single JSON file in the user's
 * data dir (GLib.get_user_data_dir() + '/gnome-osk/userdata.json').
 * Saves are debounced via GLib.timeout_add so we don't hit the disk on
 * every keypress.  destroy() flushes any pending save.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';


// Score weights.  Tuned so that:
//   - a single user-learned bigram comfortably out-ranks any seeded
//     bigram (i.e. personal phrasing wins once it's been taught),
//   - and within seeds, the hand-tuned priority counts in
//     seed-bigrams.txt decide ordering.
// The seed file's `count` column tops out at ~15; we cap it there
// anyway on load.  So max seed score = 15 * W_SEED_BIGRAM = 450,
// which is less than one user repeat (W_BIGRAM = 600).  Net: every
// time the user types a phrase, their version of that bigram jumps
// above any seeded version on the next prediction.
const W_BOOST = 60;
const W_BIGRAM = 600;
const W_SEED_BIGRAM = 30;
const SEED_MAX_COUNT = 15;

// Cap on candidate length we're willing to store / suggest.  The
// longest real English word in common lists is 28-ish; this keeps a
// typo'd 200-char blob from ending up in the user dict.
const MAX_WORD_LENGTH = 30;

// Save debounce.  Short enough that 'learned' state survives a quick
// extension disable; long enough that a typing burst doesn't thrash
// the disk.  The flush-on-destroy path covers the rest.
const SAVE_DEBOUNCE_MS = 3000;

// Only alphabetic + apostrophe words get learned / predicted.  This
// deliberately drops digits, punctuation, and anything non-ASCII --
// those would bloat the user dict with tokens that prediction can't
// usefully reconstruct (the OSK's virtual device types via evdev
// keycodes, not unicode).
const WORD_RE = /^[a-z][a-z']*$/;


export class WordPredictor {
    constructor() {
        this._baseFreq = new Map();      // word -> base frequency (rank-derived)
        this._baseSourceEntries = 0;     // non-empty rows in loaded wordlist
        this._userBoost = new Map();     // word -> learned repeat count
        this._bigrams = new Map();       // prev -> Map<next, count>
        this._seedBigrams = new Map();   // prev -> Map<next, count>
                                          //   Loaded from seed-bigrams.txt,
                                          //   never modified, never persisted.
                                          //   Gives the predictor something to
                                          //   say about "next word" on first
                                          //   use before the user has taught
                                          //   it any personal bigrams.
        this._seedFallbackWords = new Set(); // seed-derived prefix fallback
        this._prefixIndex = new Map();   // first char -> [words]
        this._userWordsInIndex = new Set(); // tracks user-added words

        this._wordlistPaths = [];
        this._loadedWordlistPath = null;   // which one we actually read
        this._seedBigramsPaths = [];
        this._loadedSeedBigramsPath = null;
        this._userDataPath = null;
        this._saveTimerId = 0;
        this._dirty = false;
    }

    // Paths are tried in order; first readable, non-empty file wins.
    // Accepts a single path too so callers can pass the simple case
    // without wrapping it.
    setSeedBigramsPaths(paths) {
        this._seedBigramsPaths = Array.isArray(paths)
            ? paths.filter(Boolean)
            : (paths ? [paths] : []);
    }
    getLoadedSeedBigramsPath() { return this._loadedSeedBigramsPath; }

    setWordlistPaths(paths) {
        this._wordlistPaths = Array.isArray(paths)
            ? paths.filter(Boolean)
            : (paths ? [paths] : []);
    }
    setUserDataPath(p) { this._userDataPath = p; }

    // The path we most recently read the base dictionary from; null if
    // we haven't successfully loaded one.  Used by the extension menu's
    // status line so it can tell the user which file is live.
    getLoadedWordlistPath() { return this._loadedWordlistPath; }


    _loadFirstTextFile(paths, label) {
        for (const p of paths) {
            if (!p) continue;
            try {
                const file = Gio.File.new_for_path(p);
                if (!file.query_exists(null)) continue;
                const [ok, bytes] = file.load_contents(null);
                if (!ok) continue;
                const text = new TextDecoder('utf-8').decode(bytes);
                if (!text.trim()) continue;
                return [text, p];
            } catch (e) {
                log(`gnome-osk: ${label} load failed at ${p}: ${e}`);
            }
        }
        return [null, null];
    }


    // ---- load paths ---------------------------------------------------

    loadBaseDictionary() {
        this._baseFreq.clear();
        this._baseSourceEntries = 0;
        this._seedFallbackWords.clear();
        // Drop the top-N cache so the post-word fallback list
        // reflects the freshly-loaded dictionary on the next call.
        this._topBaseCache = null;

        const [text, usedPath] =
            this._loadFirstTextFile(this._wordlistPaths, 'wordlist');
        this._loadedWordlistPath = usedPath;

        if (!text) {
            log(`gnome-osk: no wordlist available ` +
                `(tried: ${this._wordlistPaths.join(', ') || 'none'})`);
            // Rebuild the prefix index even on failure so any
            // previously-learned user words remain discoverable via
            // prediction.
            this._rebuildPrefixIndex();
            return 0;
        }

        const lines = text.split(/\r?\n/);
        this._baseSourceEntries = lines.reduce(
            (count, raw) => count + (raw.trim() ? 1 : 0), 0);
        // First pass: filter + keep rank.  We use the original line
        // number as the rank so the very first (commonest) word gets
        // the highest base frequency; linear decay is plenty for
        // ranking purposes and is cheap to compute.
        //
        // We accept two file shapes transparently:
        //   (a) just a word per line ("the\nof\nand\n...") -- what
        //       google-10000-english ships.
        //   (b) "word count" per line ("the 22038615\nof 13151942\n...")
        //       -- what hermitdave/FrequencyWords ships.
        // We only need the word; the per-line count is ignored
        // because the LINE ORDER already encodes frequency rank.
        const filtered = [];
        const seen = new Set();
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i].trim();
            if (!raw) continue;
            // Take the first whitespace-separated token.  Handles
            // both (a) and (b) uniformly.
            const w = raw.split(/\s+/)[0].toLowerCase();
            if (!w || w.length > MAX_WORD_LENGTH) continue;
            if (!WORD_RE.test(w)) continue;
            if (seen.has(w)) continue;  // dedupe; some corpora list
                                        // the same lemma twice
            seen.add(w);
            filtered.push(w);
        }
        const n = filtered.length;
        for (let i = 0; i < n; i++) {
            // freq = n - i -> highest rank gets the biggest number.
            this._baseFreq.set(filtered[i], n - i);
        }
        // The source list is already rank-ordered, so cache the common
        // fallback words now instead of sorting the whole Map on the
        // first cold-start prediction.
        this._topBaseCache = filtered.slice(0, 30);

        this._rebuildPrefixIndex();
        log(`gnome-osk: base dictionary loaded (${n} words from ${usedPath})`);
        return n;
    }

    loadSeedBigrams() {
        // Try each configured path in order; first non-empty file
        // wins.  Formats accepted (auto-detected by whitespace):
        //   (a) hand-curated:   "prev next count"   (our own format)
        //   (b) Norvig 2-grams: "prev next\tcount"  (one word per
        //                                            token, tab-delim)
        // Both are parsed the same way by splitting on /\s+/ -- we
        // take the first three tokens and ignore anything after.
        // Lines beginning with '#' and blank lines are skipped.
        //
        // Counts above SEED_MAX_COUNT (currently 15) get clamped on
        // load; this puts a hard ceiling on how much a seeded bigram
        // can contribute to the final score, which keeps the
        // invariant that ANY user-learned repeat out-ranks ALL seeded
        // bigrams for the same pair.  Without the clamp a Norvig
        // count of 10^9 would score 3 * 10^10 and swamp user data.
        this._seedBigrams.clear();
        this._loadedSeedBigramsPath = null;
        let removedFallbackWords = false;
        for (const word of this._seedFallbackWords)
            removedFallbackWords = this._baseFreq.delete(word) || removedFallbackWords;
        this._seedFallbackWords.clear();

        const [text, usedPath] =
            this._loadFirstTextFile(this._seedBigramsPaths, 'seed bigrams');
        this._loadedSeedBigramsPath = usedPath;
        if (!text) {
            if (removedFallbackWords) {
                if (!this._loadedWordlistPath)
                    this._topBaseCache = [];
                this._rebuildPrefixIndex();
            }
            log(`gnome-osk: no seed bigrams available ` +
                `(tried: ${this._seedBigramsPaths.join(', ') || 'none'})`);
            return 0;
        }

        let loaded = 0;
        const fallbackFreq = new Map();
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const parts = line.split(/\s+/);
            if (parts.length < 2) continue;
            const prev = parts[0].toLowerCase();
            const next = parts[1].toLowerCase();
            let c = parts.length >= 3 ? parseInt(parts[2], 10) : 1;
            if (!isFinite(c) || c <= 0) c = 1;
            if (c > SEED_MAX_COUNT) c = SEED_MAX_COUNT;
            if (!WORD_RE.test(prev) || !WORD_RE.test(next)) continue;
            if (prev.length > MAX_WORD_LENGTH
                || next.length > MAX_WORD_LENGTH) continue;

            let m = this._seedBigrams.get(prev);
            if (!m) {
                m = new Map();
                this._seedBigrams.set(prev, m);
            }
            // If the file has duplicate pairs (fine for the merged
            // hand-curated + Norvig case), keep the MAX count rather
            // than overwriting -- safer default.
            const existing = m.get(next) || 0;
            m.set(next, Math.max(existing, c));
            fallbackFreq.set(prev, (fallbackFreq.get(prev) || 0) + c);
            fallbackFreq.set(next, (fallbackFreq.get(next) || 0) + c);
            loaded++;
        }

        let fallbackWords = 0;
        for (const [word, score] of fallbackFreq) {
            if (this._baseFreq.has(word)) continue;
            this._baseFreq.set(word, score);
            this._seedFallbackWords.add(word);
            fallbackWords++;
        }
        if (fallbackWords > 0) {
            if (!this._loadedWordlistPath) {
                this._topBaseCache = [...fallbackFreq.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 30)
                    .map(([word]) => word);
            }
            this._rebuildPrefixIndex();
        }

        log(`gnome-osk: seed bigrams loaded (${loaded} pairs, ` +
            `${this._seedBigrams.size} contexts, from ${usedPath})`);
        return loaded;
    }

    _rebuildPrefixIndex() {
        this._prefixIndex.clear();
        this._userWordsInIndex.clear();
        for (const word of this._baseFreq.keys()) {
            const key = word[0];
            let bucket = this._prefixIndex.get(key);
            if (!bucket) {
                bucket = [];
                this._prefixIndex.set(key, bucket);
            }
            bucket.push(word);
        }
        // Sort each bucket by base frequency descending so a short-
        // prefix lookup tends to hit the best candidates first.  Not
        // strictly required (we score and re-sort all matches anyway),
        // but helps scan order.
        for (const bucket of this._prefixIndex.values()) {
            bucket.sort((a, b) =>
                (this._baseFreq.get(b) || 0) - (this._baseFreq.get(a) || 0));
        }
        // Re-add any user words we've learned so far (learn() adds
        // them on the fly; this handles the re-sort path).
        for (const word of this._userBoost.keys()) {
            this._ensureIndexed(word);
        }
    }

    _ensureIndexed(word) {
        if (this._baseFreq.has(word)) return;
        if (this._userWordsInIndex.has(word)) return;
        const key = word[0];
        let bucket = this._prefixIndex.get(key);
        if (!bucket) {
            bucket = [];
            this._prefixIndex.set(key, bucket);
        }
        bucket.push(word);
        this._userWordsInIndex.add(word);
    }


    loadUserData() {
        this._userBoost.clear();
        this._bigrams.clear();
        if (!this._userDataPath) return;

        try {
            const file = Gio.File.new_for_path(this._userDataPath);
            if (!file.query_exists(null)) return;
            const [ok, bytes] = file.load_contents(null);
            if (!ok) return;
            const text = new TextDecoder('utf-8').decode(bytes);
            if (!text.trim()) return;
            const json = JSON.parse(text);
            if (json.userBoost && typeof json.userBoost === 'object') {
                for (const [k, v] of Object.entries(json.userBoost)) {
                    const word = String(k).toLowerCase();
                    if (!WORD_RE.test(word)) continue;
                    if (word.length > MAX_WORD_LENGTH) continue;
                    const c = Number(v);
                    if (!isFinite(c) || c <= 0) continue;
                    this._userBoost.set(word, c);
                    this._ensureIndexed(word);
                }
            }
            if (json.bigrams && typeof json.bigrams === 'object') {
                for (const [prev, nextMap] of Object.entries(json.bigrams)) {
                    const p = String(prev).toLowerCase();
                    if (!WORD_RE.test(p)) continue;
                    if (!nextMap || typeof nextMap !== 'object') continue;
                    const m = new Map();
                    for (const [next, c] of Object.entries(nextMap)) {
                        const w = String(next).toLowerCase();
                        if (!WORD_RE.test(w)) continue;
                        const cnt = Number(c);
                        if (!isFinite(cnt) || cnt <= 0) continue;
                        m.set(w, cnt);
                    }
                    if (m.size > 0) this._bigrams.set(p, m);
                }
            }
        } catch (e) {
            log(`gnome-osk: user data load failed: ${e}`);
        }
    }

    saveUserData() {
        if (!this._userDataPath) return;
        try {
            const dir = GLib.path_get_dirname(this._userDataPath);
            GLib.mkdir_with_parents(dir, 0o700);
            const obj = {
                version: 1,
                userBoost: Object.fromEntries(this._userBoost),
                bigrams: Object.fromEntries(
                    [...this._bigrams].map(([k, v]) => [k, Object.fromEntries(v)])
                ),
            };
            const bytes = new TextEncoder().encode(JSON.stringify(obj));
            const file = Gio.File.new_for_path(this._userDataPath);
            // etag=null, make_backup=false, flags=REPLACE_DESTINATION
            // is the idiomatic "atomically overwrite" path.
            file.replace_contents(
                bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
            this._dirty = false;
        } catch (e) {
            log(`gnome-osk: user data save failed: ${e}`);
        }
    }

    _scheduleSave() {
        this._dirty = true;
        if (this._saveTimerId) return;
        this._saveTimerId = GLib.timeout_add(
            GLib.PRIORITY_LOW, SAVE_DEBOUNCE_MS,
            () => {
                this._saveTimerId = 0;
                if (this._dirty) this.saveUserData();
                return GLib.SOURCE_REMOVE;
            }
        );
    }


    // ---- scoring / prediction ----------------------------------------

    _score(word, prevWord) {
        let s = this._baseFreq.get(word) || 0;
        const boost = this._userBoost.get(word);
        if (boost) s += boost * W_BOOST;
        if (prevWord) {
            const bg = this._bigrams.get(prevWord);
            if (bg) {
                const c = bg.get(word);
                if (c) s += c * W_BIGRAM;
            }
            const sbg = this._seedBigrams.get(prevWord);
            if (sbg) {
                const c = sbg.get(word);
                if (c) s += c * W_SEED_BIGRAM;
            }
        }
        return s;
    }

    // Bigram-only score for the post-word case, where we want
    // bigram-matching candidates to sort among themselves without
    // base frequency swamping them.  User-learned bigrams outweigh
    // seeded ones by the weight-ratio (W_BIGRAM : W_SEED_BIGRAM =
    // 20:1 at current constants).
    _bigramScore(word, prevWord) {
        let s = 0;
        const bg = this._bigrams.get(prevWord);
        if (bg) {
            const c = bg.get(word);
            if (c) s += c * W_BIGRAM;
        }
        const sbg = this._seedBigrams.get(prevWord);
        if (sbg) {
            const c = sbg.get(word);
            if (c) s += c * W_SEED_BIGRAM;
        }
        // Tie-breaker: prefer the more common base-dict word when two
        // bigrams have identical scores (e.g. both user count 1).
        s += (this._baseFreq.get(word) || 0) / 1e6;
        return s;
    }

    _topScoredWords(words, maxResults, scoreFn) {
        const limit = Math.max(1, maxResults | 0);
        const top = [];
        for (const word of words) {
            const score = scoreFn(word);
            let inserted = false;
            for (let i = 0; i < top.length; i++) {
                if (score > top[i].score) {
                    top.splice(i, 0, { word, score });
                    inserted = true;
                    break;
                }
            }
            if (!inserted && top.length < limit)
                top.push({ word, score });
            if (top.length > limit) top.length = limit;
        }
        return top.map(item => item.word);
    }

    // Return up to `maxResults` lowercase suggestion strings for the
    // given lowercase prefix and lowercase previous word.  Caller is
    // responsible for any display-time casing.
    predict(prefix, prevWord, maxResults) {
        maxResults = maxResults | 0 || 3;
        prefix = (prefix || '').toLowerCase();
        prevWord = prevWord ? prevWord.toLowerCase() : '';

        if (prefix.length === 0) {
            return this._predictNoPrefix(prevWord, maxResults);
        }

        const firstCh = prefix[0];
        const bucket = this._prefixIndex.get(firstCh) || [];
        const matches = function* () {
            for (const w of bucket) {
                if (w.length >= prefix.length && w.startsWith(prefix))
                    yield w;
            }
        };
        return this._topScoredWords(
            matches(), maxResults, word => this._score(word, prevWord));
    }

    _predictNoPrefix(prevWord, maxResults) {
        // Two distinct "empty prefix" states, handled differently:
        //
        //   (a) cold start / post-idle: prevWord is empty too.  No
        //       context at all, so we show NOTHING.  Splashing
        //       "the / of / and" out of nowhere is noise -- Windows
        //       OSK stays quiet here too.
        //
        //   (b) post-word: the user just committed a word (via space,
        //       enter, or by tapping a prediction) and we have a
        //       previousWord to anchor off.  This is the "suggest
        //       the next word of the sentence" case that mobile-phone
        //       keyboards do well.  Two-pass fill:
        //           pass 1 -- bigram continuations (user + seed),
        //                    sorted by bigram-only score so base
        //                    frequency doesn't swamp them;
        //           pass 2 -- if there's still slot space, fill with
        //                    top-frequency base-dict words.
        //       Bigrams are NEVER mixed with fallback in a single
        //       sort -- they always take the earlier slots.  This is
        //       what lets a seeded "hello -> there" beat the
        //       generically-common "the" when the user has just
        //       typed "hello<space>".
        if (!prevWord) return [];

        const seen = new Set();
        const result = [];

        // ---- pass 1: bigram candidates (user + seed) -----------------
        const bigramWords = new Set();
        const ubg = this._bigrams.get(prevWord);
        if (ubg) for (const w of ubg.keys()) bigramWords.add(w);
        const sbg = this._seedBigrams.get(prevWord);
        if (sbg) for (const w of sbg.keys()) bigramWords.add(w);

        if (bigramWords.size > 0) {
            const topBigrams = this._topScoredWords(
                bigramWords, maxResults,
                word => this._bigramScore(word, prevWord));
            for (const w of topBigrams) {
                result.push(w);
                seen.add(w);
            }
        }

        // ---- pass 2: top-frequency fallback --------------------------
        if (result.length < maxResults) {
            if (!this._topBaseCache) {
                this._topBaseCache = [];
            }
            for (const w of this._topBaseCache) {
                if (seen.has(w)) continue;
                result.push(w);
                seen.add(w);
                if (result.length >= maxResults) break;
            }
        }

        return result;
    }


    // ---- learning ----------------------------------------------------

    learn(word, prevWord) {
        if (!word) return;
        word = String(word).toLowerCase();
        if (word.length < 2 || word.length > MAX_WORD_LENGTH) return;
        if (!WORD_RE.test(word)) return;

        this._userBoost.set(word, (this._userBoost.get(word) || 0) + 1);
        this._ensureIndexed(word);

        if (prevWord) {
            prevWord = String(prevWord).toLowerCase();
            if (WORD_RE.test(prevWord) && prevWord.length <= MAX_WORD_LENGTH) {
                let m = this._bigrams.get(prevWord);
                if (!m) {
                    m = new Map();
                    this._bigrams.set(prevWord, m);
                }
                m.set(word, (m.get(word) || 0) + 1);
            }
        }

        this._scheduleSave();
    }

    // Forget everything the user has taught the predictor.  Base
    // dictionary is untouched.  Used from the menu.
    resetLearning() {
        this._userBoost.clear();
        this._bigrams.clear();
        // Rebuild the prefix index so user-only words drop out.
        this._rebuildPrefixIndex();
        this._dirty = true;
        this.saveUserData();
    }


    // ---- diagnostics -------------------------------------------------

    stats() {
        const countPairs = map => {
            let total = 0;
            for (const nextMap of map.values())
                total += nextMap.size;
            return total;
        };
        return {
            baseWords: this._baseFreq.size,
            baseSourceEntries: this._baseSourceEntries,
            learnedWords: this._userBoost.size,
            bigramContexts: this._bigrams.size,
            bigramPairs: countPairs(this._bigrams),
            seedBigramContexts: this._seedBigrams.size,
            seedBigramPairs: countPairs(this._seedBigrams),
        };
    }


    // ---- lifecycle ---------------------------------------------------

    destroy() {
        if (this._saveTimerId) {
            GLib.source_remove(this._saveTimerId);
            this._saveTimerId = 0;
        }
        if (this._dirty) this.saveUserData();
    }
}
