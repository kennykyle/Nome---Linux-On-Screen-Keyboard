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
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
// Cairo is the drawing backend used by the RGB row glow canvases and
// the color wheel widget.  GJS exposes it under the 'cairo' import
// (no `gi://` prefix).
import Cairo from 'cairo';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import { WordPredictor } from './predictor.js';


// ========================================================================
//  Linux evdev keycodes (what Clutter.VirtualInputDevice.notify_key wants)
// ========================================================================

const KEY = {
    ESC: 1,
    '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7,
    '7': 8, '8': 9, '9': 10, '0': 11,
    MINUS: 12, EQUAL: 13, BACKSPACE: 14, TAB: 15,
    Q: 16, W: 17, E: 18, R: 19, T: 20, Y: 21,
    U: 22, I: 23, O: 24, P: 25,
    LBRACKET: 26, RBRACKET: 27, ENTER: 28, LCTRL: 29,
    A: 30, S: 31, D: 32, F: 33, G: 34, H: 35,
    J: 36, K: 37, L: 38,
    SEMICOLON: 39, APOSTROPHE: 40, GRAVE: 41,
    LSHIFT: 42, BACKSLASH: 43,
    Z: 44, X: 45, C: 46, V: 47, B: 48, N: 49, M: 50,
    COMMA: 51, DOT: 52, SLASH: 53, RSHIFT: 54,
    LALT: 56, SPACE: 57, CAPSLOCK: 58,
    F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64,
    F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
    // Lock / system keys.  PRTSCN uses evdev's KEY_SYSRQ (99) -- on
    // most Linux keymaps the "Print Screen" physical key emits SYSRQ.
    // SCROLLLOCK (70) and PAUSE (119) are standard evdev constants.
    NUMLOCK: 69, SCROLLLOCK: 70,
    SYSRQ: 99, PAUSE: 119,
    RCTRL: 97, RALT: 100,
    HOME: 102, UP: 103, PGUP: 104, LEFT: 105, RIGHT: 106,
    END: 107, DOWN: 108, PGDN: 109, INSERT: 110, DELETE: 111,
    LMETA: 125, MENU: 127,
};

const MOD_TO_KEY = {
    SHIFT: KEY.LSHIFT,
    CTRL:  KEY.LCTRL,
    ALT:   KEY.LALT,
    META:  KEY.LMETA,
};


// Mapping used when the word predictor needs to synthesise the tail of
// a predicted word.  Only the characters the predictor can ever emit
// need to be here -- lowercase a-z, apostrophe, and space -- because
// the dictionary is filtered to alphabetic+apostrophe tokens (see
// WORD_RE in predictor.js) and the click handler always tacks on a
// trailing space.  Uppercase is handled by the caller via a [SHIFT]
// chord rather than a separate entry here.
const PREDICT_CHAR_TO_KEYCODE = {
    "a": KEY.A, "b": KEY.B, "c": KEY.C, "d": KEY.D, "e": KEY.E,
    "f": KEY.F, "g": KEY.G, "h": KEY.H, "i": KEY.I, "j": KEY.J,
    "k": KEY.K, "l": KEY.L, "m": KEY.M, "n": KEY.N, "o": KEY.O,
    "p": KEY.P, "q": KEY.Q, "r": KEY.R, "s": KEY.S, "t": KEY.T,
    "u": KEY.U, "v": KEY.V, "w": KEY.W, "x": KEY.X, "y": KEY.Y,
    "z": KEY.Z,
    "'": KEY.APOSTROPHE,
    " ": KEY.SPACE,
};


// ========================================================================
//  Key layout
// ========================================================================

function k(label, shift, keycode, width, modifier) {
    return {
        label,
        shift: shift || '',
        keycode: keycode ?? null,
        width: width || 1.0,
        modifier: modifier || '',
        special: '',
    };
}

// Factory for "special" (OSK-managed) keys whose press doesn't emit a
// keycode into the target window -- instead the keyboard triggers an
// internal action.  Used by the Windows-OSK-style layout for the
// right-hand panel (Nav, Mv Up, Mv Dn, Dock, Fade, Options, Help, Fn).
// The `special` string is the action tag; see OSKKeyboard._runSpecial
// for the dispatch table.
function kSp(label, special, width) {
    return {
        label,
        shift: '',
        keycode: null,
        width: width || 1.0,
        modifier: '',
        special: special || '',
    };
}


// ------------------------------------------------------------------------
//  Layout: Windows OSK (default).  Mirrors the Windows 11 on-screen
//  keyboard layout: 5 rows, a right-hand OSK-specific panel with Nav,
//  Mv Up/Dn, Dock, PrtScn/ScrLk, Options, Help, and Fade.  This is the
//  layout the extension boots into unless the user has picked another.
// ------------------------------------------------------------------------

const WOSK_ROW_1 = [
    k('Esc', '', KEY.ESC),
    k('`', '~', KEY.GRAVE),
    k('1', '!', KEY['1']), k('2', '@', KEY['2']),
    k('3', '#', KEY['3']), k('4', '$', KEY['4']),
    k('5', '%', KEY['5']), k('6', '^', KEY['6']),
    k('7', '&', KEY['7']), k('8', '*', KEY['8']),
    k('9', '(', KEY['9']), k('0', ')', KEY['0']),
    k('-', '_', KEY.MINUS), k('=', '+', KEY.EQUAL),
    k('\u232B', '', KEY.BACKSPACE, 1.5),   // Backspace glyph
    k('Home', '', KEY.HOME),
    k('PgUp', '', KEY.PGUP),
    kSp('Nav', 'NAV_TOGGLE'),
];

const WOSK_ROW_2 = [
    k('Tab', '', KEY.TAB, 1.5),
    k('q', 'Q', KEY.Q), k('w', 'W', KEY.W),
    k('e', 'E', KEY.E), k('r', 'R', KEY.R),
    k('t', 'T', KEY.T), k('y', 'Y', KEY.Y),
    k('u', 'U', KEY.U), k('i', 'I', KEY.I),
    k('o', 'O', KEY.O), k('p', 'P', KEY.P),
    k('[', '{', KEY.LBRACKET),
    k(']', '}', KEY.RBRACKET),
    k('Del', '', KEY.DELETE, 2.0),
    k('End', '', KEY.END),
    k('PgDn', '', KEY.PGDN),
    kSp('Mv Up', 'SNAP_TOP'),
];

const WOSK_ROW_3 = [
    k('Caps', '', KEY.CAPSLOCK, 1.75),
    k('a', 'A', KEY.A), k('s', 'S', KEY.S),
    k('d', 'D', KEY.D), k('f', 'F', KEY.F),
    k('g', 'G', KEY.G), k('h', 'H', KEY.H),
    k('j', 'J', KEY.J), k('k', 'K', KEY.K),
    k('l', 'L', KEY.L),
    k(';', ':', KEY.SEMICOLON),
    k("'", '"', KEY.APOSTROPHE),
    k('Enter', '', KEY.ENTER, 2.75),
    k('Insert', '', KEY.INSERT),
    k('Pause', '', KEY.PAUSE),
    kSp('Mv Dn', 'SNAP_BOTTOM'),
];

const WOSK_ROW_4 = [
    k('Shift', '', null, 1.75, 'SHIFT'),
    k('z', 'Z', KEY.Z), k('x', 'X', KEY.X),
    k('c', 'C', KEY.C), k('v', 'V', KEY.V),
    k('b', 'B', KEY.B), k('n', 'N', KEY.N),
    k('m', 'M', KEY.M),
    k(',', '<', KEY.COMMA), k('.', '>', KEY.DOT),
    k('/', '?', KEY.SLASH),
    k('\u2191', '', KEY.UP),    // Up arrow; Windows OSK puts it between '/' and right Shift
    k('Shift', '', null, 1.75, 'SHIFT'),
    k('PrtScn', '', KEY.SYSRQ),
    k('ScrLk', '', KEY.SCROLLLOCK),
    kSp('Dock', 'SNAP_MIDDLE'),
];

const WOSK_ROW_5 = [
    kSp('Fn', 'NONE'),
    k('Ctrl', '', null, 1.25, 'CTRL'),
    k('\u229E', '', null, 1.25, 'META'),   // Win-key glyph
    k('Alt', '', null, 1.25, 'ALT'),
    k('Space', '', KEY.SPACE, 4.25),
    k('Alt', '', null, 1.25, 'ALT'),
    k('Ctrl', '', null, 1.25, 'CTRL'),
    k('\u2190', '', KEY.LEFT),   // Left arrow
    k('\u2193', '', KEY.DOWN),   // Down arrow
    k('\u2192', '', KEY.RIGHT),  // Right arrow
    k('menu', '', KEY.MENU),
    kSp('Options', 'OPEN_MENU'),
    kSp('Help', 'HELP'),
    kSp('Fade', 'OPACITY_CYCLE'),
];


// ------------------------------------------------------------------------
//  Layout: Full desktop.  The pre-existing 6-row layout with a
//  function-key row at the top and a narrow right-hand nav column
//  (PgUp/PgDn + arrow keys).  Closer to a real PC keyboard than the
//  Windows OSK layout, and preserves the original feel for users who
//  upgraded from earlier builds where this was the only option.
// ------------------------------------------------------------------------

const ROW_F = [
    k('Esc', '', KEY.ESC),
    k('F1', '', KEY.F1), k('F2', '', KEY.F2),
    k('F3', '', KEY.F3), k('F4', '', KEY.F4),
    k('F5', '', KEY.F5), k('F6', '', KEY.F6),
    k('F7', '', KEY.F7), k('F8', '', KEY.F8),
    k('F9', '', KEY.F9), k('F10', '', KEY.F10),
    k('F11', '', KEY.F11), k('F12', '', KEY.F12),
    k('Home', '', KEY.HOME), k('End', '', KEY.END),
    k('Ins', '', KEY.INSERT), k('Del', '', KEY.DELETE),
];

const ROW_1 = [
    k('`', '~', KEY.GRAVE),
    k('1', '!', KEY['1']), k('2', '@', KEY['2']),
    k('3', '#', KEY['3']), k('4', '$', KEY['4']),
    k('5', '%', KEY['5']), k('6', '^', KEY['6']),
    k('7', '&', KEY['7']), k('8', '*', KEY['8']),
    k('9', '(', KEY['9']), k('0', ')', KEY['0']),
    k('-', '_', KEY.MINUS), k('=', '+', KEY.EQUAL),
    k('Backspace', '', KEY.BACKSPACE, 2.0),
    k('PgUp', '', KEY.PGUP),
];

const ROW_2 = [
    k('Tab', '', KEY.TAB, 1.5),
    k('q', 'Q', KEY.Q), k('w', 'W', KEY.W),
    k('e', 'E', KEY.E), k('r', 'R', KEY.R),
    k('t', 'T', KEY.T), k('y', 'Y', KEY.Y),
    k('u', 'U', KEY.U), k('i', 'I', KEY.I),
    k('o', 'O', KEY.O), k('p', 'P', KEY.P),
    k('[', '{', KEY.LBRACKET), k(']', '}', KEY.RBRACKET),
    k('\\', '|', KEY.BACKSLASH, 1.5),
    k('PgDn', '', KEY.PGDN),
];

const ROW_3 = [
    k('Caps', '', KEY.CAPSLOCK, 1.75),
    k('a', 'A', KEY.A), k('s', 'S', KEY.S),
    k('d', 'D', KEY.D), k('f', 'F', KEY.F),
    k('g', 'G', KEY.G), k('h', 'H', KEY.H),
    k('j', 'J', KEY.J), k('k', 'K', KEY.K),
    k('l', 'L', KEY.L),
    k(';', ':', KEY.SEMICOLON), k("'", '"', KEY.APOSTROPHE),
    k('Enter', '', KEY.ENTER, 2.25),
    k('Up', '', KEY.UP),
];

const ROW_4 = [
    k('Shift', '', null, 2.25, 'SHIFT'),
    k('z', 'Z', KEY.Z), k('x', 'X', KEY.X),
    k('c', 'C', KEY.C), k('v', 'V', KEY.V),
    k('b', 'B', KEY.B), k('n', 'N', KEY.N),
    k('m', 'M', KEY.M),
    k(',', '<', KEY.COMMA), k('.', '>', KEY.DOT),
    k('/', '?', KEY.SLASH),
    k('Shift', '', null, 2.0, 'SHIFT'),
    k('Left', '', KEY.LEFT),
];

