/* Nome - Onscreen Keyboard actor/runtime module. */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    KEY, MOD_TO_KEY, PREDICT_CHAR_TO_KEYCODE,
    LAYOUTS, DEFAULT_LAYOUT_KEY, KEY_SPACING, MAX_KEY_SPACING,
    _layoutKeySpacing,
} from './layouts.js';
import {
    OskLifecycleTracker, _removeSource, _clearSource,
} from './lifecycle.js';
import {
    THEMES, DEFAULT_THEME_ID, DEFAULT_CUSTOMIZATION, THEME_OPTION_KEYS,
    _coglColor, _coglColorFromHex, _coglColorFromHue,
    _rgbChannelsFromHex, _reactiveShadowStyle, _cloneTheme,
    _lookupTheme, _mergeCustomColors, buildStyles,
} from './theme.js';
import {
    RGB_BREATH_PERIOD_MS, RGB_REACTIVE_FADE_MS,
    RGB_RAINBOW_PERIOD_MS, RGB_WAVE_PERIOD_MS,
    RGB_SHADOW_CYCLE_STEPS, RGB_LOW_POWER_INTERVAL_MS,
    RGB_MIN_FRAME_INTERVAL_MS, RGB_CANVAS_LAYERS,
    RGB_CANVAS_MIN_GLOW_BLEED, RGB_CANVAS_MAX_GLOW_BLEED,
    RGB_CANVAS_CORE_ALPHA, RGB_CANVAS_OUTER_ALPHA,
    RGB_GLOW_SIZE_MAX, RGB_SPREAD_SIZE_MAX,
    RGB_CSS_MAX_GLOW_SIZE, RGB_CSS_MAX_SPREAD,
    RGB_PULSE_PERIOD_MS, RGB_BREATH_OPACITY_MIN, RGB_BREATH_OPACITY_MAX,
    RGB_SHADOW_ALPHA_COLOR, RGB_COLOR_RING_OPACITY,
    _haloBlendFeather,
} from './rgbEffects.js';
export { RGB_GLOW_SIZE_MAX, RGB_SPREAD_SIZE_MAX } from './rgbEffects.js';

const REPEAT_DELAY_MS = 450;
const REPEAT_INTERVAL_MS = 35;

const MOD_OFF = 0, MOD_ARMED = 1, MOD_LOCKED = 2;

// Dynamic suggestion-slot count: the number of buttons on the
// prediction bar scales with keyboard width.  Narrow keyboards keep
// 3 slots (Windows-OSK-style minimum); wider keyboards grow to 6 so
// the extra horizontal space actually gets used for useful output.
// We cap at 6 because beyond that each button starts getting too
// small for touch-accurate taps on the default key size.
const PREDICTION_SLOT_MIN = 3;
const PREDICTION_SLOT_MAX = 6;
// Target pixel budget per prediction slot.  At 160 px / slot the
// typical ~6-character word plus padding fits comfortably without
// truncation; see OSKKeyboard._computePredictionSlots for how this
// maps width -> slot count.
const PREDICTION_SLOT_TARGET_PX = 160;
// Height of the prediction bar when visible.  Tall enough for a
// finger-sized tap target, short enough that it doesn't crowd the
// key rows on small keyboard sizes.  Added to vertical chrome only
// when the bar is actually on -- see OSKKeyboard._verticalChrome().
const PREDICTION_BAR_HEIGHT = 38;
// After this long with no keystroke, we clear the "current word /
// previous word" tracking state and the suggestion bar goes blank.
// This avoids stale suggestions lingering for hours after a user
// wandered off mid-word.  60 s matches what Windows OSK does.
const PREDICTION_IDLE_CLEAR_MS = 60 * 1000;

// RGB effect constants and frame-budget helpers live in rgbEffects.js.

// Keyboard size bounds.  MIN values keep the keys readable; we also
// scale key height from keyboard height, so the background always hugs
// the keys (no empty band below them).  The mobile layout only has
// five rows and a narrower profile, so the width floor is loose enough
// to accommodate it without dropping below the readable-keys threshold.
export const MIN_KEYBOARD_WIDTH = 440;
export const MIN_KEYBOARD_HEIGHT = 240;
export const KEYBOARD_SCREEN_MARGIN = 20;
// Customize window size bounds.  Picked so the title bar, body and
// at least one section header stay readable at the smallest size,
// and so the picker panel always has room for its 200x200 SV square
// without overlapping the body.
export const CUSTOMIZE_WINDOW_MIN_WIDTH = 600;
export const CUSTOMIZE_WINDOW_MIN_HEIGHT = 420;
// Approx non-key vertical chrome: title bar, bottom grip row, padding,
// border, and the BoxLayout spacings between children.  We overestimate
// the row spacings here (as if the layout always had 6 rows) because
// the number of spacings actually used is (1 title + N rows + 1 bottom
// - 1) and layouts vary between 5 and 6 rows -- this is a ceiling so
// the computed key height never overflows the container.  Slight drift
// is absorbed by Math.floor() and the 20 px min clamp in _layoutKeys.
const TITLEBAR_HEIGHT_APPROX = 36;
const KEYBOARD_PADDING_TOP = 8;
const KEYBOARD_PADDING_BOTTOM = 4;
const BOTTOMROW_HEIGHT_APPROX = 16;
const BACKGROUND_POSITION_OVERSCAN = 1.28;
const KEYBOARD_V_CHROME_BASE =
    TITLEBAR_HEIGHT_APPROX +
    BOTTOMROW_HEIGHT_APPROX +
    KEYBOARD_PADDING_TOP + KEYBOARD_PADDING_BOTTOM +
    2 * 2 +                // border top + bottom
    MAX_KEY_SPACING * 7;   // 7 gaps ceiling (worst case: 6-row layout
                           // with the widest layout-specific spacing)

function _clampNumber(value, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(max, value));
}

function _setActorPositionIfChanged(actor, x, y) {
    if (!actor) return false;
    x = Math.round(x);
    y = Math.round(y);
    if (actor._oskLastX === x && actor._oskLastY === y) return false;
    actor._oskLastX = x;
    actor._oskLastY = y;
    actor.set_position(x, y);
    return true;
}

function _setActorSizeIfChanged(actor, w, h) {
    if (!actor) return false;
    w = Math.max(0, Math.round(w));
    h = Math.max(0, Math.round(h));
    if (actor._oskLastW === w && actor._oskLastH === h) return false;
    actor._oskLastW = w;
    actor._oskLastH = h;
    actor.set_size(w, h);
    return true;
}

function _setActorGeometryIfChanged(actor, x, y, w, h) {
    const moved = _setActorPositionIfChanged(actor, x, y);
    const sized = _setActorSizeIfChanged(actor, w, h);
    return moved || sized;
}

// Signal/timer tracking helpers live in lifecycle.js.

function _stageFallbackArea() {
    let width = 0;
    let height = 0;
    try {
        if (global.stage) {
            width = global.stage.width
                || (global.stage.get_width && global.stage.get_width())
                || width;
            height = global.stage.height
                || (global.stage.get_height && global.stage.get_height())
                || height;
        }
    } catch (_e) {}
    try {
        width = width || global.screen_width || 0;
        height = height || global.screen_height || 0;
    } catch (_e) {}
    width = Math.round(width || 0);
    height = Math.round(height || 0);
    if (width <= 100) width = 1280;
    if (height <= 100) height = 720;
    return {
        x: 0,
        y: 0,
        width,
        height,
    };
}

function _areaLooksUsable(area) {
    return !!area
        && Number.isFinite(area.x)
        && Number.isFinite(area.y)
        && Number.isFinite(area.width)
        && Number.isFinite(area.height)
        && area.width > 100
        && area.height > 100;
}

export function _primaryWorkArea() {
    try {
        const pIdx = Main.layoutManager.primaryIndex;
        const area = Main.layoutManager.getWorkAreaForMonitor(pIdx);
        if (_areaLooksUsable(area))
            return area;
    } catch (_e) {
    }
    return _stageFallbackArea();
}

function _workAreaMargin(area) {
    const shortest = Math.min(area.width || 0, area.height || 0);
    if (shortest <= KEYBOARD_SCREEN_MARGIN * 2) return 0;
    return KEYBOARD_SCREEN_MARGIN;
}

export function _fitKeyboardRectToWorkArea(x, y, w, h, area = null) {
    area = area || _primaryWorkArea();
    const margin = _workAreaMargin(area);
    const maxW = Math.max(1, (area.width || 1) - margin * 2);
    const maxH = Math.max(1, (area.height || 1) - margin * 2);
    const minW = Math.min(MIN_KEYBOARD_WIDTH, maxW);
    const minH = Math.min(MIN_KEYBOARD_HEIGHT, maxH);
    const width = _clampNumber(
        Math.round(Number.isFinite(w) ? w : minW), minW, maxW);
    const height = _clampNumber(
        Math.round(Number.isFinite(h) ? h : minH), minH, maxH);

    const minX = (area.x || 0) + margin;
    const minY = (area.y || 0) + margin;
    const maxX = (area.x || 0) + (area.width || width) - margin - width;
    const maxY = (area.y || 0) + (area.height || height) - margin - height;
    const posX = maxX >= minX
        ? _clampNumber(Math.round(Number.isFinite(x) ? x : minX), minX, maxX)
        : Math.floor((area.x || 0) + ((area.width || width) - width) / 2);
    const posY = maxY >= minY
        ? _clampNumber(Math.round(Number.isFinite(y) ? y : minY), minY, maxY)
        : Math.floor((area.y || 0) + ((area.height || height) - height) / 2);
    return { x: posX, y: posY, w: width, h: height };
}


// Theme definitions, config sanitizers, and style builders live in theme.js.

// ========================================================================
//  Key button with hold-to-repeat
// ========================================================================

