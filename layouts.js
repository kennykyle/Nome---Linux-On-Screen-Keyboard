/* Nome - Onscreen Keyboard layout data. */

export const KEY = {
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

export const MOD_TO_KEY = {
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
export const PREDICT_CHAR_TO_KEYCODE = {
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

export function k(label, shift, keycode, width, modifier) {
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
export function kSp(label, special, width) {
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

export const LAYOUTS = {
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

export const DEFAULT_LAYOUT_KEY = 'winOsk';

// Default key spacing (px) used when a layout doesn't override.  The
// active layout's spacing is always read via _layoutKeySpacing(); this
// constant is just the fallback for layouts without a `keySpacing`
// field, plus any code that needs a constant maximum (e.g., chrome
// calculations).
export const KEY_SPACING = 3;
// Maximum keySpacing ANY layout might use.  Used by chrome budget
// calculations that need a worst-case ceiling so layouts with the
// largest gaps still get a correctly-sized vertical key area.
export const MAX_KEY_SPACING = 6;
export function _layoutKeySpacing(layoutKey) {
    const v = LAYOUTS[layoutKey] && LAYOUTS[layoutKey].keySpacing;
    return (typeof v === 'number' && v > 0) ? v : KEY_SPACING;
}