const ROW_5 = [
    k('Ctrl', '', null, 1.25, 'CTRL'),
    k('Super', '', null, 1.25, 'META'),
    k('Alt', '', null, 1.25, 'ALT'),
    k('Space', '', KEY.SPACE, 6.25),
    k('Alt', '', null, 1.25, 'ALT'),
    k('Super', '', null, 1.25, 'META'),
    k('Menu', '', KEY.MENU, 1.25),
    k('Ctrl', '', null, 1.25, 'CTRL'),
    k('Down', '', KEY.DOWN),
    k('Right', '', KEY.RIGHT),
];


// ------------------------------------------------------------------------
//  Layout: Compact.  The 5 main rows with no function-key strip and no
//  right-hand nav column -- just the physical keys a typist reaches
//  for on a shrunken laptop.  Narrow enough to sit on a half-screen
//  split without feeling cramped.
// ------------------------------------------------------------------------

const CMPT_ROW_1 = [
    k('Esc', '', KEY.ESC),
    k('`', '~', KEY.GRAVE),
    k('1', '!', KEY['1']), k('2', '@', KEY['2']),
    k('3', '#', KEY['3']), k('4', '$', KEY['4']),
    k('5', '%', KEY['5']), k('6', '^', KEY['6']),
    k('7', '&', KEY['7']), k('8', '*', KEY['8']),
    k('9', '(', KEY['9']), k('0', ')', KEY['0']),
    k('-', '_', KEY.MINUS), k('=', '+', KEY.EQUAL),
    k('Backspace', '', KEY.BACKSPACE, 2.0),
];

const CMPT_ROW_2 = [
    k('Tab', '', KEY.TAB, 1.5),
    k('q', 'Q', KEY.Q), k('w', 'W', KEY.W),
    k('e', 'E', KEY.E), k('r', 'R', KEY.R),
    k('t', 'T', KEY.T), k('y', 'Y', KEY.Y),
    k('u', 'U', KEY.U), k('i', 'I', KEY.I),
    k('o', 'O', KEY.O), k('p', 'P', KEY.P),
    k('[', '{', KEY.LBRACKET), k(']', '}', KEY.RBRACKET),
    k('\\', '|', KEY.BACKSLASH, 1.5),
];

const CMPT_ROW_3 = [
    k('Caps', '', KEY.CAPSLOCK, 1.75),
    k('a', 'A', KEY.A), k('s', 'S', KEY.S),
    k('d', 'D', KEY.D), k('f', 'F', KEY.F),
    k('g', 'G', KEY.G), k('h', 'H', KEY.H),
    k('j', 'J', KEY.J), k('k', 'K', KEY.K),
    k('l', 'L', KEY.L),
    k(';', ':', KEY.SEMICOLON), k("'", '"', KEY.APOSTROPHE),
    k('Enter', '', KEY.ENTER, 2.25),
];

const CMPT_ROW_4 = [
    k('Shift', '', null, 2.25, 'SHIFT'),
    k('z', 'Z', KEY.Z), k('x', 'X', KEY.X),
    k('c', 'C', KEY.C), k('v', 'V', KEY.V),
    k('b', 'B', KEY.B), k('n', 'N', KEY.N),
    k('m', 'M', KEY.M),
    k(',', '<', KEY.COMMA), k('.', '>', KEY.DOT),
    k('/', '?', KEY.SLASH),
    k('Shift', '', null, 2.75, 'SHIFT'),
];

const CMPT_ROW_5 = [
    k('Ctrl', '', null, 1.25, 'CTRL'),
    k('Super', '', null, 1.25, 'META'),
    k('Alt', '', null, 1.25, 'ALT'),
    k('Space', '', KEY.SPACE, 6.25),
    k('Alt', '', null, 1.25, 'ALT'),
    k('Super', '', null, 1.25, 'META'),
    k('Menu', '', KEY.MENU, 1.25),
    k('Ctrl', '', null, 1.25, 'CTRL'),
];


// ------------------------------------------------------------------------
//  Layout: Laptop.  Function-key row on top (useful for terminal work
//  and app shortcuts), a compact main block, and an inline arrow
//  cluster at the bottom right -- no separate navigation column.
//  Narrower than the Full layout but keeps F1..F12.
// ------------------------------------------------------------------------

const LAP_ROW_F = [
    k('Esc', '', KEY.ESC),
    k('F1', '', KEY.F1), k('F2', '', KEY.F2),
    k('F3', '', KEY.F3), k('F4', '', KEY.F4),
    k('F5', '', KEY.F5), k('F6', '', KEY.F6),
    k('F7', '', KEY.F7), k('F8', '', KEY.F8),
    k('F9', '', KEY.F9), k('F10', '', KEY.F10),
    k('F11', '', KEY.F11), k('F12', '', KEY.F12),
    k('Del', '', KEY.DELETE),
];

const LAP_ROW_1 = CMPT_ROW_1;
const LAP_ROW_2 = CMPT_ROW_2;
const LAP_ROW_3 = CMPT_ROW_3;

const LAP_ROW_4 = [
    k('Shift', '', null, 2.25, 'SHIFT'),
    k('z', 'Z', KEY.Z), k('x', 'X', KEY.X),
    k('c', 'C', KEY.C), k('v', 'V', KEY.V),
    k('b', 'B', KEY.B), k('n', 'N', KEY.N),
    k('m', 'M', KEY.M),
    k(',', '<', KEY.COMMA), k('.', '>', KEY.DOT),
    k('/', '?', KEY.SLASH),
    k('Shift', '', null, 1.75, 'SHIFT'),
    k('\u2191', '', KEY.UP),
];

const LAP_ROW_5 = [
    k('Ctrl', '', null, 1.25, 'CTRL'),
    k('Super', '', null, 1.25, 'META'),
    k('Alt', '', null, 1.25, 'ALT'),
    k('Space', '', KEY.SPACE, 6.25),
    k('Alt', '', null, 1.25, 'ALT'),
    k('Ctrl', '', null, 1.25, 'CTRL'),
    k('\u2190', '', KEY.LEFT),
    k('\u2193', '', KEY.DOWN),
    k('\u2192', '', KEY.RIGHT),
];


// ------------------------------------------------------------------------
//  Layout: Mobile/Touch.  Simplified layout with no modifiers except a
//  combined Shift/Backspace bottom strip -- sized and arranged to feel
//  like a phone keyboard.  Intended for touch-first use or cramped
//  pop-ups where the full PC layout is overkill.
// ------------------------------------------------------------------------

const MOB_ROW_1 = [
    k('1', '', KEY['1']), k('2', '', KEY['2']),
    k('3', '', KEY['3']), k('4', '', KEY['4']),
    k('5', '', KEY['5']), k('6', '', KEY['6']),
    k('7', '', KEY['7']), k('8', '', KEY['8']),
    k('9', '', KEY['9']), k('0', '', KEY['0']),
];

const MOB_ROW_2 = [
    k('q', 'Q', KEY.Q), k('w', 'W', KEY.W),
    k('e', 'E', KEY.E), k('r', 'R', KEY.R),
    k('t', 'T', KEY.T), k('y', 'Y', KEY.Y),
    k('u', 'U', KEY.U), k('i', 'I', KEY.I),
    k('o', 'O', KEY.O), k('p', 'P', KEY.P),
];

const MOB_ROW_3 = [
    k('a', 'A', KEY.A), k('s', 'S', KEY.S),
    k('d', 'D', KEY.D), k('f', 'F', KEY.F),
    k('g', 'G', KEY.G), k('h', 'H', KEY.H),
    k('j', 'J', KEY.J), k('k', 'K', KEY.K),
    k('l', 'L', KEY.L),
];

const MOB_ROW_4 = [
    k('Shift', '', null, 1.5, 'SHIFT'),
    k('z', 'Z', KEY.Z), k('x', 'X', KEY.X),
    k('c', 'C', KEY.C), k('v', 'V', KEY.V),
    k('b', 'B', KEY.B), k('n', 'N', KEY.N),
    k('m', 'M', KEY.M),
    k('\u232B', '', KEY.BACKSPACE, 1.5),
];

const MOB_ROW_5 = [
    k(',', '', KEY.COMMA),
    k('Space', '', KEY.SPACE, 6.0),
    k('.', '', KEY.DOT),
    k('Enter', '', KEY.ENTER, 1.5),
];


// ------------------------------------------------------------------------
//  Layout registry.  Keys are referenced from config.json (persisted
//  across sessions) and from the Layout submenu in the panel
//  indicator.  The registry lookup order matches the order shown to
//  the user; `winOsk` is first and is the default.
// ------------------------------------------------------------------------

const LAYOUTS = {
    winOsk: {
        label: 'Windows OSK',
        rows: [WOSK_ROW_1, WOSK_ROW_2, WOSK_ROW_3, WOSK_ROW_4, WOSK_ROW_5],
        defaultW: 1100, defaultH: 320,
        // Wider key gaps (vertical + horizontal) for the default
        // layout so each key has more visible space around it for
        // the RGB glow to spill into.  Other layouts stay tight.
        keySpacing: 6,
    },
    full: {
        label: 'Full desktop',
        rows: [ROW_F, ROW_1, ROW_2, ROW_3, ROW_4, ROW_5],
        defaultW: 900, defaultH: 380,
    },
    compact: {
        label: 'Compact',
        rows: [CMPT_ROW_1, CMPT_ROW_2, CMPT_ROW_3, CMPT_ROW_4, CMPT_ROW_5],
        defaultW: 820, defaultH: 320,
    },
    laptop: {
        label: 'Laptop',
        rows: [LAP_ROW_F, LAP_ROW_1, LAP_ROW_2, LAP_ROW_3, LAP_ROW_4, LAP_ROW_5],
        defaultW: 900, defaultH: 360,
    },
    mobile: {
        label: 'Mobile / Touch',
        rows: [MOB_ROW_1, MOB_ROW_2, MOB_ROW_3, MOB_ROW_4, MOB_ROW_5],
        defaultW: 620, defaultH: 320,
    },
};

const DEFAULT_LAYOUT_KEY = 'winOsk';

// Default key spacing (px) used when a layout doesn't override.  The
// active layout's spacing is always read via _layoutKeySpacing(); this
// constant is just the fallback for layouts without a `keySpacing`
// field, plus any code that needs a constant maximum (e.g., chrome
// calculations).
const KEY_SPACING = 3;
// Maximum keySpacing ANY layout might use.  Used by chrome budget
// calculations that need a worst-case ceiling so layouts with the
// largest gaps still get a correctly-sized vertical key area.
const MAX_KEY_SPACING = 6;
function _layoutKeySpacing(layoutKey) {
    const v = LAYOUTS[layoutKey] && LAYOUTS[layoutKey].keySpacing;
    return (typeof v === 'number' && v > 0) ? v : KEY_SPACING;
}
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