const OSKKey = GObject.registerClass(
class OSKKey extends St.Button {
    _init(spec, keyboard) {
        super._init({
            label: spec.label,
            style_class: 'osk-key',
            can_focus: false,
            reactive: true,
            visible: false,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            // FILL aligns make the button stretch to fill the cell it
            // gets from the row's BoxLayout; without this the key sits
            // at its natural size and we get empty bands around it.
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._spec = spec;
        this._keyboard = keyboard;
        this._labelText = spec.label || '';
        // Normal/default text uses St.Button's built-in label path.
        // Hue-mode RGB text can temporarily hide this label and draw
        // all row labels on a lightweight canvas instead.
        this._rgbCanvasLabelMode = false;
        this._modState = 'off';
        this._hovering = false;
        this._pressed = false;
        this._initialDelayId = 0;
        this._repeatId = 0;
        this._lifecycle = new OskLifecycleTracker(this);
        // Stable index in the keyboard's flat key sequence, assigned
        // by OSKKeyboard after _buildRows.  Reactive mode reads it to
        // dedupe simultaneous presses on the same physical key.
        this._rgbIndex = 0;

        // Style is chosen by _updateStyle based on (pressed, modState,
        // hovering).  Size is set later (via set_size) by OSKKeyboard's
        // _layoutKeys so keys scale proportionally with the keyboard.
        this._updateStyle();

        // St.Button has `clicked` (release-over-widget) but we want
        // separate press/release for hold-to-repeat.  Connect raw events.
        this.connect('button-press-event', this._onPress.bind(this));
        this.connect('button-release-event', this._onRelease.bind(this));
        this.connect('leave-event', this._onLeave.bind(this));
        // notify::hover is the cleanest way to get "mouse entered" /
        // "mouse left" callbacks -- works with track_hover: true above.
        // Stylesheet-based :hover is unreliable here because our
        // per-key inline set_style() beats external CSS on specificity.
        this.connect('notify::hover', this._onHoverChanged.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));

        // The RGB halo lives on a SIBLING actor (a Clutter.Actor in
        // the row's per-key wrapper -- see OSKKeyboard._buildRows).
        // Sibling architecture is necessary because the halo needs to
        // paint BEHIND this key's CSS background; a child of the key
        // would paint AFTER the parent's bg and cover it up.
    }

    get spec() { return this._spec; }

    get_label() {
        return this._getDisplayLabel();
    }

    set_label(text) {
        this._setDisplayLabel(text);
    }

    _getDisplayLabel() {
        return this._labelText || '';
    }

    _setDisplayLabel(text) {
        this._labelText = text || '';
        this._syncButtonLabelText();
    }

    setCanvasLabelMode(on) {
        const enabled = !!on;
        if (this._rgbCanvasLabelMode === enabled) return;
        this._rgbCanvasLabelMode = enabled;
        this._syncButtonLabelText();
    }

    _syncButtonLabelText() {
        const visibleText = this._rgbCanvasLabelMode
            ? '' : (this._labelText || '');
        try { super.set_label(visibleText); }
        catch (_e) {
            try { this.label = visibleText; } catch (__e) {}
        }
    }

    setHoverTrackingEnabled(enabled) {
        const on = !!enabled;
        if (this.track_hover === on) return;
        this.track_hover = on;
        if (!on) {
            const hadVisualState = this._hovering || this._pressed;
            this._hovering = false;
            if (this._pressed) {
                this._pressed = false;
                this._stopTimers();
            }
            if (hadVisualState) this._updateStyle();
        }
    }

    setModState(state) {
        if (state === this._modState) return;
        this.remove_style_class_name('mod-armed');
        this.remove_style_class_name('mod-locked');
        if (state === 'armed') {
            this.add_style_class_name('mod-armed');
        } else if (state === 'locked') {
            this.add_style_class_name('mod-locked');
        }
        this._modState = state;
        this._updateStyle();
    }

    // Pick the right inline style for the current (pressed, mod, hover)
    // combination.  Priority: pressed > armed/locked > hover > base.
    // A held-down armed modifier still shows the pressed color so the
    // user gets visual feedback when they click it.  Styles are pulled
    // from the keyboard's styles map (computed once per theme /
    // customization change).
    //
    // Text color is NOT carried by the inline CSS (see buildStyles).
    // _applyTextColor() pushes it directly onto Clutter.Text via
    // set_color, so animated RGB label transitions can take ownership
    // without fighting St's per-paint CSS-color propagation.
    _updateStyle() {
        const styles = this._keyboard && this._keyboard._styles;
        if (!styles) return;
        let style;
        let textState;
        if (this._pressed) {
            style = styles.keyPressed;
            textState = 'pressed';
        } else if (this._modState === 'armed') {
            style = styles.keyArmed;
            textState = 'armed';
        } else if (this._modState === 'locked') {
            style = styles.keyLocked;
            textState = 'locked';
        } else if (this._hovering) {
            style = styles.keyHover;
            textState = 'hover';
        } else {
            style = styles.keyBase;
            textState = 'base';
        }
        // Skip the set_style call if the resulting CSS is identical to
        // what the actor already has.  set_style invalidates Clutter's
        // per-actor style cache and triggers a CSS re-parse + repaint.
        if (this._lastAppliedStyle !== style) {
            this._lastAppliedStyle = style;
            this.set_style(style);
        }
        // Text color: hue-cycling RGB modes own label color for every
        // key state so text stays phase-locked with the ring/glow.
        // Pulse owns only the base state; pressed / armed / locked
        // pulse labels fall back to the theme colors for legibility.
        const cyclingActive = this._keyboard
            && this._keyboard._isLabelAnimatingRgbMode
            && this._keyboard._isLabelAnimatingRgbMode();
        const hueCycling = this._keyboard
            && this._keyboard._isHueCyclingRgbMode
            && this._keyboard._isHueCyclingRgbMode();
        const ownedByRgb = cyclingActive
            && (hueCycling || textState === 'base');
        this._currentTextState = textState;
        if (ownedByRgb) {
            if (this._keyboard && this._keyboard._ensureRgbLabelAnimation)
                this._keyboard._ensureRgbLabelAnimation(this);
        } else {
            this._applyTextColor();
        }
    }

    // Push the current state's theme text color onto the underlying
    // Clutter.Text directly (set_color overrides CSS-driven color).
    // Called from _updateStyle for states where RGB label animation
    // should not own the text color.
    _applyTextColor() {
        if (!this._keyboard || !this._keyboard._styles) return;
        const map = this._keyboard._styles.keyTextColors;
        if (!map) return;
        const hex = map[this._currentTextState] || map.base;
        if (!hex) return;
        let labelActor = this._keyLabel || null;
        if (!labelActor && this.get_label_actor) {
            try { labelActor = this.get_label_actor(); } catch (_e) {}
        }
        const text = this._keyboard && this._keyboard._clutterTextFor
            ? this._keyboard._clutterTextFor(this) : null;
        const base = this._keyboard && this._keyboard._keyLabelBaseCss
            ? this._keyboard._keyLabelBaseCss() : '';
        const css = `${base}color: ${hex} !important;`;
        if (this._lastAppliedTextCss === css
            && this._lastAppliedTextHex === hex) {
            return;
        }
        if (text && text.remove_transition) {
            try { text.remove_transition('rgb-color'); } catch (_e) {}
        }
        if (labelActor && labelActor.set_style) {
            if (labelActor._oskKeyLabelCss !== css) {
                try {
                    labelActor.set_style(css);
                    labelActor._oskKeyLabelCss = css;
                } catch (_e) {}
            }
        }
        if (text) {
            try { text.set_color(_coglColorFromHex(hex)); } catch (_e) {}
        }
        this._lastAppliedTextCss = css;
        this._lastAppliedTextHex = hex;
    }

    _onHoverChanged() {
        this._hovering = this.hover;
        if (!this._hovering) {
            // Pointer drifted off the key: clear pressed state and
            // stop any held-key repeat, otherwise the button can look
            // "stuck" if the user releases outside the key.
            this._pressed = false;
            this._stopTimers();
        }
        this._updateStyle();
    }

    setCapturedHover(hovering) {
        hovering = !!hovering;
        if (this._hovering === hovering) return;
        this._hovering = hovering;
        if (!this._hovering) {
            this._pressed = false;
            this._stopTimers();
        }
        this._updateStyle();
    }

    _onPress(_actor, event) {
        // Capture which mouse button started the press.  For modifier
        // keys this picks the dispatch path: button 1 (left) treats
        // the key as a normal tap (so Super opens Activities, Shift
        // can be used in real chords, etc.); button 3 (right) keeps
        // the legacy off/armed/locked toggle so users can still set
        // up sticky-key combos.  For non-modifier keys the button is
        // ignored -- left and right both just send the keycode.
        const button = (event && event.get_button) ? event.get_button() : 1;
        this._lastButton = button;
        this._pressed = true;
        // Let the keyboard's RGB "reactive" mode kick off the per-key
        // background-color fade transition.  No-op when RGB mode isn't
        // 'reactive'.  Runs on the GPU once installed, so the press
        // path stays cheap regardless of how often the user types.
        if (this._keyboard && this._keyboard._onKeyPressedForRgb) {
            this._keyboard._onKeyPressedForRgb(this);
        }
        this._updateStyle();
        this._keyboard.onKeyPress(this._spec, false, button);
        // Delay/interval read from the keyboard so the "Key repeat"
        // menu can change them at runtime.  delay == 0 means "no
        // repeat" (user chose Off), so we skip scheduling entirely.
        // We still skip repeat for modifier keys regardless of which
        // button was used: holding Shift / Ctrl repeats nothing the
        // user actually wants, and a held-down Super would re-fire
        // Activities continuously.
        const delay = this._keyboard._repeatDelay;
        if (!this._spec.modifier && this._spec.keycode !== null
            && delay > 0) {
            this._stopTimers();
            this._lifecycle.timeoutAdd(
                '_initialDelayId',
                GLib.PRIORITY_DEFAULT, delay,
                () => this._startRepeat()
            );
        }
        return Clutter.EVENT_STOP;
    }

    handleCapturedPointerEvent(event) {
        // Shell modals install a stage grab, so replaying the same
        // Clutter event through actor.event() can still be swallowed
        // by the grab machinery.  The extension-level capture handler
        // calls this method directly after hit-testing the OSK key.
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN) {
            return this._onPress(this, event);
        }
        if (type === Clutter.EventType.BUTTON_RELEASE ||
            type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.TOUCH_CANCEL) {
            return this._onRelease(this, event);
        }
        if (type === Clutter.EventType.LEAVE) {
            return this._onLeave();
        }
        return Clutter.EVENT_STOP;
    }

    _startRepeat() {
        this._initialDelayId = 0;
        const interval = this._keyboard._repeatInterval;
        if (interval <= 0) return GLib.SOURCE_REMOVE;
        this._lifecycle.timeoutAdd(
            '_repeatId',
            GLib.PRIORITY_DEFAULT, interval,
            () => {
                this._keyboard.onKeyPress(
                    this._spec, true, this._lastButton || 1);
                return GLib.SOURCE_CONTINUE;
            }
        );
        return GLib.SOURCE_REMOVE;
    }

    _onRelease() {
        this._pressed = false;
        this._stopTimers();
        this._updateStyle();
        return Clutter.EVENT_STOP;
    }

    _onLeave() {
        // Stop repeating if the pointer drifts off the key.  Keep this
        // fallback even with hover tracking enabled so a grab/leave edge
        // case cannot leave the pressed visual stuck.
        this._stopTimers();
        if (!this.track_hover) {
            const hadVisualState = this._hovering || this._pressed;
            this._hovering = false;
            this._pressed = false;
            if (hadVisualState) this._updateStyle();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onDestroy() {
        this._stopTimers();
        // Stop any label-color transition installed by the cycling
        // RGB modes so it doesn't fire into a destroyed actor.  The
        // halo actor is a SIBLING (in the row's per-key wrapper) and
        // is owned by OSKKeyboard; its cleanup is in _teardownRgbAnimation
        // / _destroyRows, not here.
        const text = this._keyboard && this._keyboard._clutterTextFor
            ? this._keyboard._clutterTextFor(this) : null;
        if (text && text.remove_transition) {
            try { text.remove_transition('rgb-color'); } catch (_e) { }
        }
        if (this._lifecycle) {
            this._lifecycle.clear();
            this._lifecycle = null;
        }
    }

    _stopTimers() {
        if (this._lifecycle) {
            this._lifecycle.clearSource('_initialDelayId');
            this._lifecycle.clearSource('_repeatId');
        } else {
            _clearSource(this, '_initialDelayId');
            _clearSource(this, '_repeatId');
        }
    }
});


// ========================================================================
//  Title bar (drag handle + close button)
// ========================================================================

const OSKTitleBar = GObject.registerClass({
    Signals: {
        'close-requested': {},
        'minimize-requested': {},
    },
}, class OSKTitleBar extends St.BoxLayout {
    _init(keyboard) {
        super._init({
            style_class: 'osk-titlebar',
            reactive: true,
            x_expand: true,
            y_expand: false,
        });
        this._keyboard = keyboard;
        this.set_style(keyboard._styles.titleBar);

        // Drag state owned by the title bar.  The draggable area is
        // the label -- it's reactive, fills the space between left
        // edge and the min/close buttons, and is NOT an St.Button,
        // so its clicks don't collide with button handlers.
        this._dragStartX = null;
        this._dragStartY = null;
        this._dragOriginX = 0;
        this._dragOriginY = 0;
        this._dragGrab = null;
        this._pendingDragX = 0;
        this._pendingDragY = 0;
        this._dragApplyId = 0;
        this._dragPollId = 0;
        this._lifecycle = new OskLifecycleTracker(this);
        this._sawButtonDown = false;
        this._pressTimeUs = 0;
        this._capturedHoverButton = null;
        // When locked (via the "Lock position" menu toggle) the title
        // bar ignores button presses, so reaching for the min/close
        // buttons can't accidentally kick off a drag.
        this._dragLocked = false;

        const label = new St.Label({
            text: 'Nome - Onscreen Keyboard  (drag to move)',
            style_class: 'osk-titlelabel',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        label.set_style(keyboard._styles.titleLabel);
        label.connect('button-press-event', this._onDragStart.bind(this));
        label.connect('motion-event',       this._onDragMotion.bind(this));
        label.connect('button-release-event', this._onDragEnd.bind(this));
        this.connect('destroy', () => {
            this._lifecycle.clearSource('_dragApplyId');
            this._stopPointerPoll();
            if (this._dragGrab) {
                try { this._dragGrab.dismiss(); } catch (_e) {}
                this._dragGrab = null;
            }
            if (this._dragStartX !== null && this._keyboard
                && this._keyboard._endInteractiveMotion) {
                this._keyboard._endInteractiveMotion('drag');
            }
            this._lifecycle.clear();
        });
        this._dragLabel = label;
        this.add_child(label);

        // Minimize: hides the keyboard but keeps it in memory, so
        // bringing it back via the panel icon is instant.
        const minBtn = new St.Button({
            label: '\u2212',   // Unicode MINUS SIGN (cleaner than '-')
            style_class: 'osk-titlebtn',
            can_focus: false,
            reactive: true,
            // track_hover is required for notify::hover to fire.  The
            // stylesheet's :hover rule is not reliable here because our
            // inline set_style() beats external CSS on specificity, so
            // we swap inline styles ourselves on hover change.
            track_hover: true,
        });
        minBtn.set_style(keyboard._styles.titleBtn);
        minBtn.connect('notify::hover', () => {
            this._applyTitleButtonStyle(minBtn, 'min');
        });
        minBtn.connect('clicked', () => this.emit('minimize-requested'));
        this._minBtn = minBtn;
        this.add_child(minBtn);

        // Close: fully exits the extension -- panel icon and keyboard
        // both go away, no background state held.
        const closeBtn = new St.Button({
            label: '\u00d7',
            style_class: 'osk-titlebtn',
            can_focus: false,
            reactive: true,
            track_hover: true,
        });
        closeBtn.set_style(keyboard._styles.titleBtn);
        closeBtn.add_style_class_name('osk-closebtn');
        closeBtn.connect('notify::hover', () => {
            this._applyTitleButtonStyle(closeBtn, 'close');
        });
        closeBtn.connect('clicked', () => this.emit('close-requested'));
        this._closeBtn = closeBtn;
        this.add_child(closeBtn);
    }

    // Re-apply styles to every sub-widget after the keyboard rebuilt
    // its styles map (theme / customization change).  Hover state is
    // fine to ignore here -- the notify::hover handlers above will
    // paint the correct hover variant when the pointer is actually
    // over the widget.
    applyStyles() {
        const s = this._keyboard && this._keyboard._styles;
        if (!s) return;
        this.set_style(s.titleBar);
        if (this._dragLabel) this._dragLabel.set_style(s.titleLabel);
        this._syncTitleText();
        if (this._minBtn) {
            this._applyTitleButtonStyle(this._minBtn, 'min');
        }
        if (this._closeBtn) {
            this._applyTitleButtonStyle(this._closeBtn, 'close');
        }
    }

    _applyTitleButtonStyle(button, kind) {
        const s = this._keyboard && this._keyboard._styles;
        if (!s || !button) return;
        const hovering = button.hover || this._capturedHoverButton === kind;
        const style = hovering
            ? (kind === 'close' ? s.closeBtnHover : s.titleBtnHover)
            : s.titleBtn;
        try { button.set_style(style); } catch (_e) {}
    }

    _setCapturedButtonHover(kind) {
        kind = kind || null;
        if (this._capturedHoverButton === kind) return;
        this._capturedHoverButton = kind;
        this._applyTitleButtonStyle(this._minBtn, 'min');
        this._applyTitleButtonStyle(this._closeBtn, 'close');
    }

    _syncTitleText() {
        if (!this._dragLabel) return;
        const showTitle = !this._keyboard
            || !this._keyboard._showOskTitle
            || this._keyboard._showOskTitle();
        if (!showTitle) {
            this._dragLabel.set_text('');
            return;
        }
        this._dragLabel.set_text(this._authMode
            ? 'Nome - Onscreen Keyboard  (drag to move)'
            : (this._dragLocked
                ? 'Nome - Onscreen Keyboard  (position locked)'
                : 'Nome - Onscreen Keyboard  (drag to move)'));
    }

    setDragLocked(locked) {
        this._dragLocked = !!locked;
        this._syncTitleText();
    }

    setAuthMode(enabled) {
        enabled = !!enabled;
        this._authMode = enabled;
        if (enabled) {
            if (this._preAuthDragLocked === undefined)
                this._preAuthDragLocked = !!this._dragLocked;
            this._dragLocked = false;
        } else if (this._preAuthDragLocked !== undefined) {
            this._dragLocked = !!this._preAuthDragLocked;
            this._preAuthDragLocked = undefined;
        }
        if (this._minBtn) this._minBtn.visible = !enabled;
        if (this._closeBtn) this._closeBtn.visible = !enabled;
        this._syncTitleText();
    }

    setCapturedHover(hovering, event = null) {
        if (!hovering) {
            this._setCapturedButtonHover(null);
            return;
        }
        let x = 0;
        let y = 0;
        try {
            if (event && event.get_coords)
                [x, y] = event.get_coords();
        } catch (_e) {
            this._setCapturedButtonHover(null);
            return;
        }
        const overMin = this._actorContainsStagePoint(this._minBtn, x, y);
        const overClose = this._actorContainsStagePoint(this._closeBtn, x, y);
        this._setCapturedButtonHover(overMin ? 'min'
            : (overClose ? 'close' : null));
    }

    handleCapturedPointerEvent(event) {
        const type = event.type();
        let x = 0;
        let y = 0;
        try {
            [x, y] = event.get_coords();
        } catch (_e) {}

        const overMin = this._actorContainsStagePoint(this._minBtn, x, y);
        const overClose = this._actorContainsStagePoint(this._closeBtn, x, y);
        const overDrag = this._actorContainsStagePoint(this._dragLabel, x, y);
        this._setCapturedButtonHover(overMin ? 'min'
            : (overClose ? 'close' : null));
        const startsPointerSequence =
            type === Clutter.EventType.BUTTON_PRESS
            || type === Clutter.EventType.TOUCH_BEGIN;
        const endsPointerSequence =
            type === Clutter.EventType.BUTTON_RELEASE
            || type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL;

        if (startsPointerSequence) {
            this._capturedTitleButton = overMin ? 'min'
                : (overClose ? 'close' : null);
            if (this._capturedTitleButton) return Clutter.EVENT_STOP;
            if (overDrag) return this._onDragStart(this._dragLabel, event);
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.MOTION
            || type === Clutter.EventType.TOUCH_UPDATE) {
            if (this._dragStartX !== null)
                return this._onDragMotion(this._dragLabel, event);
            return Clutter.EVENT_STOP;
        }

        if (endsPointerSequence) {
            const pressed = this._capturedTitleButton;
            this._capturedTitleButton = null;
            if (this._dragStartX !== null)
                return this._onDragEnd(this._dragLabel, event);
            if (type !== Clutter.EventType.TOUCH_CANCEL) {
                if (pressed === 'min' && overMin)
                    this.emit('minimize-requested');
                else if (pressed === 'close' && overClose)
                    this.emit('close-requested');
            }
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_STOP;
    }

    _actorContainsStagePoint(actor, x, y) {
        if (!actor || actor.visible === false) return false;
        let ax = 0;
        let ay = 0;
        try {
            [ax, ay] = actor.get_transformed_position();
        } catch (_e) {
            return false;
        }
        const w = actor.width > 0 ? actor.width
            : (actor.get_width ? actor.get_width() : 0);
        const h = actor.height > 0 ? actor.height
            : (actor.get_height ? actor.get_height() : 0);
        return w > 0 && h > 0
            && x >= ax && x <= ax + w
            && y >= ay && y <= ay + h;
    }

    _onDragStart(_actor, event) {
        if (this._dragLocked) return Clutter.EVENT_PROPAGATE;
        if (event.get_button && event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        const kbd = this.get_parent();
        if (!kbd) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._dragStartX = x;
        this._dragStartY = y;
        this._dragOriginX = kbd.get_x();
        this._dragOriginY = kbd.get_y();
        this._pendingDragX = this._dragOriginX;
        this._pendingDragY = this._dragOriginY;
        if (this._keyboard && this._keyboard._beginInteractiveMotion)
            this._keyboard._beginInteractiveMotion('drag');
        try {
            if (global.stage.grab) {
                this._dragGrab = global.stage.grab(this._dragLabel);
            }
        } catch (_e) {
            this._dragGrab = null;
        }
        this._startPointerPoll();
        return Clutter.EVENT_STOP;
    }

    _onDragMotion(_actor, event) {
        if (this._dragStartX === null) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._pendingDragX = Math.round(
            this._dragOriginX + (x - this._dragStartX));
        this._pendingDragY = Math.round(
            this._dragOriginY + (y - this._dragStartY));
        if (!this._dragApplyId) {
            this._lifecycle.timeoutAdd(
                '_dragApplyId',
                GLib.PRIORITY_DEFAULT, 16,
                () => {
                    this._applyPendingDragPosition();
                    return GLib.SOURCE_REMOVE;
                });
        }
        return Clutter.EVENT_STOP;
    }

    _applyPendingDragPosition() {
        const kbd = this.get_parent();
        if (!kbd) return;
        kbd.set_position(this._pendingDragX, this._pendingDragY);
    }

    _onDragEnd() {
        this._lifecycle.clearSource('_dragApplyId');
        this._stopPointerPoll();
        if (this._dragStartX !== null) this._applyPendingDragPosition();
        this._dragStartX = null;
        this._dragStartY = null;
        if (this._dragGrab) {
            try { this._dragGrab.dismiss(); } catch (_e) { }
            this._dragGrab = null;
        }
        if (this._keyboard && this._keyboard._endInteractiveMotion)
            this._keyboard._endInteractiveMotion('drag');
        return Clutter.EVENT_STOP;
    }

    _readPointer() {
        try {
            const p = global.get_pointer();
            if (p && p.length >= 3) return p;
        } catch (_e) {}
        return null;
    }

    _startPointerPoll() {
        this._stopPointerPoll();
        this._sawButtonDown = false;
        this._pressTimeUs = GLib.get_monotonic_time();
        this._lifecycle.timeoutAdd(
            '_dragPollId',
            GLib.PRIORITY_DEFAULT, 16,
            () => {
                if (this._dragStartX === null) {
                    this._dragPollId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                const p = this._readPointer();
                if (p) {
                    const mask = Clutter.ModifierType.BUTTON1_MASK || 0;
                    if (mask) {
                        const isDown = !!((p[2] || 0) & mask);
                        if (isDown) this._sawButtonDown = true;
                        const elapsedMs = (GLib.get_monotonic_time()
                            - this._pressTimeUs) / 1000;
                        if (this._sawButtonDown && !isDown
                            && elapsedMs > 120) {
                            this._dragPollId = 0;
                            this._onDragEnd();
                            return GLib.SOURCE_REMOVE;
                        }
                    }
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPointerPoll() {
        if (this._lifecycle)
            this._lifecycle.clearSource('_dragPollId');
        else
            _clearSource(this, '_dragPollId');
    }
});


// ========================================================================
//  Resize grip (bottom-right)
// ========================================================================

const OSKResizeGrip = GObject.registerClass(
class OSKResizeGrip extends St.Button {
    _init(keyboard) {
        super._init({
            // South-east arrow -- clear "drag to resize" indicator,
            // and in the standard Unicode Arrows block so every font
            // GNOME ships (Cantarell, Noto, DejaVu) has the glyph.
            label: '\u2198',
            style_class: 'osk-grip',
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._keyboard = keyboard;
        this.set_style(keyboard._styles.grip);
        this.set_size(22, BOTTOMROW_HEIGHT_APPROX);

        this._startX = null;
        this._startY = null;
        this._origW = 0;
        this._origH = 0;
        this._pendingW = 0;
        this._pendingH = 0;
        this._resizePollId = 0;
        this._sawButtonDown = false;
        this._pressTimeUs = 0;
        this._lifecycle = new OskLifecycleTracker(this);
        this._stageSignals = new OskLifecycleTracker();
        this._stageTrackingActive = false;
        this._capturedHovering = false;

        this.connect('notify::hover', () => {
            this._applyHoverStyle();
        });

        this.connect('button-press-event', this._onPress.bind(this));
        this.connect('motion-event', this._onMotion.bind(this));
        this.connect('destroy', () => {
            this._disconnectStageTracking();
            this._stopPointerPoll();
            if (this._startX !== null && this._keyboard
                && this._keyboard._endInteractiveMotion) {
                this._keyboard._endInteractiveMotion('resize');
            }
            this._lifecycle.clear();
        });
    }

    applyStyles() {
        this._applyHoverStyle();
    }

    _applyHoverStyle() {
        const s = this._keyboard && this._keyboard._styles;
        if (!s) return;
        this.set_style((this.hover || this._capturedHovering)
            ? s.gripHover : s.grip);
    }

    setCapturedHover(hovering) {
        hovering = !!hovering;
        if (this._capturedHovering === hovering) return;
        this._capturedHovering = hovering;
        this._applyHoverStyle();
    }

    setHoverTrackingEnabled(enabled) {
        const on = !!enabled;
        if (this.track_hover === on) return;
        this.track_hover = on;
        if (!on) {
            this._capturedHovering = false;
            this._applyHoverStyle();
        }
    }

    _onPress(_actor, event) {
        return this.beginResizeFromEvent(event);
    }

    beginResizeFromEvent(event) {
        if (event.get_button && event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        if (this._keyboard && this._keyboard.ensureOnScreen)
            this._keyboard.ensureOnScreen();
        this._startX = x;
        this._startY = y;
        const geom = this._keyboard && this._keyboard._currentGeometry
            ? this._keyboard._currentGeometry() : null;
        this._origW = geom ? geom.w : (this._keyboard.width > 0
            ? this._keyboard.width : this._keyboard.get_width());
        this._origH = geom ? geom.h : (this._keyboard.height > 0
            ? this._keyboard.height : this._keyboard.get_height());
        this._pendingW = this._origW;
        this._pendingH = this._origH;
        if (this._keyboard && this._keyboard._beginInteractiveMotion)
            this._keyboard._beginInteractiveMotion('resize');
        // Track on the stage for the whole drag.  The visible grip is
        // intentionally tiny, so relying on grip-local motion events
        // loses the resize as soon as the pointer leaves the glyph.
        this._connectStageTracking();
        this._startPointerPoll();
        return Clutter.EVENT_STOP;
    }

    _onMotion(_actor, event) {
        if (this._startX === null) return Clutter.EVENT_PROPAGATE;
        this._queueResizeFromEvent(event);
        return Clutter.EVENT_STOP;
    }

    handleCapturedPointerEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS
            || type === Clutter.EventType.TOUCH_BEGIN) {
            return this.beginResizeFromEvent(event);
        }
        if (type === Clutter.EventType.MOTION
            || type === Clutter.EventType.TOUCH_UPDATE) {
            if (this._startX === null) return Clutter.EVENT_PROPAGATE;
            this._queueResizeFromEvent(event);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE
            || type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL) {
            if (this._startX === null) return Clutter.EVENT_PROPAGATE;
            this._queueResizeFromEvent(event);
            this._finishResize();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    _connectStageTracking() {
        if (this._stageTrackingActive) return;
        this._connectStageSignal('captured-event',
            (_stage, event) => this._onStageCapturedEvent(event));
        this._connectStageSignal('button-release-event',
            (_stage, event) => this._onStageCapturedEvent(event));
        this._connectStageSignal('touch-event',
            (_stage, event) => this._onStageCapturedEvent(event));
        this._stageTrackingActive = true;
    }

    _connectStageSignal(name, callback) {
        try {
            this._stageSignals.connect(global.stage, name, callback);
        } catch (_e) {}
    }

    _disconnectStageTracking() {
        this._stageSignals.clear();
        this._stageTrackingActive = false;
    }

    _onStageCapturedEvent(event) {
        if (this._startX === null) return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_RELEASE
            || type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL) {
            this._queueResizeFromEvent(event);
            this._finishResize();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _readPointer() {
        try {
            const p = global.get_pointer();
            if (p && p.length >= 2) return p;
        } catch (_e) {}
        return null;
    }

    _startPointerPoll() {
        this._stopPointerPoll();
        this._sawButtonDown = false;
        this._pressTimeUs = GLib.get_monotonic_time();
        this._lifecycle.timeoutAdd(
            '_resizePollId',
            GLib.PRIORITY_DEFAULT, 16,
            () => {
                if (this._startX === null) {
                    this._resizePollId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                const p = this._readPointer();
                if (p) {
                    this._updatePendingSize(p[0], p[1]);
                    this._applyPendingResize();
                    const mask = Clutter.ModifierType.BUTTON1_MASK || 0;
                    if (mask) {
                        const isDown = !!((p[2] || 0) & mask);
                        if (isDown) this._sawButtonDown = true;
                        const elapsedMs = (GLib.get_monotonic_time()
                            - this._pressTimeUs) / 1000;
                        if (this._sawButtonDown && !isDown
                            && elapsedMs > 120) {
                            this._resizePollId = 0;
                            this._finishResize();
                            return GLib.SOURCE_REMOVE;
                        }
                    }
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPointerPoll() {
        if (this._lifecycle)
            this._lifecycle.clearSource('_resizePollId');
        else
            _clearSource(this, '_resizePollId');
    }

    _queueResizeFromEvent(event) {
        let x, y;
        try {
            [x, y] = event.get_coords();
        } catch (_e) {
            return;
        }
        this._updatePendingSize(x, y);
        this._applyPendingResize();
    }

    _updatePendingSize(x, y) {
        // Clamp at MIN_KEYBOARD_* and the current work area so the
        // keyboard never gets too small to use or too large to recover.
        this._pendingW = Math.max(
            MIN_KEYBOARD_WIDTH,
            Math.round(this._origW + (x - this._startX)));
        this._pendingH = Math.max(
            MIN_KEYBOARD_HEIGHT,
            Math.round(this._origH + (y - this._startY)));
    }

    _applyPendingResize() {
        if (this._pendingW <= 0 || this._pendingH <= 0) return;
        if (this._keyboard && this._keyboard.setConstrainedSize) {
            this._keyboard.setConstrainedSize(
                this._pendingW, this._pendingH);
        } else if (this._keyboard) {
            this._keyboard.set_size(this._pendingW, this._pendingH);
        }
    }

    _finishResize() {
        if (this._startX === null) return;
        this._startX = null;
        this._startY = null;
        this._disconnectStageTracking();
        this._stopPointerPoll();
        this._applyPendingResize();
        this._pendingW = 0;
        this._pendingH = 0;
        if (this._keyboard && this._keyboard._endInteractiveMotion)
            this._keyboard._endInteractiveMotion('resize');
    }
});


// ========================================================================
//  Prediction button
// ========================================================================
//
// One slot on the top-row suggestion bar.  Simpler than OSKKey -- no
// hold-to-repeat, no modifier semantics -- but shares the same
// "inline-style on hover/press" pattern because Shell's stylesheet
// :hover rules are unreliable once we've set_style()'d the widget
// (our inline style beats external CSS on specificity).
//
// Empty state (no suggestion for this slot) is represented by setting
// the label to '' and the 'isEmpty' flag; the dashed placeholder style
// is applied and the button becomes non-reactive so it can't accept a
// click.  This is cheaper than constantly adding / removing the actor
// and keeps the three slots' positions stable while the user types.

const OSKPredictionButton = GObject.registerClass(
class OSKPredictionButton extends St.Button {
    _init(keyboard, slotIndex) {
        super._init({
            label: '',
            style_class: 'osk-prediction-btn',
            can_focus: false,
            reactive: false,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._keyboard = keyboard;
        this._slotIndex = slotIndex;
        this._isEmpty = true;
        this._hovering = false;
        this._pressed = false;
        this._suggestionText = '';
        this._lastSuggestionStyleValue = '';
        this._predictionLabel = new St.Label({
            text: '',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        try {
            this._predictionLabel.clutter_text.set_ellipsize(
                Pango.EllipsizeMode.END);
        } catch (_e) {}
        this.set_child(this._predictionLabel);
        this.set_style(keyboard._styles.predictionBtnEmpty);
        this._predictionLabel.set_text('\u2013\u2013\u2013');

        this.connect('button-press-event', () => {
            if (this._isEmpty) return Clutter.EVENT_PROPAGATE;
            this._pressed = true;
            this._updateStyle();
            return Clutter.EVENT_STOP;
        });
        this.connect('button-release-event', () => {
            if (this._isEmpty) return Clutter.EVENT_PROPAGATE;
            this._pressed = false;
            this._updateStyle();
            this._keyboard.onPredictionClicked(this._slotIndex);
            return Clutter.EVENT_STOP;
        });
        this.connect('notify::hover', () => {
            this._hovering = this.hover;
            if (!this._hovering) this._pressed = false;
            this._updateStyle();
        });
    }

    handleCapturedPointerEvent(event) {
        if (this._isEmpty) return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN) {
            this._pressed = true;
            this._updateStyle();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE ||
            type === Clutter.EventType.TOUCH_END) {
            this._pressed = false;
            this._updateStyle();
            this._keyboard.onPredictionClicked(this._slotIndex);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.TOUCH_CANCEL ||
            type === Clutter.EventType.LEAVE) {
            this._pressed = false;
            this._updateStyle();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    setCapturedHover(hovering) {
        hovering = !!hovering;
        if (this._hovering === hovering) return;
        this._hovering = hovering;
        if (!this._hovering) this._pressed = false;
        this._updateStyle();
    }

    get_label() {
        return this._getDisplayLabel();
    }

    _getDisplayLabel() {
        return this._suggestionText || '';
    }

    setSuggestion(text) {
        const value = text || '';
        const wasEmpty = this._isEmpty;
        if (!text) {
            this._isEmpty = true;
            if (this.reactive) this.reactive = false;
            if (this._suggestionText !== '') {
                this._predictionLabel.set_text('\u2013\u2013\u2013');
            }
        } else {
            this._isEmpty = false;
            if (!this.reactive) this.reactive = true;
            if (this._suggestionText !== value)
                this._predictionLabel.set_text(value);
        }
        this._suggestionText = value;
        this._pressed = false;
        if (wasEmpty === this._isEmpty && this._lastSuggestionStyleValue === value) {
            this._updateStyle();
            return;
        }
        this._lastSuggestionStyleValue = value;
        this._updateStyle();
    }

    _updateStyle() {
        const s = this._keyboard && this._keyboard._styles;
        if (!s) return;
        let style;
        if (this._isEmpty) {
            style = s.predictionBtnEmpty;
        } else if (this._pressed) {
            style = s.predictionBtnPressed;
        } else if (this._hovering) {
            style = s.predictionBtnHover;
        } else {
            style = s.predictionBtn;
        }
        if (this._lastAppliedStyle !== style) {
            this._lastAppliedStyle = style;
            this.set_style(style);
        }
        if (this._keyboard && this._keyboard._applyPredictionButtonTextColor)
            this._keyboard._applyPredictionButtonTextColor(this);
    }
});


// ========================================================================
//  Keyboard (the actual on-screen keyboard widget)
// ========================================================================

export const OSKKeyboard = GObject.registerClass({
    Signals: {
        'close-requested': {},
        'minimize-requested': {},
        // Emitted when a special-action key (Mv Up, Dock, Mv Dn) asks
        // the extension to reposition the window on the work area.
        // Detail is a string: 'top' | 'middle' | 'bottom'.
        'snap-requested': { param_types: [GObject.TYPE_STRING] },
        // User tapped the "Options" key -- extension should pop its
        // right-click menu near the indicator.
        'options-requested': {},
        // User tapped "Help" -- extension should show help (for now
        // that's a brief OSD with the build tag; see _onHelpRequested).
        'help-requested': {},
    },
}, class OSKKeyboard extends St.BoxLayout {
    _init(virtualDevice, layoutKey, customization, userThemes) {
        super._init({
            vertical: true,
            style_class: 'osk-keyboard',
            reactive: true,
            visible: false,
            // No code reads the root widget's hover state, and
            // entering/leaving the keyboard window in RGB modes can
            // otherwise trigger a full-shell hover invalidation pass.
            track_hover: false,
            can_focus: false,
        });
        this._desiredWidth = 0;
        this._desiredHeight = 0;
        // Resolve the requested layout key against LAYOUTS up front so
        // it's available for spacing setup below; the same fallback is
        // re-applied to `this._layoutKey` further down for clarity.
        const resolvedLayoutKey = LAYOUTS[layoutKey] ? layoutKey : DEFAULT_LAYOUT_KEY;
        // `spacing` is not a valid CSS property -- set it as a real
        // BoxLayout property via JS.  Initial value uses the active
        // layout's spacing; setLayout() re-applies on layout change.
        this.spacing = _layoutKeySpacing(resolvedLayoutKey);

        // ---- customization / theming ------------------------------
        // Normalise the customization record before anything else so
        // _buildUi can call buildStyles and set per-widget inline
        // styles on the first paint (instead of applying a default
        // then re-themeing immediately, which causes a visible flash
        // during the first Shell paint frame).
        this._customization = Object.assign(
            {}, DEFAULT_CUSTOMIZATION, customization || {});
        // User-defined themes (forks of built-in themes).  Owned by
        // the keyboard so the renderer can resolve any theme id the
        // user selects, whether it's built-in or a fork.  Kept as a
        // simple dict (id -> theme definition).
        this._userThemes = userThemes ? Object.assign({}, userThemes) : {};
        this._styles = buildStyles(
            this._lookupThemeOrDefault(this._customization.themeId),
            this._customization);
        this.set_style(this._styles.keyboard);

        // RGB state lives on the per-key wrapper / halo / key actors.
        // Hue-cycling modes use one low-power timer guarded by a
        // generation token so stale callbacks cannot mutate rebuilt
        // actors.
        this._rgbCycleGeneration = 0;
        this._rgbCycleTimerId = 0;
        this._rgbCycleState = null;
        this._activeRgbModeSettingChangeKey = null;
        this._layoutKeysQueued = 0;
        this._postLayoutRefreshId = 0;
        this._layoutSettleRefreshId = 0;
        this._sizeRelayoutId = 0;
        this._keyRevealId = 0;
        this._suppressSizeNotifyLayout = false;
        this._interactiveMotionCount = 0;
        this._interactiveResize = false;
        this._resizeEffectsPaused = false;
        this._visibleEffectsPaused = false;
        this._dragLockedSetting = false;
        this._backgroundFrame = null;
        this._backgroundImage = null;
        this._backgroundSyncId = 0;

        this._virtualDevice = virtualDevice;
        this._modifiers = { SHIFT: MOD_OFF, CTRL: MOD_OFF, ALT: MOD_OFF, META: MOD_OFF };
        this._modButtons = { SHIFT: [], CTRL: [], ALT: [], META: [] };
        this._shiftedButtons = [];

        // Hold-to-repeat settings read by OSKKey on every press.  Kept
        // on the keyboard (not the keys) so the "Key repeat" menu can
        // change them at runtime from one place.  delay == 0 disables
        // the repeat scheduler entirely (== the "Off" menu choice).
        this._repeatDelay = REPEAT_DELAY_MS;
        this._repeatInterval = REPEAT_INTERVAL_MS;

        // Per-row records (box + list of {btn, spec}) so _layoutKeys
        // can walk the rows and assign sizes on every resize.
        this._rowRecords = [];

        // Active layout key (lookup into LAYOUTS).  Changed via
        // setLayout() at runtime; persisted to config.json by the
        // extension so next start-up restores it.  Fall back to the
        // documented default if the caller passed something unknown
        // (stale config from an older build).
        this._layoutKey = LAYOUTS[layoutKey] ? layoutKey : DEFAULT_LAYOUT_KEY;

        // ---- prediction state -------------------------------------
        // Off by default; the indicator menu flips it on and loads
        // state via setPredictor / setPredictionEnabled.  All three
        // "currentWord / previousWord / predictor" reads are nullable
        // so the typing path costs nothing when prediction is off.
        this._predictor = null;
        this._predictionEnabled = false;
        this._currentWord = '';     // what the user has typed of the
                                    // word they're currently on (mixed case)
        this._previousWord = '';    // most recently committed word (lowercase)
        this._predictionLayer = null;
        this._predictionBarBg = null;
        this._predictionBar = null;
        this._predictionGlow = null;
        this._predictionGlowBleed = 0;
        this._predictionButtons = [];
        // Debounced refresh: multiple keypresses within a short burst
        // collapse into a single predictor.predict() call.  Keeps the
        // typing path snappy if the dictionary ever grows huge.
        this._predictRefreshId = 0;
        // Idle auto-clear timer.  Reset on every keypress (including
        // taps on the prediction bar itself); when it fires we wipe
        // the tracking buffer and hide suggestions -- so a user who
        // walked away mid-word doesn't come back to stale "finish
        // this word for me" prompts.  Only armed while prediction is
        // enabled, see _armIdleTimer / _cancelIdleTimer.
        this._idleTimerId = 0;

        this._buildUi();
        this._assignKeyRgbIndices();
        // Install whatever RGB animation matches the current mode.
        // Does nothing when mode is 'off' (the default).
        this._syncRgbAnimation();

        // Per-key state (RGB transitions on key/halo/wrapper actors)
        // is cleaned by OSKKey._onDestroy + the wrapper teardown when
        // the actor tree comes down.  Only non-actor state needs an
        // explicit destroy hook.
        this.connect('destroy', () => {
            this._cancelRgbCycleEngine();
            this._cancelIdleTimer();
            this._cancelQueuedLayoutWork();
            _clearSource(this, '_keyRevealId');
            _clearSource(this, '_backgroundSyncId');
            this._destroyBackgroundLayer();
        });

        // No visibility-pause handler is needed: Clutter doesn't draw
        // hidden actors, so the animated transitions consume no GPU
        // work while the keyboard is minimised.  Their timelines do
        // keep advancing in C, but that's a micro-cost (no JS, no
        // texture upload) that doesn't justify the install/uninstall
        // churn the old rainbow timer needed.

        // Drag is handled by OSKTitleBar (on its label only) so that
        // button/key clicks can never collide with drag starts.  The
        // keyboard itself has no button-press-event handler.

        // Recompute key sizes on every size change.  Connect BOTH
        // width and height: width changes the per-key horizontal size,
        // height changes the vertical size (so the background always
        // hugs the keys, no empty band below).
        this.connect('notify::width', () => {
            if (!this._suppressSizeNotifyLayout) this._queueLayoutKeys();
        });
        this.connect('notify::height', () => {
            if (!this._suppressSizeNotifyLayout) this._queueLayoutKeys();
        });
        this.connect('notify::x', () => this._queueBackgroundLayerSync());
        this.connect('notify::y', () => this._queueBackgroundLayerSync());
        this.connect('notify::width', () => this._queueBackgroundLayerSync());
        this.connect('notify::height', () => this._queueBackgroundLayerSync());
        try {
            this.connect('captured-event',
                (_actor, event) => this._onKeyboardCapturedEvent(event));
        } catch (_e) {}
        this.connect('notify::visible', () => this._onVisibilityChanged());
    }

    vfunc_get_preferred_width(forHeight) {
        if (this._desiredWidth > 0)
            return [this._desiredWidth, this._desiredWidth];
        return [MIN_KEYBOARD_WIDTH, MIN_KEYBOARD_WIDTH];
    }

    vfunc_get_preferred_height(forWidth) {
        if (this._desiredHeight > 0)
            return [this._desiredHeight, this._desiredHeight];
        return [MIN_KEYBOARD_HEIGHT, MIN_KEYBOARD_HEIGHT];
    }

    _buildUi() {
        const titleBar = new OSKTitleBar(this);
        this._titleBar = titleBar;
        titleBar.connect('close-requested',
            () => this.emit('close-requested'));
        titleBar.connect('minimize-requested',
            () => this.emit('minimize-requested'));
        this.add_child(titleBar);

        // Prediction bar -- three clickable suggestion slots above the
        // key rows.  Hidden by default; the indicator menu's "Word
        // prediction" switch flips setPredictionEnabled(true) which
        // both shows this strip AND starts feeding the predictor.
        // Inserted here (between title bar and rows) so when visible
        // it reads as part of the keyboard chrome; _layoutKeys()
        // subtracts its height from the per-key vertical budget via
        // _verticalChrome() so the six rows scale correctly.
        this._predictionLayer = new Clutter.Actor({
            x_expand: true,
            y_expand: false,
            visible: false,
            reactive: false,
        });
        this._predictionBarBg = new St.Widget({
            reactive: false,
            visible: true,
        });
        this._predictionBarBg.set_style(this._styles.predictionBar);
        this._predictionLayer.add_child(this._predictionBarBg);

        this._predictionGlow = new St.DrawingArea({
            reactive: false,
            visible: false,
        });
        this._predictionGlow.connect('repaint',
            () => this._drawPredictionGlow(this._predictionGlow));
        this._predictionLayer.add_child(this._predictionGlow);

        this._predictionBar = new St.BoxLayout({
            x_expand: true,
            y_expand: false,
            visible: false,
            reactive: true,
        });
        this._predictionBar.spacing = KEY_SPACING;
        this._predictionBar.set_style(this._styles.predictionBarOverlay);
        // Start with the minimum slot count; _ensurePredictionSlotCount
        // grows / shrinks the array from _layoutKeys once we know the
        // actual keyboard width.  This keeps the bar functional even
        // on the first paint before any size allocation has happened.
        for (let i = 0; i < PREDICTION_SLOT_MIN; i++) {
            const btn = new OSKPredictionButton(this, i);
            this._predictionBar.add_child(btn);
            this._predictionButtons.push(btn);
        }
        this._predictionLayer.add_child(this._predictionBar);
        this.add_child(this._predictionLayer);

        // Build the key rows for the active layout.  Factored out so
        // setLayout() can rebuild just the rows (not the title bar /
        // prediction bar / bottom grip) when the user picks a
        // different layout at runtime.
        this._buildRows(LAYOUTS[this._layoutKey].rows);

        // Bottom row: resize grip floated to the right via an expanding
        // spacer (there's no right-alignment property on BoxLayout
        // children; spacer-with-x_expand is the idiom).
        const bottomRow = new St.BoxLayout({ x_expand: true });
        bottomRow.spacing = 0;
        const spacer = new St.Widget({ x_expand: true, y_expand: false });
        bottomRow.add_child(spacer);
        this._grip = new OSKResizeGrip(this);
        bottomRow.add_child(this._grip);
        this.add_child(bottomRow);
        this._bottomRow = bottomRow;
        this._applyChromeVisibility();
    }

    _onKeyboardCapturedEvent(event) {
        const type = event.type && event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;
        if (!this._grip || !this._eventInResizeCorner(event))
            return Clutter.EVENT_PROPAGATE;
        try {
            if (event.get_button && event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
        } catch (_e) {
            return Clutter.EVENT_PROPAGATE;
        }
        return this._grip.beginResizeFromEvent(event);
    }

    _eventInResizeCorner(event) {
        let x, y;
        try {
            [x, y] = event.get_coords();
        } catch (_e) {
            return false;
        }
        let gx = 0, gy = 0;
        try {
            [gx, gy] = this.get_transformed_position();
        } catch (_e) {
            gx = this.get_x();
            gy = this.get_y();
        }
        const w = this._desiredWidth > 0
            ? this._desiredWidth : (this.width > 0 ? this.width : this.get_width());
        const h = this._desiredHeight > 0
            ? this._desiredHeight : (this.height > 0 ? this.height : this.get_height());
        if (w <= 0 || h <= 0) return false;
        const hotW = 48;
        const hotH = Math.max(28, BOTTOMROW_HEIGHT_APPROX + 8);
        return x >= gx + w - hotW && x <= gx + w
            && y >= gy + h - hotH && y <= gy + h;
    }

    // Create OSKKey actors for each spec in `rows` and append them as
    // St.BoxLayout children between the prediction bar and the bottom
    // grip row.  Populates _rowRecords / _modButtons / _shiftedButtons
    // from scratch; callers that are switching layouts must call
    // _destroyRows() first to tear down the previous rows cleanly.
    //
    // Each row is a lightweight layer with a rowGlow canvas behind the
    // rowBox.  Each key cell is then a Clutter.Actor wrapper inside
    // rowBox, holding a colorRing behind the OSKKey.  rowText is a
    // row-level canvas used only for hue-mode RGB text cycling; it
    // avoids recoloring every key label actor on each sampled frame.
    //
    // Manual positioning via notify::allocation: the key fills the
    // wrapper; shadows / ring extend past the wrapper's bounds (Clutter
    // children aren't clipped to parent bounds, so their paint reaches
    // into the inter-key gaps and beyond).
    _buildRows(rows) {
        const insertBefore = this._bottomRow || null;
        const sp = _layoutKeySpacing(this._layoutKey);
        let rowIndex = 0;
        for (const row of rows) {
            const currentRowIndex = rowIndex++;
            const rowLayer = new Clutter.Actor({
                x_expand: true,
                y_expand: true,
                reactive: false,
            });

            const rowGlows = [];
            for (let i = 0; i < RGB_CANVAS_LAYERS; i++) {
                const rowGlow = new St.DrawingArea({
                    reactive: false,
                    x_expand: true,
                    y_expand: true,
                });
                rowGlow.opacity = 0;
                rowGlow.visible = false;
                rowGlow._rgbGlowStep = -1;
                rowLayer.add_child(rowGlow);
                rowGlows.push(rowGlow);
            }

            const rowBox = new St.BoxLayout({
                style_class: 'osk-row',
                x_expand: true,
                y_expand: true,
            });
            rowBox.spacing = sp;
            rowLayer.add_child(rowBox);

            const rowText = new St.DrawingArea({
                reactive: false,
                x_expand: true,
                y_expand: true,
            });
            rowText.visible = false;
            rowText.opacity = 255;
            rowText._rgbTextPhase = 0;
            rowLayer.add_child(rowText);

            const record = {
                box: rowLayer,
                rowBox,
                rowText,
                rowGlow: rowGlows[0],
                rowGlows,
                keys: [],
                totalUnits: row.reduce((sum, spec) => sum + spec.width, 0),
                spacingTotal: sp * Math.max(0, row.length - 1),
                minAvailable: row.length * 16,
                rowIndex: currentRowIndex,
                rowCount: rows.length,
                _rgbGlowBleed: 0,
            };
            for (const rowGlow of rowGlows) {
                rowGlow.connect('repaint',
                    () => this._drawRgbRowGlow(rowGlow, record));
            }
            rowText.connect('repaint',
                () => this._drawRgbRowText(rowText, record));
            rowLayer.connect('notify::allocation',
                () => this._layoutRgbRowGlow(record));

            for (const spec of row) {
                const wrapper = new Clutter.Actor({
                    x_expand: true,
                    y_expand: true,
                });

                const colorRing = new Clutter.Actor({ reactive: false });
                colorRing.opacity = 0;
                wrapper.add_child(colorRing);

                const btn = new OSKKey(spec, this);
                wrapper.add_child(btn);

                wrapper.connect('notify::allocation', () => {
                    this._layoutCellActors(wrapper, btn, colorRing);
                });

                rowBox.add_child(wrapper);
                record.keys.push({
                    btn, spec, wrapper, colorRing,
                });
                if (spec.modifier) {
                    this._modButtons[spec.modifier].push(btn);
                } else if (spec.shift) {
                    this._shiftedButtons.push(btn);
                }
            }
            this._rowRecords.push(record);
            if (insertBefore) {
                this.insert_child_below(rowLayer, insertBefore);
            } else {
                this.add_child(rowLayer);
            }
        }
    }

    // Position the key body and RGB colorRing inside their wrapper.
    // Called from notify::allocation on the wrapper AND from
    // _resizeAllColorRings when the user adjusts the border size
    // slider mid-session (which doesn't trigger a fresh allocation).
    _layoutCellActors(wrapper, btn, colorRing) {
        const a = wrapper.get_allocation_box
            && wrapper.get_allocation_box();
        if (!a) return;
        const w = a.x2 - a.x1;
        const h = a.y2 - a.y1;
        if (w <= 0 || h <= 0) return;
        _setActorGeometryIfChanged(btn, 0, 0, w, h);
        if (btn) {
            btn._oskHasCellAllocation = true;
            if (!btn.visible)
                this._queueAllocatedKeyReveal();
        }
        if (this._interactiveResize) return;
        const cb = this._currentColorRingGeometryBleed();
        _setActorGeometryIfChanged(
            colorRing, -cb, -cb, w + 2 * cb, h + 2 * cb);
    }

    _queueAllocatedKeyReveal() {
        if (this._keyRevealId) return;
        this._keyRevealId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE, 16,
            () => {
                this._keyRevealId = 0;
                this._revealAllocatedKeys();
                return GLib.SOURCE_REMOVE;
            });
    }

    _revealAllocatedKeys() {
        for (const row of this._rowRecords) {
            for (const cell of row.keys) {
                const btn = cell.btn;
                if (!btn || btn.visible || !btn._oskHasCellAllocation)
                    continue;
                try { btn.visible = true; } catch (_e) {}
            }
        }
    }

    _layoutRgbRowGlow(row) {
        if (!row || !row.box) return;
        const a = row.box.get_allocation_box
            && row.box.get_allocation_box();
        if (!a) return;
        const w = a.x2 - a.x1;
        const h = a.y2 - a.y1;
        if (w <= 0 || h <= 0) return;

        let geometryChanged = false;
        if (row.rowBox) {
            geometryChanged = _setActorGeometryIfChanged(
                row.rowBox, 0, 0, w, h) || geometryChanged;
        }
        if (row.rowText) {
            const textChanged = _setActorGeometryIfChanged(
                row.rowText, 0, 0, w, h);
            geometryChanged = textChanged || geometryChanged;
            if (textChanged && row.rowText.visible
                && !this._isInteractiveMotionPaused())
                row.rowText.queue_repaint();
        }
        if (this._interactiveResize) return;

        const glows = row.rowGlows || (row.rowGlow ? [row.rowGlow] : []);
        const bleed = this._currentCanvasGlowBleed();
        row._rgbGlowBleed = bleed;
        for (const rowGlow of glows) {
            const glowChanged = _setActorGeometryIfChanged(
                rowGlow, -bleed, -bleed, w + 2 * bleed, h + 2 * bleed);
            if ((glowChanged || geometryChanged) && rowGlow.visible)
                rowGlow.queue_repaint();
        }
    }

    // Tear down every row built by _buildRows so setLayout can replace
    // them.  Resets the mod/shifted button registries because the
    // incoming rows have their own OSKKey instances.  Modifier state
    // itself is kept (user's SHIFT/CTRL lock state survives a layout
    // switch) -- only the button references are invalidated.
    _destroyRows() {
        for (const rec of this._rowRecords) {
            rec._destroyed = true;
            const glows = rec.rowGlows || (rec.rowGlow ? [rec.rowGlow] : []);
            for (const glow of glows) {
                if (!glow) continue;
                glow.visible = false;
                glow.opacity = 0;
            }
            if (rec.rowText) rec.rowText.visible = false;
            // Destroying the row layer takes its glow canvas, rowBox,
            // wrappers, and OSKKey children with it.
            try { rec.box.destroy(); }
            catch (_e) { }
        }
        this._rowRecords = [];
        this._modButtons = { SHIFT: [], CTRL: [], ALT: [], META: [] };
        this._shiftedButtons = [];
    }

    _destroyUiChildren() {
        for (const child of this.get_children()) {
            try { child.destroy(); }
            catch (_e) { }
        }
        this._titleBar = null;
        this._predictionLayer = null;
        this._predictionBarBg = null;
        this._predictionBar = null;
        this._predictionGlow = null;
        this._predictionButtons = [];
        this._bottomRow = null;
        this._grip = null;
        this._rowRecords = [];
        this._modButtons = { SHIFT: [], CTRL: [], ALT: [], META: [] };
        this._shiftedButtons = [];
    }

    // Public: swap the active key-row layout to a different one in the
    // LAYOUTS registry.  No-op if the key is unknown or already
    // active.  Persistence is the extension's responsibility -- this
    // method just rebuilds the actors.
    setLayout(layoutKey) {
        if (!LAYOUTS[layoutKey]) return;
        if (layoutKey === this._layoutKey) return;
        if (this._layoutSwitchInProgress) return;
        this._layoutSwitchInProgress = true;
        this._cancelQueuedLayoutWork();
        this._teardownRgbAnimation();
        const oldSuppress = this._suppressSizeNotifyLayout;
        this._suppressSizeNotifyLayout = true;
        try {
            const geom = this._currentGeometry();
            this._layoutKey = layoutKey;
            // Re-apply layout-specific vertical spacing (the keyboard's
            // BoxLayout `spacing` controls the gap between row boxes and
            // the prediction bar / bottom grip).  _buildRows then uses
            // the same value for horizontal gaps within each row.
            this.spacing = _layoutKeySpacing(layoutKey);
            // A full child-tree rebuild is more reliable than swapping
            // only row actors: St.BoxLayout can keep stale allocations
            // around for destroyed children until the next frame.
            this._destroyUiChildren();
            this._buildUi();
            if (this._titleBar) {
                this._titleBar.setDragLocked(!!this._dragLockedSetting);
                this._titleBar.setAuthMode(!!this._authMode);
            }
            // Re-apply SHIFT visual state so any pressed-but-not-consumed
            // SHIFT shows correctly on the new mod buttons.  If we don't
            // do this the freshly built Shift keys look "off" even while
            // the internal state says armed/locked.
            for (const name of ['SHIFT', 'CTRL', 'ALT', 'META']) {
                this._refreshModButtons(name);
            }
            this._refreshShiftedLabels();
            // Fresh set of OSKKey actors -- assign new RGB indices so the
            // rainbow / reactive modes work, then reinstall whatever
            // animation matches the active mode (the breathing transitions
            // we installed on the previous key actors went away with them).
            this._assignKeyRgbIndices();
            this._applyStyles();
            this._applyKeyboardSize(geom.w, geom.h);
        } finally {
            this._suppressSizeNotifyLayout = oldSuppress;
            this._layoutSwitchInProgress = false;
        }
        this._syncRgbAnimation();
        this._queuePostLayoutRefresh();
    }

    getLayout() { return this._layoutKey; }


    // ---- theme / customization ----------------------------------
    //
    // The keyboard owns a single `_styles` map (produced by
    // buildStyles) and a single `_customization` record.  Mutating
    // either goes through `_applyCustomization` which rebuilds styles
    // and calls `_applyStyles` to repaint every widget.  Individual
    // setters (setTheme, setKeyOpacity, ...) are convenience wrappers
    // around `_applyCustomization(partial)`; the menu code uses the
    // fine-grained setters, while the extension's startup / config
    // restore path uses the bulk setter.
    //
    // Everything here is idempotent -- setting the same theme again
    // is a no-op, so it's safe to call from config-restore paths that
    // don't track what changed.

    // Assign each existing key a stable `_rgbIndex` (flat row-major
    // index), `_rgbRowIndex`, and `_rgbColumnIndex` for the RGB
    // animated modes.  Called after _buildUi and after setLayout (key
    // actors get replaced on layout change).  rainbow / cycle use
    // _rgbIndex for per-key hue offsets; wave combines row + column
    // phase so it reads as a diagonal sweep instead of row bands.
    _assignKeyRgbIndices() {
        let idx = 0;
        let rowIdx = 0;
        for (const row of this._rowRecords) {
            const rowCount = row.keys.length || 1;
            let colIdx = 0;
            for (const { btn } of row.keys) {
                btn._rgbIndex = idx++;
                btn._rgbRowIndex = rowIdx;
                btn._rgbColumnIndex = colIdx++;
                btn._rgbRowKeyCount = rowCount;
            }
            rowIdx++;
        }
    }

    getCustomization() {
        return Object.assign({}, this._customization);
    }

    // Return a deep-ish clone of the user themes map.  The theme
    // objects themselves are plain data so the JSON round-trip used
    // by _cloneTheme is fine, and returning a clone rather than the
    // live map means callers can't accidentally mutate our state.
    getUserThemes() {
        const out = {};
        for (const [id, t] of Object.entries(this._userThemes)) {
            out[id] = _cloneTheme(t);
        }
        return out;
    }

    _themeOptionsFromCustomization(custom = this._customization) {
        const out = {};
        for (const key of THEME_OPTION_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(custom, key)) continue;
            const v = custom[key];
            out[key] = (v && typeof v === 'object')
                ? JSON.parse(JSON.stringify(v)) : v;
        }
        return out;
    }

    _syncOptionsToActiveUserTheme() {
        const id = this._customization && this._customization.themeId;
        const t = id && this._userThemes && this._userThemes[id];
        if (!t) return;
        t.options = this._themeOptionsFromCustomization();
    }

    // Look up a theme by id across both registries, falling back to
    // the documented default if neither has it.  Never returns null
    // so callers can use the result unconditionally.
    _lookupThemeOrDefault(id) {
        return _lookupTheme(id, this._userThemes) || THEMES[DEFAULT_THEME_ID];
    }

    // All theme ids, built-in first then user themes, each tagged
    // with { id, label, builtIn }.  Used by the Customize window to
    // render its theme picker.
    listAllThemes() {
        const out = [];
        for (const id of Object.keys(THEMES)) {
            out.push({ id, label: THEMES[id].label, builtIn: true });
        }
        for (const id of Object.keys(this._userThemes)) {
            const t = this._userThemes[id];
            out.push({
                id,
                label: (t && t.label) || id,
                builtIn: false,
            });
        }
        return out;
    }

    getThemeLabel(id) {
        const t = _lookupTheme(id, this._userThemes);
        return t ? t.label : id;
    }

    // Bulk setter: merge `partial` into the current customization,
    // rebuild normal key styles only when the changed fields affect
    // them, and re-sync the RGB loop in case the lighting changed.
    // Returns the effective customization after merge so callers can
    // persist it to disk.
    _applyCustomization(partial) {
        const prev = this._customization;
        const next = Object.assign({}, prev, partial || {});
        const sameValue = (a, b) => {
            if (a === b) return true;
            if (a && b && typeof a === 'object' && typeof b === 'object') {
                try { return JSON.stringify(a) === JSON.stringify(b); }
                catch (_e) { return false; }
            }
            return false;
        };
        const changed = (key) => !sameValue(prev && prev[key], next[key]);
        const modeSettingKey = changed('rgbModeSettings')
            ? this._activeRgbModeSettingChangeKey : null;
        const modeSettingMaybe = (key) =>
            changed('rgbModeSettings')
            && (!modeSettingKey || modeSettingKey === key);
        const needsStyleRebuild = [
            'themeId',
            'customBackground',
            'backgroundFit',
            'backgroundPositionX',
            'backgroundPositionY',
            'backgroundScale',
            'topBarOpacity',
            'predictionButtonOpacity',
            'keyboardBg',
            'customColors',
            'keyOpacity',
            'textBold',
            'textOpacity',
            'keyTextSize',
        ].some(changed);
        const needsTitleVisibility = changed('showOskTitle');
        const advancedRgbChanged = [
            'rgbBorderSize',
            'rgbGlowSize',
            'rgbBlurAmount',
            'rgbSpeed',
            'rgbHaloSoftness',
            'rgbHaloCoverage',
            'rgbCornerBlend',
            'rgbModeSettings',
        ].some(changed);
        const speedChanged = changed('rgbSpeed')
            || modeSettingMaybe('rgbSpeed');
        const needsRgbSync = [
            'rgbMode',
            'rgbColor',
            'rgbIntensity',
            'rgbCycleLabels',
        ].some(changed) || speedChanged;
        const needsRingResize = changed('rgbBorderSize')
            || modeSettingMaybe('rgbBorderSize')
            || changed('rgbMode');
        const needsCanvasResize = changed('rgbBorderSize')
            || changed('rgbGlowSize')
            || modeSettingMaybe('rgbBorderSize')
            || modeSettingMaybe('rgbGlowSize')
            || changed('rgbMode');
        const needsTextRepaint = changed('textOpacity')
            || changed('textBold')
            || changed('keyTextSize');
        this._customization = next;
        this._syncOptionsToActiveUserTheme();
        if (needsStyleRebuild) {
            const theme = this._lookupThemeOrDefault(this._customization.themeId);
            this._styles = buildStyles(theme, this._customization);
            this._applyStyles();
        }
        if (needsTitleVisibility && this._titleBar
            && this._titleBar._syncTitleText) {
            this._titleBar._syncTitleText();
        }
        // RGB geometry changes need manual sizing because wrapper
        // allocations do not re-fire when only a slider value changed.
        // Non-RGB text/theme tweaks skip this path to keep sliders
        // lightweight.
        if (needsRingResize) this._resizeAllColorRings();
        if (needsCanvasResize) this._resizeRgbCanvasGlows();
        if (needsRgbSync) {
            this._syncRgbAnimation();
        } else if (advancedRgbChanged) {
            this._repaintRgbCanvasGlows();
        } else if (needsTextRepaint && this._rgbCycleState
            && this._rgbCycleState.cycleLabels) {
            for (const row of this._rowRecords) {
                if (row.rowText) row.rowText.queue_repaint();
            }
        }
        return this.getCustomization();
    }

    _showOskTitle() {
        return !this._customization
            || this._customization.showOskTitle !== false;
    }

    _applyChromeVisibility() {
        if (this._titleBar) {
            this._titleBar.visible = true;
            if (this._titleBar._syncTitleText)
                this._titleBar._syncTitleText();
        }
        this._updatePredictionVisibility();
        this._queueLayoutKeys();
        this._queuePostLayoutRefresh();
    }

    // Walk every key entry and re-apply the colorRing's position +
    // size based on the current rgbBorderSize slider.  Called by
    // _applyCustomization so the user sees the slider take effect
    // live (notify::allocation only fires on real layout changes).
    _resizeAllColorRings() {
        for (const row of this._rowRecords) {
            for (const cell of row.keys) {
                this._layoutCellActors(
                    cell.wrapper, cell.btn, cell.colorRing);
            }
        }
    }

    _resizeRgbCanvasGlows() {
        for (const row of this._rowRecords) {
            this._layoutRgbRowGlow(row);
        }
        this._layoutPredictionGlow();
    }

    _repaintRgbCanvasGlows() {
        const state = this._rgbCycleState;
        const ringOpacity = this._currentColorRingOpacity();
        if (state) state.ringOpacity = ringOpacity;
        for (const row of this._rowRecords) {
            for (const cell of row.keys) {
                if (cell.colorRing && cell.colorRing.opacity > 0)
                    cell.colorRing.opacity = ringOpacity;
            }
            const glows = row.rowGlows || (row.rowGlow ? [row.rowGlow] : []);
            for (const glow of glows) {
                if (glow && glow.visible) glow.queue_repaint();
            }
            if (state && state.cycleLabels && row.rowText && row.rowText.visible)
                row.rowText.queue_repaint();
        }
        if (this._predictionGlow && this._predictionGlow.visible)
            this._predictionGlow.queue_repaint();
    }

    // Rebuild styles without changing the customization record.  Used
    // after a user theme is edited in place -- the customization is
    // unchanged but the referenced theme's contents moved.
    _reapplyActiveTheme() {
        const theme = this._lookupThemeOrDefault(this._customization.themeId);
        this._styles = buildStyles(theme, this._customization);
        this._applyStyles();
    }

    _destroyBackgroundLayer() {
        if (!this._backgroundFrame) return;
        try { this._backgroundFrame.destroy(); }
        catch (_e) { }
        this._backgroundFrame = null;
        this._backgroundImage = null;
    }

    _ensureBackgroundLayer() {
        const hasImage = !!(this._customization
            && this._customization.customBackground);
        if (!hasImage) {
            this._destroyBackgroundLayer();
            return false;
        }

        const parent = this.get_parent && this.get_parent();
        if (!parent) return false;

        if (!this._backgroundFrame
            || this._backgroundFrame.get_parent() !== parent) {
            this._destroyBackgroundLayer();
            const frame = new St.Widget({
                reactive: false,
                visible: this.visible,
            });
            const image = new St.Widget({
                reactive: false,
                visible: true,
            });
            frame.add_child(image);
            try {
                if (parent.insert_child_below)
                    parent.insert_child_below(frame, this);
                else
                    parent.add_child(frame);
            } catch (_e) {
                try { parent.add_child(frame); } catch (_e2) { return false; }
            }
            this._backgroundFrame = frame;
            this._backgroundImage = image;
        }

        try {
            if (parent.set_child_below_sibling)
                parent.set_child_below_sibling(this._backgroundFrame, this);
        } catch (_e) { }

        return true;
    }

    _queueBackgroundLayerSync() {
        if (this._backgroundSyncId) return;
        this._backgroundSyncId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE, 16,
            () => {
                this._backgroundSyncId = 0;
                this._syncBackgroundLayer();
                return GLib.SOURCE_REMOVE;
            });
    }

    _syncBackgroundLayer() {
        if (!this._ensureBackgroundLayer()) return;
        const frame = this._backgroundFrame;
        const image = this._backgroundImage;
        if (!frame || !image || !this._styles) return;

        const geom = this._currentGeometry();
        const w = Math.max(1, geom.w | 0);
        const h = Math.max(1, geom.h | 0);
        frame.visible = !!this.visible;
        frame.set_style(this._styles.keyboardBackgroundFrame || '');
        image.set_style(this._styles.keyboardBackgroundImage || '');
        _setActorGeometryIfChanged(frame, geom.x, geom.y, w, h);
        try { frame.set_clip(0, 0, w, h); } catch (_e) { }

        const fit = this._styles.keyboardBackgroundFit || 'cover';
        const userScale = Math.max(40, Math.min(250,
            this._styles.keyboardBackgroundScale !== undefined
                ? this._styles.keyboardBackgroundScale : 100)) / 100;
        const baseScale = fit === 'stretch' ? 1 : BACKGROUND_POSITION_OVERSCAN;
        const scale = baseScale * userScale;
        const imgW = Math.max(1, Math.round(w * scale));
        const imgH = Math.max(1, Math.round(h * scale));
        const posX = Math.max(0, Math.min(100,
            this._styles.keyboardBackgroundPositionX !== undefined
                ? this._styles.keyboardBackgroundPositionX : 50));
        const posY = Math.max(0, Math.min(100,
            this._styles.keyboardBackgroundPositionY !== undefined
                ? this._styles.keyboardBackgroundPositionY : 50));
        const x = imgW >= w
            ? -Math.round((imgW - w) * (posX / 100))
            : Math.round((w - imgW) * (posX / 100));
        const y = imgH >= h
            ? -Math.round((imgH - h) * (posY / 100))
            : Math.round((h - imgH) * (posY / 100));
        _setActorGeometryIfChanged(image, x, y, imgW, imgH);
        try { image.queue_redraw(); } catch (_e) { }
    }

    setTheme(id) {
        const theme = _lookupTheme(id, this._userThemes);
        if (!theme) return this.getCustomization();
        const savedOptions = (theme && theme.options
            && typeof theme.options === 'object')
            ? JSON.parse(JSON.stringify(theme.options)) : {};
        return this._applyCustomization(Object.assign({}, savedOptions, {
            themeId: id,
        }));
    }

    // Create a new user theme by cloning the currently active theme
    // (built-in or user) under a new id + label.  Activates the new
    // theme.  Returns the id.  Caller is responsible for validating
    // the label / making sure it's unique; we use a lower-cased,
    // sanitised version of the label as the id (falling back to a
    // timestamped default for all-punctuation inputs).
    forkActiveTheme(label) {
        const srcId = this._customization.themeId;
        const src = this._lookupThemeOrDefault(srcId);
        const cleanLabel = (label || '').trim() || 'Custom theme';
        const id = this._uniqueUserThemeId(cleanLabel);
        const copy = _cloneTheme(src);
        copy.label = cleanLabel;
        copy.based_on = srcId;
        copy.options = this._themeOptionsFromCustomization();
        this._userThemes[id] = copy;
        // Any existing customColors overrides on the source theme
        // should bake into the new user theme so the fork *looks*
        // identical to what the user currently sees.
        const overrides = this._customization.customColors || {};
        for (const [path, hex] of Object.entries(overrides)) {
            if (!hex) continue;
            const parts = path.split('.');
            if (parts.length === 2 && copy[parts[0]]) {
                copy[parts[0]][parts[1]] = hex;
            }
        }
        if (this._customization.keyboardBg) {
            copy.keyboard = copy.keyboard || {};
            copy.keyboard.bg = this._customization.keyboardBg;
        }
        // Switch to the new theme and clear the now-redundant overrides.
        this._applyCustomization({
            themeId: id,
            customColors: {},
            keyboardBg: null,
        });
        return id;
    }

    // Sanitise `label` into a unique user-theme id.  Lowercases,
    // replaces non-alphanum with dashes, appends a numeric suffix if
    // the id is already taken.
    _uniqueUserThemeId(label) {
        let base = String(label).toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!base) base = 'theme';
        // Built-in ids must not be shadowed.
        const taken = (id) => !!(THEMES[id] || this._userThemes[id]);
        let id = base;
        let n = 2;
        while (taken(id)) {
            id = `${base}-${n++}`;
        }
        return id;
    }

    // Modify a single color slot on a user theme, then re-apply
    // styles if it's the active theme.  Throws nothing on built-in
    // ids (just a no-op) so the Customize window's edit flow can call
    // this unconditionally after a successful fork.
    setUserThemeColor(id, path, hex) {
        const t = this._userThemes[id];
        if (!t) return;
        if (!hex) return;
        const parts = path.split('.');
        if (parts.length !== 2) return;
        t[parts[0]] = t[parts[0]] || {};
        t[parts[0]][parts[1]] = String(hex);
        if (this._customization.themeId === id) {
            this._reapplyActiveTheme();
        }
    }

    // Rename a user theme (label only -- the id stays the same so
    // persisted config references keep working).
    renameUserTheme(id, newLabel) {
        const t = this._userThemes[id];
        if (!t) return;
        t.label = String(newLabel || '').trim() || t.label;
    }

    // Delete a user theme.  If it's the active theme, fall back to
    // the default built-in theme so the keyboard doesn't end up
    // pointing at nothing.
    deleteUserTheme(id) {
        if (!this._userThemes[id]) return;
        delete this._userThemes[id];
        if (this._customization.themeId === id) {
            this._applyCustomization({ themeId: DEFAULT_THEME_ID });
        }
    }

    setCustomBackground(path) {
        // null / '' / undefined all mean "no image"; normalise to null
        // so downstream equality checks work.
        const p = path ? String(path) : null;
        return this._applyCustomization({ customBackground: p });
    }

    setBackgroundFit(fit) {
        if (!['cover', 'contain', 'stretch'].includes(fit)) return this.getCustomization();
        return this._applyCustomization({ backgroundFit: fit });
    }

    setBackgroundPosition(axis, pct) {
        pct = Math.max(0, Math.min(100, Math.round(+pct || 0)));
        if (axis === 'x')
            return this._applyCustomization({ backgroundPositionX: pct });
        if (axis === 'y')
            return this._applyCustomization({ backgroundPositionY: pct });
        return this.getCustomization();
    }

    setBackgroundScale(pct) {
        pct = Math.max(40, Math.min(250, Math.round(+pct || 100)));
        return this._applyCustomization({ backgroundScale: pct });
    }

    setTopBarOpacity(pct) {
        pct = Math.max(0, Math.min(100, pct | 0));
        return this._applyCustomization({ topBarOpacity: pct });
    }

    setOskTitleVisible(visible) {
        return this._applyCustomization({ showOskTitle: !!visible });
    }

    setPredictionButtonOpacity(pct) {
        pct = Math.max(0, Math.min(100, pct | 0));
        return this._applyCustomization({ predictionButtonOpacity: pct });
    }

    setKeyOpacity(pct) {
        pct = Math.max(0, Math.min(100, pct | 0));
        return this._applyCustomization({ keyOpacity: pct });
    }

    setTextOpacity(pct) {
        pct = Math.max(0, Math.min(100, pct | 0));
        return this._applyCustomization({ textOpacity: pct });
    }

    setTextBold(bold) {
        return this._applyCustomization({ textBold: !!bold });
    }

    setKeyTextSize(px) {
        px = Math.max(10, Math.min(28, px | 0));
        return this._applyCustomization({ keyTextSize: px });
    }

    // Set a single per-element color override.  `path` is a dotted
    // key into the theme object (e.g. 'key.bg', 'titleBar.text').
    // `hex` is a CSS hex color; null / '' clears the override.
    // Unknown paths are tolerated -- they just sit in the dict with
    // no visible effect, letting callers be forward-compatible with
    // future theme slots.
    setCustomColor(path, hex) {
        if (typeof path !== 'string' || !path) return this.getCustomization();
        const prev = this._customization.customColors || {};
        const nextColors = Object.assign({}, prev);
        if (hex) {
            nextColors[path] = String(hex);
        } else {
            delete nextColors[path];
        }
        return this._applyCustomization({ customColors: nextColors });
    }

    // Remove a per-element color override (restore the theme's value
    // for that slot).  Equivalent to setCustomColor(path, null) but
    // reads clearer at call sites.
    resetCustomColor(path) {
        return this.setCustomColor(path, null);
    }

    // Wipe every per-element color override.  Keeps other tweaks
    // (opacity, RGB, etc.) intact.  Used by the "Reset colors"
    // button in the Customization window.
    clearCustomColors() {
        return this._applyCustomization({ customColors: {} });
    }

    // Return the effective color at `path` after merging the active
    // theme (built-in or user) and any customColors overrides.  Used
    // by the Customize window to paint color swatches with the live
    // value the user sees on the keyboard.
    getResolvedColor(path) {
        const theme = this._lookupThemeOrDefault(this._customization.themeId);
        const merged = _mergeCustomColors(theme, this._customization);
        const parts = path.split('.');
        let v = merged;
        for (const p of parts) v = v && v[p];
        return v || null;
    }

    setRgbMode(mode) {
        const allowed = ['off', 'static', 'gradient', 'breathing',
                         'rainbow', 'cycle', 'wave', 'pulse', 'reactive'];
        if (!allowed.includes(mode)) return this.getCustomization();
        return this._applyCustomization({ rgbMode: mode });
    }

    setRgbColor(color) {
        if (typeof color !== 'string') return this.getCustomization();
        return this._applyCustomization({ rgbColor: color });
    }

    setRgbIntensity(pct) {
        pct = Math.max(0, Math.min(100, pct | 0));
        return this._applyCustomization({ rgbIntensity: pct });
    }

    setRgbCycleLabels(on) {
        return this._applyCustomization({ rgbCycleLabels: !!on });
    }

    _rgbModeSettingValue(key, fallback) {
        const mode = this._rgbMode();
        const all = this._customization && this._customization.rgbModeSettings;
        const modeSettings = all && all[mode];
        if (modeSettings && typeof modeSettings[key] === 'number') {
            return modeSettings[key];
        }
        const legacy = this._customization && this._customization[key];
        return (typeof legacy === 'number') ? legacy : fallback;
    }

    _setRgbModeSetting(key, value) {
        const mode = this._rgbMode();
        const all = Object.assign({},
            (this._customization && this._customization.rgbModeSettings) || {});
        const modeSettings = Object.assign({}, all[mode] || {});
        modeSettings[key] = value;
        all[mode] = modeSettings;
        this._activeRgbModeSettingChangeKey = key;
        try {
            return this._applyCustomization({ rgbModeSettings: all });
        } finally {
            this._activeRgbModeSettingChangeKey = null;
        }
    }

    getRgbBorderSize() {
        const v = this._rgbModeSettingValue('rgbBorderSize',
            DEFAULT_CUSTOMIZATION.rgbBorderSize);
        return (typeof v === 'number') ? Math.max(0.1, v) : 1;
    }

    getRgbGlowSize() {
        return this._rgbModeSettingValue('rgbGlowSize',
            DEFAULT_CUSTOMIZATION.rgbGlowSize);
    }

    getRgbBlurAmount() {
        return this._rgbModeSettingValue('rgbBlurAmount',
            DEFAULT_CUSTOMIZATION.rgbBlurAmount);
    }

    getRgbSpeed() {
        return this._rgbModeSettingValue('rgbSpeed',
            DEFAULT_CUSTOMIZATION.rgbSpeed);
    }

    getRgbHaloSoftness() {
        return this._rgbModeSettingValue('rgbHaloSoftness',
            DEFAULT_CUSTOMIZATION.rgbHaloSoftness);
    }

    getRgbHaloCoverage() {
        return this._rgbModeSettingValue('rgbHaloCoverage',
            DEFAULT_CUSTOMIZATION.rgbHaloCoverage);
    }

    getRgbCornerBlend() {
        return this._rgbModeSettingValue('rgbCornerBlend',
            DEFAULT_CUSTOMIZATION.rgbCornerBlend);
    }

    _rgbModeSupportsSpeed(mode = null) {
        const m = mode || this._rgbMode();
        return ['rainbow', 'cycle', 'wave',
                'breathing', 'pulse', 'reactive'].includes(m);
    }

    _rgbSpeedFactor() {
        if (!this._rgbModeSupportsSpeed()) return 1;
        const v = this.getRgbSpeed();
        return Math.max(0.25, Math.min(3.0,
            (typeof v === 'number' ? v : 100) / 100));
    }

    setRgbBorderSize(px) {
        // Allow fractional px values.  The colorRing actor itself uses
        // a safe integer-sized footprint; sub-pixel values are expressed
        // by opacity scaling so they do not round away or misalign.
        const f = parseFloat(px);
        if (!isFinite(f)) return this.getCustomization();
        // Round to 1 decimal so persisted JSON stays clean.
        const v = Math.max(0.1, Math.min(20,
            Math.round(f * 10) / 10));
        return this._setRgbModeSetting('rgbBorderSize', v);
    }

    setRgbGlowSize(px) {
        // Shape size / reach.  The row-canvas renderer maps this to a
        // bounded texture bleed, so high values look bigger without
        // letting the canvas grow without limit.
        px = Math.max(1, Math.min(RGB_GLOW_SIZE_MAX, px | 0));
        return this._setRgbModeSetting('rgbGlowSize', px);
    }

    setRgbBlurAmount(px) {
        // Legacy field name, UI label is "Glow density".  This controls
        // bloom brightness/saturation, not geometry or animation FPS.
        px = Math.max(0, Math.min(RGB_SPREAD_SIZE_MAX, px | 0));
        return this._setRgbModeSetting('rgbBlurAmount', px);
    }

    setRgbSpeed(percent) {
        // Speed changes animation periods only.  Hue modes still render
        // at RGB_LOW_POWER_FPS, so faster color travel does not increase
        // the number of GPU wakeups.
        percent = Math.max(25, Math.min(300, percent | 0));
        return this._setRgbModeSetting('rgbSpeed', percent);
    }

    setRgbHaloSoftness(percent) {
        percent = Math.max(0, Math.min(100, percent | 0));
        return this._setRgbModeSetting('rgbHaloSoftness', percent);
    }

    setRgbHaloCoverage(percent) {
        percent = Math.max(0, Math.min(100, percent | 0));
        return this._setRgbModeSetting('rgbHaloCoverage', percent);
    }

    setRgbCornerBlend(percent) {
        percent = Math.max(0, Math.min(100, percent | 0));
        return this._setRgbModeSetting('rgbCornerBlend', percent);
    }

    // Reset customization to defaults.  Preserves themeId so users
    // don't lose their theme when they press "Reset tweaks".
    resetCustomization(keepTheme) {
        const next = Object.assign({}, DEFAULT_CUSTOMIZATION);
        if (keepTheme) next.themeId = this._customization.themeId;
        return this._applyCustomization(next);
    }

    // Walk every widget we know about and re-apply its style from the
    // current `_styles` map.  Called after `_styles` is rebuilt (theme
    // or customization change).  Hover state is taken from each
    // widget's live `.hover` so we don't paint a hover variant onto a
    // key the pointer isn't over.
    _applyStyles() {
        if (!this._styles) return;
        // Keyboard background itself (including any custom image).
        this.set_style(this._styles.keyboard);
        try { this.queue_relayout(); } catch (_e) {}
        try { this.queue_redraw(); } catch (_e) {}
        this._syncBackgroundLayer();
        // Title bar sub-tree.
        if (this._titleBar && this._titleBar.applyStyles) {
            this._titleBar.applyStyles();
        }
        // Prediction bar strip + its buttons.
        if (this._predictionBarBg) {
            this._predictionBarBg.set_style(this._styles.predictionBar);
        }
        if (this._predictionBar) {
            this._predictionBar.set_style(this._styles.predictionBarOverlay);
        }
        for (const btn of this._predictionButtons) {
            if (btn && btn._updateStyle) btn._updateStyle();
        }
        // Keys.
        for (const row of this._rowRecords) {
            for (const { btn } of row.keys) {
                if (btn && btn._updateStyle) btn._updateStyle();
            }
        }
        // Resize grip.
        if (this._grip && this._grip.applyStyles) {
            this._grip.applyStyles();
        }
        this._layoutPredictionGlow();
        this._syncPredictionGlowForMode(this._rgbMode());
    }


    // ---- RGB lighting --------------------------------------------
    //
    // Per-cell actor stack (back to front, see _buildRows):
    //   1. rowGlow       (St.DrawingArea per row) -- Cairo soft bloom
    //      for every persistent RGB halo mode.
    //   2. colorRing     (Clutter) -- thin sharp colored band at the
    //      key edge; bg-color animates via Clutter in cycling modes.
    //   3. btn           (OSKKey).
    // Per-cell record shape:
    //   { btn, spec, wrapper, colorRing }
    //
    // CSS box-shadow gives a true Gaussian falloff, but animating or
    // restyling it during RGB effects is too expensive in GNOME Shell.
    // Persistent modes use row-level Cairo radial gradients instead.
    //
    //   off       no halo actors visible.  No transitions.
    //   static    fixed rgbColor row-canvas glow + ring.
    //   gradient  per-key hue baked into row-canvas glow + ring.  Spatial
    //             rainbow, static.  Labels colored to match.
    //   breathing fixed rgbColor row-canvas glow + auto-reverse opacity
    //             (whole cell breathes).
    //   rainbow   row-canvas soft bloom + ring/text
    //             cycle; per-key hue offset.  Labels animate via
    //             matching Clutter transitions.
    //   cycle     same as rainbow but every key shares offset 0.
    //   wave      diagonal column+row bands, faster than rainbow.
    //   pulse     fixed rgbColor row-canvas glow + auto-reverse opacity
    //             only; key body stays.
    //   reactive  each press spawns a temporary overlay in Main.uiGroup
    //             that fades to 0 over RGB_REACTIVE_FADE_MS.

    _rgbMode() {
        return (this._customization && this._customization.rgbMode) || 'off';
    }

    _isHueCyclingRgbMode(mode = null) {
        const m = mode || this._rgbMode();
        return m === 'rainbow' || m === 'cycle' || m === 'wave';
    }

    _isLabelAnimatingRgbMode(mode = null) {
        const m = mode || this._rgbMode();
        return ['static', 'gradient', 'breathing', 'pulse',
                'rainbow', 'cycle', 'wave'].includes(m)
            && !!(this._customization && this._customization.rgbCycleLabels);
    }

    _syncKeyHoverTracking(mode = null) {
        const enabled = true;
        if (this._grip && this._grip.setHoverTrackingEnabled)
            this._grip.setHoverTrackingEnabled(enabled);
        for (const row of this._rowRecords) {
            for (const { btn } of row.keys) {
                if (!btn || !btn.setHoverTrackingEnabled) continue;
                btn.setHoverTrackingEnabled(enabled);
            }
        }
    }

    _beginInteractiveMotion(kind) {
        this._interactiveMotionCount =
            Math.max(0, (this._interactiveMotionCount || 0)) + 1;
        if (kind === 'resize') {
            this._interactiveResize = true;
            this._pauseEffectsForResize();
        }
    }

    _endInteractiveMotion(kind) {
        this._interactiveMotionCount =
            Math.max(0, (this._interactiveMotionCount || 0) - 1);
        if (kind === 'resize') {
            this._interactiveResize = false;
            this._layoutKeys();
            this._resizeAllColorRings();
            this._resizeRgbCanvasGlows();
            this._resumeEffectsAfterResize();
        }
        if (this._interactiveMotionCount === 0
            && this._rgbCycleState
            && this._rgbCycleState.animatesHue) {
            this._runRgbCycleFrame(this._rgbCycleState);
        }
    }

    _isInteractiveMotionPaused() {
        return (this._interactiveMotionCount || 0) > 0;
    }

    _pauseEffectsForResize() {
        if (this._resizeEffectsPaused) return;
        this._resizeEffectsPaused = true;
        this._cancelRgbCycleEngine();
        this._hideRgbCanvasGlow();
        this._hidePredictionGlow();
        for (const row of this._rowRecords) {
            for (const cell of row.keys) {
                if (cell.colorRing) cell.colorRing.opacity = 0;
            }
        }
        for (const btn of this._predictionButtons) {
            if (btn && btn._updateStyle) btn._updateStyle();
        }
    }

    _resumeEffectsAfterResize() {
        if (!this._resizeEffectsPaused) return;
        this._resizeEffectsPaused = false;
        this._syncRgbAnimation();
        this._syncPredictionGlowForMode(this._rgbMode());
        for (const btn of this._predictionButtons) {
            if (btn && btn._updateStyle) btn._updateStyle();
        }
    }

    _onVisibilityChanged() {
        this._syncBackgroundLayer();
        if (this.visible) {
            this._visibleEffectsPaused = false;
            this._queuePostLayoutRefresh();
        } else {
            if (this._visibleEffectsPaused) return;
            this._visibleEffectsPaused = true;
            this._teardownRgbAnimation();
            this._hidePredictionGlow();
        }
    }

    _syncRgbAnimation() {
        const mode = this._customization && this._customization.rgbMode;
        this._syncKeyHoverTracking(mode);
        this._teardownRgbAnimation();
        if (this._authMode) {
            this._hidePredictionGlow();
            return;
        }
        if (!this.visible) {
            this._hidePredictionGlow();
            return;
        }

        switch (mode) {
            case 'static':    this._installStaticHalos(); break;
            case 'gradient':  this._installGradientHalos(); break;
            case 'breathing': this._installBreathingMode(); break;
            case 'rainbow':   this._installColorCycle('perKey'); break;
            case 'cycle':     this._installColorCycle('uniform'); break;
            case 'wave':      this._installColorCycle('wave'); break;
            case 'pulse':     this._installPulseHalos(); break;
            // 'reactive' and 'off' install nothing globally; reactive
            // installs per-press only, off leaves everything cleared.
        }
        this._syncPredictionGlowForMode(mode);
    }

    _cancelRgbCycleEngine() {
        this._rgbCycleGeneration = (this._rgbCycleGeneration || 0) + 1;
        _clearSource(this, '_rgbCycleTimerId');
        this._rgbCycleState = null;
    }

    // Stop every halo / wrapper / label animation and return every
    // actor to a clean baseline before the next mode installs.  All
    // animated properties (bg-color on the ring, opacity on wrappers,
    // color on labels) are Clutter transitions installed on standard
    // properties; cleanup is transition removal plus a baseline reset.
    _teardownRgbAnimation() {
        this._cancelRgbCycleEngine();
        this._hideRgbCanvasGlow();
        this._hidePredictionGlow();
        for (const row of this._rowRecords) {
            for (const cell of row.keys) {
                this._teardownCell(cell);
            }
        }
    }

    // Reset one cell to a clean baseline.  Removes every transition,
    // hides colorRing, and drops the label's explicit color.
    _teardownCell(cell) {
        const { btn, wrapper, colorRing } = cell;
        if (wrapper) {
            for (const name of ['rgb-breathing', 'rgb-opacity']) {
                try { wrapper.remove_transition(name); } catch (_e) {}
            }
            wrapper.opacity = 255;
        }
        if (colorRing) {
            for (const name of ['rgb-color', 'rgb-opacity']) {
                try { colorRing.remove_transition(name); } catch (_e) {}
            }
            colorRing.opacity = 0;
            try { colorRing.set_background_color(_coglColor(0, 0, 0, 0)); }
            catch (_e) {}
        }
        this._clearRgbLabelAnimation(btn, true);
        // Restore the label's static text color from the current
        // theme (since cycling mode bypasses CSS color, we need to
        // explicitly re-set it on teardown so the next mode shows
        // the right color).
        if (btn && btn._applyTextColor) btn._applyTextColor();
    }

    // Walk every key entry, skipping pressed and modifier-state keys
    // whose visual must stay legible.  Returns the full per-cell
    // record shape (see _buildRows) so install paths can reach every
    // animated actor without re-resolving them.
    _eligibleAnimatedKeyEntries() {
        const out = [];
        for (const row of this._rowRecords) {
            for (const entry of row.keys) {
                const btn = entry.btn;
                if (!btn) continue;
                if (btn._pressed) continue;
                if (btn._modState && btn._modState !== 'off') continue;
                out.push(entry);
            }
        }
        return out;
    }

    // The user's chosen accent color, resolved to a Cogl.Color.
    _resolvedRgbColor() {
        return _coglColorFromHex(
            (this._customization && this._customization.rgbColor)
                || '#ff00ff');
    }

    // The intensity slider as a 0..1 multiplier.  Used by the shadow
    // CSS path (which scales alpha but never blur radius / spread, so
    // the soft outer aura just dims uniformly).
    _intensityFraction() {
        const pct = (this._customization
            && this._customization.rgbIntensity !== undefined)
                ? this._customization.rgbIntensity : 70;
        return Math.max(0, Math.min(100, pct)) / 100;
    }

    // Requested border size from the slider.  This may be sub-pixel;
    // colorRing geometry is stabilized separately below.
    _currentBorderSize() {
        const v = this.getRgbBorderSize();
        return (typeof v === 'number' && v > 0) ? Math.max(0.1, v) : 1;
    }

    // colorRing is a rectangular actor behind the key body.  Actor
    // bounds are rounded to whole pixels, so sub-pixel geometry can
    // vanish or shift unevenly.  Give it at least a one-pixel footprint
    // and simulate thinner requested sizes with opacity scaling.
    _currentColorRingGeometryBleed() {
        return Math.max(1, this._currentBorderSize());
    }

    _currentColorRingThicknessScale() {
        return Math.max(0.08, Math.min(1,
            this._currentBorderSize() / this._currentColorRingGeometryBleed()));
    }

    // Soft-glow reach from the current mode's "Glow size" slider.
    // Persistent RGB modes use this to size each row bloom texture and
    // the per-key ellipse.  It deliberately does not change brightness.
    _currentBlur() {
        const v = this.getRgbGlowSize();
        const px = (typeof v === 'number' && v > 0)
            ? Math.round(v) : DEFAULT_CUSTOMIZATION.rgbGlowSize;
        return Math.max(1, Math.min(RGB_GLOW_SIZE_MAX, px));
    }

    // Glow density from the current mode's "Glow density" slider.
    // Legacy method name is kept because older config uses
    // rgbBlurAmount, but this is brightness/saturation now.
    _currentSpread() {
        const v = this.getRgbBlurAmount();
        const px = (typeof v === 'number' && v >= 0)
            ? Math.round(v) : DEFAULT_CUSTOMIZATION.rgbBlurAmount;
        return Math.max(0, Math.min(RGB_SPREAD_SIZE_MAX, px));
    }

    _currentGlowDensityNorm() {
        return Math.max(0, Math.min(1,
            this._currentSpread() / RGB_SPREAD_SIZE_MAX));
    }

    _currentGlowDensityGain() {
        const n = this._currentGlowDensityNorm();
        return 0.22 + Math.pow(n, 0.85) * 2.05;
    }

    _currentGlowColorBoost() {
        const n = this._currentGlowDensityNorm();
        return 0.72 + n * 0.55;
    }

    _currentCanvasGlowBleed() {
        const size = this._currentBlur();
        const norm = Math.max(0, Math.min(1,
            (size - 1) / Math.max(1, RGB_GLOW_SIZE_MAX - 1)));
        const bleed = RGB_CANVAS_MIN_GLOW_BLEED
            + Math.pow(norm, 0.88)
                * (RGB_CANVAS_MAX_GLOW_BLEED - RGB_CANVAS_MIN_GLOW_BLEED)
            + this._currentBorderSize() * 0.35;
        return Math.max(this._currentBorderSize(),
            Math.min(RGB_CANVAS_MAX_GLOW_BLEED,
                Math.round(bleed)));
    }

    _currentHaloSoftness() {
        const v = this.getRgbHaloSoftness();
        return (typeof v === 'number') ? Math.max(0, Math.min(100, v)) : 75;
    }

    _currentHaloCoverage() {
        const v = this.getRgbHaloCoverage();
        return (typeof v === 'number') ? Math.max(0, Math.min(100, v)) : 65;
    }

    _currentCornerBlend() {
        const v = this.getRgbCornerBlend();
        return (typeof v === 'number') ? Math.max(0, Math.min(100, v)) : 65;
    }

    _currentCssGlowBlur() {
        const softness = this._currentHaloSoftness() / 100;
        const base = Math.min(this._currentBlur(), RGB_CSS_MAX_GLOW_SIZE);
        return Math.max(32, Math.round(base * (0.74 + softness * 0.24)));
    }

    _currentCssGlowSpread() {
        const softness = this._currentHaloSoftness() / 100;
        const coverage = this._currentHaloCoverage() / 100;
        const base = Math.min(this._currentBlur(), RGB_CSS_MAX_GLOW_SIZE);
        return Math.max(1, Math.min(RGB_CSS_MAX_SPREAD,
            Math.round(base * (0.035 + coverage * 0.045)
                * (1.0 - softness * 0.38))));
    }

    _currentCssGlowAlpha(baseAlpha) {
        const softness = this._currentHaloSoftness() / 100;
        return baseAlpha
            * this._intensityFraction()
            * this._currentGlowDensityGain()
            * (1.08 - softness * 0.10);
    }

    // colorRing opacity (0-255), scaled by the intensity slider so
    // the colored border dims uniformly with the glow.  Master
    // opacity = RGB_COLOR_RING_OPACITY * intensity_fraction.
    _currentColorRingOpacity() {
        return Math.round(
            RGB_COLOR_RING_OPACITY
            * this._intensityFraction()
            * this._currentColorRingThicknessScale());
    }

    // Resolve a key's underlying Clutter.Text so callers can animate
    // its `color` property directly (set_color overrides the parent
    // St.Button's CSS color, and Clutter.PropertyTransition /
    // Clutter.KeyframeTransition can interpolate Cogl.Color values
    // on it).  Returns null for icon-only or label-less keys.
    _clutterTextFor(btn) {
        if (!btn) return null;
        let labelActor = btn._keyLabel || btn._predictionLabel || null;
        if (!labelActor && btn.get_label_actor) {
            try { labelActor = btn.get_label_actor(); } catch (_e) {}
        }
        if (!labelActor) return null;
        if (labelActor.get_clutter_text) {
            try {
                const text = labelActor.get_clutter_text();
                if (text) return text;
            } catch (_e) {}
        }
        if (labelActor.clutter_text) return labelActor.clutter_text;
        // Some Shell/St versions expose the Clutter.Text directly as
        // the label actor.  Treat any actor with text-color transition
        // methods as the text node so RGB labels are not skipped.
        if (labelActor.set_color && labelActor.add_transition)
            return labelActor;
        return null;
    }

    _labelActorFor(btn) {
        if (!btn) return null;
        if (btn._keyLabel) return btn._keyLabel;
        if (btn._predictionLabel) return btn._predictionLabel;
        if (!btn.get_label_actor) return null;
        try { return btn.get_label_actor(); } catch (_e) { return null; }
    }

    _keyLabelBaseCss() {
        return (this._styles && this._styles.keyLabelBase)
            || 'font-family: "Cantarell", Sans; font-size: 14px; font-weight: bold;';
    }

    _keyLabelFontDescription() {
        const desc = new Pango.FontDescription();
        desc.set_family('Cantarell');
        const size = Math.max(10, Math.min(28,
            (this._customization && this._customization.keyTextSize)
                || DEFAULT_CUSTOMIZATION.keyTextSize));
        desc.set_absolute_size(size * Pango.SCALE);
        desc.set_weight((this._customization
            && this._customization.textBold === false)
            ? Pango.Weight.NORMAL : Pango.Weight.BOLD);
        return desc;
    }

    _rgbLabelCss(color, durationMs = 0) {
        // RGB modes drive color directly on the overlay's Clutter.Text.
        // Do not leave a CSS color here, or Shell's style machinery can
        // pin the text to one color and block animated updates.
        let css = this._keyLabelBaseCss();
        if (durationMs > 0) {
            css += ' transition-property: color;' +
                ` transition-duration: ${durationMs|0}ms;` +
                ' transition-timing-function: linear;';
        }
        return css;
    }

    _setRgbLabelCss(btn, color, durationMs = 0) {
        const labelActor = this._labelActorFor(btn);
        if (!labelActor || !labelActor.set_style) return;
        try { labelActor.set_style(this._rgbLabelCss(color, durationMs)); }
        catch (_e) {}
        if (btn) {
            btn._lastAppliedTextCss = null;
            btn._lastAppliedTextHex = null;
        }
    }

    _clearRgbLabelCss(btn) {
        const labelActor = this._labelActorFor(btn);
        if (!labelActor || !labelActor.set_style) return;
        try { labelActor.set_style(this._keyLabelBaseCss()); } catch (_e) {}
        if (btn) {
            btn._lastAppliedTextCss = null;
            btn._lastAppliedTextHex = null;
        }
    }

    _predictionTextState(btn) {
        if (!btn || btn._isEmpty) return 'empty';
        if (btn._pressed) return 'pressed';
        if (btn._hovering) return 'hover';
        return 'base';
    }

    _applyPredictionTextColor(btn) {
        if (!btn || !this._styles) return;
        const map = this._styles.predictionTextColors
            || this._styles.keyTextColors;
        const hex = (map && (map[this._predictionTextState(btn)] || map.base))
            || '#ffffff';
        const labelActor = this._labelActorFor(btn);
        const css = `${this._keyLabelBaseCss()}color: ${hex} !important;`;
        if (labelActor && labelActor.set_style
            && labelActor._oskPredictionLabelCss !== css) {
            try {
                labelActor.set_style(css);
                labelActor._oskPredictionLabelCss = css;
            } catch (_e) {}
        }
        const text = this._clutterTextFor(btn);
        if (text) {
            try { text.set_color(_coglColorFromHex(hex)); } catch (_e) {}
        }
    }

    _predictionButtonBaseStyle(btn) {
        const s = this._styles || {};
        if (!btn || btn._isEmpty) return s.predictionBtnEmpty || '';
        if (btn._pressed) return s.predictionBtnPressed || '';
        if (btn._hovering) return s.predictionBtnHover || '';
        return s.predictionBtn || '';
    }

    _predictionRgbButtonStyle(btn, color) {
        const base = this._predictionButtonBaseStyle(btn);
        const alpha = (this._styles
            && typeof this._styles.predictionAlpha === 'number')
                ? this._styles.predictionAlpha : 1;
        const rgba = `rgba(${color.red|0},${color.green|0},${color.blue|0},` +
            `${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
        return base + `border: 1px solid ${rgba};`;
    }

    _predictionRgbModeEnabled(mode = null) {
        const m = mode || this._rgbMode();
        return ['static', 'gradient', 'breathing', 'rainbow',
                'cycle', 'wave', 'pulse'].includes(m);
    }

    _predictionHasActiveButtons() {
        for (const btn of this._predictionButtons || []) {
            if (btn && !btn._isEmpty && btn.visible) return true;
        }
        return false;
    }

    _layoutPredictionGlow() {
        if (!this._predictionLayer || !this._predictionBar) return;
        const layer = this._predictionLayer;
        const w = Math.max(0, layer.width > 0 ? layer.width : layer.get_width());
        const h = PREDICTION_BAR_HEIGHT;
        if (w <= 0) return;

        if (this._predictionBarBg) {
            _setActorGeometryIfChanged(this._predictionBarBg, 0, 0, w, h);
        }
        _setActorGeometryIfChanged(this._predictionBar, 0, 0, w, h);

        if (!this._predictionGlow) return;
        const bleed = this._currentCanvasGlowBleed();
        this._predictionGlowBleed = bleed;
        const changed = _setActorGeometryIfChanged(
            this._predictionGlow, -bleed, -bleed,
            w + 2 * bleed, h + 2 * bleed);
        if (changed && this._predictionGlow.visible)
            this._predictionGlow.queue_repaint();
    }

    _clearPredictionGlowTransitions() {
        const glow = this._predictionGlow;
        if (!glow) return;
        try { glow.remove_transition('rgb-prediction-opacity'); }
        catch (_e) {}
    }

    _hidePredictionGlow() {
        const glow = this._predictionGlow;
        if (!glow) return;
        this._clearPredictionGlowTransitions();
        glow.opacity = 0;
        glow.visible = false;
        glow._rgbGlowPhase = 0;
        glow._rgbGlowState = null;
        this._predictionRgbBorderStep = -1;
    }

    _syncPredictionGlowForMode(mode = null) {
        mode = mode || this._rgbMode();
        this._clearPredictionGlowTransitions();
        if (!this._predictionGlow
            || !this._predictionRgbModeEnabled(mode)
            || this._resizeEffectsPaused
            || !this._predictionEnabled
            || !this._predictionBar
            || !this._predictionBar.visible
            || !this._predictionHasActiveButtons()) {
            this._hidePredictionGlow();
            return false;
        }

        // Prediction keeps the RGB look and samples the same phase as
        // the keyboard.  The hot path below only repaints one small
        // canvas and updates Clutter text colors; CSS border restyles
        // are throttled in _setPredictionRgbTextColors().
        this._layoutPredictionGlow();
        const glow = this._predictionGlow;
        glow.visible = true;
        glow.opacity = 255;
        const state = this._rgbCycleState;
        const phase = state && typeof state.phaseDeg === 'number'
            ? state.phaseDeg : 0;
        this._queuePredictionGlowRepaint(
            this._isHueCyclingRgbMode(mode) ? state : null,
            phase);
        for (const btn of this._predictionButtons || []) {
            if (btn && !btn._isEmpty)
                this._applyPredictionButtonTextColor(btn);
        }
        if (mode === 'breathing' || mode === 'pulse') {
            const halfPeriod = Math.round(
                ((mode === 'breathing'
                    ? RGB_BREATH_PERIOD_MS : RGB_PULSE_PERIOD_MS)
                / this._rgbSpeedFactor()) / 2);
            const t = new Clutter.PropertyTransition({
                property_name: 'opacity',
            });
            t.set_from(mode === 'breathing' ? RGB_BREATH_OPACITY_MIN : 80);
            t.set_to(255);
            t.set_duration(halfPeriod);
            t.set_repeat_count(-1);
            t.set_auto_reverse(true);
            t.set_progress_mode(Clutter.AnimationMode.EASE_IN_OUT_SINE);
            glow.add_transition('rgb-prediction-opacity', t);
        }
        return true;
    }

    _queuePredictionGlowRepaint(state = null, phaseDeg = 0) {
        const glow = this._predictionGlow;
        if (!glow || !glow.visible || this._resizeEffectsPaused) return;
        glow._rgbGlowState = state || null;
        glow._rgbGlowPhase = Number.isFinite(phaseDeg) ? phaseDeg : 0;
        glow.queue_repaint();
    }

    _drawPredictionGlow(area) {
        const cr = area.get_context();
        try {
            const [surfaceW, surfaceH] = area.get_surface_size();
            let clearSaved = false;
            try {
                cr.save();
                clearSaved = true;
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
            } catch (_e) {
            } finally {
                if (clearSaved) {
                    try { cr.restore(); } catch (_e) {}
                }
            }

            const mode = this._rgbMode();
            if (!area.visible
                || !this._predictionRgbModeEnabled(mode)
                || !this._predictionHasActiveButtons()) {
                return;
            }

            const state = area._rgbGlowState || this._rgbCycleState;
            const phaseDeg = (typeof area._rgbGlowPhase === 'number')
                ? area._rgbGlowPhase
                : 0;
            const bleed = this._predictionGlowBleed
                || this._currentCanvasGlowBleed();
            const intensity = state && typeof state.intensity === 'number'
                ? state.intensity : this._intensityFraction();

            const buttons = this._predictionButtons || [];
            const boxes = buttons.map(btn => (btn && btn.get_allocation_box)
                ? btn.get_allocation_box() : null);
            const feather = _haloBlendFeather(
                bleed, KEY_SPACING, this._currentCornerBlend());
            for (let i = 0; i < buttons.length; i++) {
                const btn = buttons[i];
                if (!btn || btn._isEmpty || !btn.visible) continue;
                const a = boxes[i];
                if (!a) continue;
                const w = a.x2 - a.x1;
                const h = a.y2 - a.y1;
                if (w <= 0 || h <= 0) continue;

                const prevA = i > 0 ? boxes[i - 1] : null;
                const nextA = i < boxes.length - 1 ? boxes[i + 1] : null;
                const leftMid = prevA ? bleed + ((prevA.x2 + a.x1) / 2) : 0;
                const rightMid = nextA ? bleed + ((a.x2 + nextA.x1) / 2)
                    : surfaceW;
                const clipLeft = prevA
                    ? Math.max(0, leftMid - feather) : 0;
                const clipRight = nextA
                    ? Math.min(surfaceW, rightMid + feather) : surfaceW;
                if (clipRight <= clipLeft) continue;

                const color = this._predictionRgbColorForButton(
                    btn, mode, state, phaseDeg);
                cr.save();
                try {
                    cr.rectangle(clipLeft, 0, clipRight - clipLeft, surfaceH);
                    cr.clip();
                    this._drawCanvasKeyBloom(
                        cr,
                        a.x1 + bleed,
                        a.y1 + bleed,
                        w, h,
                        { r: color.red, g: color.green, b: color.blue },
                        intensity,
                        bleed,
                        surfaceW,
                        surfaceH);
                } finally {
                    try { cr.restore(); } catch (_e) {}
                }
            }
        } finally {
            cr.$dispose();
        }
    }

    _predictionRgbOffset(btn, state) {
        if (!btn) return 0;
        const buttons = this._predictionButtons || [];
        const count = Math.max(1, buttons.length);
        const i = Math.max(0, btn._slotIndex || 0);
        if (state && state.pattern === 'uniform') return 0;
        if (state && state.pattern === 'wave') {
            const colNorm = count > 1 ? i / (count - 1) : 0.5;
            return (colNorm * 1.15 * 360) % 360;
        }

        // Prediction slots sit above the key rows, so sample the
        // nearest top-row key's RGB offset.  That keeps the bar
        // visually phase-locked to the keyboard instead of running a
        // separate mini-rainbow based only on the slot count.
        const topRow = this._rowRecords && this._rowRecords[0];
        const topKeys = topRow && topRow.keys;
        if (topKeys && topKeys.length > 0) {
            const xNorm = count > 1 ? i / (count - 1) : 0.5;
            const keyIdx = _clampNumber(
                Math.round(xNorm * (topKeys.length - 1)),
                0, topKeys.length - 1);
            const entry = topKeys[keyIdx];
            if (entry && typeof entry._rgbCycleOffset === 'number')
                return entry._rgbCycleOffset;
            const totalKeys = this._rowRecords.reduce(
                (sum, row) => sum + row.keys.length, 0);
            if (entry && entry.btn
                && typeof entry.btn._rgbIndex === 'number'
                && totalKeys > 0) {
                return (entry.btn._rgbIndex / totalKeys) * 360;
            }
        }
        return (i / count) * 360;
    }

    _predictionRgbColorForButton(btn, mode, state, phaseDeg) {
        mode = mode || this._rgbMode();
        if (mode === 'gradient') {
            return this._rgbCycleColorForPhase({
                offset: this._predictionRgbOffset(btn, { pattern: 'perKey' }),
            }, 0);
        }
        if (this._isHueCyclingRgbMode(mode)) {
            const fallback = {
                pattern: mode === 'cycle'
                    ? 'uniform' : (mode === 'wave' ? 'wave' : 'perKey'),
            };
            return this._rgbCycleColorForPhase({
                offset: this._predictionRgbOffset(btn, state || fallback),
            }, phaseDeg || 0);
        }
        return this._resolvedRgbColor();
    }

    _applyPredictionRgbButtonColor(btn, color) {
        if (!btn || btn._isEmpty || !color) return;
        // The soft halo lives on the shared prediction DrawingArea.
        // Button CSS only carries the crisp border/text so moving RGB
        // never restyles box-shadows on every frame.
        const btnStyle = this._predictionRgbButtonStyle(btn, color);
        if (btn.set_style && btn._lastAppliedStyle !== btnStyle) {
            try {
                btn.set_style(btnStyle);
                btn._lastAppliedStyle = btnStyle;
            } catch (_e) {}
        }
    }

    _applyPredictionRgbTextColor(btn, color) {
        if (!btn || btn._isEmpty) return;
        const labelActor = this._labelActorFor(btn);
        const css = this._rgbLabelCss(color, 0);
        if (labelActor && labelActor.set_style
            && labelActor._oskPredictionLabelCss !== css) {
            try {
                labelActor.set_style(css);
                labelActor._oskPredictionLabelCss = css;
            } catch (_e) {}
        }
        const text = this._clutterTextFor(btn);
        if (text) {
            try { text.set_color(color); } catch (_e) {}
        }
    }

    _applyPredictionButtonTextColor(btn) {
        if (!btn) return;
        if (btn._isEmpty) {
            this._applyPredictionTextColor(btn);
            return;
        }
        if (this._resizeEffectsPaused) {
            this._applyPredictionTextColor(btn);
            return;
        }

        const mode = this._rgbMode();
        if (!this._predictionRgbModeEnabled(mode)) {
            this._applyPredictionTextColor(btn);
            return;
        }

        const state = this._rgbCycleState;
        const phase = state && typeof state.phaseDeg === 'number'
            ? state.phaseDeg : 0;
        const color = this._predictionRgbColorForButton(
            btn, mode, state, phase);
        this._applyPredictionRgbButtonColor(btn, color);

        if (this._isLabelAnimatingRgbMode(mode)) {
            this._applyPredictionRgbTextColor(btn, color);
            return;
        }
        this._applyPredictionTextColor(btn);
    }

    _setPredictionRgbTextColors(state, phaseDeg) {
        if (!state
            || !this._predictionEnabled
            || !this._predictionBar
            || !this._predictionBar.visible
            || !this._predictionHasActiveButtons()) {
            return;
        }

        // Keep the prediction glow phase-locked with the main keyboard
        // by repainting its single shared canvas from the same RGB
        // cycle frame.  This is cheap compared with per-button CSS
        // shadow updates.
        this._queuePredictionGlowRepaint(state, phaseDeg);

        const borderStep = Math.floor(((phaseDeg % 360) + 360) / 18);
        const refreshBorders = this._predictionRgbBorderStep !== borderStep;
        if (refreshBorders) this._predictionRgbBorderStep = borderStep;

        const buttons = this._predictionButtons || [];
        for (const btn of buttons) {
            if (!btn || btn._isEmpty) continue;
            const color = this._predictionRgbColorForButton(
                btn, this._rgbMode(), state, phaseDeg);
            // CSS border updates are the expensive part; keep them in
            // sync, but at a coarser cadence than the glow/text.
            if (refreshBorders) this._applyPredictionRgbButtonColor(btn, color);
            if (state.cycleLabels)
                this._applyPredictionRgbTextColor(btn, color);
        }
    }

    _paintStaticRgbLabel(btn, color) {
        if (!btn) return;
        btn._rgbLabelAnimationSpec = {
            kind: 'cycle',
            currentTint: color,
        };
        const text = this._clutterTextFor(btn);
        if (text) {
            try { text.remove_transition('rgb-color'); } catch (_e) {}
            try { text.set_color(color); } catch (_e) {}
        }
        this._setRgbLabelCss(btn, color, 0);
    }

    _setRgbPulseLabelSpec(btn, dim, bright, halfPeriod) {
        if (!btn) return;
        btn._rgbLabelAnimationSpec = {
            kind: 'pulse',
            dim,
            bright,
            halfPeriod,
        };
        this._ensureRgbLabelAnimation(btn);
    }

    _clearRgbLabelAnimation(btn, clearSpec) {
        const text = this._clutterTextFor(btn);
        if (text && text.remove_transition) {
            try { text.remove_transition('rgb-color'); } catch (_e) {}
        }
        this._clearRgbLabelCss(btn);
        if (clearSpec && btn) btn._rgbLabelAnimationSpec = null;
    }

    _ensureRgbLabelAnimation(btn) {
        const spec = btn && btn._rgbLabelAnimationSpec;
        if (!spec) return;
        if (spec.kind !== 'cycle') {
            if (btn._pressed) return;
            if (btn._modState && btn._modState !== 'off') return;
        }
        const text = this._clutterTextFor(btn);
        if (!text) return;
        if (text.get_transition) {
            try {
                if (text.get_transition('rgb-color')) return;
            } catch (_e) {}
        }
        try { text.remove_transition('rgb-color'); } catch (_e) {}

        try {
            if (spec.kind === 'cycle') {
                text.set_color(spec.currentTint);
                this._setRgbLabelCss(btn, spec.currentTint, 0);
            } else if (spec.kind === 'pulse') {
                text.set_color(spec.bright);
                this._setRgbLabelCss(btn, spec.bright, 0);
                const t = new Clutter.PropertyTransition({
                    property_name: 'color',
                });
                t.set_from(spec.dim);
                t.set_to(spec.bright);
                t.set_duration(spec.halfPeriod);
                t.set_repeat_count(-1);
                t.set_auto_reverse(true);
                t.set_progress_mode(Clutter.AnimationMode.EASE_IN_OUT_SINE);
                text.add_transition('rgb-color', t);
            }
        } catch (_e) {}
    }

    // Static: same row-canvas halo renderer as rainbow/cycle/wave,
    // but with one fixed rgbColor instead of hue cycling.
    _installStaticHalos() {
        const target = this._resolvedRgbColor();
        const cycleLabels = !!(this._customization
            && this._customization.rgbCycleLabels);
        this._installFixedCanvasHalos('static', target, cycleLabels);
    }

    // Gradient: same row-canvas halo renderer, with per-key hue baked
    // once.  No time animation.
    _installGradientHalos() {
        const cycleLabels = !!(this._customization
            && this._customization.rgbCycleLabels);
        this._installFixedCanvasHalos('gradient', null, cycleLabels);
    }

    // Breathing: fixed-color row-canvas halo plus the existing wrapper
    // opacity breath.  No hue cycling.
    _installBreathingMode() {
        const target = this._resolvedRgbColor();
        const halfPeriod = Math.round(
            (RGB_BREATH_PERIOD_MS / this._rgbSpeedFactor()) / 2);
        const cycleLabels = !!(this._customization
            && this._customization.rgbCycleLabels);
        const state = this._installFixedCanvasHalos(
            'static', target, cycleLabels);
        if (state) {
            for (const rowEntry of state.rowCells) {
                const row = rowEntry.record;
                const glows = row && (row.rowGlows
                    || (row.rowGlow ? [row.rowGlow] : []));
                const glow = glows && glows[0];
                if (!glow) continue;
                const gt = new Clutter.PropertyTransition({
                    property_name: 'opacity',
                });
                gt.set_from(RGB_BREATH_OPACITY_MIN);
                gt.set_to(255);
                gt.set_duration(halfPeriod);
                gt.set_repeat_count(-1);
                gt.set_auto_reverse(true);
                gt.set_progress_mode(Clutter.AnimationMode.EASE_IN_OUT_SINE);
                glow.remove_transition('rgb-canvas-opacity');
                glow.add_transition('rgb-canvas-opacity', gt);
            }
        }
        for (const { wrapper } of this._eligibleAnimatedKeyEntries()) {
            if (!wrapper) continue;
            const t = new Clutter.PropertyTransition({
                property_name: 'opacity',
            });
            t.set_from(RGB_BREATH_OPACITY_MIN);
            t.set_to(RGB_BREATH_OPACITY_MAX);
            t.set_duration(halfPeriod);
            t.set_repeat_count(-1);
            t.set_auto_reverse(true);
            t.set_progress_mode(Clutter.AnimationMode.EASE_IN_OUT_SINE);
            wrapper.remove_transition('rgb-breathing');
            wrapper.add_transition('rgb-breathing', t);
        }
    }

    _rgbCycleColorForPhase(cell, phaseDeg) {
        const offset = (typeof cell.offset === 'number')
            ? cell.offset : ((typeof cell._rgbCycleOffset === 'number')
                ? cell._rgbCycleOffset : 0);
        const hue = (offset + phaseDeg) % 360;
        return _coglColorFromHue(hue);
    }

    _rgbCanvasColorForCell(cell, state, phaseDeg) {
        if (state && state.staticColor)
            return state.staticColor;
        return this._rgbCycleColorForPhase(cell, phaseDeg || 0);
    }

    _hideRgbCanvasGlow() {
        for (const row of this._rowRecords) {
            const glows = row.rowGlows || (row.rowGlow ? [row.rowGlow] : []);
            for (const rowGlow of glows) {
                rowGlow.opacity = 0;
                rowGlow.visible = false;
                rowGlow._rgbGlowStep = -1;
                rowGlow._rgbGlowPhase = 0;
                try { rowGlow.remove_transition('rgb-canvas-opacity'); }
                catch (_e) {}
            }
            if (row.rowText) {
                row.rowText.visible = false;
                row.rowText._rgbTextPhase = 0;
            }
            for (const cell of row.keys) {
                if (cell.btn && cell.btn.setCanvasLabelMode)
                    cell.btn.setCanvasLabelMode(false);
            }
        }
    }

    _setRgbCycleCanvasLabelsVisible(visible) {
        visible = !!visible;
        for (const row of this._rowRecords) {
            if (row.rowText) {
                row.rowText.visible = visible;
                if (visible) row.rowText.queue_repaint();
            }
            for (const cell of row.keys) {
                if (cell.btn && cell.btn.setCanvasLabelMode)
                    cell.btn.setCanvasLabelMode(visible);
            }
        }
    }

    _initRgbCanvasGlow(state) {
        for (const rowEntry of state.rowCells) {
            const row = rowEntry.record;
            if (!row) continue;
            this._layoutRgbRowGlow(row);
            const glows = row.rowGlows || (row.rowGlow ? [row.rowGlow] : []);
            for (let i = 0; i < glows.length; i++) {
                const glow = glows[i];
                try { glow.remove_transition('rgb-canvas-opacity'); }
                catch (_e) {}
                glow.visible = i === 0;
                glow.opacity = i === 0 ? 255 : 0;
                glow._rgbGlowStep = -1;
                glow._rgbGlowPhase = state.phaseDeg || 0;
                if (i === 0) glow.queue_repaint();
            }
        }
    }

    _drawRgbRowGlow(area, row) {
        if (!area || !area.visible || !row || row._destroyed) return;
        const state = this._rgbCycleState;
        if (!state || state.generation !== this._rgbCycleGeneration) return;
        const cr = area.get_context();
        try {
            const [surfaceW, surfaceH] = area.get_surface_size();
            let clearSaved = false;
            try {
                cr.save();
                clearSaved = true;
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
            } catch (_e) {
            } finally {
                if (clearSaved) {
                    try { cr.restore(); } catch (_e) {}
                }
            }

            const bleed = row._rgbGlowBleed || this._currentCanvasGlowBleed();
            const phaseDeg = (typeof area._rgbGlowPhase === 'number')
                ? area._rgbGlowPhase
                : (((state.step || 0) % RGB_SHADOW_CYCLE_STEPS)
                    * (360 / RGB_SHADOW_CYCLE_STEPS));
            const sp = _layoutKeySpacing(this._layoutKey);
            const vPad = Math.min(bleed, Math.max(1, (sp / 2) + 1));
            const feather = _haloBlendFeather(
                bleed, sp, this._currentCornerBlend());
            const rowHeight = Math.max(0, surfaceH - 2 * bleed);
            const topClip = row.rowIndex === 0
                ? 0 : Math.max(0, bleed - vPad - feather);
            const bottomClip = row.rowIndex === row.rowCount - 1
                ? surfaceH : Math.min(surfaceH, bleed + rowHeight + vPad + feather);
            if (bottomClip <= topClip) return;

            const cells = row.keys || [];
            const boxes = cells.map(cell => (
                cell && cell.wrapper && cell.wrapper.get_allocation_box)
                ? cell.wrapper.get_allocation_box() : null);
            for (let i = 0; i < cells.length; i++) {
                const cell = cells[i];
                if (!cell.wrapper) continue;
                const a = boxes[i];
                if (!a) continue;
                const w = a.x2 - a.x1;
                const h = a.y2 - a.y1;
                if (w <= 0 || h <= 0) continue;

                const prevA = i > 0 ? boxes[i - 1] : null;
                const nextA = i < boxes.length - 1 ? boxes[i + 1] : null;
                const leftMid = prevA ? bleed + ((prevA.x2 + a.x1) / 2) : 0;
                const rightMid = nextA ? bleed + ((a.x2 + nextA.x1) / 2)
                    : surfaceW;
                const clipLeft = prevA
                    ? Math.max(0, leftMid - feather) : 0;
                const clipRight = nextA
                    ? Math.min(surfaceW, rightMid + feather) : surfaceW;
                if (clipRight <= clipLeft) continue;

                const color = this._rgbCanvasColorForCell(cell, state, phaseDeg);
                const rgb = { r: color.red, g: color.green, b: color.blue };
                cr.save();
                try {
                    cr.rectangle(
                        clipLeft, topClip,
                        clipRight - clipLeft, bottomClip - topClip);
                    cr.clip();
                    this._drawCanvasKeyBloom(
                        cr,
                        a.x1 + bleed,
                        a.y1 + bleed,
                        w, h,
                        rgb,
                        state.intensity,
                        bleed,
                        surfaceW,
                        surfaceH);
                } finally {
                    try { cr.restore(); } catch (_e) {}
                }
            }
        } finally {
            cr.$dispose();
        }
    }

    _drawCanvasKeyBloom(cr, x, y, w, h, rgb, intensity, bleed, surfaceW, surfaceH) {
        const r = rgb.r / 255;
        const g = rgb.g / 255;
        const b = rgb.b / 255;
        const ix = Math.max(0, Math.min(1, intensity));
        if (ix <= 0 || bleed <= 0 || w <= 0 || h <= 0) return;

        // One edge-weighted elliptical bloom per key.  The alpha rises
        // toward the key edge, then falls away smoothly outside it; that
        // keeps the halo visible without returning to the old squared
        // clipped-corner look.  Still just one gradient per key.
        const softness = this._currentHaloSoftness() / 100;
        const coverage = this._currentHaloCoverage() / 100;
        const cornerBlend = this._currentCornerBlend() / 100;
        const gain = this._currentGlowDensityGain();
        const colorBoost = this._currentGlowColorBoost();
        const crgb = {
            r: Math.min(1, r * colorBoost),
            g: Math.min(1, g * colorBoost),
            b: Math.min(1, b * colorBoost),
        };

        const reach = Math.max(2, bleed * 0.92);
        const edgeAlpha = Math.min(0.620,
            RGB_CANVAS_CORE_ALPHA * gain * (1.04 - softness * 0.08)) * ix;
        const midAlpha = Math.min(0.320,
            RGB_CANVAS_OUTER_ALPHA * gain
                * (0.78 + softness * 0.14 + cornerBlend * 0.18)) * ix;
        const tailAlpha = Math.min(0.150,
            RGB_CANVAS_OUTER_ALPHA * gain
                * (0.12 + softness * 0.16 + cornerBlend * 0.36)) * ix;
        const centerAlpha = edgeAlpha * (0.06 + coverage * 0.62);

        const cx = x + w / 2;
        const cy = y + h / 2;
        const xStretch = 0.92 + coverage * 0.50;
        const yStretch = 0.94 + coverage * 0.20;
        const rx = Math.max(2, (w / 2) * xStretch + reach);
        const ry = Math.max(2, (h / 2) * yStretch + reach * 0.94);
        const edgeStopRaw = ((w / 2) / rx + (h / 2) / ry) / 2;
        const edgeStop = Math.max(0.34, Math.min(0.70, edgeStopRaw));
        const innerStop = Math.max(0.05, edgeStop * (0.12 + coverage * 0.68));
        const midStop = Math.max(edgeStop + 0.07, Math.min(0.90,
            edgeStop + (1 - edgeStop) * (0.18 + softness * 0.42)));
        const tailStop = Math.max(midStop + 0.06, Math.min(0.985,
            edgeStop + (1 - edgeStop)
                * (0.42 + softness * 0.36 + cornerBlend * 0.18)));

        cr.save();
        cr.translate(cx, cy);
        cr.scale(rx, ry);
        const grad = new Cairo.RadialGradient(0, 0, 0, 0, 0, 1);
        grad.addColorStopRGBA(0, crgb.r, crgb.g, crgb.b, centerAlpha);
        grad.addColorStopRGBA(innerStop, crgb.r, crgb.g, crgb.b,
            centerAlpha + (edgeAlpha - centerAlpha) * 0.45);
        grad.addColorStopRGBA(edgeStop, crgb.r, crgb.g, crgb.b, edgeAlpha);
        grad.addColorStopRGBA(midStop, crgb.r, crgb.g, crgb.b, midAlpha);
        grad.addColorStopRGBA(tailStop, crgb.r, crgb.g, crgb.b, tailAlpha);
        grad.addColorStopRGBA(1, crgb.r, crgb.g, crgb.b, 0);
        cr.setSource(grad);
        cr.arc(0, 0, 1, 0, Math.PI * 2);
        cr.fill();
        cr.restore();
    }

    _drawRgbRowText(area, row) {
        if (!area || !area.visible || !row || row._destroyed) return;
        const state = this._rgbCycleState;
        if (!state || !state.cycleLabels
            || state.generation !== this._rgbCycleGeneration) {
            return;
        }
        const cr = area.get_context();
        try {
            let clearSaved = false;
            try {
                cr.save();
                clearSaved = true;
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
            } catch (_e) {
            } finally {
                if (clearSaved) {
                    try { cr.restore(); } catch (_e) {}
                }
            }
            const phaseDeg = (typeof area._rgbTextPhase === 'number')
                ? area._rgbTextPhase
                : (state.phaseDeg || 0);
            const desc = this._keyLabelFontDescription();
            const textAlpha = Math.max(0, Math.min(100,
                (this._customization && this._customization.textOpacity) || 100)) / 100;

            for (const cell of row.keys) {
                if (!cell.wrapper || !cell.btn) continue;
                const label = cell.btn._getDisplayLabel
                    ? cell.btn._getDisplayLabel() : '';
                if (!label) continue;
                const a = cell.wrapper.get_allocation_box
                    && cell.wrapper.get_allocation_box();
                if (!a) continue;
                const w = a.x2 - a.x1;
                const h = a.y2 - a.y1;
                if (w <= 0 || h <= 0) continue;

                const color = this._rgbCanvasColorForCell(cell, state, phaseDeg);
                cr.setSourceRGBA(
                    color.red / 255,
                    color.green / 255,
                    color.blue / 255,
                    textAlpha);
                const layout = PangoCairo.create_layout(cr);
                layout.set_font_description(desc);
                layout.set_alignment(Pango.Alignment.CENTER);
                layout.set_text(label, -1);
                let x;
                let y;
                try {
                    const [, logical] = layout.get_pixel_extents();
                    x = a.x1 + (w - logical.width) / 2 - logical.x;
                    y = a.y1 + (h - logical.height) / 2 - logical.y;
                } catch (_e) {
                    const [tw, th] = layout.get_pixel_size();
                    x = a.x1 + Math.max(0, (w - tw) / 2);
                    y = a.y1 + Math.max(0, (h - th) / 2);
                }
                cr.moveTo(Math.round(x), Math.round(y));
                PangoCairo.show_layout(cr, layout);
            }
        } finally {
            cr.$dispose();
        }
    }

    _initRgbCycleEngine(state) {
        if (!state || state.generation !== this._rgbCycleGeneration) return;
        const step = ((state.step % RGB_SHADOW_CYCLE_STEPS)
            + RGB_SHADOW_CYCLE_STEPS) % RGB_SHADOW_CYCLE_STEPS;
        for (const rowEntry of state.rowCells) {
            this._initRgbCycleRow(
                state, rowEntry.cells || rowEntry, step);
        }
    }

    _initRgbCycleRow(state, row, step) {
        for (const cell of row) {
            const color = this._rgbCanvasColorForCell(
                cell, state, step * (360 / RGB_SHADOW_CYCLE_STEPS));
            if (cell.colorRing) {
                try { cell.colorRing.remove_transition('rgb-color'); } catch (_e) {}
                try { cell.colorRing.set_background_color(color); } catch (_e) {}
                cell.colorRing.opacity = state.ringOpacity;
            }

            if (state.cycleLabels) {
                if (cell.btn) {
                    cell.btn._rgbLabelAnimationSpec = {
                        kind: 'cycle',
                        currentTint: color,
                    };
                }
            } else if (cell.btn && cell.btn._applyTextColor) {
                cell.btn._rgbLabelAnimationSpec = null;
                cell.btn._applyTextColor();
            }
        }
    }

    _startRgbCycleEngine(state) {
        state.step = ((state.step % RGB_SHADOW_CYCLE_STEPS)
            + RGB_SHADOW_CYCLE_STEPS) % RGB_SHADOW_CYCLE_STEPS;
        state.animatesHue = true;
        state.startUs = GLib.get_monotonic_time();
        state.phaseDeg = 0;
        state.frameIntervalMs = this._rgbCycleFrameInterval(state.pattern);
        state.lastFrameBucket = -1;
        this._rgbCycleState = state;
        this._setRgbCycleCanvasLabelsVisible(state.cycleLabels);
        this._initRgbCanvasGlow(state);
        this._initRgbCycleEngine(state);
        this._runRgbCycleFrame(state);
        this._scheduleNextRgbCycleFrame(state);
    }

    _rgbCycleFrameInterval(pattern) {
        // Keep all hue modes capped to the same low-power frame budget.
        // The pattern argument stays here so mode-specific budgets can be
        // tuned without touching the scheduler again.
        switch (pattern) {
            case 'wave':
            case 'perKey':
            case 'uniform':
            default:
                return RGB_LOW_POWER_INTERVAL_MS;
        }
    }

    _rgbCycleCanRun(state) {
        return !!state
            && state.generation === this._rgbCycleGeneration
            && this._rgbCycleState === state
            && !!this.visible
            && !this._authMode
            && !this._visibleEffectsPaused
            && !this._resizeEffectsPaused
            && !this._isInteractiveMotionPaused();
    }

    _scheduleNextRgbCycleFrame(state) {
        if (!state || state.generation !== this._rgbCycleGeneration) return;
        _clearSource(this, '_rgbCycleTimerId');
        this._rgbCycleTimerId = GLib.timeout_add(
            GLib.PRIORITY_LOW,
            Math.max(RGB_MIN_FRAME_INTERVAL_MS,
                state.frameIntervalMs || RGB_LOW_POWER_INTERVAL_MS),
            () => {
                if (!this._rgbCycleState
                    || state.generation !== this._rgbCycleGeneration) {
                    this._rgbCycleTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                if (this._rgbCycleCanRun(state))
                    this._runRgbCycleFrame(state);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _runRgbCycleFrame(state) {
        if (!this._rgbCycleCanRun(state)) return;
        const nowUs = GLib.get_monotonic_time();
        const elapsedMs = Math.max(0, (nowUs - (state.startUs || nowUs)) / 1000);
        const frameInterval = Math.max(
            RGB_MIN_FRAME_INTERVAL_MS,
            state.frameIntervalMs || RGB_LOW_POWER_INTERVAL_MS);
        const frameBucket = Math.floor(elapsedMs / frameInterval);
        if (state.lastFrameBucket === frameBucket) return;
        state.lastFrameBucket = frameBucket;
        const period = Math.max(1, state.periodMs || RGB_RAINBOW_PERIOD_MS);
        const phaseDeg = ((elapsedMs % period) / period) * 360;
        state.phaseDeg = phaseDeg;

        for (const rowEntry of state.rowCells) {
            const rowRecord = rowEntry.record;
            if (rowRecord) {
                const glows = rowRecord.rowGlows
                    || (rowRecord.rowGlow ? [rowRecord.rowGlow] : []);
                const glow = glows[0];
                if (glow) {
                    glow.visible = true;
                    glow.opacity = 255;
                    glow._rgbGlowPhase = phaseDeg;
                    glow.queue_repaint();
                }
                if (state.cycleLabels && rowRecord.rowText) {
                    rowRecord.rowText.visible = true;
                    rowRecord.rowText._rgbTextPhase = phaseDeg;
                    rowRecord.rowText.queue_repaint();
                }
            }

            const row = rowEntry.cells || rowEntry;
            for (const cell of row) {
                const color = this._rgbCanvasColorForCell(cell, state, phaseDeg);
                if (cell.colorRing) {
                    try { cell.colorRing.set_background_color(color); }
                    catch (_e) {}
                    cell.colorRing.opacity = state.ringOpacity;
                }
            }
        }
        this._setPredictionRgbTextColors(state, phaseDeg);
    }

    _buildRgbCanvasRowCells(pattern) {
        const totalKeys = this._rowRecords.reduce(
            (sum, row) => sum + row.keys.length, 0);
        if (totalKeys <= 0) return [];
        const numRows = this._rowRecords.length || 1;
        const rowCells = [];
        for (const row of this._rowRecords) {
            const out = [];
            for (const entry of row.keys) {
                let offsetDeg = 0;
                if (pattern === 'perKey' || pattern === 'gradient') {
                    const idx = (typeof entry.btn._rgbIndex === 'number')
                        ? entry.btn._rgbIndex : 0;
                    offsetDeg = (idx / totalKeys) * 360;
                } else if (pattern === 'wave') {
                    const rowIdx = (typeof entry.btn._rgbRowIndex === 'number')
                        ? entry.btn._rgbRowIndex : 0;
                    const colIdx = (typeof entry.btn._rgbColumnIndex === 'number')
                        ? entry.btn._rgbColumnIndex : 0;
                    const rowCount = Math.max(1,
                        (entry.btn._rgbRowKeyCount || 1) - 1);
                    const rowNorm = rowIdx / Math.max(1, numRows - 1);
                    const colNorm = colIdx / rowCount;
                    offsetDeg = ((colNorm * 1.15 + rowNorm * 0.42) * 360) % 360;
                }
                const normalizedOffset = ((offsetDeg % 360) + 360) % 360;
                entry._rgbCycleOffset = normalizedOffset;
                out.push(Object.assign({}, entry, {
                    offset: normalizedOffset,
                }));
            }
            if (out.length > 0)
                rowCells.push({ record: row, cells: out });
        }
        return rowCells;
    }

    _installFixedCanvasHalos(pattern, staticColor, cycleLabels) {
        const rowCells = this._buildRgbCanvasRowCells(pattern);
        if (rowCells.length === 0) return null;
        const state = {
            rowCells,
            intensity: this._intensityFraction(),
            ringOpacity: this._currentColorRingOpacity(),
            cycleLabels: false,
            pattern,
            staticColor: staticColor || null,
            animatesHue: false,
            phaseDeg: 0,
            step: 0,
            generation: this._rgbCycleGeneration,
        };
        this._rgbCycleState = state;
        this._setRgbCycleCanvasLabelsVisible(false);
        this._initRgbCanvasGlow(state);
        for (const rowEntry of rowCells) {
            const row = rowEntry.cells || rowEntry;
            for (const cell of row) {
                const color = this._rgbCanvasColorForCell(cell, state, 0);
                if (cell.colorRing) {
                    try { cell.colorRing.set_background_color(color); }
                    catch (_e) {}
                    cell.colorRing.opacity = state.ringOpacity;
                }
                if (cycleLabels && cell.btn)
                    this._paintStaticRgbLabel(cell.btn, color);
            }
        }
        return state;
    }

    // Rainbow / cycle / wave.  Low-power color cycling with one Cairo
    // bloom canvas per row.  No animated/re-styled CSS box-shadow and
    // no continuous Clutter opacity/color transitions.
    //
    // A single timer samples exact time-based hues at
    // RGB_LOW_POWER_FPS.  That trades ultra-high-refresh animation for
    // much lower GPU wakeups, which matters on weaker hardware.
    //
    // colorRing and labels transition through the same segment colors
    // so the border/text stay phase-locked with the shadow glow.
    //
    // Labels are explicit St.Label children owned by OSKKey, so their
    // internal Clutter.Text color can be updated directly without
    // fighting St.Button's built-in label/theme color path.
    //
    // Per pattern, the per-cell hue offset is:
    //   'perKey'  -- (rgbIndex / cells) * 360.   Spatial rainbow.
    //   'uniform' -- 0 for every cell.           Whole-keyboard sync.
    //   'wave'    -- diagonal column+row phase. Broad moving bands.
    _installColorCycle(pattern) {
        const basePeriodMs = (pattern === 'wave')
            ? RGB_WAVE_PERIOD_MS : RGB_RAINBOW_PERIOD_MS;
        const periodMs = Math.round(basePeriodMs / this._rgbSpeedFactor());
        const ringOpacity = this._currentColorRingOpacity();
        const intensity = this._intensityFraction();
        const cycleLabels = !!(this._customization
            && this._customization.rgbCycleLabels);
        const rowCells = this._buildRgbCanvasRowCells(pattern);
        if (rowCells.length === 0) return;

        this._startRgbCycleEngine({
            rowCells,
            periodMs,
            intensity,
            ringOpacity,
            cycleLabels,
            pattern,
            step: 0,
            generation: this._rgbCycleGeneration,
        });
    }

    // Pulse: fixed-color row-canvas halo with auto-reversing opacity,
    // plus pulsing ring/label color.  No hue cycling.
    _installPulseHalos() {
        const bright = this._resolvedRgbColor();
        const dim = _coglColor(
            Math.round(bright.red   * 0.4),
            Math.round(bright.green * 0.4),
            Math.round(bright.blue  * 0.4),
            255);
        const halfPeriod = Math.round(
            (RGB_PULSE_PERIOD_MS / this._rgbSpeedFactor()) / 2);
        const cycleLabels = !!(this._customization
            && this._customization.rgbCycleLabels);
        const state = this._installFixedCanvasHalos(
            'static', bright, cycleLabels);
        if (state) {
            for (const rowEntry of state.rowCells) {
                const row = rowEntry.record;
                const glows = row && (row.rowGlows
                    || (row.rowGlow ? [row.rowGlow] : []));
                const glow = glows && glows[0];
                if (!glow) continue;
                const gt = new Clutter.PropertyTransition({
                    property_name: 'opacity',
                });
                gt.set_from(80);
                gt.set_to(255);
                gt.set_duration(halfPeriod);
                gt.set_repeat_count(-1);
                gt.set_auto_reverse(true);
                gt.set_progress_mode(Clutter.AnimationMode.EASE_IN_OUT_SINE);
                glow.remove_transition('rgb-canvas-opacity');
                glow.add_transition('rgb-canvas-opacity', gt);
            }
        }

        for (const { btn, colorRing } of this._eligibleAnimatedKeyEntries()) {
            // colorRing pulses bg color between dim and bright via
            // smooth Clutter color interpolation.
            if (colorRing) {
                try { colorRing.set_background_color(bright); } catch (_e) {}
                colorRing.opacity = this._currentColorRingOpacity();
                const rt = new Clutter.PropertyTransition({
                    property_name: 'background-color',
                });
                rt.set_from(dim);
                rt.set_to(bright);
                rt.set_duration(halfPeriod);
                rt.set_repeat_count(-1);
                rt.set_auto_reverse(true);
                rt.set_progress_mode(Clutter.AnimationMode.EASE_IN_OUT_SINE);
                colorRing.remove_transition('rgb-color');
                colorRing.add_transition('rgb-color', rt);
            }
            if (!cycleLabels) continue;
            this._setRgbPulseLabelSpec(btn, dim, bright, halfPeriod);
        }
    }

    // Reactive: on press of ONE key, spawn a TEMPORARY St.Widget
    // overlay in Main.uiGroup at the pressed key's GLOBAL screen
    // coordinates with a capped reactive box-shadow recipe.
    //
    // Why Main.uiGroup: per-key shadows inside the row stack get
    // clipped visually by adjacent key bodies that paint after them.
    // Spawning the overlay in Main.uiGroup lets the shadow paint above
    // the keyboard chrome, so the flash is visible around the pressed
    // key without growing unbounded when halo sliders are set high.
    //
    // The overlay's box matches the pressed key's bounds (no inset).
    // CSS box-shadow renders OUTSIDE the box, so the bright shadow
    // pixels start AT the key edge and fade outward -- the pressed
    // key body itself is INSIDE the box and not covered by shadow
    // (overlay is transparent body).  Adjacent keys' bodies sit
    // BELOW the overlay in z-order, so they are tinted by the
    // shadow's outer fade, but the brightest pixels are around
    // the pressed key.
    //
    // The overlay's opacity fades 255 -> 0 over RGB_REACTIVE_FADE_MS
    // and self-destroys on completion, so each press creates exactly
    // one short-lived actor.
    _onKeyPressedForRgb(btn) {
        if (this._authMode) return;
        if (!this._customization || this._customization.rgbMode !== 'reactive') return;
        if (!btn) return;
        const intensity = this._intensityFraction();
        if (intensity <= 0) return;  // slider at 0 -- nothing to flash

        // Resolve the key's global screen position + size.
        let gx = 0, gy = 0;
        try {
            const tp = btn.get_transformed_position();
            gx = tp[0] | 0;
            gy = tp[1] | 0;
        } catch (_e) { return; }
        const w = btn.get_width();
        const h = btn.get_height();
        if (w <= 0 || h <= 0) return;

        const hex = (this._customization.rgbColor) || '#ff00ff';
        const { r, g, b } = _rgbChannelsFromHex(hex);
        // Use a slightly larger, already-capped shadow recipe for the
        // press flash so reactive mode reads clearly without huge
        // compositor-costly shadows.
        const css = _reactiveShadowStyle(
            r, g, b, this._currentCssGlowAlpha(RGB_SHADOW_ALPHA_COLOR),
            this._currentCssGlowBlur(), this._currentCssGlowSpread());
        if (!css) return;

        const overlay = new St.Widget({ reactive: false });
        overlay.set_position(gx, gy);
        overlay.set_size(w, h);
        try { overlay.set_style(css); } catch (_e) {}
        overlay.opacity = 255;
        try { Main.uiGroup.add_child(overlay); }
        catch (_e) { overlay.destroy(); return; }

        const t = new Clutter.PropertyTransition({
            property_name: 'opacity',
        });
        t.set_from(255);
        t.set_to(0);
        t.set_duration(Math.round(
            RGB_REACTIVE_FADE_MS / this._rgbSpeedFactor()));
        t.set_progress_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
        // Self-destruct on fade completion so we never leak overlays.
        t.connect('completed', () => {
            try { overlay.destroy(); } catch (_e) {}
        });
        overlay.add_transition('rgb-opacity', t);
    }


    // Map keyboard width -> desired number of prediction slots.
    // Slot count grows linearly with width between the MIN and MAX
    // caps, using PREDICTION_SLOT_TARGET_PX as the budget per slot.
    // Deliberately independent of whether prediction is currently
    // enabled -- the bar's button count is decided before we know
    // if we're going to show it.
    _computePredictionSlots() {
        const w = this._desiredWidth > 0 ? this._desiredWidth : this.width;
        if (w <= 0) return PREDICTION_SLOT_MIN;
        // Subtract the keyboard's horizontal chrome so we're dividing
        // the actual usable width.  Same KEYBOARD_INSET value
        // _layoutKeys uses for the key rows.
        const KEYBOARD_INSET = 8 * 2 + 2 * 2 + 2;
        const usable = Math.max(0, w - KEYBOARD_INSET);
        const n = Math.floor(usable / PREDICTION_SLOT_TARGET_PX);
        return Math.max(PREDICTION_SLOT_MIN,
                        Math.min(PREDICTION_SLOT_MAX, n));
    }

    // Grow / shrink the prediction bar to hold exactly `n` buttons,
    // preserving the existing ones where possible so we don't lose
    // their current label / hover state on minor resizes.  Called
    // from _layoutKeys on every keyboard-size change.
    _ensurePredictionSlotCount(n) {
        if (!this._predictionBar) return;
        while (this._predictionButtons.length < n) {
            const idx = this._predictionButtons.length;
            const btn = new OSKPredictionButton(this, idx);
            this._predictionBar.add_child(btn);
            this._predictionButtons.push(btn);
        }
        while (this._predictionButtons.length > n) {
            const btn = this._predictionButtons.pop();
            // destroy() detaches from the parent BoxLayout too.
            btn.destroy();
        }
        this._syncPredictionGlowForMode(this._rgbMode());
    }

    // Total vertical chrome used by things that aren't key rows.
    // Adds the prediction bar's height (plus the BoxLayout gap that
    // sits above it) only when the bar is actually visible, so
    // toggling prediction on/off re-shrinks / re-grows the keys
    // instead of leaving a gap.
    _verticalChrome() {
        const sp = _layoutKeySpacing(this._layoutKey);
        let extra = 0;
        if (this._predictionUiVisible() && this._predictionBar
            && this._predictionBar.visible) {
            // Bar height + one extra row gap for the BoxLayout
            // separator between the bar and the first key row.
            extra += PREDICTION_BAR_HEIGHT + sp;
        }
        return KEYBOARD_V_CHROME_BASE + extra;
    }

    _cancelQueuedLayoutWork() {
        for (const prop of ['_layoutKeysQueued', '_postLayoutRefreshId',
                            '_layoutSettleRefreshId', '_sizeRelayoutId',
                            '_keyRevealId']) {
            _clearSource(this, prop);
        }
    }

    _queueLayoutKeys() {
        if (this._layoutKeysQueued) return;
        this._layoutKeysQueued = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE, 16,
            () => {
                this._layoutKeysQueued = 0;
                this._layoutKeys();
                return GLib.SOURCE_REMOVE;
            });
    }

    _runPostLayoutRefreshPass() {
        try { this.queue_relayout(); } catch (_e) {}
        try { this.queue_redraw(); } catch (_e) {}
        this._layoutKeys();
        this._resizeAllColorRings();
        this._resizeRgbCanvasGlows();
        this._syncPredictionGlowForMode(this._rgbMode());
        if (this.visible && !this._visibleEffectsPaused && !this._rgbCycleState)
            this._syncRgbAnimation();
        this._syncBackgroundLayer();
    }

    _queuePostLayoutRefresh() {
        if (this._postLayoutRefreshId) return;
        this._postLayoutRefreshId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE, 32,
            () => {
                this._postLayoutRefreshId = 0;
                this._runPostLayoutRefreshPass();
                if (!this._layoutSettleRefreshId) {
                    this._layoutSettleRefreshId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT_IDLE, 120,
                        () => {
                            this._layoutSettleRefreshId = 0;
                            this._runPostLayoutRefreshPass();
                            return GLib.SOURCE_REMOVE;
                        });
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    _layoutKeys() {
        // Divide our current size proportionally among keys in each
        // row, so resizing the keyboard resizes the keys with it.
        // Called on every `notify::width` / `notify::height` -- including
        // the first allocation, so keys get a sensible size from the
        // start.  Scaling the height too means the background always
        // hugs the keys (no empty band below the last row).
        const keyboardWidth = this._desiredWidth > 0
            ? this._desiredWidth : this.width;
        const keyboardHeight = this._desiredHeight > 0
            ? this._desiredHeight : this.height;
        if (keyboardWidth <= 0 || keyboardHeight <= 0) return;

        // Match the inline style: 8px horizontal padding each side,
        // 2px border each side, plus a tiny safety margin so rounding
        // never overflows.
        const KEYBOARD_INSET = 8 * 2 + 2 * 2 + 2;
        const rowWidth = keyboardWidth - KEYBOARD_INSET;
        if (rowWidth <= 0) return;

        // Explicit height on the prediction bar.  BoxLayout will give
        // it its natural height otherwise, which varies with font
        // metrics; pinning it here keeps the key-row budget
        // predictable and matches the PREDICTION_BAR_HEIGHT that
        // _verticalChrome() subtracts.
        if (this._predictionBar && this._predictionBar.visible) {
            if (this._predictionLayer) {
                _setActorSizeIfChanged(
                    this._predictionLayer, rowWidth, PREDICTION_BAR_HEIGHT);
            }
            _setActorSizeIfChanged(
                this._predictionBar, rowWidth, PREDICTION_BAR_HEIGHT);
            this._layoutPredictionGlow();
        }

        // Re-fit the prediction-bar slot count to the current width.
        // We do this on every _layoutKeys call so the button count
        // tracks user-initiated resizes.  If the count changed we
        // also refresh predictions so newly-added slots get content
        // (rather than sitting empty until the user types again).
        const desiredSlots = this._computePredictionSlots();
        if (!this._interactiveResize
            && desiredSlots !== this._predictionButtons.length) {
            this._ensurePredictionSlotCount(desiredSlots);
            if (this._predictionEnabled) this._refreshPredictions();
        }

        // One shared key height across all rows, computed so that
        // title bar + optional prediction bar + N rows + bottom grip
        // row + spacings + padding exactly fill the keyboard.  The
        // clamp to 20 keeps keys visible even if the user somehow
        // bypasses the MIN_KEYBOARD_HEIGHT resize limit.  N varies by
        // layout (5 for Mobile/Compact, 6 for Full/Laptop), so we
        // read it off _rowRecords instead of hard-coding.
        const nRows = Math.max(1, this._rowRecords.length);
        const availableV = keyboardHeight - this._verticalChrome();
        const keyHeight = Math.max(
            20, Math.floor(availableV / nRows));

        const sp = _layoutKeySpacing(this._layoutKey);
        for (const row of this._rowRecords) {
            const keys = row.keys;
            if (keys.length === 0) continue;
            const spacingTotal = row.spacingTotal !== undefined
                ? row.spacingTotal : sp * (keys.length - 1);
            const totalUnits = row.totalUnits || keys.reduce(
                (s, k) => s + k.spec.width, 0);
            const minAvailable = row.minAvailable || keys.length * 16;
            const available = Math.max(minAvailable, rowWidth - spacingTotal);
            const unitPx = available / totalUnits;
            if (row.box)
                _setActorSizeIfChanged(row.box, rowWidth, keyHeight);
            if (row.rowBox)
                _setActorSizeIfChanged(row.rowBox, rowWidth, keyHeight);
            for (const { spec, wrapper } of keys) {
                const w = Math.max(16, Math.floor(unitPx * spec.width));
                // Size the wrapper -- the wrapper's notify::allocation
                // handler installed in _buildRows propagates this to
                // the inner key and RGB ring.
                _setActorSizeIfChanged(wrapper, w, keyHeight);
            }
            this._layoutRgbRowGlow(row);
        }
    }


    // ---- public settings (driven by the indicator menu) ----

    _applyKeyboardSize(w, h) {
        const width = Math.max(1, Math.round(w));
        const height = Math.max(1, Math.round(h));
        this._desiredWidth = width;
        this._desiredHeight = height;
        this._suppressSizeNotifyLayout = true;
        try {
            this.set_width(width);
            this.set_height(height);
            this.set_size(width, height);
        } finally {
            this._suppressSizeNotifyLayout = false;
        }
        const parent = this.get_parent && this.get_parent();
        if (parent && parent.queue_relayout) {
            try { parent.queue_relayout(); } catch (_e) {}
        }
        try { this.queue_relayout(); } catch (_e) {}
        try { this.queue_redraw(); } catch (_e) {}
        this._layoutKeys();
        this._syncBackgroundLayer();
        if (!this._interactiveResize)
            this._queueSizeRelayout();
    }

    refreshLayoutGeometry() {
        const cur = this._currentGeometry();
        this._applyKeyboardSize(cur.w, cur.h);
        this._queuePostLayoutRefresh();
    }

    _queueSizeRelayout() {
        if (this._sizeRelayoutId) return;
        this._sizeRelayoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 16,
            () => {
                this._sizeRelayoutId = 0;
                if (this._desiredWidth <= 0 || this._desiredHeight <= 0)
                    return GLib.SOURCE_REMOVE;
                this._suppressSizeNotifyLayout = true;
                try {
                    this.set_width(this._desiredWidth);
                    this.set_height(this._desiredHeight);
                    this.set_size(this._desiredWidth, this._desiredHeight);
                } finally {
                    this._suppressSizeNotifyLayout = false;
                }
                const parent = this.get_parent && this.get_parent();
                if (parent && parent.queue_relayout) {
                    try { parent.queue_relayout(); } catch (_e) {}
                }
                try { this.queue_relayout(); } catch (_e) {}
                try { this.queue_redraw(); } catch (_e) {}
                return GLib.SOURCE_REMOVE;
            });
    }

    _currentGeometry() {
        const w = this._desiredWidth > 0
            ? this._desiredWidth
            : (this.width > 0 ? this.width : this.get_width());
        const h = this._desiredHeight > 0
            ? this._desiredHeight
            : (this.height > 0 ? this.height : this.get_height());
        return {
            x: this.get_x(),
            y: this.get_y(),
            w: w > 0 ? w : MIN_KEYBOARD_WIDTH,
            h: h > 0 ? h : MIN_KEYBOARD_HEIGHT,
        };
    }

    ensureOnScreen() {
        const cur = this._currentGeometry();
        const next = _fitKeyboardRectToWorkArea(
            cur.x, cur.y, cur.w, cur.h);
        if (next.x !== cur.x || next.y !== cur.y)
            this.set_position(next.x, next.y);
        if (next.w !== cur.w || next.h !== cur.h)
            this._applyKeyboardSize(next.w, next.h);
        return next;
    }

    setConstrainedSize(w, h) {
        const cur = this._currentGeometry();
        const next = _fitKeyboardRectToWorkArea(cur.x, cur.y, w, h);
        if (next.x !== cur.x || next.y !== cur.y)
            this.set_position(next.x, next.y);
        if (next.w !== cur.w || next.h !== cur.h)
            this._applyKeyboardSize(next.w, next.h);
        return next;
    }

    setDragLocked(locked) {
        this._dragLockedSetting = !!locked;
        if (this._titleBar) this._titleBar.setDragLocked(locked);
    }

    setAuthMode(enabled) {
        const wasAuthMode = !!this._authMode;
        this._authMode = !!enabled;
        if (this._titleBar && this._titleBar.setAuthMode)
            this._titleBar.setAuthMode(this._authMode);
        this._syncKeyHoverTracking(this._rgbMode());
        if (this._authMode) {
            this._teardownRgbAnimation();
            this._hidePredictionGlow();
        } else if (wasAuthMode && this.visible) {
            this._syncRgbAnimation();
        }
    }

    setRepeatSpeed(delay, interval) {
        // Clamp both to >= 0; 0 means "don't schedule at all" (Off).
        this._repeatDelay = Math.max(0, delay | 0);
        this._repeatInterval = Math.max(0, interval | 0);
    }

    setPredictor(predictor) {
        this._predictor = predictor;
        if (this._predictionEnabled) this._refreshPredictions();
    }

    _predictionUiVisible() {
        return !!this._predictionEnabled;
    }

    _updatePredictionVisibility() {
        const visible = this._predictionUiVisible();
        if (this._predictionLayer) this._predictionLayer.visible = visible;
        if (this._predictionBar) this._predictionBar.visible = visible;
        if (!visible) {
            this._hidePredictionGlow();
        } else {
            this._layoutPredictionGlow();
        }
        this._syncPredictionGlowForMode(this._rgbMode());
    }

    setPredictionEnabled(on) {
        on = !!on;
        if (on === this._predictionEnabled) return;
        this._predictionEnabled = on;
        this._updatePredictionVisibility();
        if (!on) {
            // Clear tracking state when turning off so that re-enabling
            // starts fresh rather than resuming mid-word from stale
            // buffer state that the user can't see anymore.
            this._currentWord = '';
            this._previousWord = '';
            this._cancelIdleTimer();
            this._hidePredictionGlow();
        }
        // Key sizes change because the prediction bar consumes
        // vertical space when visible.
        this._layoutKeys();
        this._refreshPredictions();
        this._syncPredictionGlowForMode(this._rgbMode());
    }

    // Idle auto-clear.  Any user-observable change to the tracking
    // buffer calls _armIdleTimer() to (re)start the 60 s countdown.
    // When the countdown expires we wipe the buffer and refresh, so
    // the suggestion bar goes blank until the user types again.
    _armIdleTimer() {
        this._cancelIdleTimer();
        if (!this._predictionEnabled) return;
        this._idleTimerId = GLib.timeout_add(
            GLib.PRIORITY_LOW, PREDICTION_IDLE_CLEAR_MS,
            () => {
                this._idleTimerId = 0;
                // Only do work if prediction is still on AND we
                // actually have state to clear -- avoids an unneeded
                // repaint if the user typed exactly one char then
                // waited.
                if (!this._predictionEnabled) return GLib.SOURCE_REMOVE;
                if (this._currentWord || this._previousWord) {
                    this._currentWord = '';
                    this._previousWord = '';
                    this._refreshPredictions();
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelIdleTimer() {
        _clearSource(this, '_idleTimerId');
    }


    // ---- key handling ----

    onKeyPress(spec, isRepeat, button) {
        // Default to left-click semantics if the caller didn't supply
        // a button (e.g. older code paths or programmatic invocation).
        button = button || 1;

        if (spec.modifier) {
            // Right-click: legacy off/armed/locked cycle.  Useful for
            // sticky-style combos (Ctrl+Alt+T) where a one-handed
            // mouse user can't physically hold three keys at once.
            if (button === 3) {
                if (!isRepeat) this._cycleModifier(spec.modifier);
                return;
            }
            // Left-click (or any other button): tap the modifier as
            // a regular key.  This matters for keys whose tap has
            // first-class meaning -- Super opens Activities, Alt
            // focuses the window's accelerator menu in some apps --
            // and gives users a fallback for combos by arming OTHER
            // modifiers via right-click first.  Any already-armed
            // modifiers are layered into the chord and consumed,
            // exactly like a normal keypress, so right-click-Ctrl
            // followed by left-click-Shift sends Ctrl+Shift.  We
            // skip MOD_TO_KEY for the modifier we're tapping so we
            // don't double-press the same physical key.
            const kc = MOD_TO_KEY[spec.modifier];
            if (kc === undefined) return;
            const activeMods = [];
            for (const m of ['SHIFT', 'CTRL', 'ALT', 'META']) {
                if (m === spec.modifier) continue;
                if (this._modifiers[m] !== MOD_OFF) {
                    activeMods.push(MOD_TO_KEY[m]);
                }
            }
            this._sendChord(activeMods, kc);
            if (!isRepeat) this._consumeArmedMods();
            return;
        }
        // Special-action (OSK-managed) keys -- Mv Up, Dock, Fade,
        // Options, Help, Nav, Fn.  These don't synthesize a keycode
        // into the target window; they ask the extension to perform
        // an OSK-level action (or are no-ops placeholders).  Handled
        // here before the keycode == null early-return so that keys
        // with special action AND null keycode work as expected.
        if (spec.special) {
            if (!isRepeat) this._runSpecial(spec.special);
            return;
        }
        if (spec.keycode === null) return;

        const activeMods = [];
        for (const m of ['SHIFT', 'CTRL', 'ALT', 'META']) {
            if (this._modifiers[m] !== MOD_OFF) {
                activeMods.push(MOD_TO_KEY[m]);
            }
        }

        this._sendChord(activeMods, spec.keycode);

        // Feed the predictor AFTER we've committed the key to the
        // target window.  isRepeat entries still count as real
        // characters typed, so the "held-down 'k'" case still builds
        // the current-word buffer.  When prediction is off this whole
        // branch is skipped, so the typing path is exactly as before.
        if (this._predictionEnabled) {
            this._trackKeyForPrediction(spec, isRepeat);
            // Any keystroke resets the idle countdown.  Done here
            // rather than inside _trackKeyForPrediction so taps on
            // non-text keys (arrows, F-keys, modifiers) count as
            // "user is active" too, even though they don't affect
            // the word buffer.
            this._armIdleTimer();
        }

        if (!isRepeat) this._consumeArmedMods();
    }

    // Dispatch a "special" (OSK-managed) action from a Windows-OSK
    // right-panel key.  Actions that change position/visibility get
    // emitted as signals so the extension (which owns the Main.*
    // APIs and the work-area math) can react; opacity is a pure
    // actor property so we handle it locally.  Unknown / 'NONE'
    // actions are silently ignored so layouts can include visual-only
    // placeholders (the Fn key) without a handler.
    _runSpecial(action) {
        switch (action) {
            case 'SNAP_TOP':
                this.emit('snap-requested', 'top');
                break;
            case 'SNAP_MIDDLE':
                this.emit('snap-requested', 'middle');
                break;
            case 'SNAP_BOTTOM':
                this.emit('snap-requested', 'bottom');
                break;
            case 'OPACITY_CYCLE':
                this._cycleOpacity();
                break;
            case 'OPEN_MENU':
                this.emit('options-requested');
                break;
            case 'HELP':
                this.emit('help-requested');
                break;
            case 'NAV_TOGGLE':
            case 'NONE':
            default:
                // Placeholder keys (Fn, Nav on the Windows-OSK
                // layout) intentionally do nothing -- kept for
                // visual parity with the reference layout.
                break;
        }
    }

    // Cycle through a fixed set of opacity levels: solid ->
    // semi-transparent steps -> back to solid.  Matches the Windows
    // OSK "Fade" button behaviour (each tap makes it a bit more
    // transparent, eventually wrapping).  Stays inside the keyboard
    // because Clutter.Actor.opacity is something we own directly.
    _cycleOpacity() {
        const levels = [255, 217, 178, 128];
        const cur = Math.round(this.opacity);
        let idx = levels.indexOf(cur);
        if (idx < 0) idx = 0;   // not on a known level -> restart cycle
        this.opacity = levels[(idx + 1) % levels.length];
    }

    // Update currentWord / previousWord based on what the key press
    // would produce, without trying to read the target application.
    // This mirrors the keypress the user sent on our own virtual
    // device, so the tracked buffer stays in sync with whatever the
    // application rendered -- assuming focus didn't change.  If focus
    // *did* change to a different text field, the buffer gets stale;
    // that's acceptable because a handful of wrong suggestions is
    // cheap, and any non-letter key (click, tab-out, etc.) would have
    // reset the buffer anyway.
    _trackKeyForPrediction(spec, _isRepeat) {
        const kc = spec.keycode;

        // Modifier-held non-text combos (Ctrl+X, Alt+Tab, etc.) clear
        // the buffer -- anything the user's doing, it isn't "typing
        // the next letter of a word."
        const hasNonShiftMod =
            this._modifiers.CTRL !== MOD_OFF ||
            this._modifiers.ALT !== MOD_OFF ||
            this._modifiers.META !== MOD_OFF;
        if (hasNonShiftMod) {
            this._resetWordTracking();
            this._refreshPredictions();
            return;
        }

        // Backspace shrinks the current word buffer.  If the buffer
        // was already empty, the backspace affected text we can't see
        // -- be conservative and wipe previousWord too so we don't
        // suggest a stale bigram continuation.
        if (kc === KEY.BACKSPACE) {
            if (this._currentWord.length > 0) {
                this._currentWord =
                    this._currentWord.slice(0, -1);
            } else {
                this._previousWord = '';
            }
            this._refreshPredictions();
            return;
        }

        // Word boundaries: commit the in-progress word, clear buffer.
        if (kc === KEY.SPACE || kc === KEY.ENTER || kc === KEY.TAB) {
            this._commitCurrentWord();
            this._refreshPredictions();
            return;
        }

        // Letter keys: append (respecting SHIFT for case).  The spec's
        // label is the unshifted character (e.g. 'a'); spec.shift is
        // the shifted character ('A').  Using them directly keeps us
        // independent of the evdev -> unicode mapping.
        const base = spec.label;
        if (base.length === 1 && /^[a-z]$/i.test(base)) {
            const shifted = this._modifiers.SHIFT !== MOD_OFF;
            const ch = shifted
                ? (spec.shift || base.toUpperCase())
                : base.toLowerCase();
            this._currentWord += ch;
            this._refreshPredictions();
            return;
        }

        // Apostrophe inside a word ("don't", "it's").  SHIFT+' is "
        // which is a quote mark, not part of a word, so bail on shift.
        if (kc === KEY.APOSTROPHE
            && this._modifiers.SHIFT === MOD_OFF
            && this._currentWord.length > 0) {
            this._currentWord += "'";
            this._refreshPredictions();
            return;
        }

        // Anything else (punctuation, digits, arrows, function keys...):
        // commit whatever word we had and start fresh.
        this._commitCurrentWord();
        this._refreshPredictions();
    }

    _commitCurrentWord() {
        if (this._currentWord.length >= 2 && this._predictor) {
            const lower = this._currentWord.toLowerCase();
            // Only record alphabetic+apostrophe tokens.  The predictor
            // does this filtering too, but doing it here avoids
            // churning previousWord on junk.
            if (/^[a-z][a-z']*$/.test(lower)) {
                this._predictor.learn(lower, this._previousWord);
                this._previousWord = lower;
            } else {
                this._previousWord = '';
            }
        }
        this._currentWord = '';
    }

    _resetWordTracking() {
        this._currentWord = '';
        this._previousWord = '';
    }

    _refreshPredictions() {
        if (!this._predictionEnabled || !this._predictor) {
            for (const btn of this._predictionButtons) {
                btn.setSuggestion('');
            }
            this._syncPredictionGlowForMode(this._rgbMode());
            return;
        }
        const prefixLower = this._currentWord.toLowerCase();
        // Ask the predictor for exactly as many suggestions as we
        // have slots to show -- the slot count is dynamic
        // (_ensurePredictionSlotCount) so this isn't a constant.
        const suggestions = this._predictor.predict(
            prefixLower, this._previousWord,
            this._predictionButtons.length);

        // Match display-case to what the user has typed so far.  This
        // is purely cosmetic -- when clicked we only synth the missing
        // tail, which is always lowercase.  See onPredictionClicked.
        const caseFn = this._casingFor(this._currentWord);
        for (let i = 0; i < this._predictionButtons.length; i++) {
            const btn = this._predictionButtons[i];
            if (i < suggestions.length) {
                btn.setSuggestion(caseFn(suggestions[i]));
            } else {
                btn.setSuggestion('');
            }
        }
        this._syncPredictionGlowForMode(this._rgbMode());
    }

    // Pick a casing function that matches the user's typed prefix:
    //   ''      -> lowercase (cold start)
    //   'h'     -> lowercase
    //   'H'     -> Capitalise
    //   'HE'    -> UPPERCASE
    //   'He'    -> Capitalise
    _casingFor(prefix) {
        if (!prefix) return (s) => s;
        if (prefix.length >= 2 && prefix === prefix.toUpperCase()
            && prefix !== prefix.toLowerCase()) {
            return (s) => s.toUpperCase();
        }
        const first = prefix[0];
        if (first === first.toUpperCase() && first !== first.toLowerCase()) {
            return (s) => s[0].toUpperCase() + s.slice(1);
        }
        return (s) => s;
    }

    // Called from OSKPredictionButton when the user taps a suggestion.
    // We synth the *missing* tail of the suggestion plus a trailing
    // space, so "He" + click "Hello" -> types "llo " and the text box
    // ends up with "Hello ".  Shift is applied per-character if the
    // tail needs uppercase (sentence-start or ALL-CAPS prefixes).
    // Armed modifiers are consumed so the user's OSK state matches
    // what they'd expect after a regular keypress.
    onPredictionClicked(slotIndex) {
        if (!this._predictionEnabled || !this._predictor) return;
        const btn = this._predictionButtons[slotIndex];
        if (!btn || !btn.visible) return;
        const displayed = btn._getDisplayLabel
            ? btn._getDisplayLabel()
            : btn.get_label();
        if (!displayed || displayed === '\u2013\u2013\u2013') return;

        // The predictor returned lowercase; the button label reflects
        // our displayed casing.  Subtract what the user has typed
        // (case-sensitively) from the button label to get the tail.
        const typed = this._currentWord;
        let tail;
        if (displayed.length >= typed.length
            && displayed.slice(0, typed.length) === typed) {
            tail = displayed.slice(typed.length);
        } else {
            // Casing mismatch (shouldn't happen given _casingFor, but
            // belt-and-braces): reconstruct from the lowercase form.
            const lowered = displayed.toLowerCase();
            const typedLower = typed.toLowerCase();
            if (lowered.startsWith(typedLower)) {
                // Emit the lowercase tail -- safer than mangling case.
                tail = displayed.slice(typed.length).toLowerCase();
            } else {
                return; // Suggestion is somehow unrelated, bail.
            }
        }

        for (const ch of tail) {
            this._emitPredictedChar(ch);
        }
        // Trailing space: also the "word boundary" that commits the
        // just-typed word to the learner on the next tracking tick.
        this._emitPredictedChar(' ');

        // Book-keeping: update our internal buffer as if the user had
        // typed each of those characters through the normal keypress
        // path.  Doing it here rather than re-entering
        // _trackKeyForPrediction keeps us out of any virtual-device
        // event feedback loop.
        this._currentWord = displayed;  // in case the user typed nothing
        this._commitCurrentWord();

        // Consume any armed SHIFT so subsequent keys aren't silently
        // capitalised.  Matches what a regular keypress does.
        this._consumeArmedMods();
        // Tapping a suggestion counts as activity: reset the 60 s
        // idle countdown so the next word's bigram continuation has
        // time to be discovered before we auto-clear.
        this._armIdleTimer();
        this._refreshPredictions();
    }

    _emitPredictedChar(ch) {
        if (!ch) return;
        const lower = ch.toLowerCase();
        const kc = PREDICT_CHAR_TO_KEYCODE[lower];
        if (kc === undefined) return;
        // Apply SHIFT only if the char is an uppercase letter -- for
        // apostrophe and space we always want the unshifted variant
        // regardless of whether the user's SHIFT is armed.
        const isUpperLetter =
            ch !== lower && /^[A-Z]$/.test(ch);
        const mods = isUpperLetter ? [KEY.LSHIFT] : [];
        this._sendChord(mods, kc);
    }

    _sendChord(modKeycodes, keycode) {
        const time = GLib.get_monotonic_time();
        for (const m of modKeycodes) {
            this._virtualDevice.notify_key(time, m, Clutter.KeyState.PRESSED);
        }
        this._virtualDevice.notify_key(time, keycode, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_key(time, keycode, Clutter.KeyState.RELEASED);
        for (const m of [...modKeycodes].reverse()) {
            this._virtualDevice.notify_key(time, m, Clutter.KeyState.RELEASED);
        }
    }

    _cycleModifier(name) {
        const cur = this._modifiers[name];
        const next = { [MOD_OFF]: MOD_ARMED,
                       [MOD_ARMED]: MOD_LOCKED,
                       [MOD_LOCKED]: MOD_OFF }[cur];
        this._modifiers[name] = next;
        this._refreshModButtons(name);
        if (name === 'SHIFT') this._refreshShiftedLabels();
    }

    _consumeArmedMods() {
        let shiftChanged = false;
        for (const name of ['SHIFT', 'CTRL', 'ALT', 'META']) {
            if (this._modifiers[name] === MOD_ARMED) {
                this._modifiers[name] = MOD_OFF;
                this._refreshModButtons(name);
                if (name === 'SHIFT') shiftChanged = true;
            }
        }
        if (shiftChanged) this._refreshShiftedLabels();
    }

    _refreshModButtons(name) {
        const state = this._modifiers[name];
        const label = state === MOD_OFF ? 'off'
                    : state === MOD_ARMED ? 'armed'
                    : 'locked';
        for (const btn of this._modButtons[name]) {
            btn.setModState(label);
        }
    }

    _refreshShiftedLabels() {
        const shifted = this._modifiers.SHIFT !== MOD_OFF;
        for (const btn of this._shiftedButtons) {
            const label = shifted ? btn.spec.shift : btn.spec.label;
            if (btn._setDisplayLabel) btn._setDisplayLabel(label);
            else btn.set_label(label);
        }
        this._resizeAllColorRings();
    }
});
