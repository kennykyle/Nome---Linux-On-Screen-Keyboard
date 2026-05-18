/* Nome - Onscreen Keyboard -- Shell Extension for GNOME 50.
 *
 * Runs inside Mutter.  That's the whole point of being a Shell
 * extension: a third-party Wayland app can't stay on top or inject
 * keys without stealing focus, but code running inside GNOME Shell can
 * because it's part of the compositor.
 *
 *   - Stay on top: the keyboard actor is added to Main.layoutManager's
 *     chrome layer, which is always rendered above normal windows.
 *   - No focus stealing: chrome actors don't participate in Wayland
 *     seat focus, so tapping a key doesn't move focus away from the
 *     text field the user was editing.
 *   - Typing in terminals: we use a Clutter.VirtualInputDevice to
 *     synthesize real evdev key events at the compositor level.  These
 *     go to whichever window currently holds keyboard focus -- which is
 *     still the terminal, because the chrome tap didn't take it away.
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
// Cairo is the drawing backend used by the RGB row glow canvases and
// the color wheel widget.  GJS exposes it under the 'cairo' import
// (no `gi://` prefix).
import Cairo from 'cairo';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import { WordPredictor } from './predictor.js';
import {
    LAYOUTS, DEFAULT_LAYOUT_KEY,
} from './layouts.js';
import {
    _removeSource, _clearSource,
} from './lifecycle.js';
import {
    THEMES, CONFIG_VERSION, DEFAULT_CUSTOMIZATION, CUSTOM_COLOR_SPECS,
    _sanitizeUserThemes, _sanitizeCustomization,
    _parseHex, _rgbToHsv, _hsvToHex,
    _lookupTheme, _isBuiltInTheme,
} from './theme.js';
import {
    OSKKeyboard, RGB_GLOW_SIZE_MAX, RGB_SPREAD_SIZE_MAX,
    MIN_KEYBOARD_WIDTH, MIN_KEYBOARD_HEIGHT, KEYBOARD_SCREEN_MARGIN,
    CUSTOMIZE_WINDOW_MIN_WIDTH, CUSTOMIZE_WINDOW_MIN_HEIGHT,
    _primaryWorkArea, _fitKeyboardRectToWorkArea,
} from './keyboard.js';
import { OSKIndicator } from './indicator.js';
import {
    OSK_BUILD_TAG, _oskDataDir, _oskConfigPath, _oskUserDataPath,
    _oskUserWordlistPath, _oskUserSeedBigramsPath, _oskPredictionManifestPath,
    WORDLIST_SOURCE_URL, WORDLIST_TOP_N, WORDLIST_DOWNLOAD_BYTES,
    WORDLIST_MAX_BYTES, SEED_BIGRAMS_SOURCE_URL, SEED_BIGRAMS_MAX_BYTES,
    SEED_BIGRAMS_TOP_N, PREDICTION_DATA_VERSION,
} from './dataPaths.js';
import {
    OSK_MODAL_HOVER_THROTTLE_US, isAuthSessionModeName,
    isPointerLikeEventType, isPointerTrackingOnlyEventType,
} from './modalAuth.js';


// Runtime modules:
// - layouts.js: evdev maps and layout registry
// - keyboard.js: OSK actors, geometry, layout scheduler, and RGB runtime
// - indicator.js: top-bar indicator actor

export default class OSKExtension extends Extension {
    _sessionMode() {
        try {
            if (Main.sessionMode && Main.sessionMode.currentMode)
                return Main.sessionMode.currentMode;
        } catch (_e) {
        }
        try {
            if (global.get_session_mode)
                return global.get_session_mode();
        } catch (_e) {
        }
        try {
            if (global.session_mode)
                return global.session_mode;
        } catch (_e) {
        }
        return 'user';
    }

    _isAuthSessionMode() {
        const mode = this._sessionModeName || this._sessionMode();
        return isAuthSessionModeName(mode, Main.sessionMode);
    }

    enable() {
        this._sessionModeName = this._sessionMode();
        this._authSessionMode = this._isAuthSessionMode();
        log(`gnome-osk: enable() starting, ${OSK_BUILD_TAG}, ` +
            `session-mode=${this._sessionModeName}`);
        this._saveConfigId = 0;
        this._predictorLoadId = 0;
        this._predictorReady = false;
        this._sessionModeUpdatedId = 0;
        this._authVisibilityRetryId = 0;
        this._layoutManagerModalId = 0;
        this._layoutManagerModalClosedId = 0;
        this._keyboardInModalLayer = false;
        this._keyboardModalHost = null;
        this._keyboardModalHostDestroyId = 0;
        this._authKeyboardHost = null;
        this._authKeyboardHostDestroyId = 0;
        this._keyboardInAuthHost = false;
        this._modalBridgeGrab = null;
        this._modalBridgePreVisible = undefined;
        this._modalBridgeModalActor = null;
        this._modalHoverTarget = null;
        this._modalHoverLastUs = 0;
        this._modalHoverLastX = null;
        this._modalHoverLastY = null;
        this._shellKeyboardBridgeInstalled = false;
        this._shellKeyboardBridgeManager = null;
        this._shellKeyboardBridgeOriginal = null;
        this._shellKeyboardBridgeWrapper = null;
        try {
            if (Main.sessionMode && Main.sessionMode.connect) {
                this._sessionModeUpdatedId = Main.sessionMode.connect(
                    'updated', () => this._onSessionModeUpdated());
            }
        } catch (_e) {
            this._sessionModeUpdatedId = 0;
        }

        // Manually load stylesheet.css into the Shell theme.  Shell is
        // supposed to auto-load `stylesheet.css` from extension root,
        // but the auto-load can be flaky (or lose to the default theme
        // on specificity).  Loading it ourselves with an explicit call
        // makes sure our rules are registered.
        // Use this.path (string) rather than this.dir (Gio.File) -- the
        // string form is stable across Shell versions and we can build
        // the Gio.File ourselves.  log() hits the journal reliably at
        // MESSAGE level whereas console.log's level varies.
        try {
            const stylesheetPath = GLib.build_filenamev([
                this.path, 'stylesheet.css',
            ]);
            this._stylesheetFile = Gio.File.new_for_path(stylesheetPath);
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const theme = themeContext.get_theme();
            theme.load_stylesheet(this._stylesheetFile);
            log(`gnome-osk: manually loaded stylesheet ${stylesheetPath}`);
        } catch (e) {
            log(`gnome-osk: stylesheet load failed: ${e}`);
            this._stylesheetFile = null;
        }

        // Create a virtual keyboard device at the Clutter/Mutter level.
        // notify_key() events fed through this device are synthesized by
        // Mutter as real keyboard input and routed to whichever window
        // has Wayland seat focus -- which stays put because chrome
        // actors (our keyboard) don't take focus on click.
        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE
        );

        // Load persisted config BEFORE building the keyboard so we
        // can pick the right initial layout.  Config is tiny (a
        // couple of booleans + a layout key), so synchronous load
        // at enable() time is fine.
        this._config = this._loadConfig();
        const initialLayoutKey = LAYOUTS[this._config.layout]
            ? this._config.layout : DEFAULT_LAYOUT_KEY;

        // Build the keyboard widget.
        // - minimize-requested: user hit the minimize button in the
        //   title bar.  Hide the widget but keep everything in memory
        //   so the panel icon can bring it back instantly.
        // - close-requested: user hit the close button.  Fully disable
        //   the extension -- no panel icon, no keyboard, nothing
        //   holding state.  User relaunches via the app grid.
        // - snap-requested / options-requested / help-requested: the
        //   Windows-OSK layout's right-panel keys (Mv Up, Dock,
        //   Mv Dn, Options, Help) fire these instead of raw keycodes;
        //   the extension owns the work-area / menu APIs so it
        //   handles them.
        // Pull the persisted customization record (theme, custom bg,
        // RGB mode, etc.) out of config and hand it to the keyboard
        // constructor so the first paint already uses the right theme
        // instead of flashing default-dark for a frame.
        const initialCustomization = this._config.customization || {};
        const initialUserThemes = this._config.userThemes || {};
        this._keyboard = new OSKKeyboard(this._virtualDevice,
                                         initialLayoutKey,
                                         initialCustomization,
                                         initialUserThemes);
        const keyboardActor = this._keyboard;
        keyboardActor.connect('destroy', () => {
            if (this._keyboard === keyboardActor) {
                this._leaveModalBridge('keyboard-destroyed', false);
                this._keyboard = null;
                this._modalPointerTarget = null;
                this._keyboardInAuthHost = false;
                this._clearCapturedHover();
                this._cancelAuthVisibilityRetry();
            }
        });
        this._keyboard.setAuthMode(this._authSessionMode);
        // Keep the actor hidden until geometry is final.  Otherwise
        // Shell can paint one frame at natural size near the origin
        // before our explicit size/position lands, which looks like a
        // broken launch on slower machines.
        this._keyboard.visible = false;
        this._keyboard.connect('minimize-requested',
            () => this._setVisible(false));
        this._keyboard.connect('close-requested',
            () => this._requestDisable());
        this._keyboard.connect('snap-requested',
            (_kbd, where) => this._snapPosition(where));
        this._keyboard.connect('options-requested',
            () => this._openOptionsMenu());
        this._keyboard.connect('help-requested',
            () => this._showHelp());

        // Size + position the keyboard before exposing it to chrome.
        // Per-layout defaults live in LAYOUTS, then get clamped to
        // the current primary work area so small screens and fractional
        // monitor layouts never spawn an unrecoverable oversized OSK.
        const lay = LAYOUTS[initialLayoutKey];
        const desiredW = (lay && lay.defaultW) || 900;
        const desiredH = (lay && lay.defaultH) || 380;
        const area = _primaryWorkArea();
        const geom = _fitKeyboardRectToWorkArea(
            Math.floor(area.x + (area.width - desiredW) / 2),
            Math.floor(area.y + area.height - desiredH - KEYBOARD_SCREEN_MARGIN),
            desiredW, desiredH, area);
        this._keyboard._applyKeyboardSize(geom.w, geom.h);
        this._keyboard.set_position(geom.x, geom.y);

        // Add to the chrome layer.  Chrome is drawn above all normal
        // windows, doesn't affect struts (doesn't shrink the workarea)
        // when we opt out, and receives pointer clicks.
        // NOTE: GNOME Shell 50 removed the `affectsInputRegion` option
        // (previous versions accepted it; 50 throws on it).  Passing
        // only the options Shell 50 still accepts.
        //
        // Top chrome keeps the OSK visible above normal windows.  In
        // normal desktop sessions we do not reparent or grab around
        // Shell system modals; those paths can block the popup input
        // stack on some GNOME Shell builds.
        this._addKeyboardToChrome('enable');
        this._keyboard._queuePostLayoutRefresh();
        if (this._authSessionMode)
            this._installModalAwareInput();
        else
            this._installShellKeyboardEventBridge();
        this._installModalRaiseHooks();

        // One-line diagnostic to journal so we can see what coords were
        // actually used if the keyboard shows up in a weird spot.
        log(
            `gnome-osk: work area ${area.x},${area.y} ${area.width}x${area.height} ` +
            `-> keyboard at (${geom.x}, ${geom.y}) size ${geom.w}x${geom.h} ` +
            `layout=${initialLayoutKey}`
        );

        this._downloadInFlight = false;
        this._vocabStatusOverride = null;  // transient string shown in
                                            // place of computed status
        // Word prediction is intentionally skipped in GDM/unlock modes:
        // auth prompts do not need suggestions, and avoiding dictionary
        // I/O keeps the login shell light and private.
        this._predictor = null;
        if (!this._authSessionMode) {
            this._predictor = this._createPredictor();
        }
        this._keyboard.setPredictor(this._predictor);
        // `_config.predictionEnabled` is explicitly defaulted to false
        // in _loadConfig, so a missing config file => prediction off.
        this._keyboard.setPredictionEnabled(
            !this._authSessionMode && !!this._config.predictionEnabled);

        // Panel indicator.  Left-click toggles the keyboard, right-click
        // opens a popup populated by _buildIndicatorMenu.  See the
        // OSKIndicator class for how the default menu handling is
        // defused so left-clicks can't accidentally open the menu.
        this._indicator = null;
        if (!this._authSessionMode && Main.panel
            && typeof Main.panel.addToStatusArea === 'function') {
            this._indicator = new OSKIndicator(this);
            Main.panel.addToStatusArea(
                'gnome-osk-toggle', this._indicator, 0, 'right'
            );
            this._buildIndicatorMenu();
        } else if (this._authSessionMode) {
            log('gnome-osk: auth mode: skipping panel indicator; ' +
                'keyboard auto-shows');
        }

        // Auth sessions must always start visible. Keep this path close
        // to the older working login-screen behavior: top chrome +
        // visible actor, with one idle restore after Shell has finished
        // the current greeter layout pass.
        if (this._authSessionMode) {
            this._restoreAuthKeyboard('enable-auth');
            this._scheduleAuthVisibilityRetry('enable');
        } else {
            // Respect the "Show keyboard on login" toggle from the
            // indicator menu in the normal user session.  Default
            // (showOnStartup: true) preserves the pre-existing
            // behaviour: keyboard visible after login.
            this._setVisible(this._config.showOnStartup !== false);
        }

        if (this._predictor)
            this._schedulePredictorLoad();

        // Export a small D-Bus interface so the .desktop launcher
        // (and any external script) can ask the extension to show /
        // hide / toggle the keyboard from outside the Shell process.
        // Wrapped because export() can fail on some Mutter builds and
        // we don't want a D-Bus glitch to take down the whole enable.
        if (!this._authSessionMode) {
            try { this._exportDBus(); }
            catch (e) { log(`gnome-osk: dbus export failed: ${e}`); }
        }
    }

    // Register an io.linuxosk.OSK interface on /io/linuxosk/OSK using
    // the Shell's session-bus connection.  Callers reach it via:
    //   gdbus call --session --dest org.gnome.Shell \
    //     --object-path /io/linuxosk/OSK \
    //     --method io.linuxosk.OSK.Toggle
    // We deliberately don't claim our own bus name -- claiming a name
    // requires async bus_own_name plumbing and the Shell already owns
    // org.gnome.Shell, so piggybacking on that connection is enough
    // for a single-method launcher contract.
    _exportDBus() {
        const xml = `
<node>
  <interface name="io.linuxosk.OSK">
    <method name="Show"/>
    <method name="Hide"/>
    <method name="Toggle"/>
  </interface>
</node>`;
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(xml, {
            Show:   () => this._setVisible(true),
            Hide:   () => this._setVisible(false),
            Toggle: () => {
                if (!this._keyboard) return;
                this._setVisible(!this._keyboard.visible);
            },
        });
        this._dbusImpl.export(Gio.DBus.session, '/io/linuxosk/OSK');
    }

    _unexportDBus() {
        if (!this._dbusImpl) return;
        try { this._dbusImpl.unexport(); } catch (_e) { }
        this._dbusImpl = null;
    }

    _createPredictor() {
        const predictor = new WordPredictor();
        predictor.setWordlistPaths([
            _oskUserWordlistPath(),
            GLib.build_filenamev([this.path, 'wordlist.txt']),
        ]);
        predictor.setUserDataPath(_oskUserDataPath());
        predictor.setSeedBigramsPaths([
            _oskUserSeedBigramsPath(),
            GLib.build_filenamev([this.path, 'seed-bigrams.txt']),
        ]);
        return predictor;
    }

    _schedulePredictorLoad() {
        if (!this._predictor || this._predictorLoadId) return;
        this._predictorLoadId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._predictorLoadId = 0;
                this._loadPredictorNow();
                return GLib.SOURCE_REMOVE;
            });
    }

    _loadPredictorNow() {
        if (!this._predictor || this._predictorReady) return;
        try {
            this._predictor.loadBaseDictionary();
            this._predictor.loadSeedBigrams();
            this._predictor.loadUserData();
            this._predictorReady = true;
            const s = this._predictor.stats();
            log(`gnome-osk: predictor ready (base=${s.baseWords}, ` +
                `learned=${s.learnedWords}, bigrams=${s.bigramPairs}, ` +
                `seedBigrams=${s.seedBigramPairs})`);
            if (this._keyboard && this._keyboard._predictionEnabled)
                this._keyboard._refreshPredictions();
            this._refreshVocabStatus();
        } catch (e) {
            log(`gnome-osk: predictor init failed: ${e}`);
        }
    }

    _buildIndicatorMenu() {
        if (!this._indicator) return;
        // OSKIndicator keeps its real menu in _rcMenu (see the class
        // comment): this._indicator.menu is a PopupDummyMenu so the
        // parent's default event handler can't pop it on left-click.
        const menu = this._indicator.getRightClickMenu();

        const toggleItem = new PopupMenu.PopupMenuItem('Toggle keyboard');
        toggleItem.connect('activate',
            () => this._setVisible(!this._keyboard.visible));
        menu.addMenuItem(toggleItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // -- Position ------------------------------------------------
        // Snap to top / middle / bottom of the screen.  Easier and
        // more precise than dragging for mouse-only users who may
        // struggle to aim the tiny title bar strip.
        const positionItem = new PopupMenu.PopupSubMenuMenuItem('Position');
        const positions = [
            ['Top of screen',    'top'],
            ['Middle of screen', 'middle'],
            ['Bottom of screen', 'bottom'],
        ];
        for (const [label, pos] of positions) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._snapPosition(pos));
            positionItem.menu.addMenuItem(item);
        }
        menu.addMenuItem(positionItem);

        // -- Lock position ------------------------------------------
        // Mouse-only users reaching for the minimize / close buttons
        // can easily land on the title-bar label and kick off a drag.
        // Locking disables the drag entirely until toggled back on.
        const lockItem = new PopupMenu.PopupSwitchMenuItem(
            'Lock position (disable drag)', false);
        lockItem.connect('toggled', (_item, state) => {
            if (this._keyboard) this._keyboard.setDragLocked(state);
        });
        menu.addMenuItem(lockItem);

        // -- Open menu on hover -------------------------------------
        // Off by default: the panel icon opens its menu only on
        // right-click, and left-click toggles the keyboard.  Users
        // who find right-clicking awkward (or just prefer it) can
        // flip this on and get the menu as soon as the pointer
        // enters the icon.  Outside-click / Escape still close it.
        const hoverItem = new PopupMenu.PopupSwitchMenuItem(
            'Open menu on hover', false);
        hoverItem.connect('toggled', (_item, state) => {
            if (this._indicator) this._indicator.setHoverOpens(state);
        });
        menu.addMenuItem(hoverItem);

        // -- Show keyboard on login ---------------------------------
        // Controls whether the keyboard widget auto-shows when the
        // shell starts / extension loads.  On by default so an
        // upgrade from a pre-toggle build preserves behaviour.  Off
        // means "only the panel indicator loads at login; click it
        // to bring the keyboard up" -- useful on desktops where
        // most sessions don't need an on-screen keyboard and the
        // user only occasionally brings it up.
        //
        // The indicator itself is always loaded -- this setting has
        // no way to hide it, because without it there'd be no way
        // to bring the keyboard back.
        const initialShowOnStartup =
            this._config && this._config.showOnStartup !== false;
        const startupItem = new PopupMenu.PopupSwitchMenuItem(
            'Show keyboard on login', initialShowOnStartup);
        startupItem.connect('toggled', (_item, state) => {
            this._config = this._config || {};
            this._config.showOnStartup = !!state;
            this._saveConfig();
        });
        menu.addMenuItem(startupItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // -- Word prediction submenu --------------------------------
        // Groups everything related to the word-prediction feature so
        // the top level of the menu stays readable.  Four rows:
        //   1. Enable switch (persisted to config.json)
        //   2. Vocabulary status line (read-only info)
        //   3. Download vocabulary button (runs curl/wget async)
        //   4. Clear learned words (wipes user-boost / bigrams only)
        //
        // The whole feature is OFF by default; a user who's never
        // opened this submenu sees no prediction bar, no disk writes,
        // no behaviour change from the keyboard they already know.
        const wpItem = new PopupMenu.PopupSubMenuMenuItem('Word prediction');
        const wpMenu = wpItem.menu;

        const initialPredictOn = !!(this._config
            && this._config.predictionEnabled);
        this._wpEnableItem = new PopupMenu.PopupSwitchMenuItem(
            'Enable word prediction', initialPredictOn);
        this._wpEnableItem.connect('toggled', (_item, state) => {
            if (this._keyboard) this._keyboard.setPredictionEnabled(state);
            if (state && this._predictor && !this._predictorReady)
                this._schedulePredictorLoad();
            this._config = this._config || {};
            this._config.predictionEnabled = !!state;
            this._saveConfig();
        });
        wpMenu.addMenuItem(this._wpEnableItem);

        wpMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Prediction-data status line.  Non-reactive PopupMenuItem is
        // GNOME Shell's idiomatic "label inside a menu" -- `.label`
        // gives us the inner St.Label whose text we can update after
        // a download completes.  Reports BOTH the wordlist state and
        // the seed-bigrams state on one line.
        this._wpStatusItem = new PopupMenu.PopupMenuItem(
            'Prediction data: checking...');
        this._wpStatusItem.reactive = false;
        this._wpStatusItem.can_focus = false;
        wpMenu.addMenuItem(this._wpStatusItem);

        // Download / refresh prediction data.  Runs two HTTP fetches
        // in sequence (wordlist then seed bigrams).  Label flips
        // between "Download..." and "Re-download..." based on whether
        // EITHER file is present; during a fetch it becomes
        // "Downloading..." and goes non-reactive.
        this._wpDownloadItem = new PopupMenu.PopupMenuItem(
            'Download prediction data');
        this._wpDownloadItem.connect('activate', () => {
            this._onDownloadVocabularyClicked();
        });
        wpMenu.addMenuItem(this._wpDownloadItem);

        wpMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Explicit escape hatch: wipe the user-learned unigram boosts
        // and bigram counts without touching the base dictionary.
        // Useful if a typo got reinforced, or for privacy before
        // sharing the machine.
        const clearItem = new PopupMenu.PopupMenuItem('Clear learned words');
        clearItem.connect('activate', () => {
            if (this._predictor) {
                this._predictor.resetLearning();
                log('gnome-osk: predictor learning reset by user');
            }
        });
        wpMenu.addMenuItem(clearItem);

        menu.addMenuItem(wpItem);

        // Populate the status line now that both items exist.  This
        // also sets the download-button label to "Re-download..." if
        // a wordlist is already present.
        this._refreshVocabStatus();

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // -- Opacity -------------------------------------------------
        // Adwaita's accent blue shows through well at 70% so that's
        // a reasonable "low".
        const opacityItem = new PopupMenu.PopupSubMenuMenuItem('Opacity');
        const opacities = [
            ['Solid (100%)',       255],
            ['High (85%)',         217],
            ['Medium (70%)',       178],
            ['Low (50%)',          128],
        ];
        for (const [label, val] of opacities) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => {
                if (this._keyboard) this._keyboard.opacity = val;
            });
            opacityItem.menu.addMenuItem(item);
        }
        menu.addMenuItem(opacityItem);

        // -- Size ----------------------------------------------------
        // Heights are picked so keys end up at ~40 / 46 / 60 px
        // respectively (key height scales linearly with keyboard
        // height after the vertical chrome is subtracted).
        const sizeItem = new PopupMenu.PopupSubMenuMenuItem('Size');
        const sizes = [
            ['Small  (720x340)',   720, 340],
            ['Medium (900x380)',   900, 380],
            ['Large  (1100x460)', 1100, 460],
        ];
        for (const [label, w, h] of sizes) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => {
                if (this._keyboard) this._keyboard.setConstrainedSize(w, h);
            });
            sizeItem.menu.addMenuItem(item);
        }
        menu.addMenuItem(sizeItem);

        // -- Layout --------------------------------------------------
        // Switch between registered key arrangements.  Each entry
        // also resizes the keyboard to the layout's default
        // dimensions (Windows OSK needs more horizontal room than
        // Mobile).  Selection is persisted in config.json so the
        // next session boots into the chosen layout.  The active
        // entry gets "(active)" appended so the user can see at a
        // glance which one is live.
        const layoutItem = new PopupMenu.PopupSubMenuMenuItem('Layout');
        this._layoutMenuItems = {};   // keyed by layout key for
                                      // _refreshLayoutMenu()
        for (const [key, lay] of Object.entries(LAYOUTS)) {
            const item = new PopupMenu.PopupMenuItem(lay.label);
            item.connect('activate', () => this._selectLayout(key));
            layoutItem.menu.addMenuItem(item);
            this._layoutMenuItems[key] = item;
        }
        menu.addMenuItem(layoutItem);
        this._refreshLayoutMenu();

        // -- Key repeat ---------------------------------------------
        // For users with hand tremor or limited fine motor control,
        // hold-to-repeat can fire unwanted extra keypresses if the
        // cursor lingers.  "Off" disables repeat entirely; Slow gives
        // a generous delay and slow cadence.  [delay_ms, interval_ms]
        const repeatItem = new PopupMenu.PopupSubMenuMenuItem('Key repeat');
        const repeatSpeeds = [
            ['Off',              0,   0  ],
            ['Slow',             800, 120],
            ['Normal (default)', 450, 35 ],
            ['Fast',             250, 20 ],
        ];
        for (const [label, delay, interval] of repeatSpeeds) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => {
                if (this._keyboard)
                    this._keyboard.setRepeatSpeed(delay, interval);
            });
            repeatItem.menu.addMenuItem(item);
        }
        menu.addMenuItem(repeatItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // -- Customize... -------------------------------------------
        // Opens a standalone window with every tweakable setting --
        // themes, per-element colors, RGB lighting, custom
        // background, opacity, etc.  A full window is easier to
        // navigate than a nested submenu and works identically on
        // stock GNOME and heavily themed Shell setups, so every
        // customization is in one place instead of scattered across
        // half-a-dozen dropdown submenus.
        const customItem = new PopupMenu.PopupMenuItem('Customize...');
        customItem.connect('activate',
            () => this._openCustomizationWindow());
        menu.addMenuItem(customItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const closeItem = new PopupMenu.PopupMenuItem('Close (disable extension)');
        closeItem.connect('activate', () => this._requestDisable());
        menu.addMenuItem(closeItem);
    }

    // Capture the keyboard's current customization + user themes into
    // this._config and queue a config write.  Slider drags can fire a
    // lot of updates; batching disk writes keeps the Shell main loop
    // focused on rendering the live preview instead of JSON I/O.
    _persistCustomization() {
        if (!this._keyboard) return;
        this._config = this._config || {};
        this._config.customization = this._keyboard.getCustomization();
        this._config.userThemes = this._keyboard.getUserThemes();
        this._scheduleConfigSave();
    }

    _scheduleConfigSave(delayMs = 350) {
        if (this._saveConfigId) return;
        this._saveConfigId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE, Math.max(1, delayMs | 0),
            () => {
                this._saveConfigId = 0;
                this._saveConfig();
                return GLib.SOURCE_REMOVE;
            });
    }

    _flushConfigSave() {
        _clearSource(this, '_saveConfigId');
        this._saveConfig();
    }

    // ---- Customize window ----------------------------------------
    //
    // Chrome-level, non-modal floating window that replaces the old
    // ModalDialog implementation.  Being non-modal is critical: the
    // user can keep typing on the OSK while they tweak colors, and
    // the OSK is explicitly raised above the window so live-preview
    // is visible at all times (the old modal covered the OSK).
    //
    // Built by directly adding an St.BoxLayout to Main.layoutManager's
    // chrome layer, same mechanism the keyboard itself uses.  Has a
    // custom title bar with drag + close, a scrollable body with
    // section builders, and an inline color-picker panel (HSV wheel
    // + hex entry) that opens when the user clicks a color's
    // "Change..." button.

    _openCustomizationWindow() {
        // If the window exists, just show + raise it.  We keep it in
        // memory across open/close cycles so repeated openings are
        // instant and the scroll position is preserved.
        if (this._customWindow) {
            this._customWindow.show();
            this._raiseKeyboardAboveCustomize();
            this._refreshAllControls();
            return;
        }

        const win = this._buildCustomizeWindow();
        this._customWindow = win;

        // Add to Main's chrome layer -- same layer the OSK itself
        // lives in -- so it's above normal windows but can be
        // z-ordered against the OSK.  affectsStruts:false keeps it
        // from shrinking the work area.
        Main.layoutManager.addChrome(win, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        // Size + position.  Positioned top-centre of the work area so
        // it doesn't typically overlap the OSK's default bottom
        // position.  User can drag it from the title bar if it gets
        // in the way, and resize from the bottom-right grip.
        //
        // Default height is "as tall as the work area allows" up to a
        // generous cap, so all sections (themes, colours, RGB, ...)
        // are visible without scrolling on common monitor sizes.
        const pIdx = Main.layoutManager.primaryIndex;
        const area = Main.layoutManager.getWorkAreaForMonitor(pIdx);
        const W = 720;
        const H = Math.max(
            CUSTOMIZE_WINDOW_MIN_HEIGHT,
            Math.min(area.height - 60, 1000));
        win.set_size(W, H);
        win.set_position(
            Math.floor(area.x + (area.width - W) / 2),
            Math.floor(area.y + 30));

        // Raise the OSK above the Customize window so live preview is
        // always visible.  Without this the Customize window paints
        // on top because it was added to chrome most recently.
        this._raiseKeyboardAboveCustomize();
        this._refreshAllControls();
    }

    _closeCustomizationWindow() {
        if (!this._customWindow) return;
        // Belt-and-braces save: every individual change already
        // persists immediately, but this catches any in-flight
        // edit (e.g. an unfinished drag the user abandoned by
        // hitting Close) so the latest user theme state always
        // makes it to disk.
        try {
            this._persistCustomization();
            this._flushConfigSave();
        }
        catch (e) { log(`gnome-osk: persist on close failed: ${e}`); }
        // If we're mid-picker the window is parented under
        // window_group instead of chrome; remove from whichever
        // parent it currently has.
        const parent = this._customWindow.get_parent();
        if (this._customWinLowered && parent) {
            try { parent.remove_child(this._customWindow); }
            catch (_e) { /* best-effort */ }
            this._customWinLowered = false;
            this._customWinSaved = null;
        } else {
            try { Main.layoutManager.removeChrome(this._customWindow); }
            catch (_e) { /* already gone */ }
        }
        try { this._customWindow.destroy(); }
        catch (_e) { /* already destroyed */ }
        this._customWindow = null;
        this._controlRefreshers = null;
    }

    // Put the OSK on top of the Customize window by re-ordering the
    // children of their shared parent (Main.layoutManager.uiGroup).
    // `set_child_above_sibling(actor, null)` raises `actor` to the
    // top of its parent's child list, which is how Shell's GL layer
    // order works.  Guard against missing APIs so a future Shell
    // renaming doesn't crash the whole open path.
    _raiseKeyboardAboveCustomize() {
        if (!this._keyboard) return;
        const parent = this._keyboard.get_parent();
        if (parent && typeof parent.set_child_above_sibling === 'function') {
            try { parent.set_child_above_sibling(this._keyboard, null); }
            catch (_e) { /* ignore; visual glitch only */ }
        }
        if (this._keyboard._syncBackgroundLayer)
            this._keyboard._syncBackgroundLayer();
    }

    // Demote the customize window into `global.window_group` so the
    // file picker window naturally paints above it.  Used while any
    // file picker (xdg-portal, zenity, kdialog) is open.
    //
    // Why window_group specifically:
    //
    //   * Chrome (uiGroup) paints ABOVE every Mutter window -- an
    //     actor parked there would hide the picker.
    //   * bottom_window_group paints BELOW every window, including
    //     existing user apps (the terminal that ran install.sh,
    //     Firefox, whatever) -- the customize window gets buried
    //     under those and LOOKS closed even though it isn't.  That
    //     was the "still closing the customize window" symptom.
    //   * window_group is the actual stacking layer Mutter uses for
    //     every regular window.  A Clutter actor inserted at the
    //     TOP of window_group paints above every currently-visible
    //     window.  When the file picker then opens -- itself a
    //     regular focused window -- Mutter's own restacking raises
    //     the picker above our actor, so the picker lands on top,
    //     the customize window sits right underneath (still fully
    //     visible), and every other app is below both.
    //
    // This is the simplest variant that keeps the customize window
    // visible throughout the picker's lifetime AND lets the picker
    // paint on top of it.  The actor stays a Clutter actor -- Mutter
    // doesn't manage it as a window -- so input still works via
    // Clutter event dispatch.
    //
    // Hard invariant: this function NEVER destroys, closes, or hides
    // the customize window.  It's a z-order move only.  Every
    // failure path ends by re-showing the actor against a valid
    // parent.  Matching contract in `_raiseCustomWindowBack`.
    _lowerCustomWindowForPicker() {
        if (!this._customWindow || this._customWinLowered) return;
        const win = this._customWindow;
        const x = win.get_x();
        const y = win.get_y();
        const w = win.get_width();
        const h = win.get_height();
        this._customWinSaved = { x, y, w, h };

        const wg = global.window_group;
        if (!wg) {
            log('gnome-osk: lower: no window_group; staying in chrome');
            return;
        }

        this._customWinLowered = true;
        try {
            Main.layoutManager.removeChrome(win);
        } catch (e) {
            log(`gnome-osk: lower: removeChrome failed: ${e}`);
            this._customWinLowered = false;
            this._customWinSaved = null;
            try { win.show(); } catch (_e) { }
            return;
        }

        try {
            wg.add_child(win);
            // Raise to the very top of window_group's child list.
            // When the picker opens, Mutter restacks it above us
            // naturally -- we don't need to police ordering after
            // this initial placement.
            if (typeof wg.set_child_above_sibling === 'function') {
                try { wg.set_child_above_sibling(win, null); }
                catch (_e) { /* best-effort */ }
            }
            win.set_position(x, y);
            win.set_size(w, h);
            win.show();
            log('gnome-osk: lower: moved customize into window_group (top)');
        } catch (e) {
            log(`gnome-osk: lower: add_child failed: ${e}`);
            this._customWinLowered = false;
            // Put it back in chrome so it's never lost.
            try {
                Main.layoutManager.addChrome(win, {
                    affectsStruts: false,
                    trackFullscreen: false,
                });
                win.set_position(x, y);
                if (w > 0 && h > 0) win.set_size(w, h);
                win.show();
            } catch (_e) { }
        }
    }

    // Reverse of `_lowerCustomWindowForPicker`: pull the actor back
    // out of the lower layer and re-add it to chrome.  Safe to call
    // unconditionally -- no-op when the window wasn't lowered, and
    // idempotent against portal Response / safety-timer double-fire.
    //
    // Hard invariant (matches `_lower..`): NEVER destroys the
    // customize window.  If re-adding to chrome fails, the window
    // stays parented to whatever host we demoted it to, so it
    // remains on-screen -- just at the z-order it already had.
    _raiseCustomWindowBack() {
        if (!this._customWindow || !this._customWinLowered) return;
        const win = this._customWindow;
        this._customWinLowered = false;
        const saved = this._customWinSaved || { x: 0, y: 0, w: 0, h: 0 };
        this._customWinSaved = null;

        const demotedParent = win.get_parent();
        let removed = false;
        if (demotedParent) {
            try {
                demotedParent.remove_child(win);
                removed = true;
            } catch (e) {
                log(`gnome-osk: raise: remove_child failed: ${e}`);
            }
        }
        try {
            Main.layoutManager.addChrome(win, {
                affectsStruts: false,
                trackFullscreen: false,
            });
            win.set_position(saved.x, saved.y);
            if (saved.w > 0 && saved.h > 0) win.set_size(saved.w, saved.h);
            win.show();
            log('gnome-osk: raise: moved customize back into chrome');
        } catch (e) {
            log(`gnome-osk: raise: addChrome failed: ${e}`);
            // addChrome failed AND we already removed from the demoted
            // host -- the window is now orphaned.  Put it back in the
            // demoted host as a last-resort so the user still sees it.
            if (removed && demotedParent) {
                try {
                    demotedParent.add_child(win);
                    win.set_position(saved.x, saved.y);
                    if (saved.w > 0 && saved.h > 0)
                        win.set_size(saved.w, saved.h);
                    win.show();
                    log('gnome-osk: raise: reverted to demoted host after addChrome failure');
                } catch (e2) {
                    log(`gnome-osk: raise: reparent fallback failed: ${e2}`);
                }
            }
        }
        this._raiseKeyboardAboveCustomize();
    }

    _refreshAllControls() {
        if (!this._controlRefreshers) return;
        for (const fn of this._controlRefreshers) {
            try { fn(); }
            catch (e) { log(`gnome-osk: refresher threw: ${e}`); }
        }
    }

    // Build the full Customize window actor tree.  Returns the root
    // St.BoxLayout ready for Main.layoutManager.addChrome.
    _buildCustomizeWindow() {
        this._controlRefreshers = [];
        // Target path of the currently-open inline color picker.
        // null means the picker is collapsed.  Set by _openPickerFor;
        // the picker panel itself is a member of the Customize window
        // created once and shown/hidden on demand.
        this._pickerTarget = null;

        const root = new St.BoxLayout({
            vertical: true,
            reactive: true,
            track_hover: true,
            style_class: 'osk-customize-window',
        });

        // Title bar.  Drag on the label to move the window; close
        // button on the right to dismiss.  Mirrors the OSK's own
        // title-bar pattern so it reads as part of the same app.
        root.add_child(this._buildCustomizeTitleBar(root));

        // Horizontal split: scrollable body on the left, inline
        // color picker panel on the right (hidden by default).
        const split = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
        });
        split.spacing = 0;
        root.add_child(split);

        // Scroll view with the main body.
        const scroll = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            style_class: 'osk-customize-scroll',
        });

        const body = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'osk-customize-body',
        });
        body.spacing = 16;
        this._scrollBody = body;

        try {
            if (typeof scroll.set_child === 'function') scroll.set_child(body);
            else if (typeof scroll.add_actor === 'function') scroll.add_actor(body);
            else scroll.child = body;
        } catch (e) {
            log(`gnome-osk: scrollview add_actor: ${e}`);
            try { scroll.child = body; } catch (_e) { }
        }
        split.add_child(scroll);

        // Inline color picker.  Lives on the right-hand side of the
        // split; hidden until the user clicks a "Change..." button.
        const picker = this._buildInlineColorPicker();
        this._picker = picker;
        picker.visible = false;
        split.add_child(picker);

        // Footer with bulk actions.  Kept as plain pills so they
        // match the rest of the window visually.
        const footer = new St.BoxLayout({
            x_expand: true,
            style_class: 'osk-customize-footer',
        });
        footer.spacing = 8;

        const resetColorsBtn = this._makePillButton('Reset colors', false);
        resetColorsBtn.connect('clicked', () => {
            if (!this._keyboard) return;
            this._keyboard.clearCustomColors();
            this._persistCustomization();
            this._refreshAllControls();
        });
        footer.add_child(resetColorsBtn);

        const resetAllBtn = this._makePillButton('Reset everything', false);
        resetAllBtn.connect('clicked', () => {
            if (!this._keyboard) return;
            this._keyboard.resetCustomization(false);
            this._persistCustomization();
            this._refreshAllControls();
        });
        footer.add_child(resetAllBtn);

        const spacer = new St.Widget({ x_expand: true });
        footer.add_child(spacer);

        const closeBtn = this._makePillButton('Close', true);
        closeBtn.connect('clicked', () => this._closeCustomizationWindow());
        footer.add_child(closeBtn);

        // Resize grip in the bottom-right corner.  Drag to live-resize
        // the window the same way a real GNOME app does.  Closure
        // captures the window root so we don't need a separate class.
        const grip = this._makeWindowResizeGrip(root);
        footer.add_child(grip);

        root.add_child(footer);

        // Build each section.
        this._buildWindowThemes(body);
        this._buildWindowGeneral(body);
        this._buildWindowBackground(body);
        this._buildWindowColors(body);
        this._buildWindowRgb(body);

        return root;
    }

    // Bottom-right resize grip for the Customize window.  Mirrors the
    // OSK keyboard's own grip behaviour: drag with the left mouse
    // button to resize, with a stage-level pointer grab so motion
    // events keep firing once the cursor leaves the grip.  Min size
    // is enforced via CUSTOMIZE_WINDOW_MIN_*.
    _makeWindowResizeGrip(target) {
        const grip = new St.Button({
            label: '\u2198',   // Diagonal resize arrow
            can_focus: false,
            reactive: true,
            track_hover: true,
            style_class: 'osk-customize-resize-grip',
        });

        let startX = null, startY = null;
        let origW = 0, origH = 0;
        let stageGrab = null;

        grip.connect('button-press-event', (_a, ev) => {
            if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const [x, y] = ev.get_coords();
            startX = x; startY = y;
            origW = target.width;
            origH = target.height;
            try {
                if (global.stage.grab) stageGrab = global.stage.grab(grip);
            } catch (_e) { stageGrab = null; }
            return Clutter.EVENT_STOP;
        });
        grip.connect('motion-event', (_a, ev) => {
            if (startX === null) return Clutter.EVENT_PROPAGATE;
            const [x, y] = ev.get_coords();
            const newW = Math.max(
                CUSTOMIZE_WINDOW_MIN_WIDTH,
                Math.round(origW + (x - startX)));
            const newH = Math.max(
                CUSTOMIZE_WINDOW_MIN_HEIGHT,
                Math.round(origH + (y - startY)));
            target.set_size(newW, newH);
            return Clutter.EVENT_STOP;
        });
        grip.connect('button-release-event', () => {
            startX = null;
            startY = null;
            if (stageGrab) {
                try { stageGrab.dismiss(); } catch (_e) { }
                stageGrab = null;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return grip;
    }

    _buildCustomizeTitleBar(win) {
        const bar = new St.BoxLayout({
            reactive: true,
            x_expand: true,
            style_class: 'osk-customize-titlebar',
        });

        // Drag label fills horizontally; mouse-press/motion on it
        // moves the whole window.  Same pattern as OSKTitleBar.
        const titleLbl = new St.Label({
            text: 'Customize Nome - Onscreen Keyboard',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            style_class: 'osk-customize-title',
        });

        // Drag state kept on the closure so the handlers don't have
        // to read-write an instance field.
        let dragStart = null;
        let origPos = null;
        let grab = null;
        titleLbl.connect('button-press-event', (_a, ev) => {
            if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const [x, y] = ev.get_coords();
            dragStart = [x, y];
            origPos = [win.get_x(), win.get_y()];
            try {
                if (global.stage.grab) grab = global.stage.grab(titleLbl);
            } catch (_e) { grab = null; }
            return Clutter.EVENT_STOP;
        });
        titleLbl.connect('motion-event', (_a, ev) => {
            if (!dragStart) return Clutter.EVENT_PROPAGATE;
            const [x, y] = ev.get_coords();
            win.set_position(
                Math.round(origPos[0] + (x - dragStart[0])),
                Math.round(origPos[1] + (y - dragStart[1])));
            return Clutter.EVENT_STOP;
        });
        titleLbl.connect('button-release-event', () => {
            dragStart = null; origPos = null;
            if (grab) { try { grab.dismiss(); } catch (_e) { } grab = null; }
            return Clutter.EVENT_PROPAGATE;
        });
        bar.add_child(titleLbl);

        // Subtle hint next to the title explaining that the OSK is
        // still live during customization.  Two-line text would look
        // cramped; one short sentence fits fine beside the drag label.
        const hint = new St.Label({
            text: 'Live preview - drag here to move',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'osk-customize-title-hint',
        });
        bar.add_child(hint);

        const closeBtn = new St.Button({
            label: '\u00d7',
            can_focus: true,
            reactive: true,
            track_hover: true,
            style_class: 'osk-customize-close',
        });
        closeBtn.connect('clicked', () => this._closeCustomizationWindow());
        bar.add_child(closeBtn);

        return bar;
    }

    // ---- Customize window: section builders ---------------------

    // Theme picker: nice card layout, one card per available theme
    // (built-in or user-created).  Each card shows the theme name,
    // a flag "built-in" or "custom", and a little row of color
    // swatches previewing the theme's key colors.  Clicking a card
    // switches to that theme.  User-created themes get a delete
    // button on hover.
    _buildWindowThemes(parent) {
        this._addWindowSection(parent, 'Themes');
        const sub = new St.Label({
            text: 'Pick a theme, or create a custom one by editing any color below.',
            style_class: 'osk-customize-theme-subtitle',
        });
        parent.add_child(sub);

        const gridWrap = new St.BoxLayout({ vertical: true, x_expand: true });
        gridWrap.spacing = 8;
        parent.add_child(gridWrap);

        this._themeCards = {};
        this._themeGridWrap = gridWrap;

        // Build initial cards.  Subsequent calls to refresh rebuild
        // the grid in case the user added / removed a theme.
        const buildGrid = () => this._rebuildThemeGrid();
        buildGrid();
        this._controlRefreshers.push(buildGrid);
    }

    _rebuildThemeGrid() {
        const wrap = this._themeGridWrap;
        if (!wrap) return;
        // Destroy existing cards.
        for (const child of wrap.get_children()) {
            try { child.destroy(); } catch (_e) { }
        }
        this._themeCards = {};
        if (!this._keyboard) return;

        const all = this._keyboard.listAllThemes();
        const activeId = this._keyboard.getCustomization().themeId;

        // Arrange in rows of 3 cards.
        const PER_ROW = 3;
        let row = null;
        for (let i = 0; i < all.length; i++) {
            if (i % PER_ROW === 0) {
                row = new St.BoxLayout({ x_expand: true });
                row.spacing = 10;
                wrap.add_child(row);
            }
            const { id, label, builtIn } = all[i];
            const card = this._buildThemeCard(id, label, builtIn, id === activeId);
            row.add_child(card);
            this._themeCards[id] = card;
        }
        // Pad the last row with an invisible spacer so cards align.
        if (row) {
            const fill = (all.length % PER_ROW);
            if (fill > 0) {
                for (let j = fill; j < PER_ROW; j++) {
                    const spacer = new St.Widget({ x_expand: true });
                    row.add_child(spacer);
                }
            }
        }
    }

    _buildThemeCard(id, label, builtIn, active) {
        const card = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            reactive: true,
            track_hover: true,
            can_focus: true,
        });
        card.spacing = 6;
        const applyCardStyle = (isActive) => {
            card.set_style(
                'background-color: rgba(255,255,255,0.05);' +
                'border: 2px solid ' +
                    (isActive ? '#3584e4' : 'rgba(255,255,255,0.12)') + ';' +
                'border-radius: 8px;' +
                'padding: 8px 10px;' +
                'min-width: 180px;');
        };
        applyCardStyle(active);
        card.connect('notify::hover', () => {
            card.set_style(
                'background-color: ' + (card.hover
                    ? 'rgba(255,255,255,0.09)'
                    : 'rgba(255,255,255,0.05)') + ';' +
                'border: 2px solid ' +
                    (active ? '#3584e4' : 'rgba(255,255,255,0.18)') + ';' +
                'border-radius: 8px;' +
                'padding: 8px 10px;' +
                'min-width: 180px;');
        });

        // Header row: name (left) + built-in/custom tag + delete (user).
        const head = new St.BoxLayout({ x_expand: true });
        head.spacing = 6;
        const nameLbl = new St.Label({
            text: label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        nameLbl.set_style('color: #ffffff; font-weight: bold; font-size: 13px;');
        head.add_child(nameLbl);
        const tagLbl = new St.Label({
            text: builtIn ? 'built-in' : 'custom',
            y_align: Clutter.ActorAlign.CENTER,
        });
        tagLbl.set_style(
            'color: rgba(255,255,255,0.55);' +
            'font-size: 10px;' +
            `background-color: rgba(${builtIn ? '53,132,228' : '166,112,232'},0.25);` +
            'border-radius: 8px;' +
            'padding: 1px 8px;');
        head.add_child(tagLbl);
        card.add_child(head);

        // Swatch preview row: 6 key colors from the theme.
        const sw = new St.BoxLayout({ x_expand: true });
        sw.spacing = 4;
        const sourceTheme = _lookupTheme(id,
            this._keyboard && this._keyboard._userThemes);
        const previewSlots = sourceTheme ? [
            sourceTheme.keyboard && sourceTheme.keyboard.bg,
            sourceTheme.key && sourceTheme.key.bg,
            sourceTheme.key && sourceTheme.key.text,
            sourceTheme.keyPressed && sourceTheme.keyPressed.bg,
            sourceTheme.keyArmed && sourceTheme.keyArmed.bg,
            sourceTheme.keyLocked && sourceTheme.keyLocked.bg,
        ] : [];
        for (const c of previewSlots) {
            const chip = new St.Widget({ y_expand: false });
            chip.set_style(
                `background-color: ${c || '#333333'};` +
                'border: 1px solid rgba(255,255,255,0.2);' +
                'border-radius: 3px;' +
                'min-width: 22px; min-height: 14px;');
            sw.add_child(chip);
        }
        card.add_child(sw);

        // Action row: "Select" + optional "Rename"/"Delete" (user themes).
        const actions = new St.BoxLayout({ x_expand: true });
        actions.spacing = 6;

        const selectBtn = this._makePillButton(
            active ? 'Active' : 'Select', active);
        selectBtn.connect('clicked', () => {
            if (!this._keyboard) return;
            this._keyboard.setTheme(id);
            this._persistCustomization();
            this._refreshAllControls();
        });
        actions.add_child(selectBtn);

        if (!builtIn) {
            const renameBtn = this._makePillButton('Rename', false);
            renameBtn.connect('clicked', () => {
                this._promptModal(
                    'Rename theme',
                    'Enter a new name for this custom theme.',
                    label,
                    (text) => {
                        if (!this._keyboard) return;
                        const newLabel = (text || '').trim();
                        if (!newLabel) return;
                        this._keyboard.renameUserTheme(id, newLabel);
                        this._persistCustomization();
                        this._refreshAllControls();
                    });
            });
            actions.add_child(renameBtn);

            const delBtn = this._makePillButton('Delete', false);
            delBtn.connect('clicked', () => {
                if (!this._keyboard) return;
                this._keyboard.deleteUserTheme(id);
                this._persistCustomization();
                this._refreshAllControls();
            });
            actions.add_child(delBtn);
        }

        card.add_child(actions);

        return card;
    }

    _buildWindowGeneral(parent) {
        this._addWindowSection(parent, 'Keyboard chrome');
        this._addWindowCheckboxRow(parent, 'Show OSK title',
            () => this._keyboard
                && this._keyboard.getCustomization().showOskTitle !== false,
            (val) => {
                this._keyboard.setOskTitleVisible(val);
                this._persistCustomization();
            });
        this._addWindowSliderRow(parent, 'Top bar opacity',
            () => (this._keyboard
                && this._keyboard.getCustomization().topBarOpacity) | 0,
            (val) => {
                this._keyboard.setTopBarOpacity(val);
                this._persistCustomization();
            },
            { min: 0, max: 100, unit: '%' });
        this._addWindowColorRow(parent, 'Title text color', 'titleBar.text');
        this._addWindowSliderRow(parent, 'Prediction opacity',
            () => (this._keyboard
                && this._keyboard.getCustomization().predictionButtonOpacity) | 0,
            (val) => {
                this._keyboard.setPredictionButtonOpacity(val);
                this._persistCustomization();
            },
            { min: 0, max: 100, unit: '%' });

        this._addWindowSection(parent, 'Text Options');
        this._addWindowPillRow(parent, 'Bold text',
            [['Bold', true], ['Normal', false]],
            () => this._keyboard && this._keyboard.getCustomization().textBold,
            (val) => {
                this._keyboard.setTextBold(val);
                this._persistCustomization();
            });

        this._addWindowPillRow(parent, 'Key opacity',
            [['100%', 100], ['85%', 85], ['70%', 70], ['50%', 50], ['30%', 30]],
            () => this._keyboard && this._keyboard.getCustomization().keyOpacity,
            (val) => {
                this._keyboard.setKeyOpacity(val);
                this._persistCustomization();
            });

        this._addWindowPillRow(parent, 'Text opacity',
            [['100%', 100], ['85%', 85], ['70%', 70], ['50%', 50]],
            () => this._keyboard && this._keyboard.getCustomization().textOpacity,
            (val) => {
                this._keyboard.setTextOpacity(val);
                this._persistCustomization();
            });
        this._addWindowSliderRow(parent, 'Key text size',
            () => (this._keyboard
                && this._keyboard.getCustomization().keyTextSize) | 0,
            (val) => {
                this._keyboard.setKeyTextSize(val);
                this._persistCustomization();
            },
            { min: 10, max: 28, unit: ' px' });
    }

    _buildWindowBackground(parent) {
        this._addWindowSection(parent, 'Background image');

        const pathRow = new St.BoxLayout({ x_expand: true });
        pathRow.spacing = 8;
        const pathLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        pathLabel.set_style(
            'color: rgba(255,255,255,0.85); font-size: 13px;' +
            'padding: 4px 10px; min-height: 28px;' +
            'background-color: rgba(255,255,255,0.06);' +
            'border-radius: 4px;');
        pathRow.add_child(pathLabel);

        // "Browse..." opens a real GTK file dialog (zenity / kdialog,
        // whichever is installed) so users don't have to type a path
        // by hand.  If no native picker is available, we fall back
        // to the typed-path modal.  "Type path..." is always offered
        // alongside for users who prefer it (or for headless setups
        // where typing is faster than navigating).
        const browseBtn = this._makePillButton('Browse...', false);
        browseBtn.x_expand = false;
        browseBtn.connect('clicked', () => {
            if (!this._tryNativeFilePickerForBackground()) {
                this._promptManualBackgroundPath();
            }
        });
        pathRow.add_child(browseBtn);

        const typeBtn = this._makePillButton('Type path...', false);
        typeBtn.x_expand = false;
        typeBtn.connect('clicked', () => this._promptManualBackgroundPath());
        pathRow.add_child(typeBtn);

        const clearBtn = this._makePillButton('Clear', false);
        clearBtn.x_expand = false;
        clearBtn.connect('clicked', () => {
            if (!this._keyboard) return;
            this._keyboard.setCustomBackground(null);
            this._persistCustomization();
            this._refreshAllControls();
        });
        pathRow.add_child(clearBtn);
        parent.add_child(pathRow);

        this._controlRefreshers.push(() => {
            if (!this._keyboard) return;
            const p = this._keyboard.getCustomization().customBackground;
            pathLabel.text = p ? p : '(no image set)';
        });

        this._addWindowPillRow(parent, 'Image fit',
            [['Cover (no distortion)', 'cover'],
             ['Contain (fit entirely)', 'contain'],
             ['Stretch', 'stretch']],
            () => this._keyboard && this._keyboard.getCustomization().backgroundFit,
            (val) => {
                this._keyboard.setBackgroundFit(val);
                this._persistCustomization();
            });

        this._addWindowSliderRow(parent, 'Image position X',
            () => (this._keyboard
                && this._keyboard.getCustomization().backgroundPositionX) | 0,
            (val) => {
                this._keyboard.setBackgroundPosition('x', val);
                this._persistCustomization();
            },
            { min: 0, max: 100, unit: '%', liveDelay: 20 });
        this._addWindowSliderRow(parent, 'Image position Y',
            () => (this._keyboard
                && this._keyboard.getCustomization().backgroundPositionY) | 0,
            (val) => {
                this._keyboard.setBackgroundPosition('y', val);
                this._persistCustomization();
            },
            { min: 0, max: 100, unit: '%', liveDelay: 20 });
        this._addWindowSliderRow(parent, 'Image size',
            () => (this._keyboard
                && this._keyboard.getCustomization().backgroundScale) | 0,
            (val) => {
                this._keyboard.setBackgroundScale(val);
                this._persistCustomization();
            },
            { min: 40, max: 250, unit: '%', liveDelay: 20 });
    }

    // Spawn a native GUI file picker (zenity preferred, kdialog as
    // a backup) and apply the chosen path on success.  Returns
    // `true` when a picker was launched -- in which case the
    // selection arrives later via the async callback -- or `false`
    // when no supported picker tool is available, so the caller can
    // fall back to a typed-path modal.
    //
    // Subprocess.communicate_utf8_async is fully async; the user can
    // keep using the OSK and the customize window while the picker
    // is open.
    _tryNativeFilePickerForBackground() {
        // 1) Preferred: xdg-desktop-portal's FileChooser interface.
        //    On GNOME this dispatches to the GtkFileDialog (the
        //    Files-app-style picker the user expects), on KDE it
        //    dispatches to QFileDialog, etc.  Available on every
        //    modern Linux desktop without needing extra packages
        //    (xdg-desktop-portal is part of the standard stack).
        if (this._tryPortalFilePicker()) return true;

        // 2) Fallback: spawn zenity or kdialog binaries if they
        //    happen to be installed.  Older Shell setups might lack
        //    a portal but still have zenity around.
        const home = GLib.get_home_dir() || '/';
        const candidates = [
            ['zenity', (exe) => [
                exe, '--file-selection',
                '--title=Choose background image',
                `--filename=${home}/`,
                '--file-filter=Images | *.png *.PNG *.jpg *.JPG ' +
                    '*.jpeg *.JPEG *.svg *.SVG *.webp *.WEBP ' +
                    '*.bmp *.BMP *.gif *.GIF',
                '--file-filter=All files | *',
            ]],
            ['kdialog', (exe) => [
                exe, '--getopenfilename', home,
                'Image files (*.png *.jpg *.jpeg *.svg *.webp *.bmp *.gif)',
            ]],
        ];
        for (const [name, build] of candidates) {
            const path = GLib.find_program_in_path(name);
            if (!path) continue;
            return this._spawnFilePicker(build(path));
        }
        return false;
    }

    // Open the system file picker via the org.freedesktop.portal.FileChooser
    // DBus interface.  Returns `true` if the call was dispatched (the
    // result arrives async via the Response signal); `false` if
    // something failed synchronously and the caller should try the
    // next backend.
    //
    // Important GJS / GVariant quirks baked into this implementation:
    //
    //   * `new GLib.Variant(typesig, value)` is the universal
    //     constructor.  `GLib.Variant.new_string(...)` and friends
    //     work on most builds but fail on some ("not a subclass of
    //     GObject_Struct, it's a GIRepositoryFunction"), so we avoid
    //     them.
    //   * For `a{sv}` dicts, pass a plain JS object whose values are
    //     already GLib.Variant instances -- GJS boxes each one as
    //     `v` automatically.  Don't pre-build the whole dict as a
    //     standalone Variant and then embed it; just inline.
    //   * Call `conn.call_finish(result)` from the async callback
    //     (the `conn` arg is the reconstructed connection), not the
    //     outer `bus` -- some Shell builds give different results.
    //
    // We deliberately do NOT pre-flight with NameHasOwner -- the
    // portal is auto-activated so its name isn't on the bus until
    // the first method call wakes it up, and NameHasOwner would
    // falsely report "no portal" in that case.
    _tryPortalFilePicker() {
        let bus;
        try { bus = Gio.DBus.session; }
        catch (e) {
            log(`gnome-osk: portal session bus: ${e}`);
            return false;
        }

        // Predict the request object path: the spec lets us pass a
        // handle_token in options, then constructs the path as
        // /org/freedesktop/portal/desktop/request/<sender>/<token>
        // where <sender> is our unique bus name with the leading ':'
        // dropped and dots replaced by underscores.
        const uniqueName = bus.get_unique_name();
        if (!uniqueName) {
            log('gnome-osk: portal: no unique bus name');
            return false;
        }
        const senderForPath = uniqueName
            .replace(/^:/, '').replace(/\./g, '_');
        const token = `osk_${Date.now()}_${
            Math.floor(Math.random() * 100000)}`;
        const responsePath =
            `/org/freedesktop/portal/desktop/request/${senderForPath}/${token}`;

        // Chrome-layer actors always paint above regular application
        // windows (the portal file dialog is a regular xdg-toplevel),
        // so we temporarily demote the customize window into
        // `global.window_group` for the duration of the picker.
        // Being a sibling of MetaWindowActor children there, the
        // picker window appears above it (Mutter raises newly-opened
        // / focused windows to the top of their group), so the user
        // can see the picker while still seeing the customize window
        // underneath.
        const lowerCustomWindow = () => this._lowerCustomWindowForPicker();
        const restoreCustomWindow = () => this._raiseCustomWindowBack();

        let subId = 0;
        let safetyTimerId = 0;
        const cleanup = () => {
            if (subId) {
                try { bus.signal_unsubscribe(subId); } catch (_e) { }
                subId = 0;
            }
            if (safetyTimerId) {
                _removeSource(safetyTimerId);
                safetyTimerId = 0;
            }
        };

        // Resilient deep-unpack: GJS renamed deep_unpack to deepUnpack
        // somewhere around GJS 1.80; support both.
        const deepUnpack = (v) => {
            if (!v) return null;
            if (typeof v.deepUnpack === 'function') return v.deepUnpack();
            if (typeof v.deep_unpack === 'function') return v.deep_unpack();
            return null;
        };

        const onResponse = (_c, _s, _p, _i, _sig, params) => {
            try {
                const arr = deepUnpack(params);
                if (!arr) return;
                const response = arr[0];
                const results = arr[1] || {};
                if (response !== 0) {
                    log(`gnome-osk: portal response code ${response}`);
                    return;
                }
                let uriList = results['uris'];
                if (uriList && typeof uriList.deepUnpack === 'function') {
                    uriList = uriList.deepUnpack();
                } else if (uriList
                        && typeof uriList.deep_unpack === 'function') {
                    uriList = uriList.deep_unpack();
                }
                if (!uriList || uriList.length === 0) {
                    log('gnome-osk: portal response missing uris');
                    return;
                }
                const uri = uriList[0];
                let filePath = null;
                try {
                    filePath = Gio.File.new_for_uri(uri).get_path();
                } catch (e) {
                    log(`gnome-osk: portal uri decode: ${e}`);
                    return;
                }
                if (!filePath || !this._keyboard) return;
                this._keyboard.setCustomBackground(filePath);
                this._persistCustomization();
                this._refreshAllControls();
            } catch (e) {
                log(`gnome-osk: portal response handler: ${e}`);
            } finally {
                cleanup();
                restoreCustomWindow();
            }
        };

        try {
            subId = bus.signal_subscribe(
                'org.freedesktop.portal.Desktop',
                'org.freedesktop.portal.Request',
                'Response',
                responsePath,
                null,
                Gio.DBusSignalFlags.NONE,
                onResponse);
        } catch (e) {
            log(`gnome-osk: portal subscribe: ${e}`);
            return false;
        }

        try {
            // Inline options dict directly into the tuple.  Values
            // that go into `v` slots must be GLib.Variant instances;
            // we build each with the generic `new GLib.Variant` form
            // to avoid the GIRepositoryFunction marshalling bug that
            // bites `GLib.Variant.new_string` / `new_boolean` on
            // some Shell builds.
            const params = new GLib.Variant('(ssa{sv})', [
                '',
                'Choose OSK background image',
                {
                    'handle_token': new GLib.Variant('s', token),
                    'filters': new GLib.Variant('a(sa(us))', [
                        ['Images', [
                            [0, '*.png'], [0, '*.PNG'],
                            [0, '*.jpg'], [0, '*.JPG'],
                            [0, '*.jpeg'], [0, '*.JPEG'],
                            [0, '*.svg'], [0, '*.SVG'],
                            [0, '*.webp'], [0, '*.WEBP'],
                            [0, '*.bmp'], [0, '*.BMP'],
                            [0, '*.gif'], [0, '*.GIF'],
                        ]],
                        ['All files', [[0, '*']]],
                    ]),
                },
            ]);

            // Demote the customize window from chrome to window_group
            // so the portal picker (a regular window) paints above it.
            // Both stay visible; only z-order changes.  Restored by
            // onResponse / error paths below.
            lowerCustomWindow();

            // Safety net: if the portal accepts our call but never
            // sends Response (badly behaved backend, user killed the
            // dialog process, etc.) we'd be stuck with the customize
            // window demoted forever.  Restore it after 10 minutes
            // even if we hear nothing back.
            safetyTimerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_LOW, 600,
                () => {
                    safetyTimerId = 0;
                    log('gnome-osk: portal safety timer fired; restoring window');
                    cleanup();
                    restoreCustomWindow();
                    return GLib.SOURCE_REMOVE;
                });

            bus.call(
                'org.freedesktop.portal.Desktop',
                '/org/freedesktop/portal/desktop',
                'org.freedesktop.portal.FileChooser',
                'OpenFile',
                params,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, result) => {
                    try {
                        conn.call_finish(result);
                        log('gnome-osk: portal OpenFile accepted');
                    } catch (e) {
                        log(`gnome-osk: portal OpenFile rejected: ${e}`);
                        cleanup();
                        restoreCustomWindow();
                        try { this._promptManualBackgroundPath(); }
                        catch (_e) { }
                    }
                });
        } catch (e) {
            log(`gnome-osk: portal call dispatch: ${e}`);
            cleanup();
            restoreCustomWindow();
            return false;
        }

        log(`gnome-osk: portal OpenFile dispatched (token=${token})`);
        return true;
    }

    _spawnFilePicker(argv) {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE
                | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            log(`gnome-osk: file picker spawn failed: ${e}`);
            return false;
        }

        // Demote the customize window to below window_group so the
        // zenity / kdialog window (a regular xdg-toplevel that lives
        // in window_group) paints above it instead of being hidden
        // underneath chrome.  Contract mirrors the portal path:
        // the customize window stays open and rendered the whole
        // time -- lowering is a z-order move, not a destroy -- so
        // when the picker closes we just promote it back.
        this._lowerCustomWindowForPicker();

        proc.communicate_utf8_async(null, null, (source, result) => {
            let stdout = '';
            let exited = false;
            try {
                const r = source.communicate_utf8_finish(result);
                // r is [success, stdout, stderr] in GJS.
                if (Array.isArray(r) && r.length >= 2) {
                    stdout = r[1] || '';
                }
                exited = source.get_successful();
            } catch (e) {
                log(`gnome-osk: file picker read failed: ${e}`);
                this._raiseCustomWindowBack();
                return;
            }
            try {
                // zenity / kdialog exit non-zero on Cancel; just
                // ignore that case so we don't clobber the existing
                // path.  Either way, restore customize window z-order.
                if (!exited) return;
                const filePath = (stdout || '').trim();
                if (!filePath) return;
                if (!this._keyboard) return;
                this._keyboard.setCustomBackground(filePath);
                this._persistCustomization();
                this._refreshAllControls();
            } finally {
                this._raiseCustomWindowBack();
            }
        });
        return true;
    }

    // Modal text-entry fallback for the background path.  Used when
    // no native file picker is available, and from the explicit
    // "Type path..." button.
    _promptManualBackgroundPath() {
        const cur = this._keyboard
            ? (this._keyboard.getCustomization().customBackground || '')
            : '';
        this._promptModal(
            'Custom background image',
            'Enter the absolute path to a PNG / JPG / SVG image.',
            cur,
            (text) => {
                if (!this._keyboard) return;
                const p = text && text.trim();
                this._keyboard.setCustomBackground(p || null);
                this._persistCustomization();
                this._refreshAllControls();
            });
    }

    _buildWindowColors(parent) {
        this._addWindowSection(parent, 'Element colors');
        const intro = new St.Label({
            text: 'Click any swatch to open the color wheel. ' +
                  'Editing a built-in theme creates a new custom theme.'
        });
        intro.set_style('color: rgba(255,255,255,0.55); font-size: 11px;');
        parent.add_child(intro);

        let currentGroup = null;
        for (const [label, path, group] of CUSTOM_COLOR_SPECS) {
            if (group !== currentGroup) {
                currentGroup = group;
                const gLbl = new St.Label({ text: group.toUpperCase() });
                gLbl.set_style(
                    'color: rgba(255,255,255,0.5); font-size: 10px;' +
                    'font-weight: bold; padding-top: 8px;');
                parent.add_child(gLbl);
            }
            this._addWindowColorRow(parent, label, path);
        }
    }

    _buildWindowRgb(parent) {
        this._addWindowSection(parent, 'RGB lighting');

        // Split across two rows so the 8 mode pills don't overflow the
        // window's minimum width (600 px).  Both rows share the same
        // getActive/onPick so the active highlight always lands on the
        // selected mode regardless of which row holds it.
        const onPickMode = (val) => {
            this._keyboard.setRgbMode(val);
            this._persistCustomization();
        };
        const getActiveMode = () =>
            this._keyboard && this._keyboard.getCustomization().rgbMode;
        this._addWindowPillRow(parent, 'Mode',
            [['Off', 'off'], ['Static', 'static'],
             ['Gradient', 'gradient'], ['Breathing', 'breathing'],
             ['Reactive', 'reactive']],
            getActiveMode, onPickMode);
        this._addWindowPillRow(parent, '',
            [['Rainbow', 'rainbow'], ['Cycle', 'cycle'],
             ['Wave', 'wave'], ['Pulse', 'pulse']],
            getActiveMode, onPickMode);

        const colRow = new St.BoxLayout({ x_expand: true });
        colRow.spacing = 8;
        const lblAct = new St.Label({
            text: 'Glow color',
            y_align: Clutter.ActorAlign.CENTER,
        });
        lblAct.set_style(
            'font-size: 13px; color: rgba(255,255,255,0.85);' +
            'min-width: 120px;');
        colRow.add_child(lblAct);

        const swatch = this._makeColorSwatch('#ff00ff');
        colRow.add_child(swatch);
        const colValLbl = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
        });
        colValLbl.set_style(
            'font-size: 12px; color: rgba(255,255,255,0.75);' +
            'min-width: 80px; padding: 0 6px;');
        colRow.add_child(colValLbl);

        const changeBtn = this._makePillButton('Pick color...', false);
        changeBtn.x_expand = false;
        const openPicker = () => this._openPickerFor('rgb', 'RGB glow color');
        changeBtn.connect('clicked', openPicker);
        swatch.connect('clicked', openPicker);
        colRow.add_child(changeBtn);
        parent.add_child(colRow);

        this._controlRefreshers.push(() => {
            if (!this._keyboard) return;
            const c = this._keyboard.getCustomization().rgbColor || '#ff00ff';
            this._setSwatchColor(swatch, c);
            colValLbl.text = c;
        });

        const presets = [
            ['Magenta', '#ff00ff'], ['Cyan', '#00ffff'],
            ['Red', '#ff2020'],     ['Green', '#20ff40'],
            ['Blue', '#2060ff'],    ['Yellow', '#ffd000'],
            ['White', '#ffffff'],
        ];
        this._addWindowPillRow(parent, 'Preset',
            presets,
            () => (this._keyboard
                && (this._keyboard.getCustomization().rgbColor || '').toLowerCase()),
            (val) => {
                this._keyboard.setRgbColor(val);
                this._persistCustomization();
            },
            { keyCase: 'lower' });

        this._addWindowSliderRow(parent, 'Intensity',
            () => (this._keyboard
                && this._keyboard.getCustomization().rgbIntensity) | 0,
            (val) => {
                this._keyboard.setRgbIntensity(val);
                this._persistCustomization();
            });

        this._addWindowPillRow(parent, 'RGB key text',
            [['On', true], ['Off', false]],
            () => this._keyboard
                && !!this._keyboard.getCustomization().rgbCycleLabels,
            (val) => {
                this._keyboard.setRgbCycleLabels(val);
                this._persistCustomization();
            });

        // Advanced Options: collapsed by default.  These sliders are
        // stored per RGB mode, so tuning wave no longer changes
        // rainbow/cycle/static/etc.  Every persistent RGB halo mode
        // feeds the same row-canvas glow engine.
        const advanced = this._addWindowCollapsibleSection(
            parent, 'Advanced Options', false);
        this._addWindowSliderRow(advanced, 'Border size',
            () => (this._keyboard
                && +this._keyboard.getRgbBorderSize()) || 0.1,
            (val) => {
                this._keyboard.setRgbBorderSize(val);
                this._persistCustomization();
            },
            { min: 0.1, max: 20, step: 0.1, precision: 1,
              unit: ' px', liveDelay: 70 });
        this._addWindowSliderRow(advanced, 'Glow size',
            () => (this._keyboard
                && this._keyboard.getRgbGlowSize()) | 0,
            (val) => {
                this._keyboard.setRgbGlowSize(val);
                this._persistCustomization();
            },
            { min: 1, max: RGB_GLOW_SIZE_MAX, unit: ' px', liveDelay: 70 });
        this._addWindowSliderRow(advanced, 'Glow density',
            () => (this._keyboard
                && this._keyboard.getRgbBlurAmount()) | 0,
            (val) => {
                this._keyboard.setRgbBlurAmount(val);
                this._persistCustomization();
            },
            { min: 0, max: RGB_SPREAD_SIZE_MAX, unit: '', liveDelay: 70 });
        this._addWindowSliderRow(advanced, 'Halo softness',
            () => (this._keyboard
                && this._keyboard.getRgbHaloSoftness()) | 0,
            (val) => {
                this._keyboard.setRgbHaloSoftness(val);
                this._persistCustomization();
            },
            { min: 0, max: 100, unit: '%', liveDelay: 70 });
        this._addWindowSliderRow(advanced, 'Halo coverage',
            () => (this._keyboard
                && this._keyboard.getRgbHaloCoverage()) | 0,
            (val) => {
                this._keyboard.setRgbHaloCoverage(val);
                this._persistCustomization();
            },
            { min: 0, max: 100, unit: '%', liveDelay: 70 });
        this._addWindowSliderRow(advanced, 'Corner blend',
            () => (this._keyboard
                && this._keyboard.getRgbCornerBlend()) | 0,
            (val) => {
                this._keyboard.setRgbCornerBlend(val);
                this._persistCustomization();
            },
            { min: 0, max: 100, unit: '%', liveDelay: 70 });
        const speedRow = this._addWindowSliderRow(advanced, 'Speed',
            () => (this._keyboard
                && this._keyboard.getRgbSpeed()) | 0,
            (val) => {
                this._keyboard.setRgbSpeed(val);
                this._persistCustomization();
            },
            { min: 25, max: 300, unit: '%', liveDelay: 120 });
        this._controlRefreshers.push(() => {
            if (!speedRow || !this._keyboard) return;
            speedRow.visible = this._keyboard._rgbModeSupportsSpeed();
        });
    }

    // ---- Customize window: widget helpers -----------------------

    _addWindowSectionSeparator(parent) {
        const needsSep = parent._oskHadSection === true;
        parent._oskHadSection = true;
        if (needsSep) {
            const sep = new St.Widget({ x_expand: true, y_expand: false });
            sep.set_style(
                'background-color: rgba(255,255,255,0.08);' +
                'min-height: 1px; margin: 6px 0;');
            parent.add_child(sep);
        }
    }

    _addWindowSection(parent, text) {
        this._addWindowSectionSeparator(parent);
        const label = new St.Label({ text });
        label.set_style(
            'font-size: 14px; font-weight: bold; color: #ffffff;' +
            'padding: 2px 0 4px 0;');
        parent.add_child(label);
    }

    // Add a horizontal "label + slider + value" row to `parent`.
    // Backed by GNOME Shell's `Slider` (value always 0..1 internally);
    // we expose an arbitrary integer min..max range via `opts` and
    // map the slider's 0..1 to it.  `getActive()` returns the current
    // value (in user units, min..max); `onPick(value)` is called as
    // the user drags.  Registered with _controlRefreshers so external
    // mutations (preset reset, reload from config) refresh the slider
    // position.
    //
    // opts:
    //   min       -- minimum value (default 0).  Can be a float.
    //   max       -- maximum value (default 100).  Can be a float.
    //   unit      -- string suffix shown in the value label (default '%')
    //   step      -- snap increment (default 1).  Sub-1 values give
    //                fractional sliders (e.g., step=0.1 for 0.1px).
    //   precision -- decimal places shown in the value label (default 0).
    _addWindowSliderRow(parent, label, getActive, onPick, opts) {
        opts = opts || {};
        const min = (opts.min !== undefined) ? +opts.min : 0;
        const max = (opts.max !== undefined) ? +opts.max : 100;
        const unit = (opts.unit !== undefined) ? opts.unit : '%';
        const step = (opts.step !== undefined && opts.step > 0)
            ? +opts.step : 1;
        const precision = (opts.precision !== undefined)
            ? opts.precision | 0 : 0;
        const range = max - min;
        const snapToStep = (v) =>
            Math.round(v / step) * step;
        const fracToValue = (f) => {
            if (range <= 0) return min;
            const raw = min + f * range;
            // Snap to step, then trim float dust by re-rounding to
            // `precision` decimal places.
            const snapped = snapToStep(raw);
            const factor = Math.pow(10, Math.max(precision, 6));
            return Math.round(snapped * factor) / factor;
        };
        const valueToFrac = (v) =>
            range > 0
                ? Math.max(0, Math.min(1, (v - min) / range))
                : 0;
        const applyDelay = (opts.liveDelay !== undefined)
            ? Math.max(1, opts.liveDelay | 0) : 80;
        let pendingValue = null;
        let applyId = 0;
        let refreshing = false;
        const flushPending = () => {
            applyId = 0;
            if (pendingValue === null) return GLib.SOURCE_REMOVE;
            const v = pendingValue;
            pendingValue = null;
            if (this._keyboard) onPick(v);
            return GLib.SOURCE_REMOVE;
        };

        const row = new St.BoxLayout({ x_expand: true });
        row.spacing = 8;
        const lbl = new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        lbl.set_style(
            'font-size: 13px; color: rgba(255,255,255,0.85);' +
            'min-width: 120px;');
        row.add_child(lbl);

        const slider = new Slider(
            valueToFrac(Math.max(min, Math.min(max, +getActive()))));
        slider.x_expand = true;
        slider.y_align = Clutter.ActorAlign.CENTER;
        slider.set_style('min-height: 16px; min-width: 220px;');
        row.add_child(slider);

        const valLbl = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
        });
        valLbl.set_style(
            'font-size: 12px; color: rgba(255,255,255,0.75);' +
            'min-width: 56px;');
        const updateValLbl = (v) => {
            valLbl.text = `${v.toFixed(precision)}${unit}`;
        };
        updateValLbl(fracToValue(slider.value));
        row.add_child(valLbl);

        // Drag handler: notify::value fires continuously while
        // dragging.  Push the (possibly fractional) value to the
        // keyboard on every tick so the user sees the glow update live.
        slider.connect('notify::value', () => {
            if (refreshing) return;
            const v = fracToValue(slider.value);
            updateValLbl(v);
            pendingValue = v;
            if (!applyId) {
                applyId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT_IDLE, applyDelay, flushPending);
            }
        });

        parent.add_child(row);

        this._controlRefreshers.push(() => {
            // Use +getActive() (not bitwise |0) to preserve floats.
            const v = Math.max(min, Math.min(max, +getActive()));
            updateValLbl(v);
            // Setting slider.value programmatically also fires
            // notify::value, so guard against feedback by checking
            // that the value actually differs.
            const f = valueToFrac(v);
            if (Math.abs(slider.value - f) > 0.001) {
                refreshing = true;
                slider.value = f;
                refreshing = false;
            }
        });
        return row;
    }

    // Add a collapsible section with a clickable header + child
    // container.  Returns the child container so the caller can add
    // rows that are shown/hidden when the user clicks the header.
    // Visually mirrors _addWindowSection's style (separator + bold
    // title) plus a clickable arrow that toggles the content's
    // visibility.
    _addWindowCollapsibleSection(parent, text, defaultExpanded) {
        this._addWindowSectionSeparator(parent);

        // Clickable header (St.Button -- handles hover + click for free).
        // Background stays transparent so it blends with the section
        // styling; only the label + arrow show.
        const header = new St.Button({
            x_expand: true,
            reactive: true,
            track_hover: true,
            can_focus: false,
        });
        header.set_style(
            'background-color: transparent;' +
            'border: none;' +
            'padding: 2px 0 4px 0;' +
            'color: #ffffff;' +
            'font-size: 14px;' +
            'font-weight: bold;');

        // Hidden-by-default content container.  Caller adds rows to
        // this; we just toggle its `.visible` on header clicks.
        const content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        content.set_style('padding: 4px 0 0 8px;');

        let expanded = !!defaultExpanded;
        const updateLabel = () => {
            header.set_label(`${expanded ? '▼' : '▶'}  ${text}`);
            content.visible = expanded;
        };
        updateLabel();

        header.connect('clicked', () => {
            expanded = !expanded;
            updateLabel();
        });

        parent.add_child(header);
        parent.add_child(content);

        return content;
    }

    _addWindowCheckboxRow(parent, label, getActive, onToggle) {
        const row = new St.BoxLayout({ x_expand: true });
        row.spacing = 8;

        const btn = new St.Button({
            can_focus: true,
            track_hover: true,
            reactive: true,
        });
        btn.set_style(
            'background-color: transparent;' +
            'color: rgba(255,255,255,0.88);' +
            'border: none;' +
            'border-radius: 6px;' +
            'padding: 7px 8px;' +
            'font-size: 18px;' +
            'font-weight: bold;' +
            'min-width: 280px;' +
            'min-height: 36px;' +
            'text-align: left;');
        row.add_child(btn);
        parent.add_child(row);

        let checked = false;
        const paint = () => {
            btn.set_label(`${checked ? '\u2611' : '\u2610'}  ${label}`);
        };
        btn.connect('clicked', () => {
            if (!this._keyboard) return;
            checked = !checked;
            onToggle(checked);
            paint();
            this._refreshAllControls();
        });
        this._controlRefreshers.push(() => {
            checked = !!(getActive ? getActive() : false);
            paint();
        });
        checked = !!(getActive ? getActive() : false);
        paint();
    }

    _addWindowPillRow(parent, label, choices, getActive, onPick, opts) {
        opts = opts || {};
        const row = new St.BoxLayout({ x_expand: true });
        row.spacing = 6;
        const lbl = new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        lbl.set_style(
            'font-size: 13px; color: rgba(255,255,255,0.85);' +
            'min-width: 120px;');
        row.add_child(lbl);

        const buttons = [];
        for (const [text, value] of choices) {
            const btn = this._makePillButton(text, false);
            btn.connect('clicked', () => {
                if (!this._keyboard) return;
                onPick(value);
                this._refreshAllControls();
            });
            row.add_child(btn);
            buttons.push({ btn, value });
        }
        parent.add_child(row);

        const refresh = () => {
            let active = getActive ? getActive() : null;
            if (opts.keyCase === 'lower' && typeof active === 'string') {
                active = active.toLowerCase();
            }
            for (const { btn, value } of buttons) {
                let v = value;
                if (opts.keyCase === 'lower' && typeof v === 'string') {
                    v = v.toLowerCase();
                }
                this._setPillActive(btn, v === active);
            }
        };
        this._controlRefreshers.push(refresh);
        refresh();
    }

    _addWindowColorRow(parent, label, path) {
        const row = new St.BoxLayout({ x_expand: true });
        row.spacing = 8;

        const lbl = new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        lbl.set_style(
            'font-size: 13px; color: rgba(255,255,255,0.85);' +
            'min-width: 180px;');
        row.add_child(lbl);

        const swatch = this._makeColorSwatch('#000000');
        row.add_child(swatch);

        const hexLbl = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        hexLbl.set_style(
            'font-size: 12px; color: rgba(255,255,255,0.65);' +
            'padding: 0 6px;');
        row.add_child(hexLbl);

        const changeBtn = this._makePillButton('Change...', false);
        changeBtn.x_expand = false;
        const openPickerHere = () => this._openPickerFor(path, label);
        changeBtn.connect('clicked', openPickerHere);
        swatch.connect('clicked', openPickerHere);
        row.add_child(changeBtn);

        const resetBtn = this._makePillButton('Reset', false);
        resetBtn.x_expand = false;
        resetBtn.connect('clicked', () => {
            if (!this._keyboard) return;
            // "Reset" removes the override from customColors OR, for
            // user themes, restores the slot from the original
            // built-in theme the user forked from (if known).
            this._resetPathToThemeDefault(path);
            this._persistCustomization();
            this._refreshAllControls();
        });
        row.add_child(resetBtn);

        parent.add_child(row);

        this._controlRefreshers.push(() => {
            if (!this._keyboard) return;
            const c = this._keyboard.getResolvedColor(path) || '#000000';
            this._setSwatchColor(swatch, c);
            const overridden = !!(this._keyboard.getCustomization()
                .customColors || {})[path];
            hexLbl.text = overridden ? `${c} \u2217` : c;
        });
    }

    // Reset a single color path to its theme default.  On a built-in
    // theme this means clearing the customColors override.  On a user
    // theme this means copying the value from the theme it was forked
    // from (if the fork metadata survived).  Silently no-ops when we
    // can't figure out a default.
    _resetPathToThemeDefault(path) {
        if (!this._keyboard) return;
        const c = this._keyboard.getCustomization();
        if (_isBuiltInTheme(c.themeId)) {
            this._keyboard.resetCustomColor(path);
            return;
        }
        const t = this._keyboard.getUserThemes()[c.themeId];
        const basedOn = t && t.based_on && THEMES[t.based_on];
        if (!basedOn) return;
        const parts = path.split('.');
        if (parts.length !== 2) return;
        const defaultHex = basedOn[parts[0]] && basedOn[parts[0]][parts[1]];
        if (!defaultHex) return;
        this._keyboard.setUserThemeColor(c.themeId, path, defaultHex);
    }

    _makePillButton(text, active) {
        const btn = new St.Button({
            label: text,
            can_focus: true,
            track_hover: true,
            reactive: true,
            style_class: 'osk-pill-btn',
        });
        this._setPillActive(btn, !!active);
        return btn;
    }

    _setPillActive(btn, active) {
        if (active) {
            btn.set_style(
                'background-color: #3584e4;' +
                'color: #ffffff;' +
                'border: 1px solid #1a65c0;' +
                'border-radius: 14px;' +
                'padding: 5px 14px;' +
                'font-size: 12px;' +
                'font-weight: bold;' +
                'margin: 0 2px;');
        } else {
            btn.set_style(
                'background-color: rgba(255,255,255,0.07);' +
                'color: rgba(255,255,255,0.85);' +
                'border: 1px solid rgba(255,255,255,0.12);' +
                'border-radius: 14px;' +
                'padding: 5px 14px;' +
                'font-size: 12px;' +
                'margin: 0 2px;');
        }
    }

    _makeColorSwatch(hex) {
        const swatch = new St.Button({
            style_class: 'osk-color-swatch',
            can_focus: true,
            track_hover: true,
            reactive: true,
        });
        this._setSwatchColor(swatch, hex);
        return swatch;
    }

    _setSwatchColor(swatch, hex) {
        swatch.set_style(
            `background-color: ${hex || '#000000'};` +
            'border: 1px solid rgba(255,255,255,0.35);' +
            'border-radius: 4px;' +
            'min-width: 30px;' +
            'min-height: 22px;' +
            'padding: 0;');
    }


    // ---- Inline color picker (HSV wheel + hex entry) -----------
    //
    // Built as a side panel inside the Customize window (so it's
    // always visible alongside the affected row and there's no modal
    // blocking the OSK).  Uses two St.DrawingArea canvases drawn via
    // cairo: a saturation-value square (the "wheel") and a vertical
    // hue slider.  Text entry beside them accepts a hex string for
    // precise color entry.
    //
    // Color updates are applied LIVE on every drag motion, both to
    // the target customColors slot AND to the preview here, so the
    // user can see the keyboard change as they drag.

    _buildInlineColorPicker() {
        // Right-side panel inside the Customize window.
        //
        // We make the PANEL reactive (not the inner DrawingAreas)
        // and capture all clicks/motion at this level, then dispatch
        // them based on which inner widget the cursor hit.  Earlier
        // attempts to put `reactive: true` on the DrawingArea didn't
        // reliably deliver button-press / motion events on every
        // GNOME Shell + GJS combination -- bubbling up to a known-
        // reactive parent BoxLayout is the pattern Shell's own
        // settings panels use and it works everywhere we've tested.
        //
        // Solid background matches the rest of the Customize window
        // (no transparency wash) so the picker doesn't read as a
        // separate "glassy" overlay.
        const panel = new St.BoxLayout({
            vertical: true,
            reactive: true,
            track_hover: true,
        });
        panel.spacing = 10;
        panel.set_style(
            'background-color: #181818;' +
            'border-left: 1px solid #000000;' +
            'padding: 16px;' +
            'min-width: 282px;');

        // Header: same style as section headers in the body so the
        // picker reads as another section, not a foreign overlay.
        const header = new St.Label({ text: 'Color picker' });
        header.set_style(
            'font-size: 14px; font-weight: bold; color: #ffffff;' +
            'padding: 0;');
        panel.add_child(header);
        this._pickerHeader = header;

        // "Editing: Foo" badge.  Same chip style as the
        // built-in / custom tags on theme cards for consistency.
        const targetWrap = new St.BoxLayout({ x_expand: true });
        targetWrap.set_style('padding: 2px 0 6px 0;');
        const target = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        target.set_style(
            'color: #ffffff; font-size: 11px; font-weight: bold;' +
            'background-color: rgba(53,132,228,0.35);' +
            'border-radius: 8px; padding: 2px 10px;');
        targetWrap.add_child(target);
        panel.add_child(targetWrap);
        this._pickerTargetLbl = target;

        // Row: SV square on the left, hue slider on the right.  Both
        // are St.DrawingArea but DELIBERATELY NOT reactive -- the
        // panel above catches events for them.
        const row = new St.BoxLayout({ x_expand: false });
        row.spacing = 10;
        panel.add_child(row);

        const sv = new St.DrawingArea();
        sv.set_size(200, 200);
        sv.set_style(
            'border: 1px solid rgba(255,255,255,0.25);' +
            'border-radius: 4px;');
        this._pickerSv = sv;
        sv.connect('repaint', this._drawPickerSv.bind(this));
        row.add_child(sv);

        const hue = new St.DrawingArea();
        hue.set_size(24, 200);
        hue.set_style(
            'border: 1px solid rgba(255,255,255,0.25);' +
            'border-radius: 4px;');
        this._pickerHue = hue;
        hue.connect('repaint', this._drawPickerHue.bind(this));
        row.add_child(hue);

        // Hint right under the wheel.
        const hint = new St.Label({
            text: 'Click and drag the square or hue strip.',
        });
        hint.set_style(
            'color: rgba(255,255,255,0.55); font-size: 11px;' +
            'padding-top: 4px;');
        panel.add_child(hint);

        // Manual hex entry row.  Solid card background to match the
        // theme-card / element-row look used elsewhere in the
        // window -- no extra transparency wash.
        const manualLbl = new St.Label({ text: 'Manual hex code' });
        manualLbl.set_style(
            'color: rgba(255,255,255,0.75); font-size: 11px;' +
            'font-weight: bold; padding-top: 8px;');
        panel.add_child(manualLbl);

        const bottom = new St.BoxLayout({ x_expand: true });
        bottom.spacing = 8;

        const preview = new St.Widget();
        preview.set_style(
            'background-color: #ff00ff;' +
            'border: 1px solid rgba(255,255,255,0.35);' +
            'border-radius: 4px;' +
            'min-width: 36px; min-height: 30px;' +
            'padding: 0;');
        this._pickerPreview = preview;
        bottom.add_child(preview);

        const entry = new St.Entry({
            text: '#ff00ff',
            can_focus: true,
            x_expand: true,
        });
        entry.set_style(
            'padding: 5px 8px; font-size: 12px; min-height: 28px;' +
            'background-color: #2a2a2a;' +
            'border: 1px solid rgba(255,255,255,0.15);' +
            'border-radius: 4px;' +
            'color: #ffffff;');
        this._pickerEntry = entry;
        bottom.add_child(entry);

        const applyBtn = this._makePillButton('Set', false);
        applyBtn.x_expand = false;
        applyBtn.connect('clicked', () => {
            const raw = (entry.get_text() || '').trim();
            if (_parseHex(raw)) this._commitPickerColor(raw, false);
        });
        bottom.add_child(applyBtn);
        panel.add_child(bottom);

        // Pressing Enter in the hex entry applies the value.
        if (entry.clutter_text) {
            entry.clutter_text.connect('activate', () => {
                const raw = (entry.get_text() || '').trim();
                if (_parseHex(raw)) this._commitPickerColor(raw, false);
            });
        }

        // Done button row, right-aligned.
        const actions = new St.BoxLayout({ x_expand: true });
        actions.spacing = 6;
        actions.set_style('padding-top: 10px;');
        const spacer = new St.Widget({ x_expand: true });
        actions.add_child(spacer);
        const doneBtn = this._makePillButton('Done', true);
        doneBtn.connect('clicked', () => this._closePicker());
        actions.add_child(doneBtn);
        panel.add_child(actions);

        // Connect the unified press / motion / release handlers on
        // the panel itself.  These dispatch to the right inner widget
        // by hit-testing against its transformed bounds, and use a
        // pointer grab so motion events keep firing once the cursor
        // leaves the SV / hue widget mid-drag.
        panel.connect('button-press-event',
            (_a, e) => this._pickerOnPress(e));
        panel.connect('motion-event',
            (_a, e) => this._pickerOnMotion(e));
        panel.connect('button-release-event',
            (_a, e) => this._pickerOnRelease(e));

        // State: track HSV separately from hex so drag operations
        // don't suffer HSV->hex->HSV rounding drift.
        panel._oskPickerH = 0;
        panel._oskPickerS = 0;
        panel._oskPickerV = 0;

        return panel;
    }

    _openPickerFor(path, label) {
        if (!this._picker) return;
        const proceed = () => {
            this._pickerTarget = path;
            this._pickerTargetLbl.text =
                (path === 'rgb') ? 'Editing: RGB lighting' : `Editing: ${label}`;
            // Seed the picker with the current color of the target.
            let cur;
            if (path === 'rgb') {
                cur = (this._keyboard
                    && this._keyboard.getCustomization().rgbColor) || '#ff00ff';
            } else {
                cur = (this._keyboard
                    && this._keyboard.getResolvedColor(path)) || '#000000';
            }
            this._seedPickerFromHex(cur);
            this._picker.visible = true;
            this._pickerSv.queue_repaint();
            this._pickerHue.queue_repaint();
        };

        // When the user is editing a color slot on a built-in theme,
        // fork to a user theme first.  RGB glow color is a global
        // setting (not a per-theme slot) so we skip the fork prompt
        // for it.
        if (path === 'rgb') {
            proceed();
            return;
        }
        const c = this._keyboard && this._keyboard.getCustomization();
        if (c && _isBuiltInTheme(c.themeId)) {
            this._promptForkName(() => proceed());
        } else {
            proceed();
        }
    }

    _closePicker() {
        if (!this._picker) return;
        // Catch any pending in-flight color change before hiding
        // the picker so the user's last-picked color always lands
        // in the config.
        try {
            this._persistCustomization();
            this._flushConfigSave();
        }
        catch (e) { log(`gnome-osk: persist on picker close failed: ${e}`); }
        this._picker.visible = false;
        this._pickerTarget = null;
    }

    // Prompt the user for a name for their new custom theme, then
    // fork the currently-active built-in theme into a user theme
    // with that name and call `onForked()`.  Cancelled prompts don't
    // call the callback (the pending edit is abandoned).
    _promptForkName(onForked) {
        if (!this._keyboard) return;
        const srcId = this._keyboard.getCustomization().themeId;
        const srcLabel = this._keyboard.getThemeLabel(srcId);
        this._promptModal(
            'Create custom theme',
            `"${srcLabel}" is a built-in theme. Name your new custom theme ` +
            'to save your changes there instead.',
            `${srcLabel} (custom)`,
            (text) => {
                const name = (text || '').trim() || `${srcLabel} (custom)`;
                this._keyboard.forkActiveTheme(name);
                this._persistCustomization();
                this._refreshAllControls();
                try { onForked(); }
                catch (e) { log(`gnome-osk: onForked threw: ${e}`); }
            });
    }

    _seedPickerFromHex(hex) {
        const c = _parseHex(hex);
        if (!c) return;
        const hsv = _rgbToHsv(c.r, c.g, c.b);
        this._picker._oskPickerH = hsv.h;
        this._picker._oskPickerS = hsv.s;
        this._picker._oskPickerV = hsv.v;
        if (this._pickerEntry) this._pickerEntry.set_text(hex);
        if (this._pickerPreview) {
            this._pickerPreview.set_style(
                `background-color: ${hex};` +
                'border: 1px solid rgba(255,255,255,0.35);' +
                'border-radius: 4px;' +
                'min-width: 36px; min-height: 30px;' +
                'padding: 0;');
        }
    }

    _drawPickerSv(area) {
        const [w, h] = area.get_surface_size();
        const cr = area.get_context();
        const hue = this._picker ? this._picker._oskPickerH : 0;
        // Base: pure hue fading from white on the left.
        const pureHex = _hsvToHex(hue, 1, 1);
        const pure = _parseHex(pureHex);
        const hGrad = new Cairo.LinearGradient(0, 0, w, 0);
        hGrad.addColorStopRGBA(0, 1, 1, 1, 1);
        hGrad.addColorStopRGBA(1, pure.r / 255, pure.g / 255, pure.b / 255, 1);
        cr.setSource(hGrad);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        // Overlay: black fading from top transparent to bottom opaque.
        const vGrad = new Cairo.LinearGradient(0, 0, 0, h);
        vGrad.addColorStopRGBA(0, 0, 0, 0, 0);
        vGrad.addColorStopRGBA(1, 0, 0, 0, 1);
        cr.setSource(vGrad);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        // Cursor ring at current (s, v).
        const s = this._picker ? this._picker._oskPickerS : 0;
        const v = this._picker ? this._picker._oskPickerV : 0;
        const cx = s * w;
        const cy = (1 - v) * h;
        cr.setLineWidth(2);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.arc(cx, cy, 6, 0, Math.PI * 2);
        cr.stroke();
        cr.setLineWidth(1);
        cr.setSourceRGBA(0, 0, 0, 0.7);
        cr.arc(cx, cy, 6, 0, Math.PI * 2);
        cr.stroke();
        cr.$dispose();
    }

    _drawPickerHue(area) {
        const [w, h] = area.get_surface_size();
        const cr = area.get_context();
        // 6-stop rainbow gradient vertically.
        const g = new Cairo.LinearGradient(0, 0, 0, h);
        const stops = [
            [0,     1, 0, 0],
            [1/6,   1, 1, 0],
            [2/6,   0, 1, 0],
            [3/6,   0, 1, 1],
            [4/6,   0, 0, 1],
            [5/6,   1, 0, 1],
            [1,     1, 0, 0],
        ];
        for (const [off, r, gg, b] of stops) {
            g.addColorStopRGBA(off, r, gg, b, 1);
        }
        cr.setSource(g);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        // Cursor line at current hue.
        const hue = this._picker ? this._picker._oskPickerH : 0;
        const y = (hue / 360) * h;
        cr.setLineWidth(2);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.moveTo(0, y); cr.lineTo(w, y); cr.stroke();
        cr.setLineWidth(1);
        cr.setSourceRGBA(0, 0, 0, 0.7);
        cr.moveTo(0, y + 1); cr.lineTo(w, y + 1); cr.stroke();
        cr.$dispose();
    }

    // Unified panel-level event dispatcher.  Hit-tests the click
    // location against the SV square + hue strip; if it lands on
    // either, capture a pointer grab and route motion / release
    // events to the appropriate handler.  Clicks outside the
    // wheel widgets propagate so the inner entry / buttons keep
    // working normally.
    _pickerOnPress(event) {
        if (!this._picker) return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = event.get_coords();
        let target = null;
        if (this._actorContainsPoint(this._pickerSv, sx, sy)) target = 'sv';
        else if (this._actorContainsPoint(this._pickerHue, sx, sy)) target = 'hue';
        if (!target) return Clutter.EVENT_PROPAGATE;

        this._pickerActiveDrag = target;
        // Pointer grab so motion + release fire even if the cursor
        // leaves the picker panel mid-drag.
        try {
            if (global.stage.grab) {
                this._pickerGrab = global.stage.grab(this._picker);
            }
        } catch (_e) { this._pickerGrab = null; }

        if (target === 'sv') this._pickerSvHandle(sx, sy);
        else this._pickerHueHandle(sx, sy);
        return Clutter.EVENT_STOP;
    }

    _pickerOnMotion(event) {
        if (!this._pickerActiveDrag) return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = event.get_coords();
        if (this._pickerActiveDrag === 'sv') this._pickerSvHandle(sx, sy);
        else this._pickerHueHandle(sx, sy);
        return Clutter.EVENT_STOP;
    }

    _pickerOnRelease(_event) {
        if (!this._pickerActiveDrag) return Clutter.EVENT_PROPAGATE;
        this._pickerActiveDrag = null;
        if (this._pickerGrab) {
            try { this._pickerGrab.dismiss(); } catch (_e) { }
            this._pickerGrab = null;
        }
        // One final commit + UI refresh now that the drag is over.
        this._finalizePickerColor();
        return Clutter.EVENT_PROPAGATE;
    }

    // Bounds check using stage-space coordinates.  Used by the
    // panel-level event dispatcher to know which inner widget the
    // user clicked on.
    _actorContainsPoint(actor, sx, sy) {
        if (!actor) return false;
        const [ax, ay] = actor.get_transformed_position();
        const [w, h] = actor.get_size();
        return sx >= ax && sx < ax + w && sy >= ay && sy < ay + h;
    }

    _pickerSvHandle(sx, sy) {
        if (!this._picker || !this._pickerSv) return;
        const [w, h] = this._pickerSv.get_size();
        const [px, py] = this._pickerSv.get_transformed_position();
        const lx = sx - px;
        const ly = sy - py;
        const s = Math.max(0, Math.min(1, lx / w));
        const v = Math.max(0, Math.min(1, 1 - ly / h));
        this._picker._oskPickerS = s;
        this._picker._oskPickerV = v;
        this._pickerSv.queue_repaint();
        this._emitPickerColor(/*live=*/true);
    }

    _pickerHueHandle(sx, sy) {
        if (!this._picker || !this._pickerHue) return;
        const [_w, h] = this._pickerHue.get_size();
        const [_px, py] = this._pickerHue.get_transformed_position();
        const ly = sy - py;
        const hue = Math.max(0, Math.min(360, (ly / h) * 360));
        this._picker._oskPickerH = hue;
        this._pickerHue.queue_repaint();
        this._pickerSv.queue_repaint();
        this._emitPickerColor(/*live=*/true);
    }

    // Called on every drag motion (live=true) AND after manual hex
    // entry / Apply button (live=false).  Applies the picker's
    // current color to the target + updates the preview.  In live
    // mode we skip the expensive full-refresh + config save -- those
    // fire once on drag release via _finalizePickerColor.
    _emitPickerColor(live) {
        if (!this._picker) return;
        const hex = _hsvToHex(
            this._picker._oskPickerH,
            this._picker._oskPickerS,
            this._picker._oskPickerV);
        this._commitPickerColor(hex, live);
    }

    _commitPickerColor(hex, live) {
        if (!hex || !this._keyboard || !this._pickerTarget) return;
        if (this._pickerEntry) this._pickerEntry.set_text(hex);
        if (this._pickerPreview) {
            this._pickerPreview.set_style(
                `background-color: ${hex};` +
                'border: 1px solid rgba(255,255,255,0.35);' +
                'border-radius: 4px;' +
                'min-width: 36px; min-height: 30px;' +
                'padding: 0;');
        }
        const target = this._pickerTarget;
        if (target === 'rgb') {
            this._keyboard.setRgbColor(hex);
        } else {
            // Element color -- dispatch differently for built-in vs
            // user theme.  Built-in paths don't reach here because
            // _openPickerFor forks first; defensive check anyway.
            const cid = this._keyboard.getCustomization().themeId;
            if (_isBuiltInTheme(cid)) {
                this._keyboard.setCustomColor(target, hex);
            } else {
                this._keyboard.setUserThemeColor(cid, target, hex);
            }
        }
        if (!live) {
            this._persistCustomization();
            this._refreshAllControls();
        }
    }

    // Called on drag release to commit the latest picker color to
    // disk and refresh all UI controls.  A cheap no-op if the user
    // didn't actually change anything during the drag.
    _finalizePickerColor() {
        if (!this._picker) return;
        const hex = _hsvToHex(
            this._picker._oskPickerH,
            this._picker._oskPickerS,
            this._picker._oskPickerV);
        this._commitPickerColor(hex, /*live=*/false);
    }


    // Minimal modal text-entry prompt.  Used by the path / theme-name
    // / manual hex paths.  Stays as a modal because it's a short
    // one-shot interaction and the OSK doesn't need to be active
    // during a brief text entry.
    _promptModal(title, description, initial, onAccept) {
        try {
            const dialog = new ModalDialog.ModalDialog({
                destroyOnClose: true,
                styleClass: 'osk-prompt-dialog',
            });

            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true,
            });
            box.spacing = 8;
            box.set_style('padding: 12px; min-width: 420px;');

            const titleLabel = new St.Label({ text: title });
            titleLabel.set_style(
                'font-weight: bold; font-size: 15px; color: #ffffff;');
            box.add_child(titleLabel);

            const descLabel = new St.Label({ text: description });
            descLabel.set_style('font-size: 12px; color: #cccccc;');
            box.add_child(descLabel);

            const entry = new St.Entry({
                text: initial || '',
                can_focus: true,
                x_expand: true,
            });
            entry.set_style(
                'padding: 6px 8px; font-size: 13px; min-height: 28px;');
            box.add_child(entry);

            dialog.contentLayout.add_child(box);

            const accept = () => {
                const text = entry.get_text() || '';
                dialog.close(global.get_current_time());
                try { onAccept(text); }
                catch (e) { log(`gnome-osk: modal accept threw: ${e}`); }
            };

            dialog.setButtons([
                {
                    label: 'Cancel',
                    action: () => dialog.close(global.get_current_time()),
                    key: Clutter.KEY_Escape,
                },
                {
                    label: 'OK',
                    action: accept,
                    isDefault: true,
                },
            ]);

            dialog.open(global.get_current_time());
            if (entry.clutter_text) {
                entry.clutter_text.grab_key_focus();
                entry.clutter_text.connect('activate', accept);
            }
        } catch (e) {
            log(`gnome-osk: modal prompt failed: ${e}`);
        }
    }

    _defaultConfig() {
        return {
            configVersion: CONFIG_VERSION,
            predictionEnabled: false,
            showOnStartup: true,
            layout: DEFAULT_LAYOUT_KEY,
            customization: Object.assign({}, DEFAULT_CUSTOMIZATION),
            userThemes: {},
        };
    }

    _quarantineConfigFile(path, reason) {
        try {
            const src = Gio.File.new_for_path(path);
            if (!src.query_exists(null)) return;
            const stamp = GLib.DateTime.new_now_local()
                .format('%Y%m%d-%H%M%S');
            const dest = Gio.File.new_for_path(`${path}.bad-${stamp}`);
            src.move(dest, Gio.FileCopyFlags.NONE, null, null);
            log(`gnome-osk: quarantined bad config (${reason}) to ${dest.get_path()}`);
        } catch (e) {
            log(`gnome-osk: config quarantine failed: ${e}`);
        }
    }

    _loadConfig() {
        // Read the saved UI config from $XDG_DATA_HOME/gnome-osk/
        // config.json.  Returns a plain object; missing file or bad
        // JSON -> defaults (prediction off, Windows-OSK layout,
        // dark theme, no customization tweaks).
        //
        // The customization sub-object is merged into DEFAULT_CUSTOMIZATION
        // so older configs (which had no `customization` key) get all
        // the new fields at default values on first read, and unknown
        // fields from newer builds are preserved but ignored.
        const path = _oskConfigPath();
        const defaults = this._defaultConfig();
        try {
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) return defaults;
            const [ok, bytes] = file.load_contents(null);
            if (!ok) return defaults;
            const text = new TextDecoder('utf-8').decode(bytes);
            if (!text.trim()) return defaults;
            const cfg = JSON.parse(text);
            const userThemes = _sanitizeUserThemes(cfg.userThemes);
            return {
                configVersion: CONFIG_VERSION,
                predictionEnabled: cfg.predictionEnabled === true,
                showOnStartup: cfg.showOnStartup !== false,
                layout: LAYOUTS[cfg.layout] ? cfg.layout : DEFAULT_LAYOUT_KEY,
                customization: _sanitizeCustomization(
                    cfg.customization, userThemes),
                userThemes,
            };
        } catch (e) {
            log(`gnome-osk: config load failed: ${e}`);
            this._quarantineConfigFile(path, e.message || e);
            return defaults;
        }
    }

    // Apply a layout chosen from the Layout submenu (or from the
    // Windows-OSK internal "switch layout" action, if we ever wire
    // one up).  Rebuilds the key rows, resizes to the layout's
    // defaults (only when that would make the keyboard fit the work
    // area better -- we don't shrink a user who's already resized
    // larger than the new default), and persists the choice.
    _selectLayout(key) {
        if (!this._keyboard) return;
        if (!LAYOUTS[key]) return;
        if (this._keyboard.getLayout() === key) return;

        // Resize first, then rebuild the key rows against the target
        // geometry.  Rebuilding at the old size and resizing a moment
        // later can leave stale BoxLayout allocations around until the
        // user manually nudges the keyboard.
        const lay = LAYOUTS[key];
        const w = (lay && lay.defaultW) || 900;
        const h = (lay && lay.defaultH) || 380;
        this._keyboard.setConstrainedSize(
            Math.max(MIN_KEYBOARD_WIDTH, w),
            Math.max(MIN_KEYBOARD_HEIGHT, h));

        try {
            this._keyboard.setLayout(key);
        } catch (e) {
            log(`gnome-osk: layout switch to ${key} failed: ${e}`);
            return;
        }

        this._keyboard.refreshLayoutGeometry();

        this._config = this._config || {};
        this._config.layout = key;
        this._saveConfig();
        this._refreshLayoutMenu();
        log(`gnome-osk: layout switched to ${key}`);
    }

    // Update the "(active)" suffix on the Layout submenu items so the
    // check-mark-equivalent always points at the live layout.  Called
    // after _selectLayout and once at build time.
    _refreshLayoutMenu() {
        if (!this._layoutMenuItems) return;
        const active = this._keyboard ? this._keyboard.getLayout() : null;
        for (const [key, item] of Object.entries(this._layoutMenuItems)) {
            const lay = LAYOUTS[key];
            if (!lay) continue;
            item.label.text = (key === active)
                ? `${lay.label}  (active)`
                : lay.label;
        }
    }

    // Windows-OSK "Options" key: pop the right-click menu so the user
    // can reach the same settings without needing to right-click the
    // panel icon.  The menu belongs to the indicator; toggle() handles
    // both open and close if the user taps Options twice.
    _openOptionsMenu() {
        if (!this._indicator) return;
        const rc = this._indicator.getRightClickMenu();
        if (rc) rc.toggle();
    }

    // Windows-OSK "Help" key.  There's no detailed help surface yet;
    // for now we flash an OSD with the build tag so the user gets
    // visible acknowledgement the key works and can report which
    // build they're running.
    _showHelp() {
        try {
            Main.osdWindowManager.show(
                -1,
                new Gio.ThemedIcon({ name: 'input-keyboard-symbolic' }),
                `Nome - Onscreen Keyboard\n${OSK_BUILD_TAG}`,
                null, null);
        } catch (e) {
            log(`gnome-osk: _showHelp osd failed: ${e}`);
        }
    }

    _saveConfig() {
        // Fire-and-forget, synchronous.  Config is still small, and
        // callers debounce slider drags before reaching this point.
        if (this._sessionModeName === 'gdm') return;
        const path = _oskConfigPath();
        try {
            GLib.mkdir_with_parents(_oskDataDir(), 0o700);
            const cfg = Object.assign(this._defaultConfig(), this._config || {});
            cfg.configVersion = CONFIG_VERSION;
            cfg.userThemes = _sanitizeUserThemes(cfg.userThemes);
            cfg.customization = _sanitizeCustomization(
                cfg.customization, cfg.userThemes);
            cfg.layout = LAYOUTS[cfg.layout] ? cfg.layout : DEFAULT_LAYOUT_KEY;
            cfg.predictionEnabled = cfg.predictionEnabled === true;
            cfg.showOnStartup = cfg.showOnStartup !== false;
            this._config = cfg;
            const bytes = new TextEncoder().encode(
                JSON.stringify(cfg));
            const file = Gio.File.new_for_path(path);
            file.replace_contents(
                bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
        } catch (e) {
            log(`gnome-osk: config save failed: ${e}`);
        }
    }


    // ---- vocabulary status / download -----------------------------
    //
    // `_vocabularyStatus()` is the source of truth: reads the file
    // system to decide whether either of the predictor's candidate
    // wordlist paths has usable content.  Called from
    // `_refreshVocabStatus()` which repaints the submenu's status
    // line and download button.  During a download the status is
    // overridden by `_vocabStatusOverride` so the user sees
    // "Downloading..." / error messages without the FS-check path
    // racing ahead.

    _vocabularyStatus() {
        // Returns the on-disk state for BOTH data files the predictor
        // consumes: the base word list (unigrams) and the seed bigrams
        // file.  Each tracked independently so the menu can report
        // them separately ("50k words installed, bigrams missing").
        //
        // `wordCount` / `bigramCount` come from the predictor's
        // already-loaded stats when the found path matches what the
        // predictor last read -- saves re-parsing on every menu open.
        const findFirstExisting = (paths) => {
            for (const p of paths) {
                try {
                    const file = Gio.File.new_for_path(p);
                    if (!file.query_exists(null)) continue;
                    const info = file.query_info(
                        'standard::size',
                        Gio.FileQueryInfoFlags.NONE, null);
                    if (info.get_size() <= 0) continue;
                    return p;
                } catch (_e) { continue; }
            }
            return null;
        };

        const wordPath = findFirstExisting([
            _oskUserWordlistPath(),
            GLib.build_filenamev([this.path, 'wordlist.txt']),
        ]);
        const bigramPath = findFirstExisting([
            _oskUserSeedBigramsPath(),
            GLib.build_filenamev([this.path, 'seed-bigrams.txt']),
        ]);

        let wordCount = 0;
        let wordSourceCount = 0;
        let bigramCount = 0;
        if (this._predictor) {
            const stats = this._predictor.stats();
            if (wordPath &&
                this._predictor.getLoadedWordlistPath() === wordPath) {
                wordCount = stats.baseWords;
                wordSourceCount = stats.baseSourceEntries || 0;
            }
            if (bigramPath &&
                this._predictor.getLoadedSeedBigramsPath() === bigramPath) {
                bigramCount = stats.seedBigramPairs || 0;
            }
        }

        return {
            wordsInstalled: !!wordPath,
            bigramsInstalled: !!bigramPath,
            wordPath, bigramPath,
            wordCount, wordSourceCount, bigramCount,
        };
    }

    _refreshVocabStatus() {
        // Update the two submenu items created in _buildIndicatorMenu.
        // Called at menu build time, after a download finishes, and
        // whenever state changes (e.g. clearing learned words does
        // NOT affect this -- only the base dictionary / seed bigrams
        // do).
        if (!this._wpStatusItem || !this._wpDownloadItem) return;

        // Transient override (e.g. "Downloading...") wins over the
        // computed status so the user can see live feedback.
        if (this._vocabStatusOverride) {
            this._wpStatusItem.label.text = this._vocabStatusOverride;
        } else {
            const s = this._vocabularyStatus();
            if (!s.wordsInstalled && !s.bigramsInstalled) {
                this._wpStatusItem.label.text =
                    'Prediction data: not installed';
            } else {
                // Format:
                // "49,456 words loaded / 62,000 source entries,
                //  48,293 bigrams loaded".  Counts are shown even
                // when one side is missing so the user can tell which
                // file needs re-downloading.
                const wordPart = s.wordsInstalled
                    ? (s.wordCount > 0
                        ? (s.wordSourceCount > 0
                            ? `${this._formatCount(s.wordCount)} words loaded / ` +
                              `${this._formatCount(s.wordSourceCount)} source entries`
                            : `${this._formatCount(s.wordCount)} words loaded`)
                        : 'words installed')
                    : 'words MISSING';
                const bgPart = s.bigramsInstalled
                    ? (s.bigramCount > 0
                        ? `${this._formatCount(s.bigramCount)} bigrams loaded`
                        : 'bigrams installed')
                    : 'bigrams MISSING';
                this._wpStatusItem.label.text = `${wordPart}, ${bgPart}`;
            }
        }

        // Download button label + reactivity.  During a download we
        // freeze both so rapid re-clicks don't queue up a second curl.
        if (this._downloadInFlight) {
            this._wpDownloadItem.label.text = 'Downloading...';
            this._wpDownloadItem.reactive = false;
            this._wpDownloadItem.can_focus = false;
        } else {
            const s = this._vocabularyStatus();
            // Single button handles both files.  Label flips to "Re-"
            // once either file is present; the user just wants to
            // refresh in that case.
            this._wpDownloadItem.label.text =
                (s.wordsInstalled || s.bigramsInstalled)
                    ? 'Re-download prediction data'
                    : 'Download prediction data';
            this._wpDownloadItem.reactive = true;
            this._wpDownloadItem.can_focus = true;
        }
    }

    _formatCount(n) {
        // Thousands separators without pulling in Intl -- GJS has it
        // but the locale detection is occasionally flaky, and a plain
        // comma is unambiguous for this menu.
        const s = String(Math.max(0, n | 0));
        return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    _onDownloadVocabularyClicked() {
        if (this._downloadInFlight) return;
        // Clear any lingering error state from a previous attempt, set
        // the transient "Downloading..." status, freeze the button.
        // We run two downloads in sequence (wordlist, then seed
        // bigrams) because most users run on a single connection and
        // back-to-back Gio.Subprocesses are simpler than coordinating
        // parallel ones.  Either one succeeding independently is
        // counted as partial progress -- we only treat it as a total
        // failure if BOTH fail.
        this._downloadInFlight = true;
        this._vocabStatusOverride = 'Downloading vocabulary...';
        this._refreshVocabStatus();

        // --- step 1: wordlist ---
        this._downloadFile(
            WORDLIST_SOURCE_URL,
            _oskUserWordlistPath(),
            WORDLIST_DOWNLOAD_BYTES,
            WORDLIST_MAX_BYTES,
            (wOk, wMsg) => {
                if (wOk) {
                    if (WORDLIST_TOP_N > 0) {
                        // Optional quality/size cap.  Current builds
                        // keep the full file (WORDLIST_TOP_N = 0), but
                        // this path stays here for future smaller builds.
                        const trimOk = this._truncateFileLines(
                            _oskUserWordlistPath(), WORDLIST_TOP_N);
                        if (!trimOk) {
                            wOk = false;
                            wMsg = 'downloaded but trim failed';
                        }
                    }
                    if (wOk) {
                        try { this._predictor.loadBaseDictionary(); }
                        catch (e) {
                            log(`gnome-osk: reload (words) failed: ${e}`);
                        }
                    }
                }

                // --- step 2: seed bigrams ---
                this._vocabStatusOverride =
                    wOk ? 'Downloading bigrams...'
                        : `Vocabulary failed (${wMsg}); trying bigrams...`;
                this._refreshVocabStatus();

                this._downloadFile(
                    SEED_BIGRAMS_SOURCE_URL,
                    _oskUserSeedBigramsPath(),
                    /* maxRangeBytes */ 0,   // need full file for sort
                    SEED_BIGRAMS_MAX_BYTES,
                    (bOk, bMsg) => {
                        if (bOk) {
                            // Norvig's file is alphabetically sorted;
                            // re-sort by count desc and truncate to
                            // the top N so the on-disk file (and the
                            // predictor's in-memory Map) stay small.
                            const sortOk = this._sortSeedBigramsFile(
                                _oskUserSeedBigramsPath(),
                                SEED_BIGRAMS_TOP_N);
                            if (!sortOk) {
                                bMsg = 'downloaded but sort failed';
                                bOk = false;
                            } else {
                                try { this._predictor.loadSeedBigrams(); }
                                catch (e) {
                                    log(`gnome-osk: reload (bigrams) failed: ${e}`);
                                }
                            }
                        }
                        this._downloadInFlight = false;
                        if (this._keyboard && this._keyboard._predictionEnabled) {
                            this._keyboard._refreshPredictions();
                        }
                        this._writePredictionDataManifest({
                            wordsOk: wOk,
                            wordsMessage: wMsg || '',
                            bigramsOk: bOk,
                            bigramsMessage: bMsg || '',
                        });

                        if (wOk && bOk) {
                            this._vocabStatusOverride = null;
                            log(`gnome-osk: vocabulary + bigrams installed`);
                        } else if (!wOk && !bOk) {
                            this._vocabStatusOverride =
                                `Download failed (words: ${wMsg}, bigrams: ${bMsg})`;
                            log(`gnome-osk: both downloads failed`);
                        } else if (!wOk) {
                            this._vocabStatusOverride =
                                `Bigrams ok, words failed (${wMsg})`;
                        } else {
                            this._vocabStatusOverride =
                                `Words ok, bigrams failed (${bMsg})`;
                        }
                        this._refreshVocabStatus();
                    }
                );
            }
        );
    }

    _writePredictionDataManifest(result) {
        result = result || {};
        try {
            GLib.mkdir_with_parents(_oskDataDir(), 0o700);
            const stamp = GLib.DateTime.new_now_utc()
                .format('%Y-%m-%dT%H:%M:%SZ');
            const wordInfo = this._predictionDataFileInfo(_oskUserWordlistPath());
            const bigramInfo = this._predictionDataFileInfo(_oskUserSeedBigramsPath());
            const manifest = {
                version: PREDICTION_DATA_VERSION,
                updatedAt: stamp,
                wordlist: {
                    path: _oskUserWordlistPath(),
                    source: WORDLIST_SOURCE_URL,
                    topN: WORDLIST_TOP_N,
                    ok: !!result.wordsOk,
                    message: result.wordsMessage || '',
                    bytes: wordInfo.bytes,
                    sha256: wordInfo.sha256,
                },
                seedBigrams: {
                    path: _oskUserSeedBigramsPath(),
                    source: SEED_BIGRAMS_SOURCE_URL,
                    topN: SEED_BIGRAMS_TOP_N,
                    ok: !!result.bigramsOk,
                    message: result.bigramsMessage || '',
                    bytes: bigramInfo.bytes,
                    sha256: bigramInfo.sha256,
                },
            };
            const bytes = new TextEncoder().encode(
                JSON.stringify(manifest, null, 2) + '\n');
            Gio.File.new_for_path(_oskPredictionManifestPath())
                .replace_contents(
                    bytes, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null
                );
        } catch (e) {
            log(`gnome-osk: prediction manifest write failed: ${e}`);
        }
    }

    _predictionDataFileInfo(path) {
        try {
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) return { bytes: 0, sha256: '' };
            const info = file.query_info(
                'standard::size',
                Gio.FileQueryInfoFlags.NONE, null);
            const [ok, bytes] = file.load_contents(null);
            if (!ok) return { bytes: info.get_size(), sha256: '' };
            const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
            checksum.update(bytes);
            return {
                bytes: info.get_size(),
                sha256: checksum.get_string(),
            };
        } catch (e) {
            log(`gnome-osk: prediction checksum failed for ${path}: ${e}`);
            return { bytes: 0, sha256: '' };
        }
    }

    // Async file download.  Shared by both the wordlist and the
    // seed-bigrams fetches.  Flow:
    //   1. mkdir the containing directory if needed;
    //   2. spawn curl (preferred) or wget under Gio.Subprocess;
    //   3. validate the temp file (size sanity);
    //   4. atomic move to the final path.
    // Fires `callback(success, message)` on the main loop once the
    // child exits.  maxRangeBytes > 0 enables an HTTP Range GET (used
    // to download only the first N bytes of Norvig's 200 MiB bigram
    // corpus); ignored when 0.
    _downloadFile(url, destPath, maxRangeBytes, maxFileBytes, callback) {
        const cb = (ok, msg) => {
            try { callback(ok, msg); }
            catch (e) { log(`gnome-osk: download callback threw: ${e}`); }
        };

        const tmp = destPath + '.tmp';
        try {
            GLib.mkdir_with_parents(
                GLib.path_get_dirname(destPath), 0o700);
        } catch (e) {
            cb(false, `can't create data dir: ${e.message || e}`);
            return;
        }
        // Clear any stale .tmp from a previous aborted run.
        try {
            const stale = Gio.File.new_for_path(tmp);
            if (stale.query_exists(null)) stale.delete(null);
        } catch (_e) { /* best-effort */ }

        const curl = GLib.find_program_in_path('curl');
        const wget = GLib.find_program_in_path('wget');
        let argv;
        const timeout = maxRangeBytes > 0 ? '60' : '180';
        if (curl) {
            argv = [curl, '-fsSL', '--max-time', timeout];
            if (maxRangeBytes > 0) {
                // curl's --range is "start-end" inclusive.
                argv.push('--range', `0-${maxRangeBytes - 1}`);
            }
            argv.push(url, '-o', tmp);
        } else if (wget) {
            argv = [wget, '-q', `--timeout=${timeout}`];
            if (maxRangeBytes > 0) {
                // wget needs the full Range header form.
                argv.push('--header', `Range: bytes=0-${maxRangeBytes - 1}`);
            }
            argv.push(url, '-O', tmp);
        } else {
            cb(false, 'neither curl nor wget found');
            return;
        }

        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            cb(false, `spawn failed: ${e.message || e}`);
            return;
        }

        proc.wait_async(null, (source, result) => {
            let exitOk = false;
            try {
                source.wait_finish(result);
                exitOk = source.get_successful();
            } catch (e) {
                cb(false, `wait_async: ${e.message || e}`);
                return;
            }
            if (!exitOk) {
                try { Gio.File.new_for_path(tmp).delete(null); }
                catch (_e) {}
                cb(false, 'HTTP error or network failure');
                return;
            }
            try {
                const tmpFile = Gio.File.new_for_path(tmp);
                if (!tmpFile.query_exists(null)) {
                    cb(false, 'no file produced');
                    return;
                }
                const info = tmpFile.query_info(
                    'standard::size',
                    Gio.FileQueryInfoFlags.NONE, null);
                const size = info.get_size();
                if (size <= 0) {
                    try { tmpFile.delete(null); } catch (_e) {}
                    cb(false, 'downloaded file was empty');
                    return;
                }
                if (maxFileBytes > 0 && size > maxFileBytes) {
                    try { tmpFile.delete(null); } catch (_e) {}
                    cb(false, `file too large (${size} bytes)`);
                    return;
                }
                // Atomic-ish move.  OVERWRITE lets this replace any
                // existing file at the destination (re-download path).
                const destFile = Gio.File.new_for_path(destPath);
                tmpFile.move(
                    destFile,
                    Gio.FileCopyFlags.OVERWRITE,
                    null, null
                );
                cb(true, 'installed');
            } catch (e) {
                cb(false, `post-download: ${e.message || e}`);
            }
        });
    }

    // Truncate a text file to its first N lines, rewriting the file
    // in place.  Current builds keep the full wordlist, but this is
    // still available for future size-capped vocabularies.
    _truncateFileLines(path, topN) {
        try {
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) return false;
            const [loadOk, bytes] = file.load_contents(null);
            if (!loadOk) return false;
            const text = new TextDecoder('utf-8').decode(bytes);
            const lines = text.split(/\r?\n/);
            const kept = lines.slice(0, topN);
            const output = kept.join('\n') + '\n';
            const outBytes = new TextEncoder().encode(output);
            file.replace_contents(
                outBytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
            log(`gnome-osk: wordlist truncated to ${kept.length} lines ` +
                `(from ${lines.length})`);
            return true;
        } catch (e) {
            log(`gnome-osk: truncate wordlist failed: ${e}`);
            return false;
        }
    }

    // Post-process a just-downloaded Norvig-format bigram file in
    // place: parse each "word1 word2\tcount" line, sort by count
    // descending, keep the top `topN`, rewrite the file in our
    // "prev next count" format.  Synchronous (the file is ~5 MiB,
    // parse+sort is a few hundred ms in GJS), runs after the async
    // download has completed so we're not blocking user input on
    // the sort.  Returns true on success, false if anything went
    // wrong -- caller decides whether to keep the raw file or not.
    _sortSeedBigramsFile(path, topN) {
        try {
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) return false;
            const [loadOk, bytes] = file.load_contents(null);
            if (!loadOk) return false;
            const text = new TextDecoder('utf-8').decode(bytes);

            const entries = [];
            for (const raw of text.split(/\r?\n/)) {
                const line = raw.trim();
                if (!line || line.startsWith('#')) continue;
                // Norvig lines are "word1 word2\tcount"; splitting on
                // /\s+/ gives three tokens either way.
                const parts = line.split(/\s+/);
                if (parts.length < 3) continue;
                const c = parseInt(parts[2], 10);
                if (!isFinite(c) || c <= 0) continue;
                entries.push([parts[0], parts[1], c]);
            }
            if (entries.length === 0) return false;

            entries.sort((a, b) => b[2] - a[2]);
            const top = entries.slice(0, topN);
            // Rewrite in our own "prev next count" format (tab -> space
            // for consistency with the hand-curated seed-bigrams.txt).
            const output = top
                .map(e => `${e[0]} ${e[1]} ${e[2]}`)
                .join('\n') + '\n';
            const outBytes = new TextEncoder().encode(output);
            file.replace_contents(
                outBytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
            log(`gnome-osk: seed bigrams sorted ` +
                `(${top.length} kept of ${entries.length} parsed)`);
            return true;
        } catch (e) {
            log(`gnome-osk: sort seed bigrams failed: ${e}`);
            return false;
        }
    }


    _snapPosition(pos) {
        // Centre horizontally, place vertically according to `pos`.
        // 20 px margin from top/bottom matches the default offset
        // used when the extension first starts.
        const keyboard = this._keyboardOrNull('_snapPosition');
        if (!keyboard) return;
        const pIdx = Main.layoutManager.primaryIndex;
        const area = Main.layoutManager.getWorkAreaForMonitor(pIdx);
        const cur = keyboard._currentGeometry
            ? keyboard._currentGeometry()
            : {
                x: keyboard.get_x(),
                y: keyboard.get_y(),
                w: keyboard.width,
                h: keyboard.height,
            };
        const w = cur.w;
        const h = cur.h;
        const x = Math.floor(area.x + (area.width - w) / 2);
        let y;
        if (pos === 'top')
            y = area.y + KEYBOARD_SCREEN_MARGIN;
        else if (pos === 'middle')
            y = Math.floor(area.y + (area.height - h) / 2);
        else
            y = Math.floor(area.y + area.height - h - KEYBOARD_SCREEN_MARGIN);
        const geom = _fitKeyboardRectToWorkArea(x, y, w, h, area);
        if (geom.w !== cur.w || geom.h !== cur.h)
            keyboard._applyKeyboardSize(geom.w, geom.h);
        if (geom.x !== cur.x || geom.y !== cur.y)
            keyboard.set_position(geom.x, geom.y);
    }

    _requestDisable() {
        // Schedule disable for the next tick -- disabling while we're
        // still inside an event handler tears down code that's still
        // on the stack.  idle_add defers until the current tick ends.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                Main.extensionManager.disableExtension(this.uuid);
            } catch (e) {
                log(`gnome-osk: disableExtension failed: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        // Drop the D-Bus interface first so a late .desktop-launch
        // toggle can't poke a half-disabled extension and call
        // _setVisible on a destroyed keyboard.
        try { this._unexportDBus(); }
        catch (e) { log(`gnome-osk: dbus unexport failed: ${e}`); }
        if (this._sessionModeUpdatedId && Main.sessionMode) {
            try { Main.sessionMode.disconnect(this._sessionModeUpdatedId); }
            catch (_e) {}
            this._sessionModeUpdatedId = 0;
        }
        this._cancelAuthVisibilityRetry();
        _clearSource(this, '_predictorLoadId');
        this._uninstallModalRaiseHooks();
        this._leaveModalBridge('disable', false);

        // Final flush of customization + user themes to disk before
        // we tear anything down, so a Shell restart / extension
        // reload never loses an in-flight edit.  Wrapped because
        // disable() must succeed even when the predictor / config
        // path is temporarily borked.
        try {
            if (this._keyboard) this._persistCustomization();
            this._flushConfigSave();
        } catch (e) { log(`gnome-osk: persist on disable failed: ${e}`); }
        // Clear menu-item references first so any in-flight download
        // callback that fires after this point -- `_downloadFile` is
        // async and not cancelable from here -- lands on the
        // "already destroyed" branch of `_refreshVocabStatus` instead
        // of poking a dead St.Widget and spamming the journal.
        this._wpEnableItem = null;
        this._wpStatusItem = null;
        this._wpDownloadItem = null;
        this._vocabStatusOverride = null;
        // Layout-submenu items come down with the indicator (they're
        // children of its popup) but null the map so stale references
        // can't outlive the actor tree if disable() is followed by a
        // late enable() in the same process.
        this._layoutMenuItems = null;
        // Close any open Customize window (chrome-level actor) --
        // removeChrome detaches it from the layout manager and
        // destroy() drops the actor tree.  Nulling the supporting
        // refs defends against stale callbacks running after disable.
        // If the picker was mid-flight the window sits under
        // window_group instead; remove from whichever parent it's in.
        if (this._customWindow) {
            const parent = this._customWindow.get_parent();
            if (this._customWinLowered && parent) {
                try { parent.remove_child(this._customWindow); }
                catch (_e) { /* best-effort */ }
            } else {
                try { Main.layoutManager.removeChrome(this._customWindow); }
                catch (_e) { /* already gone */ }
            }
            try { this._customWindow.destroy(); }
            catch (_e) { /* already destroyed */ }
            this._customWindow = null;
            this._customWinLowered = false;
            this._customWinSaved = null;
        }
        this._controlRefreshers = null;
        this._scrollBody = null;
        this._themeCards = null;
        this._themeGridWrap = null;
        this._picker = null;
        this._pickerSv = null;
        this._pickerHue = null;
        this._pickerEntry = null;
        this._pickerPreview = null;
        this._pickerTarget = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        // Drop the stage-level captured-event handler before the
        // keyboard goes away, so any in-flight event re-dispatch can't
        // land on a destroyed actor.
        this._uninstallModalAwareInput();
        this._uninstallShellKeyboardEventBridge();
        if (this._keyboard) {
            const keyboard = this._keyboard;
            this._keyboard = null;
            this._modalPointerTarget = null;
            // Drop every per-key RGB transition while _customization
            // is still readable.  OSKKey._onDestroy would do the same
            // when the actor tree comes down, but doing it here first
            // means the explicit Clutter background colors are cleared
            // before the actors paint their last frame.
            try { keyboard._teardownRgbAnimation(); }
            catch (e) { log(`gnome-osk: rgb teardown failed: ${e}`); }
            this._detachKeyboardFromShellLayer(keyboard);
            try { keyboard.destroy(); }
            catch (_e) {}
        }
        this._destroyAuthKeyboardHost();
        // Flush any pending debounced save in the predictor -- this
        // catches the "user turned off extension within 3s of their
        // last typed word" case where the save timer hasn't fired.
        if (this._predictor) {
            this._predictor.destroy();
            this._predictor = null;
        }
        this._predictorReady = false;
        // Unload the stylesheet we manually loaded in enable().
        if (this._stylesheetFile) {
            try {
                const theme = St.ThemeContext
                    .get_for_stage(global.stage).get_theme();
                theme.unload_stylesheet(this._stylesheetFile);
            } catch (_e) { }
            this._stylesheetFile = null;
        }
        // Null out the virtual device; its lifetime is tied to the seat,
        // there's no explicit destroy.
        this._virtualDevice = null;
    }

    _onSessionModeUpdated() {
        const wasAuth = !!this._authSessionMode;
        const keyboard = this._keyboardOrNull('_onSessionModeUpdated');
        const previousVisible = keyboard ? !!keyboard.visible : false;
        this._sessionModeName = this._sessionMode();
        this._authSessionMode = this._isAuthSessionMode();
        if (!keyboard) return;
        if (keyboard.setAuthMode)
            keyboard.setAuthMode(this._authSessionMode);

        if (!wasAuth && this._authSessionMode) {
            this._uninstallShellKeyboardEventBridge();
            this._installModalAwareInput();
            this._installModalRaiseHooks();
            this._preAuthVisible = previousVisible;
            this._restoreAuthKeyboard('session-enter-auth');
            this._scheduleAuthVisibilityRetry('session-enter-auth');
            return;
        }
        if (wasAuth && !this._authSessionMode) {
            this._uninstallModalAwareInput();
            this._installShellKeyboardEventBridge();
            this._cancelAuthVisibilityRetry();
            this._leaveModalBridge('session-leave-auth', false);
            this._restoreKeyboardFromAuthHost('session-leave-auth');
            const restore = this._preAuthVisible;
            this._preAuthVisible = undefined;
            this._setVisible(restore !== undefined
                ? !!restore : this._config.showOnStartup !== false);
        }
    }

    _keyboardOrNull(reason) {
        const keyboard = this._keyboard;
        if (!keyboard) return null;
        try {
            if (typeof keyboard.is_destroyed === 'function'
                && keyboard.is_destroyed()) {
                throw new Error('actor destroyed');
            }
            // Accessing a property is enough to catch disposed GObject
            // wrappers before the stage-level capture path trips over
            // them repeatedly.
            void keyboard.visible;
            return keyboard;
        } catch (e) {
            this._keyboard = null;
            this._modalPointerTarget = null;
            this._cancelAuthVisibilityRetry();
            log(`gnome-osk: dropped disposed keyboard actor (${reason}): ${e}`);
            return null;
        }
    }

    _setVisible(visible) {
        const keyboard = this._keyboardOrNull('_setVisible');
        if (!keyboard) return;
        visible = !!visible;
        let wasVisible = false;
        try { wasVisible = !!keyboard.visible; } catch (_e) {}
        if (visible && keyboard.ensureOnScreen)
            keyboard.ensureOnScreen();
        keyboard.visible = visible;
        if (visible && !wasVisible) {
            keyboard._visibleEffectsPaused = false;
            if (keyboard._queuePostLayoutRefresh)
                keyboard._queuePostLayoutRefresh();
        }
    }

    _addKeyboardToChrome(reason, force = false) {
        const keyboard = this._keyboardOrNull('_addKeyboardToChrome');
        if (!keyboard) return false;
        const lm = Main.layoutManager;
        if (!lm) return false;

        const parent = keyboard.get_parent ? keyboard.get_parent() : null;
        if (parent && !this._keyboardInModalLayer) {
            const chromeParent = lm.uiGroup || Main.uiGroup || null;
            if (!force || parent === chromeParent) {
                this._raiseKeyboardToTop(reason || 'already-in-chrome');
                return true;
            }
        }
        const [stageX, stageY] = this._actorStagePosition(keyboard);

        try {
            if (keyboard._destroyBackgroundLayer)
                keyboard._destroyBackgroundLayer();
        } catch (_e) {}

        if (parent) {
            try { parent.remove_child(keyboard); } catch (_e) {}
        }

        try {
            const addChromeFn = typeof lm.addTopChrome === 'function'
                ? lm.addTopChrome.bind(lm)
                : lm.addChrome.bind(lm);
            addChromeFn(keyboard, {
                affectsStruts: false,
                trackFullscreen: false,
            });
            this._setActorStagePosition(keyboard, stageX, stageY);
            this._keyboardInModalLayer = false;
            this._disconnectKeyboardModalHost();
            this._keyboardModalHost = null;
            this._raiseKeyboardToTop(reason || 'add-chrome');
            return true;
        } catch (e) {
            log(`gnome-osk: add keyboard to chrome failed (${reason}): ${e}`);
            return false;
        }
    }

    _authHostParent() {
        return Main.uiGroup
            || (Main.layoutManager && Main.layoutManager.uiGroup)
            || global.stage
            || null;
    }

    _ensureAuthKeyboardHost(reason) {
        if (!this._authSessionMode)
            return null;

        const parent = this._authHostParent();
        if (!parent || typeof parent.add_child !== 'function')
            return null;

        let host = this._authKeyboardHost;
        const hostParent = host && host.get_parent ? host.get_parent() : null;
        if (host && hostParent !== parent) {
            try {
                if (hostParent)
                    hostParent.remove_child(host);
            } catch (_e) {}
            host = null;
            this._authKeyboardHost = null;
            this._authKeyboardHostDestroyId = 0;
        }

        if (!host) {
            host = new St.Widget({
                name: 'gnome-osk-auth-host',
                reactive: false,
                visible: true,
            });
            try { host.set_no_layout(true); } catch (_e) {}
            try {
                host.add_constraint(new Clutter.BindConstraint({
                    source: global.stage,
                    coordinate: Clutter.BindCoordinate.ALL,
                }));
            } catch (_e) {
                try {
                    host.set_position(0, 0);
                    host.set_size(global.stage.width, global.stage.height);
                } catch (__e) {}
            }
            try {
                parent.add_child(host);
            } catch (e) {
                log(`gnome-osk: auth host add failed (${reason}): ${e}`);
                try { host.destroy(); } catch (_e) {}
                return null;
            }
            try {
                this._authKeyboardHostDestroyId = host.connect('destroy', () => {
                    this._authKeyboardHostDestroyId = 0;
                    this._authKeyboardHost = null;
                    this._keyboardInAuthHost = false;
                });
            } catch (_e) {
                this._authKeyboardHostDestroyId = 0;
            }
            this._authKeyboardHost = host;
            log(`gnome-osk: auth keyboard host created (${reason})`);
        }

        host.visible = true;
        try {
            host.set_position(0, 0);
            host.set_size(
                global.stage.width || global.screen_width || 1,
                global.stage.height || global.screen_height || 1);
        } catch (_e) {}
        try {
            parent.set_child_above_sibling(host, null);
        } catch (_e) {}
        return host;
    }

    _moveKeyboardToAuthHost(reason) {
        if (!this._authSessionMode)
            return false;
        const keyboard = this._keyboardOrNull('_moveKeyboardToAuthHost');
        const host = this._ensureAuthKeyboardHost(reason);
        if (!keyboard || !host)
            return false;

        const parent = keyboard.get_parent ? keyboard.get_parent() : null;
        if (parent === host) {
            this._keyboardInAuthHost = true;
            this._keyboardInModalLayer = false;
            this._raiseAuthKeyboardHost(reason || 'auth-host-raise');
            return true;
        }

        const [stageX, stageY] = this._actorStagePosition(keyboard);
        try {
            if (keyboard._destroyBackgroundLayer)
                keyboard._destroyBackgroundLayer();
        } catch (_e) {}
        try { Main.layoutManager.removeChrome(keyboard); }
        catch (_e) {}
        const afterChromeParent = keyboard.get_parent
            ? keyboard.get_parent() : null;
        if (afterChromeParent && afterChromeParent !== host) {
            try { afterChromeParent.remove_child(keyboard); } catch (_e) {}
        }

        try {
            host.add_child(keyboard);
            this._setActorStagePosition(keyboard, stageX, stageY);
            this._keyboardInAuthHost = true;
            this._keyboardInModalLayer = false;
            this._disconnectKeyboardModalHost();
            this._keyboardModalHost = null;
            this._raiseAuthKeyboardHost(reason || 'auth-host');
            return true;
        } catch (e) {
            this._keyboardInAuthHost = false;
            log(`gnome-osk: move keyboard to auth host failed (${reason}): ${e}`);
            return false;
        }
    }

    _raiseAuthKeyboardHost(reason) {
        const host = this._authKeyboardHost;
        const keyboard = this._keyboardOrNull('_raiseAuthKeyboardHost');
        const parent = host && host.get_parent ? host.get_parent() : null;
        if (host && parent && parent.set_child_above_sibling) {
            try { parent.set_child_above_sibling(host, null); }
            catch (e) { log(`gnome-osk: raise auth host failed (${reason}): ${e}`); }
        }
        if (keyboard && keyboard.get_parent && keyboard.get_parent() === host
            && host && host.set_child_above_sibling) {
            try { host.set_child_above_sibling(keyboard, null); }
            catch (_e) {}
        }
        if (keyboard && keyboard._syncBackgroundLayer)
            keyboard._syncBackgroundLayer();
    }

    _restoreKeyboardFromAuthHost(reason) {
        if (!this._keyboardInAuthHost)
            return;
        this._addKeyboardToChrome(reason || 'restore-from-auth-host', true);
        this._keyboardInAuthHost = false;
        this._destroyAuthKeyboardHost();
    }

    _destroyAuthKeyboardHost() {
        const host = this._authKeyboardHost;
        if (!host)
            return;
        if (this._authKeyboardHostDestroyId) {
            try { host.disconnect(this._authKeyboardHostDestroyId); }
            catch (_e) {}
        }
        this._authKeyboardHostDestroyId = 0;
        this._authKeyboardHost = null;
        this._keyboardInAuthHost = false;
        try { host.destroy(); } catch (_e) {}
    }

    _modalLayer() {
        return Main.layoutManager && Main.layoutManager.modalDialogGroup;
    }

    _modalKeyboardHost() {
        const grab = this._stageGrabActor();
        if (grab && grab !== global.stage
            && !this._isKeyboardDescendant(grab)
            && typeof grab.add_child === 'function') {
            return grab;
        }
        const modalLayer = this._modalLayer();
        if (modalLayer && typeof modalLayer.add_child === 'function')
            return modalLayer;
        return null;
    }

    _moveKeyboardToModalLayer(reason) {
        const keyboard = this._keyboardOrNull('_moveKeyboardToModalLayer');
        const host = this._modalKeyboardHost();
        if (!keyboard || !host) return false;

        const parent = keyboard.get_parent ? keyboard.get_parent() : null;
        if (parent === host) {
            this._keyboardInModalLayer = true;
            this._connectKeyboardModalHost(host);
            this._keyboardModalHost = host;
            this._raiseKeyboardToTop(reason || 'modal-layer-raise');
            return true;
        }
        const [stageX, stageY] = this._actorStagePosition(keyboard);

        try {
            if (keyboard._destroyBackgroundLayer)
                keyboard._destroyBackgroundLayer();
        } catch (_e) {}

        try { Main.layoutManager.removeChrome(keyboard); }
        catch (_e) {}

        const afterRemoveParent = keyboard.get_parent
            ? keyboard.get_parent() : null;
        if (afterRemoveParent && afterRemoveParent !== host) {
            try { afterRemoveParent.remove_child(keyboard); } catch (_e) {}
        }

        try {
            host.add_child(keyboard);
            this._setActorStagePosition(keyboard, stageX, stageY);
            this._keyboardInModalLayer = true;
            this._connectKeyboardModalHost(host);
            this._keyboardModalHost = host;
            this._raiseKeyboardToTop(reason || 'modal-layer');
            return true;
        } catch (e) {
            this._keyboardInModalLayer = false;
            this._disconnectKeyboardModalHost();
            this._keyboardModalHost = null;
            log(`gnome-osk: move keyboard to modal layer failed (${reason}): ${e}`);
            this._addKeyboardToChrome('modal-layer-fallback');
            return false;
        }
    }

    _restoreKeyboardFromModalLayer(reason) {
        const keyboard = this._keyboardOrNull('_restoreKeyboardFromModalLayer');
        if (!keyboard || !this._keyboardInModalLayer) return;
        this._addKeyboardToChrome(reason || 'restore-from-modal-layer');
    }

    _detachKeyboardFromShellLayer(keyboard) {
        if (!keyboard) return;
        try {
            if (keyboard._destroyBackgroundLayer)
                keyboard._destroyBackgroundLayer();
        } catch (_e) {}
        try { Main.layoutManager.removeChrome(keyboard); }
        catch (_e) {}
        const parent = keyboard.get_parent ? keyboard.get_parent() : null;
        if (parent) {
            try { parent.remove_child(keyboard); } catch (_e) {}
        }
        this._keyboardInModalLayer = false;
        this._keyboardInAuthHost = false;
        this._disconnectKeyboardModalHost();
        this._keyboardModalHost = null;
    }

    _connectKeyboardModalHost(host) {
        if (this._keyboardModalHost === host
            && this._keyboardModalHostDestroyId)
            return;
        this._disconnectKeyboardModalHost();
        this._keyboardModalHost = host || null;
        if (!host || !host.connect) return;
        try {
            this._keyboardModalHostDestroyId = host.connect('destroy', () => {
                this._keyboardModalHostDestroyId = 0;
                this._keyboardModalHost = null;
                if (this._keyboardInModalLayer)
                    this._addKeyboardToChrome('modal-host-destroyed');
            });
        } catch (_e) {
            this._keyboardModalHostDestroyId = 0;
        }
    }

    _disconnectKeyboardModalHost() {
        if (this._keyboardModalHost && this._keyboardModalHostDestroyId) {
            try {
                this._keyboardModalHost.disconnect(
                    this._keyboardModalHostDestroyId);
            } catch (_e) {}
        }
        this._keyboardModalHostDestroyId = 0;
    }

    _actorStagePosition(actor) {
        if (!actor) return [0, 0];
        try {
            const [x, y] = actor.get_transformed_position();
            return [Math.round(x), Math.round(y)];
        } catch (_e) {}
        try {
            return [Math.round(actor.get_x()), Math.round(actor.get_y())];
        } catch (_e) {}
        return [0, 0];
    }

    _setActorStagePosition(actor, stageX, stageY) {
        if (!actor) return;
        const parent = actor.get_parent ? actor.get_parent() : null;
        let px = 0;
        let py = 0;
        if (parent) {
            try { [px, py] = parent.get_transformed_position(); }
            catch (_e) {
                try {
                    px = parent.get_x();
                    py = parent.get_y();
                } catch (__e) {
                    px = 0;
                    py = 0;
                }
            }
        }
        try {
            actor.set_position(
                Math.round(stageX - px),
                Math.round(stageY - py));
        } catch (_e) {}
    }

    _restoreAuthKeyboard(reason) {
        if (!this._authSessionMode)
            return;
        const keyboard = this._keyboardOrNull('_restoreAuthKeyboard');
        if (!keyboard)
            return;
        if (this._keyboardInAuthHost)
            this._restoreKeyboardFromAuthHost(reason || 'auth-restore');
        else
            this._addKeyboardToChrome(reason || 'auth-restore', true);
        this._setVisible(true);
        try { this._snapPosition('bottom'); } catch (_e) {}
        this._raiseKeyboardToTop(reason || 'auth-restore');
        try {
            const parent = keyboard.get_parent ? keyboard.get_parent() : null;
            const parentName = parent ? this._actorDescriptor(parent) : 'none';
            log(`gnome-osk: auth restore ${reason || 'auth'} ` +
                `visible=${keyboard.visible ? '1' : '0'} ` +
                `parent=${parentName || 'actor'} ` +
                `pos=${Math.round(keyboard.get_x())},${Math.round(keyboard.get_y())} ` +
                `size=${Math.round(keyboard.width)}x${Math.round(keyboard.height)}`);
        } catch (e) {
            log(`gnome-osk: auth restore diagnostic failed: ${e}`);
        }
    }

    _scheduleAuthVisibilityRetry(reason) {
        if (!this._authSessionMode || !this._keyboard) return;
        this._cancelAuthVisibilityRetry();
        this._authVisibilityRetryId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._authVisibilityRetryId = 0;
                if (this._authSessionMode && this._keyboard)
                    this._restoreAuthKeyboard(`${reason || 'auth'}-idle`);
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelAuthVisibilityRetry() {
        _clearSource(this, '_authVisibilityRetryId');
    }

    _raiseKeyboardToTop(reason) {
        const keyboard = this._keyboardOrNull('_raiseKeyboardToTop');
        if (!keyboard) return;
        const parent = keyboard.get_parent ? keyboard.get_parent() : null;
        if (!parent || !parent.set_child_above_sibling) return;
        try {
            parent.set_child_above_sibling(keyboard, null);
        } catch (e) {
            log(`gnome-osk: raise keyboard failed (${reason}): ${e}`);
        }
        if (keyboard._syncBackgroundLayer)
            keyboard._syncBackgroundLayer();
    }

    _installModalRaiseHooks() {
        if (!Main.layoutManager || !Main.layoutManager.connect)
            return;
        if (!this._layoutManagerModalId) {
            try {
                this._layoutManagerModalId = Main.layoutManager.connect(
                    'system-modal-opened',
                    () => this._onSystemModalOpened());
            } catch (e) {
                this._layoutManagerModalId = 0;
                log(`gnome-osk: modal open hook unavailable: ${e}`);
            }
        }
        if (!this._layoutManagerModalClosedId) {
            try {
                this._layoutManagerModalClosedId = Main.layoutManager.connect(
                    'system-modal-closed',
                    () => this._onSystemModalClosed());
            } catch (_e) {
                this._layoutManagerModalClosedId = 0;
            }
        }
    }

    _uninstallModalRaiseHooks() {
        if (this._layoutManagerModalId) {
            try { Main.layoutManager.disconnect(this._layoutManagerModalId); }
            catch (_e) {}
            this._layoutManagerModalId = 0;
        }
        if (this._layoutManagerModalClosedId) {
            try { Main.layoutManager.disconnect(this._layoutManagerModalClosedId); }
            catch (_e) {}
            this._layoutManagerModalClosedId = 0;
        }
    }

    _onSystemModalOpened() {
        const keyboard = this._keyboardOrNull('_onSystemModalOpened');
        if (keyboard) {
            if (this._authSessionMode) {
                if (this._modalBridgePreVisible === undefined)
                    this._modalBridgePreVisible = !!keyboard.visible;
            } else {
                this._modalBridgePreVisible = !!keyboard.visible;
            }
            this._setVisible(true);
            this._raiseKeyboardToTop('system-modal-opened');
        }
        this._enterModalBridge('system-modal-opened');
    }

    _onSystemModalClosed() {
        if (!this._authSessionMode) {
            this._leaveModalBridge('system-modal-closed');
            return;
        }
        if (!this._isModalStackActive()) {
            this._leaveModalBridge('system-modal-closed');
            return;
        }
        this._raiseKeyboardToTop('system-modal-still-active');
    }

    _enterModalBridge(reason) {
        this._rememberModalGrabActor();
        // Do not install an extension-owned stage grab. GNOME Shell
        // already owns modal input; adding our own grab can block the
        // greeter or create the invisible input layer seen on system
        // popups. Pointer rerouting happens only for OSK coordinates in
        // the capture handler / Main.keyboard bridge.
        this._dismissModalBridgeGrab(reason || 'passive-modal');
    }

    _dismissModalBridgeGrab(reason) {
        const hadGrab = !!this._modalBridgeGrab;
        if (this._modalBridgeGrab) {
            try { this._modalBridgeGrab.dismiss(); } catch (_e) {}
            this._modalBridgeGrab = null;
        }
        if (hadGrab)
            log(`gnome-osk: modal input bridge disabled (${reason})`);
        return hadGrab;
    }

    _leaveModalBridge(reason, restoreVisibility = true) {
        this._dismissModalBridgeGrab(reason);
        this._modalBridgeModalActor = null;
        this._modalPointerTarget = null;
        this._clearCapturedHover();
        this._restoreKeyboardFromModalLayer(reason);

        const restore = this._modalBridgePreVisible;
        this._modalBridgePreVisible = undefined;
        if (restoreVisibility && !this._authSessionMode
            && restore !== undefined && this._keyboard) {
            this._setVisible(!!restore);
        }

    }

    _stageGrabActor() {
        try {
            if (global.stage && typeof global.stage.get_grab_actor === 'function')
                return global.stage.get_grab_actor();
        } catch (_e) {}
        return null;
    }

    _rememberModalGrabActor(actor = null) {
        const grab = actor || this._stageGrabActor();
        if (!grab || grab === global.stage || this._isKeyboardDescendant(grab))
            return;
        this._modalBridgeModalActor = grab;
    }

    _isModalStackActive() {
        if (typeof Main.modalCount === 'number' && Main.modalCount > 0)
            return true;
        return this._isAnyModalActive(true);
    }

    _syncCapturedHoverTarget(target, event = null) {
        if (target && typeof target.setCapturedHover !== 'function')
            target = null;
        if (this._modalHoverTarget === target) {
            if (target) {
                try { target.setCapturedHover(true, event); }
                catch (_e) {}
            }
            return;
        }
        this._clearCapturedHover();
        this._modalHoverTarget = target || null;
        if (this._modalHoverTarget) {
            try { this._modalHoverTarget.setCapturedHover(true, event); }
            catch (_e) { this._modalHoverTarget = null; }
        }
    }

    _shouldProcessCapturedHoverMotion(x, y) {
        const now = GLib.get_monotonic_time();
        const lastUs = this._modalHoverLastUs || 0;
        const lastX = this._modalHoverLastX;
        const lastY = this._modalHoverLastY;
        if (lastUs && lastX !== null && lastY !== null
            && now - lastUs < OSK_MODAL_HOVER_THROTTLE_US
            && Math.abs(x - lastX) < 10
            && Math.abs(y - lastY) < 10) {
            return false;
        }
        this._modalHoverLastUs = now;
        this._modalHoverLastX = x;
        this._modalHoverLastY = y;
        return true;
    }

    _clearCapturedHover() {
        if (!this._modalHoverTarget) return;
        const target = this._modalHoverTarget;
        this._modalHoverTarget = null;
        try {
            if (typeof target.setCapturedHover === 'function')
                target.setCapturedHover(false);
        } catch (_e) {}
    }

    _installShellKeyboardEventBridge() {
        if (this._shellKeyboardBridgeInstalled)
            return true;

        const manager = Main.keyboard;
        if (!manager || typeof manager.maybeHandleEvent !== 'function') {
            log('gnome-osk: Shell keyboard event bridge unavailable');
            return false;
        }

        const original = manager.maybeHandleEvent;
        if (original._gnomeOskWrappedBy
            && original._gnomeOskWrappedBy !== this) {
            log('gnome-osk: Shell keyboard event bridge already wrapped; skipping');
            return false;
        }
        if (original._gnomeOskWrappedBy === this) {
            this._shellKeyboardBridgeInstalled = true;
            this._shellKeyboardBridgeManager = manager;
            this._shellKeyboardBridgeOriginal =
                original._gnomeOskOriginal || null;
            this._shellKeyboardBridgeWrapper = original;
            return true;
        }

        const extension = this;
        const wrapper = function (event) {
            if (extension._reentrantSyntheticDispatch)
                return original.call(this, event);

            try {
                if (original.call(this, event))
                    return true;
            } catch (e) {
                if (!extension._shellKeyboardBridgeOriginalFailed) {
                    extension._shellKeyboardBridgeOriginalFailed = true;
                    log(`gnome-osk: Shell keyboard bridge original failed: ${e}`);
                }
            }

            try {
                return extension._maybeHandleShellKeyboardEvent(event);
            } catch (e) {
                log(`gnome-osk: Shell keyboard event bridge failed: ${e}`);
                return false;
            }
        };
        wrapper._gnomeOskWrappedBy = this;
        wrapper._gnomeOskOriginal = original;

        manager.maybeHandleEvent = wrapper;
        this._shellKeyboardBridgeInstalled = true;
        this._shellKeyboardBridgeManager = manager;
        this._shellKeyboardBridgeOriginal = original;
        this._shellKeyboardBridgeWrapper = wrapper;
        log('gnome-osk: Shell keyboard event bridge installed');
        return true;
    }

    _uninstallShellKeyboardEventBridge() {
        if (!this._shellKeyboardBridgeInstalled)
            return;

        const manager = this._shellKeyboardBridgeManager;
        if (manager && manager.maybeHandleEvent === this._shellKeyboardBridgeWrapper) {
            try {
                manager.maybeHandleEvent = this._shellKeyboardBridgeOriginal;
            } catch (e) {
                log(`gnome-osk: Shell keyboard event bridge restore failed: ${e}`);
            }
        } else if (manager && manager.maybeHandleEvent
            && manager.maybeHandleEvent !== this._shellKeyboardBridgeOriginal) {
            log('gnome-osk: Shell keyboard event bridge changed before restore; leaving current handler');
        }

        this._shellKeyboardBridgeInstalled = false;
        this._shellKeyboardBridgeManager = null;
        this._shellKeyboardBridgeOriginal = null;
        this._shellKeyboardBridgeWrapper = null;
        this._shellKeyboardBridgeOriginalFailed = false;
    }

    _maybeHandleShellKeyboardEvent(event) {
        if (!event)
            return false;

        const type = event.type();
        if (!this._isPointerLikeEvent(type))
            return false;
        if (!this._modalPointerTarget
            && this._isPointerTrackingOnlyEvent(type)) {
            this._clearCapturedHover();
            return false;
        }
        if (!this._shouldUseShellKeyboardEventBridge())
            return false;

        const keyboard = this._keyboardOrNull('_maybeHandleShellKeyboardEvent');
        if (!keyboard || !keyboard.visible) {
            this._clearCapturedHover();
            return false;
        }

        let x, y;
        try {
            [x, y] = event.get_coords();
        } catch (_e) {
            this._clearCapturedHover();
            return false;
        }

        if (!this._modalPointerTarget
            && !this._actorContainsStagePoint(keyboard, x, y)) {
            this._clearCapturedHover();
            return false;
        }

        const startsPointerSequence =
            type === Clutter.EventType.BUTTON_PRESS
            || type === Clutter.EventType.TOUCH_BEGIN;
        const endsPointerSequence =
            type === Clutter.EventType.BUTTON_RELEASE
            || type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL;
        const updatesPointerSequence =
            type === Clutter.EventType.MOTION
            || type === Clutter.EventType.TOUCH_UPDATE;

        let directTarget = null;
        try {
            directTarget = global.stage.get_event_actor(event);
        } catch (_e) {}

        const directIsKeyboard = this._isKeyboardDescendant(directTarget);
        const hitTarget = directIsKeyboard
            ? directTarget
            : this._findKeyboardActorAt(keyboard, x, y);
        const hitHandler = this._capturedPointerHandlerFor(hitTarget);

        this._syncCapturedHoverTarget(hitHandler, event);

        if (!this._modalPointerTarget && endsPointerSequence)
            return false;

        if (!this._modalPointerTarget && updatesPointerSequence
            && this._eventHasButtonOrTouchGrab(event, type)) {
            return false;
        }

        let target = this._modalPointerTarget || null;
        if (!target || startsPointerSequence) {
            target = hitHandler || null;
            if (startsPointerSequence)
                this._modalPointerTarget = target;
        }

        if (!target || !this._isKeyboardDescendant(target))
            return false;
        if (typeof target.handleCapturedPointerEvent !== 'function')
            return false;

        this._reentrantSyntheticDispatch = true;
        let result = Clutter.EVENT_STOP;
        try {
            result = target.handleCapturedPointerEvent(event);
        } catch (e) {
            log(`gnome-osk: Shell keyboard event dispatch failed: ${e}`);
        } finally {
            this._reentrantSyntheticDispatch = false;
            if (endsPointerSequence) {
                this._modalPointerTarget = null;
                this._clearCapturedHover();
            }
        }

        if (startsPointerSequence && result === Clutter.EVENT_PROPAGATE)
            this._modalPointerTarget = null;

        return result !== Clutter.EVENT_PROPAGATE;
    }

    _shouldUseShellKeyboardEventBridge() {
        if (this._authSessionMode)
            return false;
        if (this._modalPointerTarget)
            return true;
        if (typeof Main.modalCount === 'number')
            return Main.modalCount > 0;
        return this._isAnyModalActive(true);
    }

    _isPointerLikeEvent(type) {
        return isPointerLikeEventType(type);
    }

    _isPointerTrackingOnlyEvent(type) {
        return isPointerTrackingOnlyEventType(type);
    }

    _eventHasButtonOrTouchGrab(event, type) {
        if (type === Clutter.EventType.TOUCH_UPDATE)
            return true;
        if (type !== Clutter.EventType.MOTION)
            return false;

        let state = 0;
        try {
            state = event.get_state();
        } catch (_e) {
            return false;
        }

        const buttonMask =
            (Clutter.ModifierType.BUTTON1_MASK || 0)
            | (Clutter.ModifierType.BUTTON2_MASK || 0)
            | (Clutter.ModifierType.BUTTON3_MASK || 0)
            | (Clutter.ModifierType.BUTTON4_MASK || 0)
            | (Clutter.ModifierType.BUTTON5_MASK || 0);
        return !!(state & buttonMask);
    }

    // ---- modal-aware input ---------------------------------------
    //
    // Auth surfaces can use stricter grabs than ordinary desktop
    // popups. Normal desktop modals use Shell's built-in
    // Main.keyboard.maybeHandleEvent() hook, installed above, so the
    // stage-level capture bridge remains only for GDM/unlock fallback
    // behavior.
    //
    // Key events still go through Clutter.VirtualInputDevice at Mutter
    // input-subsystem level.  The OSK actors do not take key focus, so
    // synthesized keys continue to target the modal's focused password
    // field or button.
    _installModalAwareInput() {
        if (this._stageCapturedEventId) return;
        this._stageCapturedEventId = global.stage.connect(
            'captured-event',
            (_stage, event) => this._onStageCapturedEvent(event));
    }

    _uninstallModalAwareInput() {
        if (this._stageCapturedEventId) {
            global.stage.disconnect(this._stageCapturedEventId);
            this._stageCapturedEventId = 0;
        }
    }

    _onStageCapturedEvent(event) {
        // Cheap early outs first -- this handler runs for every event
        // on the stage so it must do nothing in the common case.
        if (this._reentrantSyntheticDispatch) return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        // Only pointer-shaped events need rerouting.  Key events
        // travel through the virtual input device and are routed by
        // Wayland focus, not by Clutter actor grabs.
        if (type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.BUTTON_RELEASE &&
            type !== Clutter.EventType.MOTION &&
            type !== Clutter.EventType.ENTER &&
            type !== Clutter.EventType.LEAVE &&
            type !== Clutter.EventType.SCROLL &&
            type !== Clutter.EventType.TOUCH_BEGIN &&
            type !== Clutter.EventType.TOUCH_END &&
            type !== Clutter.EventType.TOUCH_UPDATE &&
            type !== Clutter.EventType.TOUCH_CANCEL) {
            return Clutter.EVENT_PROPAGATE;
        }
        const keyboard = this._keyboardOrNull('_onStageCapturedEvent');
        if (!keyboard)
            return Clutter.EVENT_PROPAGATE;
        if (!keyboard.visible)
            return Clutter.EVENT_PROPAGATE;

        let x, y;
        try {
            [x, y] = event.get_coords();
        } catch (_e) {
            return Clutter.EVENT_PROPAGATE;
        }
        const startsPointerSequence =
            type === Clutter.EventType.BUTTON_PRESS
            || type === Clutter.EventType.TOUCH_BEGIN;
        const endsPointerSequence =
            type === Clutter.EventType.BUTTON_RELEASE
            || type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL;

        const hasActiveKeyboardPointer = !!this._modalPointerTarget
            || this._actorContainsStagePoint(keyboard, x, y);
        if (!hasActiveKeyboardPointer && !this._modalBridgeGrab) {
            this._clearCapturedHover();
            return Clutter.EVENT_PROPAGATE;
        }
        const trackingOnly = this._isPointerTrackingOnlyEvent(type);
        if (trackingOnly && !this._modalPointerTarget
            && !this._shouldProcessCapturedHoverMotion(x, y)) {
            return Clutter.EVENT_PROPAGATE;
        }

        const modalActive = this._isAnyModalActive(true);
        const directTarget = this._stagePickActorAt(x, y);
        const directIsKeyboard = this._isKeyboardDescendant(directTarget);
        const manualTarget = directIsKeyboard
            ? directTarget
            : this._findKeyboardActorAt(keyboard, x, y);
        const capturedHandler = this._capturedPointerHandlerFor(manualTarget);
        if (!modalActive && !this._modalBridgeGrab
            && !this._modalPointerTarget && !capturedHandler) {
            if (this._modalBridgePreVisible !== undefined)
                this._leaveModalBridge('modal-inactive-event');
            return Clutter.EVENT_PROPAGATE;
        }
        const bridgeActive = modalActive || !!this._modalBridgeGrab
            || !!capturedHandler || !!this._modalPointerTarget;
        if (!bridgeActive)
            return Clutter.EVENT_PROPAGATE;

        this._syncCapturedHoverTarget(capturedHandler, event);
        // While the bridge grab is active, keep Shell-modal semantics:
        // taps inside the OSK or modal are allowed, but clicks that
        // would otherwise fall through to application windows behind
        // the dialog are stopped at the stage.
        const backgroundAction =
            type === Clutter.EventType.BUTTON_PRESS
            || type === Clutter.EventType.BUTTON_RELEASE
            || type === Clutter.EventType.SCROLL
            || type === Clutter.EventType.TOUCH_BEGIN
            || type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_UPDATE
            || type === Clutter.EventType.TOUCH_CANCEL;
        if (this._modalBridgeGrab && backgroundAction && !manualTarget
            && !this._modalPointerTarget
            && !this._isModalUiDescendant(directTarget))
            return Clutter.EVENT_STOP;
        // Where would this event have been delivered without the modal
        // grab?  get_actor_at_pos normally finds it, but some Shell
        // modal overlays sit above top chrome in the pick stack.  In
        // that case we fall back to a small manual hit-test inside the
        // keyboard tree.
        let target = this._modalPointerTarget || null;
        if (!target || startsPointerSequence) {
            target = capturedHandler;
            if (startsPointerSequence)
                this._modalPointerTarget = target || null;
        }
        if (!target || !this._isKeyboardDescendant(target))
            return Clutter.EVENT_PROPAGATE;
        // Bypass the grab only for actors that have an explicit direct
        // handler.  Do not replay the raw Clutter event through
        // target.event(); Mutter warns about that path during captured
        // dispatch and it can interfere with Shell recorder overlays.
        if ((this._modalBridgeGrab || modalActive) && startsPointerSequence)
            this._raiseKeyboardToTop('modal-captured-event');
        this._reentrantSyntheticDispatch = true;
        let result = Clutter.EVENT_STOP;
        try {
            result = target.handleCapturedPointerEvent(event);
        } catch (e) {
            log(`gnome-osk: captured-event dispatch failed: ${e}`);
        } finally {
            this._reentrantSyntheticDispatch = false;
            if (endsPointerSequence) {
                this._modalPointerTarget = null;
                this._clearCapturedHover();
            }
        }
        return result === Clutter.EVENT_PROPAGATE
            ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
    }

    _isAnyModalActive(ignoreOwnBridgeGrab = false) {
        // Prefer Main.modalCount when the Shell exposes it; fall back
        // to counting modalDialogGroup children so older / patched
        // Shells still benefit from the rerouting.
        if (typeof Main.modalCount === 'number' && Main.modalCount > 0)
            return true;
        try {
            if (global.stage.get_grab_actor) {
                const grab = global.stage.get_grab_actor();
                const isOwnBridgeGrab = ignoreOwnBridgeGrab
                    && !!this._modalBridgeGrab
                    && grab === global.stage;
                if (grab && !isOwnBridgeGrab
                    && !this._isKeyboardDescendant(grab))
                    return true;
            }
        } catch (_e) {}
        const g = Main.layoutManager && Main.layoutManager.modalDialogGroup;
        if (!g || !g.get_children) return false;
        try {
            for (const child of g.get_children()) {
                if (child && child.visible) return true;
            }
        } catch (_e) {
            return !!(g.get_n_children && g.get_n_children() > 0);
        }
        return false;
    }

    _actorDescriptor(actor) {
        const parts = [];
        try {
            if (actor.get_style_class_name) {
                const cls = actor.get_style_class_name();
                if (cls) parts.push(String(cls));
            }
        } catch (_e) {}
        try {
            if (actor.style_class)
                parts.push(String(actor.style_class));
        } catch (_e) {}
        try {
            if (actor.get_name) {
                const name = actor.get_name();
                if (name) parts.push(String(name));
            }
        } catch (_e) {}
        try {
            if (actor.name)
                parts.push(String(actor.name));
        } catch (_e) {}
        try {
            if (actor.constructor && actor.constructor.name)
                parts.push(String(actor.constructor.name));
        } catch (_e) {}
        try {
            if (actor.constructor
                && actor.constructor.$gtype
                && actor.constructor.$gtype.name)
                parts.push(String(actor.constructor.$gtype.name));
        } catch (_e) {}
        return parts.join(' ').toLowerCase();
    }

    _isModalUiDescendant(actor) {
        if (!actor) return false;
        const modalActor = this._modalBridgeModalActor;
        const modalGroup = Main.layoutManager
            && Main.layoutManager.modalDialogGroup;
        let cur = actor;
        while (cur) {
            if (cur === modalActor || cur === modalGroup)
                return true;
            try {
                cur = (typeof cur.get_parent === 'function')
                    ? cur.get_parent() : null;
            } catch (_e) {
                return false;
            }
        }
        return false;
    }

    _stagePickActorAt(x, y) {
        try {
            return global.stage.get_actor_at_pos(
                Clutter.PickMode.REACTIVE, x, y);
        } catch (_e) {
            return null;
        }
    }

    _findKeyboardActorAt(actor, x, y) {
        if (!actor || actor.visible === false) return null;
        if (!this._actorContainsStagePoint(actor, x, y)) return null;
        const children = actor.get_children ? actor.get_children() : [];
        for (let i = children.length - 1; i >= 0; i--) {
            const hit = this._findKeyboardActorAt(children[i], x, y);
            if (hit) return hit;
        }
        if (!actor.reactive) return null;
        return actor;
    }

    _capturedPointerHandlerFor(actor) {
        let cur = actor;
        while (cur && this._isKeyboardDescendant(cur)) {
            if (typeof cur.handleCapturedPointerEvent === 'function')
                return cur;
            cur = (typeof cur.get_parent === 'function')
                ? cur.get_parent() : null;
        }
        return null;
    }

    _actorContainsStagePoint(actor, x, y) {
        if (!actor || actor.visible === false) return false;
        let ax = 0, ay = 0;
        try {
            [ax, ay] = actor.get_transformed_position();
        } catch (_e) {
            try {
                ax = actor.get_x();
                ay = actor.get_y();
            } catch (__e) {
                return false;
            }
        }
        const w = actor.width > 0 ? actor.width
            : (actor.get_width ? actor.get_width() : 0);
        const h = actor.height > 0 ? actor.height
            : (actor.get_height ? actor.get_height() : 0);
        if (w <= 0 || h <= 0) return false;
        return x >= ax && x <= ax + w && y >= ay && y <= ay + h;
    }

    _isKeyboardDescendant(actor) {
        const root = this._keyboardOrNull('_isKeyboardDescendant');
        if (!root || !actor) return false;
        let cur = actor;
        while (cur) {
            if (cur === root) return true;
            try {
                cur = (typeof cur.get_parent === 'function')
                    ? cur.get_parent() : null;
            } catch (_e) {
                return false;
            }
        }
        return false;
    }
}