// RGB animation tuning.  Per-key actor stack (back to front):
//
//   rowGlows    (St.DrawingArea[])  -- one low-power Cairo light map
//                                      per row for every persistent RGB
//                                      halo mode.  Hue modes repaint at
//                                      a capped RGB FPS; fixed modes
//                                      paint once and animate opacity
//                                      where needed.
//   colorRing    (Clutter.Actor)    -- thin sharp colored band at
//                                      the key edge.  Used by every
//                                      colored mode.
//   btn          (OSKKey)           -- the key body, front-most.
//
// CSS box-shadow gives the nicest true blur, but repeatedly changing
// or transitioning it can stall GNOME Shell's compositor badly.  The
// persistent RGB modes therefore share a DrawingArea "light map" path
// painted with Cairo radial gradients.  Hue modes sample exact
// time-based hues at RGB_LOW_POWER_FPS; fixed modes do not color-cycle.
//
//   off       no halo actors visible.  No transitions.
//   static    fixed rgbColor row-canvas glow + ring.
//   gradient  per-key hue baked into row-canvas glow + ring.  Static spatial
//             rainbow; labels colored to match.
//   breathing fixed rgbColor row-canvas glow + auto-reverse opacity
//             (whole cell breathes).
//   rainbow   row-canvas soft bloom + ring/text cycle;
//             per-key hue offset.
//   cycle     same as rainbow but every key shares offset 0.
//   wave      diagonal column+row bands, faster than rainbow.
//   pulse     fixed rgbColor row-canvas glow + auto-reverse opacity
//             only; key body stays.
//   reactive  each press spawns a temporary St.Widget overlay in
//             Main.uiGroup with a rgbColor box-shadow that fades to 0
//             over RGB_REACTIVE_FADE_MS.
const RGB_BREATH_PERIOD_MS = 3500;
const RGB_REACTIVE_FADE_MS = 900;
// Cycle period: time for one full hue rotation (rainbow / cycle).
// Wave is shorter because its diagonal bands read best as a faster
// sweep across the keyboard.
const RGB_RAINBOW_PERIOD_MS = 24000;
const RGB_WAVE_PERIOD_MS = 12000;
// Row-canvas halo architecture.  Hue modes sample exact time-based hues
// at a fixed frame rate instead of running continuous Clutter
// transitions; fixed modes use the same geometry without hue cycling.
// This intentionally avoids forcing Mutter to repaint at the monitor
// refresh rate just for RGB lighting.
const RGB_SHADOW_CYCLE_STEPS = 30;
const RGB_LOW_POWER_FPS = 14;
const RGB_LOW_POWER_INTERVAL_MS = Math.round(1000 / RGB_LOW_POWER_FPS);
const RGB_CANVAS_LAYERS = 1;
const RGB_CANVAS_MIN_GLOW_BLEED = 7;
const RGB_CANVAS_MAX_GLOW_BLEED = 56;
const RGB_CANVAS_CORE_ALPHA = 0.36;
const RGB_CANVAS_OUTER_ALPHA = 0.19;
const RGB_GLOW_SIZE_MAX = 160;
const RGB_SPREAD_SIZE_MAX = 14;
const RGB_CSS_MAX_GLOW_SIZE = 120;
const RGB_CSS_MAX_SPREAD = 8;
function _haloBlendFeather(bleed, spacing = KEY_SPACING, blendPct = 65) {
    if (bleed <= 0) return 0;
    const gap = Math.max(1, spacing || KEY_SPACING);
    const blend = Math.max(0, Math.min(100, blendPct)) / 100;
    if (blend <= 0.01) return 0;
    const maxByGap = gap + blend * 22;
    const maxByBleed = bleed * (0.04 + blend * 0.90);
    return Math.round(Math.max(0, Math.min(maxByGap, maxByBleed)));
}
// Pulse cycle (transparent -> color -> transparent).  Half-period is
// the actual transition duration since auto-reverse handles the trip
// back.  1.2 s feels deliberately attention-grabbing without being
// strobey.
const RGB_PULSE_PERIOD_MS = 1200;
// Breathing modulates each OSKKey's `opacity` between these values
// (0-255 Clutter scale).  Floor at ~70% keeps key labels readable.
const RGB_BREATH_OPACITY_MIN = 180;
const RGB_BREATH_OPACITY_MAX = 255;
// Base alpha multiplier for the CSS shadow.  1.0 maps the intensity
// slider linearly: slider 100% = full alpha, 0% = transparent.
const RGB_SHADOW_ALPHA_COLOR = 1.0;
// colorRing: thin sharp colored band right at the key edge, used by
// every colored mode.  Bleed is read live from rgbBorderSize so the
// "Border size" slider takes effect on the next install / resize.
const RGB_COLOR_RING_OPACITY = 240;

// Keyboard size bounds.  MIN values keep the keys readable; we also
// scale key height from keyboard height, so the background always hugs
// the keys (no empty band below them).  The mobile layout only has
// five rows and a narrower profile, so the width floor is loose enough
// to accommodate it without dropping below the readable-keys threshold.
const MIN_KEYBOARD_WIDTH = 440;
const MIN_KEYBOARD_HEIGHT = 240;
const KEYBOARD_SCREEN_MARGIN = 20;
// Customize window size bounds.  Picked so the title bar, body and
// at least one section header stay readable at the smallest size,
// and so the picker panel always has room for its 200x200 SV square
// without overlapping the body.
const CUSTOMIZE_WINDOW_MIN_WIDTH = 600;
const CUSTOMIZE_WINDOW_MIN_HEIGHT = 420;
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

function _removeSource(id) {
    if (!id) return;
    try { GLib.source_remove(id); }
    catch (_e) {}
}

function _clearSource(owner, prop) {
    if (!owner || !owner[prop]) return;
    _removeSource(owner[prop]);
    owner[prop] = 0;
}

function _primaryWorkArea() {
    try {
        const pIdx = Main.layoutManager.primaryIndex;
        return Main.layoutManager.getWorkAreaForMonitor(pIdx);
    } catch (_e) {
        return { x: 0, y: 0, width: 1280, height: 720 };
    }
}

function _workAreaMargin(area) {
    const shortest = Math.min(area.width || 0, area.height || 0);
    if (shortest <= KEYBOARD_SCREEN_MARGIN * 2) return 0;
    return KEYBOARD_SCREEN_MARGIN;
}

function _fitKeyboardRectToWorkArea(x, y, w, h, area = null) {
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


// ========================================================================
//  Themes & customization
// ========================================================================
//
// A theme is a plain object describing every color the keyboard chrome
// can paint.  The style strings applied to each widget are derived from
// a theme + a customization record (user tweaks: opacity, bold, custom
// background, RGB mode) by `buildStyles(theme, custom)`, computed once
// on the keyboard and re-applied to every child when anything changes.
//
// Five pre-built themes are shipped; users can switch between them from
// the "Customization" submenu.  A sixth "custom" slot is not provided
// -- customization lives in the customization record on top of whatever
// theme is active, so you can take Dracula and tint the keys however
// you like without losing the theme's other colors.

const THEMES = {
    dark: {
        label: 'Dark (default)',
        keyboard:     { bg: '#1e1e1e', border: '#000000' },
        titleBar:     { bg: '#141414', text: '#dddddd' },
        titleBtnHover:{ bg: '#333333', text: '#ffffff' },
        closeBtnHover:{ bg: '#c42b1c', text: '#ffffff' },
        key:          { bg: '#3c3c3c', text: '#eeeeee', border: '#6a6a6a' },
        keyHover:     { bg: '#505050', text: '#ffffff', border: '#888888' },
        keyPressed:   { bg: '#1c71d8', text: '#ffffff', border: '#1a65c0' },
        keyArmed:     { bg: '#3584e4', text: '#ffffff', border: '#1c71d8' },
        keyLocked:    { bg: '#26a269', text: '#ffffff', border: '#1c8654' },
        grip:         { text: '#999999', hover: '#ffffff' },
        predictionBar:{ bg: '#151515' },
        predictionBtn:{ bg: '#2a2a2a', text: '#eeeeee', border: '#4a4a4a' },
        predictionBtnHover:   { bg: '#3a3a3a', text: '#ffffff', border: '#6a6a6a' },
        predictionBtnPressed: { bg: '#1c71d8', text: '#ffffff', border: '#1a65c0' },
        predictionBtnEmpty:   { text: '#555555', border: '#333333' },
        accent: '#3584e4',
    },
    light: {
        label: 'Light',
        keyboard:     { bg: '#ececec', border: '#b0b0b0' },
        titleBar:     { bg: '#d7d7d7', text: '#2e2e2e' },
        titleBtnHover:{ bg: '#c7c7c7', text: '#000000' },
        closeBtnHover:{ bg: '#c42b1c', text: '#ffffff' },
        key:          { bg: '#ffffff', text: '#2e2e2e', border: '#b8b8b8' },
        keyHover:     { bg: '#f2f2f2', text: '#000000', border: '#888888' },
        keyPressed:   { bg: '#3584e4', text: '#ffffff', border: '#1a65c0' },
        keyArmed:     { bg: '#3584e4', text: '#ffffff', border: '#1c71d8' },
        keyLocked:    { bg: '#26a269', text: '#ffffff', border: '#1c8654' },
        grip:         { text: '#666666', hover: '#000000' },
        predictionBar:{ bg: '#dcdcdc' },
        predictionBtn:{ bg: '#fafafa', text: '#2e2e2e', border: '#c0c0c0' },
        predictionBtnHover:   { bg: '#ffffff', text: '#000000', border: '#888888' },
        predictionBtnPressed: { bg: '#3584e4', text: '#ffffff', border: '#1a65c0' },
        predictionBtnEmpty:   { text: '#999999', border: '#bcbcbc' },
        accent: '#3584e4',
    },
    dracula: {
        label: 'Dracula',
        keyboard:     { bg: '#282a36', border: '#191a21' },
        titleBar:     { bg: '#21222c', text: '#f8f8f2' },
        titleBtnHover:{ bg: '#44475a', text: '#ffffff' },
        closeBtnHover:{ bg: '#ff5555', text: '#ffffff' },
        key:          { bg: '#44475a', text: '#f8f8f2', border: '#6272a4' },
        keyHover:     { bg: '#5a5f7d', text: '#ffffff', border: '#bd93f9' },
        keyPressed:   { bg: '#bd93f9', text: '#282a36', border: '#ff79c6' },
        keyArmed:     { bg: '#ff79c6', text: '#282a36', border: '#bd93f9' },
        keyLocked:    { bg: '#50fa7b', text: '#282a36', border: '#8be9fd' },
        grip:         { text: '#6272a4', hover: '#bd93f9' },
        predictionBar:{ bg: '#191a21' },
        predictionBtn:{ bg: '#44475a', text: '#f8f8f2', border: '#6272a4' },
        predictionBtnHover:   { bg: '#5a5f7d', text: '#ffffff', border: '#bd93f9' },
        predictionBtnPressed: { bg: '#bd93f9', text: '#282a36', border: '#ff79c6' },
        predictionBtnEmpty:   { text: '#6272a4', border: '#44475a' },
        accent: '#bd93f9',
    },
    nord: {
        label: 'Nord',
        keyboard:     { bg: '#2e3440', border: '#242933' },
        titleBar:     { bg: '#3b4252', text: '#eceff4' },
        titleBtnHover:{ bg: '#4c566a', text: '#ffffff' },
        closeBtnHover:{ bg: '#bf616a', text: '#ffffff' },
        key:          { bg: '#434c5e', text: '#eceff4', border: '#4c566a' },
        keyHover:     { bg: '#4c566a', text: '#ffffff', border: '#88c0d0' },
        keyPressed:   { bg: '#88c0d0', text: '#2e3440', border: '#81a1c1' },
        keyArmed:     { bg: '#5e81ac', text: '#eceff4', border: '#81a1c1' },
        keyLocked:    { bg: '#a3be8c', text: '#2e3440', border: '#8fbcbb' },
        grip:         { text: '#81a1c1', hover: '#88c0d0' },
        predictionBar:{ bg: '#3b4252' },
        predictionBtn:{ bg: '#434c5e', text: '#eceff4', border: '#4c566a' },
        predictionBtnHover:   { bg: '#4c566a', text: '#ffffff', border: '#88c0d0' },
        predictionBtnPressed: { bg: '#88c0d0', text: '#2e3440', border: '#81a1c1' },
        predictionBtnEmpty:   { text: '#4c566a', border: '#434c5e' },
        accent: '#88c0d0',
    },
    cyberpunk: {
        label: 'Cyberpunk',
        keyboard:     { bg: '#0a0e27', border: '#ff00ff' },
        titleBar:     { bg: '#1a0033', text: '#00ffff' },
        titleBtnHover:{ bg: '#3a0066', text: '#ffff00' },
        closeBtnHover:{ bg: '#ff0066', text: '#ffffff' },
        key:          { bg: '#16213e', text: '#00ffff', border: '#ff00ff' },
        keyHover:     { bg: '#1f2e5a', text: '#ffff00', border: '#00ffff' },
        keyPressed:   { bg: '#ff00ff', text: '#ffff00', border: '#00ffff' },
        keyArmed:     { bg: '#ff00ff', text: '#ffffff', border: '#00ffff' },
        keyLocked:    { bg: '#00ff66', text: '#0a0e27', border: '#00ffff' },
        grip:         { text: '#ff00ff', hover: '#00ffff' },
        predictionBar:{ bg: '#1a0033' },
        predictionBtn:{ bg: '#16213e', text: '#00ffff', border: '#ff00ff' },
        predictionBtnHover:   { bg: '#1f2e5a', text: '#ffff00', border: '#00ffff' },
        predictionBtnPressed: { bg: '#ff00ff', text: '#ffff00', border: '#00ffff' },
        predictionBtnEmpty:   { text: '#4a4a7a', border: '#2a1050' },
        accent: '#ff00ff',
    },
};

const DEFAULT_THEME_ID = 'dark';

// Customization record: user overrides on top of the active theme.
// Loaded from config.json, persisted on every change.  Each field is
// independently optional; the keyboard tolerates extra / missing keys
// so older configs from pre-customization builds don't crash on load.
const DEFAULT_CUSTOMIZATION = {
    themeId: DEFAULT_THEME_ID,
    // Path to a user-chosen background image.  null means "no custom
    // background, just the theme's background color".  When set, we
    // use CSS background-image + background-size for proportional
    // scaling that tracks keyboard resizes.
    customBackground: null,
    // How the background image is sized relative to the keyboard:
    //   'cover'   -- fill the whole area, preserve aspect ratio, may crop
    //   'contain' -- fit entirely inside, preserve aspect ratio, may show gaps
    //   'stretch' -- fill exactly, may distort (not recommended but offered)
    backgroundFit: 'cover',
    // Background image position as CSS percentages.  50/50 is center;
    // increasing Y nudges the image down, which helps portraits and
    // other images whose useful content sits above center.
    backgroundPositionX: 50,
    backgroundPositionY: 50,
    // Proportional background image scale.  100 preserves the default
    // overscanned image layer used by the position sliders; lower
    // values shrink, higher values zoom in, without stretching.
    backgroundScale: 100,
    // Keyboard chrome controls.  Opacity is applied to title-bar
    // background/title text only, not to the minimize/close buttons.
    topBarOpacity: 100,
    showOskTitle: true,
    // Prediction UI opacity controls only the suggestion strip/button
    // visuals; prediction text remains governed by Text opacity.
    predictionButtonOpacity: 100,
    // Key background alpha (0-100).  Lets users see the OSK background
    // (including custom image) through the keys themselves.  Applied as
    // an rgba() override on background-color.
    keyOpacity: 100,
    // Text boldness on keys and prediction buttons.
    textBold: true,
    // Text alpha on keys (0-100).
    textOpacity: 100,
    // Key/prediction text size in CSS pixels.
    keyTextSize: 14,
    // Per-element color overrides.  Keys are dotted paths into the
    // theme object (e.g. 'key.bg', 'titleBar.text'), values are hex
    // color strings.  Missing / null values fall back to the active
    // theme's value -- so a user can override just "key background"
    // without having to re-specify every other color.  The
    // Customization window builds its color controls from the
    // CUSTOM_COLOR_SPECS list below; unknown paths are tolerated
    // (ignored during merge) so stale config keys from newer builds
    // don't crash an older build.
    customColors: {},
    // RGB lighting mode: 'off', 'static', 'gradient', 'breathing',
    // 'rainbow', 'cycle', 'wave', 'pulse', 'reactive'.  'off' disables
    // the animation entirely; the others install zero or more Clutter
    // transitions per halo layer -- see OSKKeyboard's RGB section.
    rgbMode: 'off',
    // Base RGB color, hex.  Used by static/breathing/reactive.
    // Rainbow ignores this and cycles through hues.
    rgbColor: '#ff00ff',
    // Intensity of the RGB glow, 0-100.  Scales the halo overlay's
    // opacity (and the breathing-mode opacity range) so users can
    // make it subtle or loud.
    rgbIntensity: 70,
    // Whether non-hue RGB effects (pulse / gradient) also color the
    // KEY LABEL text.  Rainbow / cycle / wave always animate labels
    // in sync with the glow so the whole keyboard shares one phase.
    rgbCycleLabels: true,
    // Advanced RGB tuning -- exposed in the customize window's
    // "Advanced Options" expander.  These top-level values are legacy
    // defaults; new edits are stored per mode in rgbModeSettings so
    // rainbow/cycle/wave/etc. can each keep their own tuning.
    //
    //   rgbBorderSize  -- colorRing bleed (px past key edge).  The
    //                     thin sharp colored line at the key edge.
    //                     Sub-pixel values are allowed; the ring actor
    //                     keeps stable integer geometry and scales
    //                     opacity to simulate thinner borders.
    //   rgbGlowSize      -- halo shape size / reach.  Low values hug
    //                       the key edge; high values grow the ellipse.
    //   rgbBlurAmount    -- glow density.  Legacy key name, but it now
    //                       controls bloom brightness/saturation rather
    //                       than geometry.
    //   rgbHaloSoftness  -- falloff curve.  Low values are sharper;
    //                       high values fade smoothly to the edge.
    //   rgbHaloCoverage  -- how much of the bloom lives under the key
    //                       face versus only outside the key edge.
    //   rgbCornerBlend   -- how much neighboring halos feather together
    //                       in gaps/corners.
    //   rgbSpeed       -- animation speed percent for modes that
    //                     actually animate color/pattern timing.
    rgbBorderSize: 1,
    rgbGlowSize: 84,
    rgbBlurAmount: 4,
    rgbSpeed: 100,
    rgbHaloSoftness: 75,
    rgbHaloCoverage: 65,
    rgbCornerBlend: 65,
    // Per-mode overrides for the advanced RGB sliders.  Shape:
    // { [mode]: { rgbBorderSize, rgbGlowSize, rgbBlurAmount,
    //             rgbHaloSoftness, rgbHaloCoverage, rgbCornerBlend,
    //             rgbSpeed } }.
    // Legacy top-level values above remain as fallback/defaults for
    // older configs and modes the user has not tuned yet.
    rgbModeSettings: {},
};

const THEME_OPTION_KEYS = [
    'customBackground',
    'backgroundFit',
    'backgroundPositionX',
    'backgroundPositionY',
    'backgroundScale',
    'topBarOpacity',
    'showOskTitle',
    'predictionButtonOpacity',
    'keyOpacity',
    'textBold',
    'textOpacity',
    'keyTextSize',
    'rgbMode',
    'rgbColor',
    'rgbIntensity',
    'rgbCycleLabels',
    'rgbBorderSize',
    'rgbGlowSize',
    'rgbBlurAmount',
    'rgbSpeed',
    'rgbHaloSoftness',
    'rgbHaloCoverage',
    'rgbCornerBlend',
    'rgbModeSettings',
];

// Per-element color spec used by the Customization window.  Each row
// is [humanLabel, themePath, groupLabel, fallbackHex].  The group
// label partitions the color controls into visual groups in the UI.
// Keep the order stable so users who remember where "Key pressed bg"
// sits don't lose their muscle memory on upgrade.
const CUSTOM_COLOR_SPECS = [
    ['Background',             'keyboard.bg',        'Keyboard'],
    ['Border',                 'keyboard.border',    'Keyboard'],

    ['Background',             'titleBar.bg',        'Title bar'],
    ['Text',                   'titleBar.text',      'Title bar'],
    ['Close button hover bg',  'closeBtnHover.bg',   'Title bar'],

    ['Default background',     'key.bg',             'Keys'],
    ['Default text',           'key.text',           'Keys'],
    ['Default border',         'key.border',         'Keys'],
    ['Hover background',       'keyHover.bg',        'Keys'],
    ['Pressed background',     'keyPressed.bg',      'Keys'],
    ['Modifier armed',         'keyArmed.bg',        'Keys'],
    ['Modifier locked',        'keyLocked.bg',       'Keys'],

    ['Background',             'predictionBar.bg',   'Prediction bar'],
    ['Button background',      'predictionBtn.bg',   'Prediction bar'],
    ['Button text',            'predictionBtn.text', 'Prediction bar'],

    ['Resize grip',            'grip.text',          'Misc'],
];


// hex (#rrggbb or #rrggbbaa) -> {r, g, b, a(0-1)}.  Returns null for
// malformed input so callers can choose a fallback rather than crash.
function _parseHex(hex) {
    if (typeof hex !== 'string') return null;
    let s = hex.trim();
    if (s.startsWith('#')) s = s.slice(1);
    if (s.length === 3) {
        s = s.split('').map(c => c + c).join('');
    }
    if (s.length !== 6 && s.length !== 8) return null;
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].some(v => isNaN(v))) return null;
    return { r, g, b, a };
}

// Hex color + 0..1 alpha -> rgba(...) string suitable for CSS.  If the
// color can't be parsed, fall back to the original hex string (St
// accepts both, so the non-alpha path still paints something visible).
function _withAlpha(hex, alpha) {
    const c = _parseHex(hex);
    if (!c) return hex || 'transparent';
    const a = Math.max(0, Math.min(1, alpha));
    // Combine the hex's own alpha with the caller's alpha so
    // #rrggbbaa inputs degrade correctly.
    const out = c.a * a;
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${out.toFixed(3)})`;
}

// Convert {r,g,b} (0-255) to {h,s,v} with h in [0,360), s,v in [0,1].
// Used by the color-wheel widget to initialise its cursor position
// from an incoming hex color.
function _rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    const v = max;
    const s = max === 0 ? 0 : d / max;
    let h;
    if (d === 0) h = 0;
    else if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return { h, s, v };
}

// Convert HSV (h 0..360, s 0..1, v 0..1) to hex '#rrggbb'.  Used by
// the color wheel when the user drags -- outputs the hex string
// setCustomColor/setRgbColor expect.
function _hsvToHex(h, s, v) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(1, s));
    v = Math.max(0, Math.min(1, v));
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if      (h <  60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else              { r = c; b = x; }
    const to2 = (n) => {
        const v2 = Math.round((n + m) * 255);
        const h2 = Math.max(0, Math.min(255, v2)).toString(16);
        return h2.length < 2 ? '0' + h2 : h2;
    };
    return `#${to2(r)}${to2(g)}${to2(b)}`;
}


// HSL -> hex.  Used by the rainbow RGB mode; keeping it hex-in-hex-out
// keeps the downstream code uniform (alpha path always works the same).
function _hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    const C = (1 - Math.abs(2 * l - 1)) * s;
    const Hp = h / 60;
    const X = C * (1 - Math.abs((Hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (Hp < 1)      { r = C; g = X; }
    else if (Hp < 2) { r = X; g = C; }
    else if (Hp < 3) { g = C; b = X; }
    else if (Hp < 4) { g = X; b = C; }
    else if (Hp < 5) { r = X; b = C; }
    else             { r = C; b = X; }
    const m = l - C / 2;
    const to2 = (v) => {
        const n = Math.round((v + m) * 255);
        const h2 = Math.max(0, Math.min(255, n)).toString(16);
        return h2.length < 2 ? '0' + h2 : h2;
    };
    return `#${to2(r)}${to2(g)}${to2(b)}`;
}

// Build a Cogl.Color from 0-255 channels.  Used by the RGB animation
// path, which feeds Cogl.Color values into Clutter PropertyTransitions
// on `background-color` so the compositor can interpolate them on the
// GPU thread (no CSS reparse, no per-frame JS callback).  Default
// alpha 255 so callers writing solid colors can omit it.
function _coglColor(r, g, b, a) {
    return new Cogl.Color({
        red: r | 0,
        green: g | 0,
        blue: b | 0,
        alpha: (a === undefined) ? 255 : (a | 0),
    });
}

// Cogl.Color from a "#rrggbb" hex string with optional 0-255 alpha.
// Falls back to fully transparent on a parse failure so a typo in the
// user's saved rgbColor never crashes the install path.
function _coglColorFromHex(hex, alpha) {
    const c = _parseHex(hex);
    if (!c) return _coglColor(0, 0, 0, 0);
    return _coglColor(c.r, c.g, c.b, alpha === undefined ? 255 : alpha);
}

// Cogl.Color for an HSL hue at fixed saturation 1.0 / lightness 0.55,
// the same values used by the legacy rainbow CSS path so the new
// transition-based rainbow looks identical.  Used by the rainbow /
// cycle / wave keyframe transitions.
function _coglColorFromHue(hue, alpha) {
    // Lightness 0.50 = PEAK SATURATION for any HSL hue.  Higher
    // values mix in white (pastel), lower values mix in black
    // (deep).  0.50 keeps the color at its purest, most vivid.
    return _coglColorFromHex(_hslToHex(hue, 1.0, 0.50), alpha);
}

// Parse "#rrggbb" -> {r,g,b} (0-255) with safe fallback to magenta.
// Used by the reactive shadow CSS path (which needs decimal channels
// for an `rgba(...)` string, not the Cogl.Color object the animation
// path uses).  Tiny duplication of _parseHex but keeps the shadow
// helpers self-contained for clarity.
function _rgbChannelsFromHex(hex) {
    const c = _parseHex(hex);
    return c ? { r: c.r, g: c.g, b: c.b } : { r: 255, g: 0, b: 255 };
}

// REACTIVE press shadow: a single CSS shadow on a short-lived overlay.
// The caller passes already-capped blur and spread values so a saved
// extreme slider setting cannot create giant per-key shadows while
// typing.
function _reactiveShadowStyle(r, g, b, alpha, blurPx, spreadPx) {
    if (alpha <= 0) return '';
    const a = Math.max(0, Math.min(1, alpha));
    const c = `${r|0},${g|0},${b|0}`;
    const blur = Math.max(1, Math.round(((blurPx | 0) || 1) * 1.12));
    const spread = Math.max(0, Math.round(((spreadPx | 0) || 0) * 0.7));
    return (
        'background-color: transparent;' +
        'border-radius: 6px;' +
        ` box-shadow: 0 0 ${blur}px ${spread}px rgba(${c},${a.toFixed(3)});`
    );
}

// Deep clone a theme definition.  Themes are plain objects with only
// primitives + nested plain objects, so JSON round-trip is the
// cheapest correct copy.  Used whenever we need a mutable copy
// (forking a built-in theme into a user theme).
function _cloneTheme(theme) {
    return JSON.parse(JSON.stringify(theme));
}

// Resolve a theme id to its definition, preferring user themes over
// built-in ones so a user can shadow a built-in id if they want (we
// don't actively prevent name collisions -- the UI picks unique ids
// by default).  Returns null when neither source has the id; callers
// fall back to the default theme.
function _lookupTheme(id, userThemes) {
    if (userThemes && userThemes[id]) return userThemes[id];
    if (THEMES[id]) return THEMES[id];
    return null;
}

// True iff `id` is one of the shipped, immutable built-in themes.
// Used by the Customize window to decide whether to fork or edit
// in-place when the user changes a color.
function _isBuiltInTheme(id) {
    return !!THEMES[id];
}


// Apply the user's per-element color overrides on top of a theme.
// Returns a fresh theme object -- the input theme is never mutated.
// Unknown paths in `custom.customColors` are silently ignored (so a
// stale config key from a newer build doesn't break the theme).  The
// single-level customColors dict also treats the deprecated
// `keyboardBg` field as a synonym for `customColors['keyboard.bg']`
// to preserve configs written by earlier builds.
function _mergeCustomColors(theme, custom) {
    // Shallow clone each sub-object so we can freely assign overrides
    // without mutating the shared THEMES entry.
    const out = {};
    for (const [k, v] of Object.entries(theme)) {
        out[k] = (v && typeof v === 'object') ? Object.assign({}, v) : v;
    }
    const apply = (path, hex) => {
        if (!hex) return;
        const parts = path.split('.');
        if (parts.length === 2 && out[parts[0]]) {
            out[parts[0]][parts[1]] = hex;
        }
    };
    // Back-compat shim: older configs stored the keyboard bg in its
    // own field.  Apply it first so an explicit customColors entry
    // still wins on top.
    if (custom && custom.keyboardBg) {
        apply('keyboard.bg', custom.keyboardBg);
    }
    const colors = (custom && custom.customColors) || {};
    for (const [path, hex] of Object.entries(colors)) {
        apply(path, hex);
    }
    return out;
}


// Build the full styles map from a theme + customization record.
// Called on every theme/customization change by the keyboard; each key
// widget then reads its style string out of the result by name.  Kept
// as a pure function (no side-effects, no `this`) so it's trivial to
// unit-test and to call again for a fresh styles object.
function buildStyles(theme, custom) {
    custom = custom || DEFAULT_CUSTOMIZATION;
    theme = theme || THEMES[DEFAULT_THEME_ID];
    // Merge user-chosen colors on top of the theme.  Everywhere
    // below reads `theme.*` and gets the resolved color (override
    // where the user set one, original theme value otherwise).
    theme = _mergeCustomColors(theme, custom);

    const fontWeight = custom.textBold === false ? 'normal' : 'bold';
    const keyTextSize = Math.max(10, Math.min(28,
        (custom.keyTextSize || DEFAULT_CUSTOMIZATION.keyTextSize) | 0));
    const keyAlpha = Math.max(0, Math.min(100, custom.keyOpacity)) / 100;
    const textAlpha = Math.max(0, Math.min(100, custom.textOpacity)) / 100;
    const topBarAlpha = Math.max(0, Math.min(100,
        custom.topBarOpacity !== undefined
            ? custom.topBarOpacity : DEFAULT_CUSTOMIZATION.topBarOpacity)) / 100;
    const predictionAlpha = Math.max(0, Math.min(100,
        custom.predictionButtonOpacity !== undefined
            ? custom.predictionButtonOpacity
            : DEFAULT_CUSTOMIZATION.predictionButtonOpacity)) / 100;

    const keyBg       = _withAlpha(theme.key.bg,        keyAlpha);
    const keyHoverBg  = _withAlpha(theme.keyHover.bg,   keyAlpha);
    const keyPressBg  = _withAlpha(theme.keyPressed.bg, keyAlpha);
    const keyArmedBg  = _withAlpha(theme.keyArmed.bg,   keyAlpha);
    const keyLockedBg = _withAlpha(theme.keyLocked.bg,  keyAlpha);

    const keyText       = _withAlpha(theme.key.text,        textAlpha);
    const keyHoverText  = _withAlpha(theme.keyHover.text,   textAlpha);
    const keyPressText  = _withAlpha(theme.keyPressed.text, textAlpha);
    const keyArmedText  = _withAlpha(theme.keyArmed.text,   textAlpha);
    const keyLockedText = _withAlpha(theme.keyLocked.text,  textAlpha);
    const titleBarBg = _withAlpha(theme.titleBar.bg, topBarAlpha);
    const titleText = theme.titleBar.text;

    const predictionBarBg = _withAlpha(theme.predictionBar.bg, predictionAlpha);
    const predictionBtnBg = _withAlpha(theme.predictionBtn.bg, predictionAlpha);
    const predictionBtnHoverBg = _withAlpha(
        theme.predictionBtnHover.bg, predictionAlpha);
    const predictionBtnPressBg = _withAlpha(
        theme.predictionBtnPressed.bg, predictionAlpha);
    const predictionBtnBorder = _withAlpha(
        theme.predictionBtn.border, predictionAlpha);
    const predictionBtnHoverBorder = _withAlpha(
        theme.predictionBtnHover.border, predictionAlpha);
    const predictionBtnPressBorder = _withAlpha(
        theme.predictionBtnPressed.border, predictionAlpha);
    const predictionBtnEmptyBorder = _withAlpha(
        theme.predictionBtnEmpty.border, predictionAlpha);
    const predictionText = _withAlpha(
        theme.predictionBtn.text, textAlpha);
    const predictionHoverText = _withAlpha(
        theme.predictionBtnHover.text, textAlpha);
    const predictionPressText = _withAlpha(
        theme.predictionBtnPressed.text, textAlpha);
    const predictionEmptyText = _withAlpha(
        theme.predictionBtnEmpty.text, textAlpha);

    // RGB glow lives on a separate halo actor sibling of each key (see
    // OSKKeyboard._buildRows), not on the key's CSS.  buildStyles
    // outputs the normal theme bg / hover / pressed / etc. styles
    // without touching the halo at all -- the halo paints behind the
    // key, the key's CSS bg paints on top, label paints on top of that.
    const keyBaseBgCss  = `background-color: ${keyBg};`;
    const keyHoverBgCss = `background-color: ${keyHoverBg};`;

    // Keyboard background: solid color OR color + image.  We always
    // keep the color so the image's transparent pixels, and the area
    // around a 'contain'-fitted image, show the theme/override color
    // instead of a transparent hole.
    const hasCustomBackground = !!custom.customBackground;
    const kbdBgColor = hasCustomBackground ? 'transparent' : theme.keyboard.bg;
    const kbdBorderColor = hasCustomBackground
        ? 'transparent' : theme.keyboard.border;
    let keyboardStyle =
        `background-color: ${kbdBgColor};` +
        `border: 2px solid ${kbdBorderColor};` +
        'border-radius: 10px;' +
        `padding: ${KEYBOARD_PADDING_TOP}px 8px ` +
        `${KEYBOARD_PADDING_BOTTOM}px 8px;`;
    const fit = custom.backgroundFit || 'cover';
    const posX = Math.max(0, Math.min(100,
        custom.backgroundPositionX !== undefined
            ? custom.backgroundPositionX
            : DEFAULT_CUSTOMIZATION.backgroundPositionX));
    const posY = Math.max(0, Math.min(100,
        custom.backgroundPositionY !== undefined
            ? custom.backgroundPositionY
            : DEFAULT_CUSTOMIZATION.backgroundPositionY));
    const bgScale = Math.max(40, Math.min(250,
        custom.backgroundScale !== undefined
            ? custom.backgroundScale
            : DEFAULT_CUSTOMIZATION.backgroundScale));
    const sizeCss = fit === 'stretch' ? '100% 100%' : fit;
    const backgroundFrameStyle =
        'background-color: transparent;' +
        'border-radius: 10px;';
    const backgroundImageStyle = hasCustomBackground
        ? (`background-image: url("file://${custom.customBackground}");` +
           `background-size: ${sizeCss};` +
           'background-repeat: no-repeat;')
        : '';

    return {
        keyboard: keyboardStyle,
        keyboardBackgroundFrame: backgroundFrameStyle,
        keyboardBackgroundImage: backgroundImageStyle,
        keyboardBackgroundFit: fit,
        keyboardBackgroundPositionX: posX,
        keyboardBackgroundPositionY: posY,
        keyboardBackgroundScale: bgScale,

        titleBar:
            `background-color: ${titleBarBg};` +
            'border-radius: 6px;' +
            'padding: 4px 8px;' +
            'min-height: 28px;',

        titleLabel:
            `color: ${titleText};` +
            'font-size: 13px;',

        titleBtn:
            'background-color: transparent;' +
            `color: ${theme.titleBar.text};` +
            'border: none;' +
            'border-radius: 4px;' +
            'font-size: 18px;' +
            'font-weight: bold;' +
            'min-width: 32px;' +
            'min-height: 24px;' +
            'padding: 0 10px;',

        titleBtnHover:
            `background-color: ${theme.titleBtnHover.bg};` +
            `color: ${theme.titleBtnHover.text};` +
            'border: none;' +
            'border-radius: 4px;' +
            'font-size: 18px;' +
            'font-weight: bold;' +
            'min-width: 32px;' +
            'min-height: 24px;' +
            'padding: 0 10px;',

        closeBtnHover:
            `background-color: ${theme.closeBtnHover.bg};` +
            `color: ${theme.closeBtnHover.text};` +
            'border: none;' +
            'border-radius: 4px;' +
            'font-size: 18px;' +
            'font-weight: bold;' +
            'min-width: 32px;' +
            'min-height: 24px;' +
            'padding: 0 10px;',

        // Key/prediction inline styles intentionally OMIT `color:`.
        // Animated RGB label modes drive Clutter.Text.color directly,
        // but St re-syncs Clutter.Text.color from any inline `color:`
        // on the parent on every style sync.  By dropping `color:`
        // from the inline style and routing static text-color updates
        // through explicit text helpers, the explicit color wins in
        // every mode.  See the textColors map below for per-state
        // values outside cycling.
        keyBase:
            keyBaseBgCss +
            `border: 1px solid ${theme.key.border};` +
            'border-radius: 5px;' +
            'padding: 6px 4px;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};`,

        keyHover:
            keyHoverBgCss +
            `border: 1px solid ${theme.keyHover.border};` +
            'border-radius: 5px;' +
            'padding: 6px 4px;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};`,

        keyPressed:
            `background-color: ${keyPressBg};` +
            `border: 1px solid ${theme.keyPressed.border};` +
            'border-radius: 5px;' +
            'padding: 6px 4px;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};`,

        keyArmed:
            `background-color: ${keyArmedBg};` +
            `border: 1px solid ${theme.keyArmed.border};` +
            'border-radius: 5px;' +
            'padding: 6px 4px;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};`,

        keyLocked:
            `background-color: ${keyLockedBg};` +
            `border: 1px solid ${theme.keyLocked.border};` +
            'border-radius: 5px;' +
            'padding: 6px 4px;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};`,

        // OSKKey owns a real St.Label child instead of St.Button's
        // built-in label.  Keep font styling on that child and drive
        // color directly through its internal Clutter.Text.
        keyLabelBase:
            'font-family: "Cantarell", Sans;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};` +
            'text-align: center;' +
            'padding: 0;',

        // Per-state text colors as resolved hex strings.  OSKKey
        // applies them via Clutter.Text.set_color (NOT via CSS) so
        // animated RGB label transitions can run without fighting
        // St's CSS-color propagation.
        keyTextColors: {
            base:   keyText,
            hover:  keyHoverText,
            pressed: keyPressText,
            armed:  keyArmedText,
            locked: keyLockedText,
        },

        grip:
            'background-color: transparent;' +
            `color: ${_withAlpha(theme.grip.text, 0.72)};` +
            'border: none;' +
            'border-radius: 4px;' +
            'font-size: 13px;' +
            'font-weight: bold;' +
            'min-width: 22px;' +
            'min-height: 16px;' +
            'padding: 0;',

        gripHover:
            `background-color: ${_withAlpha(theme.grip.hover, 0.10)};` +
            `color: ${theme.grip.hover};` +
            'border: none;' +
            'border-radius: 4px;' +
            'font-size: 13px;' +
            'font-weight: bold;' +
            'min-width: 22px;' +
            'min-height: 16px;' +
            'padding: 0;',

        predictionBar:
            `background-color: ${predictionBarBg};` +
            'border-radius: 6px;' +
            'padding: 3px;',

        predictionBarOverlay:
            'background-color: transparent !important;' +
            'border-radius: 6px;' +
            'padding: 3px;',

        predictionBtn:
            `background-color: ${predictionBtnBg};` +
            `border: 1px solid ${predictionBtnBorder};` +
            'border-radius: 5px;' +
            'padding: 4px 8px;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};`,

        predictionBtnHover:
            `background-color: ${predictionBtnHoverBg};` +
            `border: 1px solid ${predictionBtnHoverBorder};` +
            'border-radius: 5px;' +
            'padding: 4px 8px;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};`,

        predictionBtnPressed:
            `background-color: ${predictionBtnPressBg};` +
            `border: 1px solid ${predictionBtnPressBorder};` +
            'border-radius: 5px;' +
            'padding: 4px 8px;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};`,

        predictionBtnEmpty:
            'background-color: transparent;' +
            `border: 1px dashed ${predictionBtnEmptyBorder};` +
            'border-radius: 5px;' +
            'padding: 4px 8px;' +
            `font-size: ${keyTextSize}px;` +
            `font-weight: ${fontWeight};`,

        predictionTextColors: {
            base: predictionText,
            hover: predictionHoverText,
            pressed: predictionPressText,
            empty: predictionEmptyText,
        },

        predictionAlpha,
    };
}


// (Persistent RGB glow is rendered by row-level Cairo canvases so it
// can stay smooth without animating CSS shadows.  Reactive press flash
// still uses a temporary CSS-shadow overlay.  See OSKKeyboard._buildRows
// and the RGB section for the animation install paths.)


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
            this._initialDelayId = GLib.timeout_add(
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
        this._repeatId = GLib.timeout_add(
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
    }

    _stopTimers() {
        _clearSource(this, '_initialDelayId');
        _clearSource(this, '_repeatId');
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
            _clearSource(this, '_dragApplyId');
            if (this._dragGrab) {
                try { this._dragGrab.dismiss(); } catch (_e) {}
                this._dragGrab = null;
            }
            if (this._dragStartX !== null && this._keyboard
                && this._keyboard._endInteractiveMotion) {
                this._keyboard._endInteractiveMotion('drag');
            }
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
            const s = this._keyboard._styles;
            minBtn.set_style(minBtn.hover ? s.titleBtnHover : s.titleBtn);
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
            const s = this._keyboard._styles;
            closeBtn.set_style(closeBtn.hover ? s.closeBtnHover : s.titleBtn);
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
            this._minBtn.set_style(
                this._minBtn.hover ? s.titleBtnHover : s.titleBtn);
        }
        if (this._closeBtn) {
            this._closeBtn.set_style(
                this._closeBtn.hover ? s.closeBtnHover : s.titleBtn);
        }
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
            ? 'Nome - Onscreen Keyboard'
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
            this._dragLocked = true;
        } else if (this._preAuthDragLocked !== undefined) {
            this._dragLocked = !!this._preAuthDragLocked;
            this._preAuthDragLocked = undefined;
        }
        if (this._minBtn) this._minBtn.visible = !enabled;
        if (this._closeBtn) this._closeBtn.visible = !enabled;
        this._syncTitleText();
    }

    _onDragStart(_actor, event) {
        if (this._dragLocked) return Clutter.EVENT_PROPAGATE;
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
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
            this._dragApplyId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 16,
                () => {
                    this._dragApplyId = 0;
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
        _clearSource(this, '_dragApplyId');
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
        this._stageSignalIds = [];

        this.connect('notify::hover', () => {
            const s = this._keyboard._styles;
            this.set_style(this.hover ? s.gripHover : s.grip);
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
        });
    }

    applyStyles() {
        const s = this._keyboard && this._keyboard._styles;
        if (!s) return;
        this.set_style(this.hover ? s.gripHover : s.grip);
    }

    _onPress(_actor, event) {
        return this.beginResizeFromEvent(event);
    }

    beginResizeFromEvent(event) {
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
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

    _connectStageTracking() {
        if (this._stageSignalIds.length > 0) return;
        this._connectStageSignal('captured-event',
            (_stage, event) => this._onStageCapturedEvent(event));
        this._connectStageSignal('button-release-event',
            (_stage, event) => this._onStageCapturedEvent(event));
        this._connectStageSignal('touch-event',
            (_stage, event) => this._onStageCapturedEvent(event));
    }

    _connectStageSignal(name, callback) {
        try {
            const id = global.stage.connect(name, callback);
            if (id) this._stageSignalIds.push(id);
        } catch (_e) {}
    }

    _disconnectStageTracking() {
        for (const id of this._stageSignalIds) {
            try { global.stage.disconnect(id); } catch (_e) {}
        }
        this._stageSignalIds = [];
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
        this._resizePollId = GLib.timeout_add(
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

const OSKKeyboard = GObject.registerClass({
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
        if (this._interactiveResize) return;
        const cb = this._currentColorRingGeometryBleed();
        _setActorGeometryIfChanged(
            colorRing, -cb, -cb, w + 2 * cb, h + 2 * cb);
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
        this._layoutKeys();
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
        for (const row of this._rowRecords) {
            for (const { btn } of row.keys) {
                if (!btn || !btn.setHoverTrackingEnabled) continue;
                btn.setHoverTrackingEnabled(true);
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
            this._layoutKeys();
            this._resizeAllColorRings();
            this._resizeRgbCanvasGlows();
            this._syncRgbAnimation();
            for (const btn of this._predictionButtons) {
                if (btn && btn._updateStyle) btn._updateStyle();
            }
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
        this._rgbCycleState = state;
        this._setRgbCycleCanvasLabelsVisible(state.cycleLabels);
        this._initRgbCanvasGlow(state);
        this._initRgbCycleEngine(state);
        this._runRgbCycleFrame(state);
        this._scheduleNextRgbCycleFrame(state);
    }

    _scheduleNextRgbCycleFrame(state) {
        if (!state || state.generation !== this._rgbCycleGeneration) return;
        _clearSource(this, '_rgbCycleTimerId');
        this._rgbCycleTimerId = GLib.timeout_add(
            GLib.PRIORITY_LOW, RGB_LOW_POWER_INTERVAL_MS,
            () => {
                if (!this._rgbCycleState
                    || state.generation !== this._rgbCycleGeneration) {
                    this._rgbCycleTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._runRgbCycleFrame(state);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _runRgbCycleFrame(state) {
        if (!state || state.generation !== this._rgbCycleGeneration) return;
        const nowUs = GLib.get_monotonic_time();
        const elapsedMs = Math.max(0, (nowUs - (state.startUs || nowUs)) / 1000);
        const period = Math.max(1, state.periodMs || RGB_RAINBOW_PERIOD_MS);
        const phaseDeg = ((elapsedMs % period) / period) * 360;
        state.phaseDeg = phaseDeg;
        if (this._isInteractiveMotionPaused()) return;

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
                            '_layoutSettleRefreshId', '_sizeRelayoutId']) {
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
        this._authMode = !!enabled;
        if (this._titleBar && this._titleBar.setAuthMode)
            this._titleBar.setAuthMode(this._authMode);
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


// ========================================================================
//  Extension entry point
// ========================================================================

// Bump this when you make user-visible behaviour changes -- it shows
// up in the journal so we can tell at a glance whether the installed
// files actually match the build we're trying to ship.
const OSK_BUILD_TAG = 'v3';


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
// Using $XDG_DATA_HOME keeps user state out of the extension install
// dir so reinstalling doesn't wipe it and uninstalling doesn't touch
// it (users can opt in to deletion via uninstall.sh).
function _oskDataDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-osk']);
}
function _oskConfigPath() {
    return GLib.build_filenamev([_oskDataDir(), 'config.json']);
}
function _oskUserDataPath() {
    return GLib.build_filenamev([_oskDataDir(), 'userdata.json']);
}
// User-owned wordlist / seed bigrams: both live under $XDG_DATA_HOME
// so they survive a reinstall of the extension (install.sh wipes
// the extension dir but does NOT touch this directory).  Also where
// the "Download vocabulary" menu item writes its fetched results.
function _oskUserWordlistPath() {
    return GLib.build_filenamev([_oskDataDir(), 'wordlist.txt']);
}
function _oskUserSeedBigramsPath() {
    return GLib.build_filenamev([_oskDataDir(), 'seed-bigrams.txt']);
}

// Source URLs for the bundled English base dictionary and seed
// bigrams.  Used by BOTH install.sh (first install) and the menu's
// "Download vocabulary" button (refresh / repair).  Kept as
// module-level constants so the two download paths agree on what's
// being fetched.
//
// Wordlist: hermitdave/FrequencyWords ships frequency-sorted lists
// derived from the OpenSubtitles corpus.  en_full.txt is the whole
// corpus -- 1.66 million entries, ~20 MiB.  The tail is mostly noise
// (typos, made-up names, OCR errors) so we:
//   1. Range-GET only the first 2 MiB (which covers ~150k lines),
//   2. Truncate to the top WORDLIST_TOP_N lines after download.
// This lands us a ~100 000-entry dictionary: well above the ~78k
// a stock /usr/share/dict/words ships, without dragging in the
// low-count junk from rank 200k onwards.
const WORDLIST_SOURCE_URL =
    'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt';
// Only the top N lines are kept after download -- post-processed by
// _truncateFileLines() in the menu path, and by `head -n N` in
// install.sh.  100k strikes a balance between coverage and noise;
// rank ~100k words still have real English entries, rank ~200k+ is
// mostly typos.
const WORDLIST_TOP_N = 100000;
// Range-GET budget: only the first 2 MiB of the 20 MiB file.  At an
// average ~13 bytes per line this captures ~150k lines, so after
// WORDLIST_TOP_N truncation we're safely in the reliable top tier.
const WORDLIST_DOWNLOAD_BYTES = 2 * 1024 * 1024;
// Hard cap in case the server ignores our Range header and streams
// the full file; we still accept up to ~5 MiB before refusing.
const WORDLIST_MAX_BYTES = 5 * 1024 * 1024;

// Seed bigrams: Peter Norvig's count_2w.txt is ~5.6 MiB with ~286 000
// entries drawn from Google Web 1T.  The file is alphabetically
// sorted (not by frequency), so we download the whole thing and
// re-sort client-side by count descending, keeping only the top N
// most-common pairs.  That becomes our seed corpus.
const SEED_BIGRAMS_SOURCE_URL =
    'https://norvig.com/ngrams/count_2w.txt';
// Hard cap on downloaded bigram file size -- 10 MiB lets the ~5.6
// MiB source through with headroom, but stops a misbehaving server
// streaming forever from filling the disk.
const SEED_BIGRAMS_MAX_BYTES = 10 * 1024 * 1024;
// After download we sort the file by count descending and keep this
// many entries.  20 000 matches install.sh's cap and bounds the
// predictor's in-memory Map at a few megabytes.
const SEED_BIGRAMS_TOP_N = 20000;


// ========================================================================
//  Panel indicator (top-bar icon)
// ========================================================================

const OSKIndicator = GObject.registerClass(
class OSKIndicator extends PanelMenu.Button {
    _init(ext) {
        // dontCreateMenu=true is important here.  PanelMenu.Button's
        // own event plumbing -- whether it lives in vfunc_event or in
        // a signal handler connected during super._init -- ends up
        // calling `this.menu.toggle()` on every BUTTON_PRESS /
        // TOUCH_BEGIN.  If this.menu is a real PopupMenu, a left-click
        // pops the dropdown before we can stop it.
        //
        // With dontCreateMenu=true, this.menu is a PopupDummyMenu
        // whose toggle() is a no-op, so the default handling is
        // harmless.  We create a separate PopupMenu as _rcMenu and
        // open/close it explicitly on right-click in vfunc_event.
        super._init(0.0, 'Nome - Onscreen Keyboard', true);
        this._ext = ext;

        this.add_child(new St.Icon({
            icon_name: 'input-keyboard-symbolic',
            style_class: 'system-status-icon',
        }));

        this._rcMenu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP);
        Main.uiGroup.add_child(this._rcMenu.actor);
        this._rcMenu.actor.hide();

        // Use our OWN PopupMenuManager rather than Main.panel.menuManager.
        // Panel's shared manager auto-switches to any of its registered
        // menus when you hover their source while a sibling menu is
        // open -- which caused our popup to appear just by hovering
        // the icon whenever any other panel menu (clock, quick
        // settings, etc.) happened to be open.  A private manager
        // tracks only our one menu, so _onMenuSourceEnter's
        // "grabbed?" check returns early and hover does nothing.
        // The manager still provides grab/escape/outside-click close
        // behaviour that a bare PopupMenu lacks.
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menuManager.addMenu(this._rcMenu);

        // Opt-in hover-to-open.  Default off (right-click only), but
        // users who find right-clicking awkward can flip it on via
        // the menu and then the popup opens as soon as the pointer
        // enters the icon.  Implemented as a signal connection we
        // add/remove rather than leaving dormant, so there's no cost
        // when the feature is off.
        this._hoverOpens = false;
        this._enterEventId = 0;

        this.connect('destroy', () => {
            if (!this._rcMenu) return;
            this._rcMenu.destroy();
            this._rcMenu = null;
            this._menuManager = null;
        });
    }

    setHoverOpens(enabled) {
        enabled = !!enabled;
        if (enabled === this._hoverOpens) return;
        if (enabled) {
            this._enterEventId = this.connect('enter-event', () => {
                if (this._rcMenu && !this._rcMenu.isOpen)
                    this._rcMenu.open();
                return Clutter.EVENT_PROPAGATE;
            });
        } else if (this._enterEventId) {
            this.disconnect(this._enterEventId);
            this._enterEventId = 0;
        }
        this._hoverOpens = enabled;
    }

    // Our left-click should toggle the keyboard, not the popup menu.
    // vfunc_event replaces the parent class's default event handler;
    // any signal-based handler in the parent calls this.menu.toggle(),
    // which is a no-op because we passed dontCreateMenu=true (see
    // _init).  So both code paths are covered.
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            const btn = event.get_button();
            if (btn === 1) {
                // If the popup happens to be open (e.g. user right-clicked,
                // then left-clicked), close it so it doesn't linger over
                // the keyboard they're about to use.
                if (this._rcMenu && this._rcMenu.isOpen)
                    this._rcMenu.close();
                this._ext._setVisible(!this._ext._keyboard.visible);
                return Clutter.EVENT_STOP;
            }
            if (btn === 3) {
                this._rcMenu.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            if (this._rcMenu && this._rcMenu.isOpen)
                this._rcMenu.close();
            this._ext._setVisible(!this._ext._keyboard.visible);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    getRightClickMenu() {
        return this._rcMenu;
    }
});


export default class OSKExtension extends Extension {
    _sessionMode() {
        try {
            return (Main.sessionMode && Main.sessionMode.currentMode) || 'user';
        } catch (_e) {
            return 'user';
        }
    }

    _isAuthSessionMode() {
        const mode = this._sessionModeName || this._sessionMode();
        return mode === 'unlock-dialog' || mode === 'gdm';
    }

    enable() {
        this._sessionModeName = this._sessionMode();
        this._authSessionMode = this._isAuthSessionMode();
        log(`gnome-osk: enable() starting, ${OSK_BUILD_TAG}, ` +
            `session-mode=${this._sessionModeName}`);
        this._saveConfigId = 0;
        this._sessionModeUpdatedId = 0;
        this._authVisibilityRetryId = 0;
        this._layoutManagerModalId = 0;
        this._modalBridgeGrab = null;
        this._modalBridgeWatchId = 0;
        this._modalBridgePreVisible = undefined;
        this._modalBridgeModalActor = null;
        this._modalHoverTarget = null;
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
        // We prefer `addTopChrome` when the Shell exposes it (45+).
        // Top chrome sits above `modalDialogGroup`, so polkit, keyring
        // unlock, sudo prompts and other Shell modals can no longer
        // overlay the OSK.  The captured-event handler installed below
        // is the other half of the fix -- without it, modal grabs
        // would still redirect pointer events away from our keys even
        // when the keyboard is visible above the modal.
        const lm = Main.layoutManager;
        const addChromeFn =
            (typeof lm.addTopChrome === 'function')
                ? lm.addTopChrome.bind(lm)
                : lm.addChrome.bind(lm);
        addChromeFn(this._keyboard, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._keyboard._queuePostLayoutRefresh();
        this._installModalAwareInput();
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
            // Word prediction.  Create the predictor, load the base
            // dictionary (from the extension's install dir) and any user
            // data (from $XDG_DATA_HOME) eagerly so the first prediction
            // call is instant.  The predictor itself is cheap to keep
            // around even when prediction is off -- the keyboard simply
            // skips the tracking path in that case.
            this._predictor = new WordPredictor();
            try {
                // Two candidate paths, tried in order.  The first is the
                // user-scope location the "Download vocabulary" menu item
                // writes to -- survives a reinstall of the extension.  The
                // second is where install.sh drops a freshly-downloaded
                // copy at install time.  Either one "counts" as installed.
                this._predictor.setWordlistPaths([
                    _oskUserWordlistPath(),
                    GLib.build_filenamev([this.path, 'wordlist.txt']),
                ]);
                this._predictor.setUserDataPath(_oskUserDataPath());
                // Seed bigrams: same two-path pattern as the wordlist --
                // user-scope file under $XDG_DATA_HOME (written by the
                // menu download, survives reinstalls) takes precedence
                // over the bundled copy in the extension dir.  The
                // bundled file is whatever install.sh managed to fetch
                // (Norvig's 2-gram corpus, top ~50k entries) falling
                // back to the hand-curated seed-bigrams.txt shipped in
                // the repo if the download failed.
                this._predictor.setSeedBigramsPaths([
                    _oskUserSeedBigramsPath(),
                    GLib.build_filenamev([this.path, 'seed-bigrams.txt']),
                ]);
                this._predictor.loadBaseDictionary();
                this._predictor.loadSeedBigrams();
                this._predictor.loadUserData();
                const s = this._predictor.stats();
                log(`gnome-osk: predictor ready (base=${s.baseWords}, ` +
                    `learned=${s.learnedWords}, bigrams=${s.bigramContexts}, ` +
                    `seedBigrams=${s.seedBigramContexts})`);
            } catch (e) {
                log(`gnome-osk: predictor init failed: ${e}`);
            }
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

        // Respect the "Show keyboard on login" toggle from the
        // indicator menu.  Default (showOnStartup: true) preserves
        // the pre-existing behaviour: keyboard visible at login.
        // Users who flipped it off see only the panel indicator;
        // clicking it brings up the keyboard on demand.
        this._setVisible(this._authSessionMode
            || this._config.showOnStartup !== false);
        if (this._authSessionMode)
            this._scheduleAuthVisibilityRetry('enable');

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
        root.set_style(
            'background-color: #1e1e1e;' +
            'border: 2px solid #000000;' +
            'border-radius: 10px;' +
            'padding: 0;');

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
        });
        scroll.set_style('padding: 4px 8px 10px 14px;');

        const body = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        body.spacing = 16;
        body.set_style('padding: 6px 8px 6px 0;');
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
        const footer = new St.BoxLayout({ x_expand: true });
        footer.spacing = 8;
        footer.set_style('padding: 10px 14px 14px 14px;' +
                         'border-top: 1px solid rgba(255,255,255,0.08);');

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
        });
        const baseStyle =
            'color: rgba(255,255,255,0.45);' +
            'background-color: transparent;' +
            'border: none;' +
            'font-size: 16px;' +
            'font-weight: bold;' +
            'min-width: 26px; min-height: 26px;' +
            'padding: 0 4px;';
        const hoverStyle =
            'color: #ffffff;' +
            'background-color: transparent;' +
            'border: none;' +
            'font-size: 16px;' +
            'font-weight: bold;' +
            'min-width: 26px; min-height: 26px;' +
            'padding: 0 4px;';
        grip.set_style(baseStyle);
        grip.connect('notify::hover', () => {
            grip.set_style(grip.hover ? hoverStyle : baseStyle);
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
        });
        bar.set_style(
            'background-color: #141414;' +
            'border-radius: 8px 8px 0 0;' +
            'padding: 6px 12px;' +
            'min-height: 32px;');

        // Drag label fills horizontally; mouse-press/motion on it
        // moves the whole window.  Same pattern as OSKTitleBar.
        const titleLbl = new St.Label({
            text: 'Customize Nome - Onscreen Keyboard',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        titleLbl.set_style(
            'color: #eeeeee; font-weight: bold; font-size: 13px;');

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
        });
        hint.set_style(
            'color: rgba(255,255,255,0.45); font-size: 11px;' +
            'padding: 0 10px;');
        bar.add_child(hint);

        const closeBtn = new St.Button({
            label: '\u00d7',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        closeBtn.set_style(
            'color: #dddddd; font-size: 18px; font-weight: bold;' +
            'min-width: 32px; min-height: 24px;' +
            'background-color: transparent;' +
            'border: none; border-radius: 4px;' +
            'padding: 0 10px;');
        closeBtn.connect('notify::hover', () => {
            closeBtn.set_style(
                closeBtn.hover
                    ? ('color: #ffffff; font-size: 18px; font-weight: bold;' +
                       'min-width: 32px; min-height: 24px;' +
                       'background-color: #c42b1c;' +
                       'border: none; border-radius: 4px;' +
                       'padding: 0 10px;')
                    : ('color: #dddddd; font-size: 18px; font-weight: bold;' +
                       'min-width: 32px; min-height: 24px;' +
                       'background-color: transparent;' +
                       'border: none; border-radius: 4px;' +
                       'padding: 0 10px;'));
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
        });
        sub.set_style('color: rgba(255,255,255,0.55); font-size: 11px;' +
                      'padding-bottom: 4px;');
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

    _addWindowSection(parent, text) {
        const needsSep = parent._oskHadSection === true;
        parent._oskHadSection = true;
        if (needsSep) {
            const sep = new St.Widget({ x_expand: true, y_expand: false });
            sep.set_style(
                'background-color: rgba(255,255,255,0.08);' +
                'min-height: 1px; margin: 6px 0;');
            parent.add_child(sep);
        }
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
        // Separator above the section header (same as _addWindowSection).
        const needsSep = parent._oskHadSection === true;
        parent._oskHadSection = true;
        if (needsSep) {
            const sep = new St.Widget({ x_expand: true, y_expand: false });
            sep.set_style(
                'background-color: rgba(255,255,255,0.08);' +
                'min-height: 1px; margin: 6px 0;');
            parent.add_child(sep);
        }

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
        const defaults = {
            predictionEnabled: false,
            // Whether the keyboard widget (not the panel indicator)
            // auto-shows when the shell starts / the extension loads.
            // True by default so the existing behaviour is preserved
            // for anyone upgrading; users who don't want the keyboard
            // popping up at login flip this off from the indicator
            // menu.  The panel icon always appears -- this setting
            // only controls whether the keyboard itself is visible.
            showOnStartup: true,
            layout: DEFAULT_LAYOUT_KEY,
            customization: Object.assign({}, DEFAULT_CUSTOMIZATION),
            userThemes: {},
        };
        try {
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) return defaults;
            const [ok, bytes] = file.load_contents(null);
            if (!ok) return defaults;
            const text = new TextDecoder('utf-8').decode(bytes);
            if (!text.trim()) return defaults;
            const cfg = JSON.parse(text);
            const merged = Object.assign({}, defaults, cfg);
            merged.customization = Object.assign(
                {}, DEFAULT_CUSTOMIZATION, cfg.customization || {});
            merged.userThemes = Object.assign({}, cfg.userThemes || {});
            // Unknown theme id (either absent from built-in THEMES and
            // from the saved user-theme dict, or hand-edited to garbage)
            // -> silently fall back to the default so the keyboard
            // still renders.
            const activeId = merged.customization.themeId;
            if (!THEMES[activeId] && !merged.userThemes[activeId]) {
                merged.customization.themeId = DEFAULT_THEME_ID;
            }
            return merged;
        } catch (e) {
            log(`gnome-osk: config load failed: ${e}`);
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
            const bytes = new TextEncoder().encode(
                JSON.stringify(this._config || {}));
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
        let bigramCount = 0;
        if (this._predictor) {
            const stats = this._predictor.stats();
            if (wordPath &&
                this._predictor.getLoadedWordlistPath() === wordPath) {
                wordCount = stats.baseWords;
            }
            if (bigramPath &&
                this._predictor.getLoadedSeedBigramsPath() === bigramPath) {
                bigramCount = stats.seedBigramContexts;
            }
        }

        return {
            wordsInstalled: !!wordPath,
            bigramsInstalled: !!bigramPath,
            wordPath, bigramPath,
            wordCount, bigramCount,
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
                // Format: "Words: 49,456  /  Bigrams: 48,293".  Both
                // counts are shown even when one side is missing so
                // the user can tell which file needs re-downloading.
                const wordPart = s.wordsInstalled
                    ? (s.wordCount > 0
                        ? `${this._formatCount(s.wordCount)} words`
                        : 'words installed')
                    : 'words MISSING';
                const bgPart = s.bigramsInstalled
                    ? (s.bigramCount > 0
                        ? `${this._formatCount(s.bigramCount)} bigrams`
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
                    // Range-GET may leave a partial last line and
                    // (harmlessly) includes more lines than we need.
                    // Trim to the top N by dropping everything past
                    // line N.  Also strips a trailing partial line if
                    // one exists (it's always past line N given the
                    // byte budget we allowed).
                    const trimOk = this._truncateFileLines(
                        _oskUserWordlistPath(), WORDLIST_TOP_N);
                    if (!trimOk) {
                        wOk = false;
                        wMsg = 'downloaded but trim failed';
                    } else {
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
        if (curl) {
            argv = [curl, '-fsSL', '--max-time', '60'];
            if (maxRangeBytes > 0) {
                // curl's --range is "start-end" inclusive.
                argv.push('--range', `0-${maxRangeBytes - 1}`);
            }
            argv.push(url, '-o', tmp);
        } else if (wget) {
            argv = [wget, '-q', '--timeout=60'];
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
    // in place.  Used after a Range-GET of hermitdave/en_full.txt to
    // drop everything past rank N and strip the partial last line
    // the Range cut introduced.  Synchronous; file is small (~2
    // MiB) so load+split+join is fine on the main loop.
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
            try { Main.layoutManager.removeChrome(keyboard); }
            catch (_e) {}
            try { keyboard.destroy(); }
            catch (_e) {}
        }
        // Flush any pending debounced save in the predictor -- this
        // catches the "user turned off extension within 3s of their
        // last typed word" case where the save timer hasn't fired.
        if (this._predictor) {
            this._predictor.destroy();
            this._predictor = null;
        }
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
            this._preAuthVisible = previousVisible;
            this._setVisible(true);
            this._scheduleAuthVisibilityRetry('session-enter-auth');
            return;
        }
        if (wasAuth && !this._authSessionMode) {
            this._cancelAuthVisibilityRetry();
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
        if (visible && !wasVisible && keyboard._syncRgbAnimation) {
            keyboard._visibleEffectsPaused = false;
            try { keyboard._layoutKeys(); } catch (_e) {}
            try { keyboard._syncRgbAnimation(); } catch (e) {
                log(`gnome-osk: RGB resume failed: ${e}`);
            }
        }
    }

    _restoreAuthKeyboard(reason) {
        if (!this._authSessionMode || !this._keyboardOrNull('_restoreAuthKeyboard'))
            return;
        this._setVisible(true);
        try { this._snapPosition('bottom'); } catch (_e) {}
        this._raiseKeyboardToTop(reason || 'auth-restore');
    }

    _scheduleAuthVisibilityRetry(reason) {
        if (!this._authSessionMode || !this._keyboard) return;
        this._cancelAuthVisibilityRetry();
        let remaining = 16;
        log(`gnome-osk: auth visibility retry armed (${reason})`);
        this._authVisibilityRetryId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 250,
            () => {
                if (!this._authSessionMode || !this._keyboard) {
                    this._authVisibilityRetryId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._restoreAuthKeyboard(reason);
                remaining--;
                if (remaining > 0) return GLib.SOURCE_CONTINUE;
                this._authVisibilityRetryId = 0;
                log(`gnome-osk: auth visibility retry complete (${reason})`);
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
        if (this._layoutManagerModalId) return;
        try {
            if (Main.layoutManager && Main.layoutManager.connect) {
                this._layoutManagerModalId = Main.layoutManager.connect(
                    'system-modal-opened',
                    () => {
                        this._onSystemModalOpened();
                        if (this._authSessionMode)
                            this._scheduleAuthVisibilityRetry('system-modal-opened');
                    });
            }
        } catch (e) {
            this._layoutManagerModalId = 0;
            log(`gnome-osk: modal raise hook unavailable: ${e}`);
        }
    }

    _uninstallModalRaiseHooks() {
        if (!this._layoutManagerModalId) return;
        try { Main.layoutManager.disconnect(this._layoutManagerModalId); }
        catch (_e) {}
        this._layoutManagerModalId = 0;
    }

    _onSystemModalOpened() {
        const keyboard = this._keyboardOrNull('_onSystemModalOpened');
        if (keyboard) {
            if (this._modalBridgePreVisible === undefined)
                this._modalBridgePreVisible = !!keyboard.visible;
            this._setVisible(true);
            this._raiseKeyboardToTop('system-modal-opened');
        }
        this._enterModalBridge('system-modal-opened');
    }

    _enterModalBridge(reason) {
        this._rememberModalGrabActor();
        this._refreshModalBridgeGrab(reason || 'modal-opened');
        this._ensureModalBridgeWatch();
    }

    _refreshModalBridgeGrab(reason) {
        const topGrab = this._stageGrabActor();
        if (this._modalBridgeGrab && topGrab === global.stage)
            return true;
        if (topGrab && this._isKeyboardDescendant(topGrab))
            return true;

        if (this._modalBridgeGrab) {
            try { this._modalBridgeGrab.dismiss(); } catch (_e) {}
            this._modalBridgeGrab = null;
        }

        try {
            if (!global.stage || typeof global.stage.grab !== 'function')
                throw new Error('global.stage.grab unavailable');
            const grab = global.stage.grab(global.stage);
            if (!grab)
                throw new Error('global.stage.grab returned no handle');
            this._modalBridgeGrab = grab;
            log(`gnome-osk: modal input bridge enabled (${reason})`);
            return true;
        } catch (e) {
            log(`gnome-osk: modal input bridge failed (${reason}): ${e}`);
            this._modalBridgeGrab = null;
            return false;
        }
    }

    _ensureModalBridgeWatch() {
        if (this._modalBridgeWatchId) return;
        this._modalBridgeWatchId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 250,
            () => this._onModalBridgeWatch());
    }

    _onModalBridgeWatch() {
        if (!this._isModalStackActive()) {
            this._modalBridgeWatchId = 0;
            this._leaveModalBridge('modal-closed');
            return GLib.SOURCE_REMOVE;
        }

        const keyboard = this._keyboardOrNull('_onModalBridgeWatch');
        if (keyboard) {
            if (!keyboard.visible)
                this._setVisible(true);
            this._raiseKeyboardToTop('modal-bridge-watch');
        }

        const topGrab = this._stageGrabActor();
        if (topGrab && topGrab !== global.stage
            && !this._isKeyboardDescendant(topGrab)) {
            this._rememberModalGrabActor(topGrab);
            this._refreshModalBridgeGrab('modal-grab-reassert');
        }

        return GLib.SOURCE_CONTINUE;
    }

    _leaveModalBridge(reason, restoreVisibility = true) {
        _clearSource(this, '_modalBridgeWatchId');

        const hadGrab = !!this._modalBridgeGrab;
        if (this._modalBridgeGrab) {
            try { this._modalBridgeGrab.dismiss(); } catch (_e) {}
            this._modalBridgeGrab = null;
        }
        this._modalBridgeModalActor = null;
        this._modalPointerTarget = null;
        this._clearCapturedHover();

        const restore = this._modalBridgePreVisible;
        this._modalBridgePreVisible = undefined;
        if (restoreVisibility && !this._authSessionMode
            && restore !== undefined && this._keyboard) {
            this._setVisible(!!restore);
        }

        if (hadGrab)
            log(`gnome-osk: modal input bridge disabled (${reason})`);
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
        if (typeof Main.modalCount === 'number')
            return Main.modalCount > 0;
        return this._isAnyModalActive();
    }

    _syncCapturedHoverTarget(target) {
        if (target && typeof target.setCapturedHover !== 'function')
            target = null;
        if (this._modalHoverTarget === target) return;
        this._clearCapturedHover();
        this._modalHoverTarget = target || null;
        if (this._modalHoverTarget) {
            try { this._modalHoverTarget.setCapturedHover(true); }
            catch (_e) { this._modalHoverTarget = null; }
        }
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

    // ---- modal-aware input ---------------------------------------
    //
    // Password/reboot prompts use Main.pushModal(...) under the hood,
    // which installs a Clutter grab on the modal actor.  Top chrome
    // solves the visual stacking problem, but not input: if the grab
    // actor is only the dialog, the visible OSK can sit above it and
    // still receive no hover, press, drag, or close events.
    //
    // `_enterModalBridge` temporarily grabs the whole stage while a
    // Shell modal is active.  Since every actor is a descendant of the
    // stage, normal picking/hover can reach the OSK again.  The capture
    // handler below keeps the important modal security property: clicks
    // outside both the modal UI and the OSK are stopped so they cannot
    // fall through to application windows behind the prompt.
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
        const keyboard = this._keyboardOrNull('_onStageCapturedEvent');
        if (!keyboard || !keyboard.visible)
            return Clutter.EVENT_PROPAGATE;
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
        const [x, y] = event.get_coords();
        const modalActive = this._isAnyModalActive();
        const directTarget = this._stagePickActorAt(x, y);
        const directIsKeyboard = this._isKeyboardDescendant(directTarget);
        const manualTarget = directIsKeyboard
            ? directTarget : this._findKeyboardActorAt(keyboard, x, y);
        const capturedHandler = this._capturedPointerHandlerFor(manualTarget);
        const blockedByOverlay = manualTarget && !directIsKeyboard;
        if (modalActive || this._modalBridgeGrab)
            this._syncCapturedHoverTarget(capturedHandler);
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
            && !this._isModalUiDescendant(directTarget)) {
            return Clutter.EVENT_STOP;
        }
        if (!modalActive && !blockedByOverlay && !this._modalPointerTarget)
            return Clutter.EVENT_PROPAGATE;

        const startsPointerSequence =
            type === Clutter.EventType.BUTTON_PRESS
            || type === Clutter.EventType.TOUCH_BEGIN;
        const endsPointerSequence =
            type === Clutter.EventType.BUTTON_RELEASE
            || type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL;

        // Where would this event have been delivered without the modal
        // grab?  get_actor_at_pos normally finds it, but some Shell
        // modal overlays sit above top chrome in the pick stack.  In
        // that case we fall back to a small manual hit-test inside the
        // keyboard tree.
        let target = this._modalPointerTarget || null;
        if (!target || startsPointerSequence) {
            target = capturedHandler || manualTarget;
            if (startsPointerSequence)
                this._modalPointerTarget = target || null;
        }
        if (!target || !this._isKeyboardDescendant(target))
            return Clutter.EVENT_PROPAGATE;
        // Bypass the grab.  OSKKey exposes a direct pointer handler so
        // keypresses do not depend on Clutter re-routing a grabbed
        // event.  Non-key chrome keeps the old synthetic-dispatch
        // fallback for buttons such as the title bar controls.
        this._raiseKeyboardToTop('modal-captured-event');
        this._reentrantSyntheticDispatch = true;
        try {
            if (typeof target.handleCapturedPointerEvent === 'function') {
                target.handleCapturedPointerEvent(event);
            } else if (typeof target.event === 'function') {
                try {
                    if (typeof event.set_source === 'function')
                        event.set_source(target);
                } catch (_e) {}
                target.event(event, false);
            }
        } catch (e) {
            log(`gnome-osk: captured-event dispatch failed: ${e}`);
        } finally {
            this._reentrantSyntheticDispatch = false;
            if (endsPointerSequence)
                this._modalPointerTarget = null;
        }
        return Clutter.EVENT_STOP;
    }

    _isAnyModalActive() {
        // Prefer Main.modalCount when the Shell exposes it; fall back
        // to counting modalDialogGroup children so older / patched
        // Shells still benefit from the rerouting.
        if (typeof Main.modalCount === 'number' && Main.modalCount > 0)
            return true;
        try {
            if (global.stage.get_grab_actor) {
                const grab = global.stage.get_grab_actor();
                if (grab && grab !== global.stage
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

    _pickKeyboardActorAt(x, y) {
        const target = this._stagePickActorAt(x, y);
        if (target && this._isKeyboardDescendant(target))
            return target;
        const keyboard = this._keyboardOrNull('_pickKeyboardActorAt');
        return keyboard ? this._findKeyboardActorAt(keyboard, x, y) : null;
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
        const children = actor.get_children ? actor.get_children() : [];
        for (let i = children.length - 1; i >= 0; i--) {
            const hit = this._findKeyboardActorAt(children[i], x, y);
            if (hit) return hit;
        }
        if (!actor.reactive) return null;
        if (!this._actorContainsStagePoint(actor, x, y)) return null;
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
        if (!actor) return false;
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
