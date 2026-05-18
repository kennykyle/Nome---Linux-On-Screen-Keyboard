import Cogl from 'gi://Cogl';

const RGB_GLOW_SIZE_MAX = 160;
const RGB_SPREAD_SIZE_MAX = 14;
const KEYBOARD_PADDING_TOP = 8;
const KEYBOARD_PADDING_BOTTOM = 4;

function _clampNumber(value, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(max, value));
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

export const THEMES = {
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

export const DEFAULT_THEME_ID = 'dark';
export const CONFIG_VERSION = 2;

// Customization record: user overrides on top of the active theme.
// Loaded from config.json, persisted on every change.  Each field is
// independently optional; the keyboard tolerates extra / missing keys
// so older configs from pre-customization builds don't crash on load.
export const DEFAULT_CUSTOMIZATION = {
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

export const THEME_OPTION_KEYS = [
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
export const CUSTOM_COLOR_SPECS = [
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

export const RGB_MODES = [
    'off', 'static', 'gradient', 'breathing',
    'rainbow', 'cycle', 'wave', 'pulse', 'reactive',
];

export const RGB_MODE_SETTING_LIMITS = {
    rgbBorderSize: [0.1, 20, 1],
    rgbGlowSize: [1, RGB_GLOW_SIZE_MAX, 84],
    rgbBlurAmount: [0, RGB_SPREAD_SIZE_MAX, 4],
    rgbSpeed: [25, 300, 100],
    rgbHaloSoftness: [0, 100, 75],
    rgbHaloCoverage: [0, 100, 65],
    rgbCornerBlend: [0, 100, 65],
};

export function _isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function _clonePlainObject(value) {
    if (!_isPlainObject(value)) return {};
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_e) { return {}; }
}

function _validHexOr(value, fallback) {
    return _parseHex(value) ? String(value) : fallback;
}

function _numberInRange(value, min, max, fallback, integer = true) {
    const n = Number(value);
    if (!isFinite(n)) return fallback;
    const clamped = Math.max(min, Math.min(max, n));
    return integer ? Math.round(clamped) : clamped;
}

function _sanitizeRgbModeSettings(settings) {
    if (!_isPlainObject(settings)) return {};
    const out = {};
    for (const [mode, values] of Object.entries(settings)) {
        if (!RGB_MODES.includes(mode) || !_isPlainObject(values)) continue;
        const clean = {};
        for (const [key, limits] of Object.entries(RGB_MODE_SETTING_LIMITS)) {
            if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
            const [min, max, fallback] = limits;
            clean[key] = _numberInRange(
                values[key], min, max, fallback, key !== 'rgbBorderSize');
        }
        if (Object.keys(clean).length > 0) out[mode] = clean;
    }
    return out;
}

function _sanitizeCustomColors(colors) {
    if (!_isPlainObject(colors)) return {};
    const allowed = new Set(CUSTOM_COLOR_SPECS.map(spec => spec[1]));
    const out = {};
    for (const [path, hex] of Object.entries(colors)) {
        if (!allowed.has(path) || !_parseHex(hex)) continue;
        out[path] = String(hex);
    }
    return out;
}

export function _sanitizeUserThemes(themes) {
    if (!_isPlainObject(themes)) return {};
    const allowedColorPaths = CUSTOM_COLOR_SPECS.map(spec => spec[1]);
    const out = {};
    for (const [id, theme] of Object.entries(themes)) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) continue;
        if (!_isPlainObject(theme)) continue;
        const basedOn = THEMES[theme.based_on] ? theme.based_on : DEFAULT_THEME_ID;
        const base = _cloneTheme(THEMES[basedOn] || THEMES[DEFAULT_THEME_ID]);
        base.label = String(theme.label || id).slice(0, 80);
        base.based_on = basedOn;
        for (const path of allowedColorPaths) {
            const parts = path.split('.');
            const group = parts[0];
            const key = parts[1];
            if (_isPlainObject(theme[group]) && _parseHex(theme[group][key])) {
                base[group] = base[group] || {};
                base[group][key] = String(theme[group][key]);
            }
        }
        base.options = _sanitizeCustomization(theme.options || {}, {}, {
            allowUnknownTheme: true,
        });
        out[id] = base;
    }
    return out;
}

export function _sanitizeCustomization(custom, userThemes = {}, opts = {}) {
    const src = _isPlainObject(custom) ? custom : {};
    const out = Object.assign({}, DEFAULT_CUSTOMIZATION);

    const themeId = typeof src.themeId === 'string' ? src.themeId : out.themeId;
    out.themeId = (opts.allowUnknownTheme || THEMES[themeId] || userThemes[themeId])
        ? themeId : DEFAULT_THEME_ID;
    out.customBackground = src.customBackground
        ? String(src.customBackground).slice(0, 4096) : null;
    out.backgroundFit = ['cover', 'contain', 'stretch'].includes(src.backgroundFit)
        ? src.backgroundFit : out.backgroundFit;
    out.backgroundPositionX = _numberInRange(
        src.backgroundPositionX, 0, 100, out.backgroundPositionX);
    out.backgroundPositionY = _numberInRange(
        src.backgroundPositionY, 0, 100, out.backgroundPositionY);
    out.backgroundScale = _numberInRange(
        src.backgroundScale, 40, 250, out.backgroundScale);
    out.topBarOpacity = _numberInRange(
        src.topBarOpacity, 0, 100, out.topBarOpacity);
    out.showOskTitle = src.showOskTitle !== false;
    out.predictionButtonOpacity = _numberInRange(
        src.predictionButtonOpacity, 0, 100, out.predictionButtonOpacity);
    out.keyOpacity = _numberInRange(src.keyOpacity, 0, 100, out.keyOpacity);
    out.textBold = src.textBold !== false;
    out.textOpacity = _numberInRange(src.textOpacity, 0, 100, out.textOpacity);
    out.keyTextSize = _numberInRange(src.keyTextSize, 10, 28, out.keyTextSize);
    out.customColors = _sanitizeCustomColors(src.customColors);
    out.rgbMode = RGB_MODES.includes(src.rgbMode) ? src.rgbMode : out.rgbMode;
    out.rgbColor = _validHexOr(src.rgbColor, out.rgbColor);
    out.rgbIntensity = _numberInRange(
        src.rgbIntensity, 0, 100, out.rgbIntensity);
    out.rgbCycleLabels = src.rgbCycleLabels !== false;
    for (const [key, limits] of Object.entries(RGB_MODE_SETTING_LIMITS)) {
        const [min, max, fallback] = limits;
        out[key] = _numberInRange(
            src[key], min, max, fallback, key !== 'rgbBorderSize');
    }
    out.rgbModeSettings = _sanitizeRgbModeSettings(src.rgbModeSettings);
    return out;
}


// hex (#rrggbb or #rrggbbaa) -> {r, g, b, a(0-1)}.  Returns null for
// malformed input so callers can choose a fallback rather than crash.
export function _parseHex(hex) {
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

// Parse the color strings this extension feeds into Clutter.Text:
// custom theme colors are hex, while opacity-aware buildStyles()
// returns rgba(...).  Returning null keeps bad user config harmless.
export function _parseCssColor(color) {
    const hex = _parseHex(color);
    if (hex) return hex;
    if (typeof color !== 'string') return null;
    const s = color.trim().toLowerCase();
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

    const m = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+%?))?\s*\)$/);
    if (!m) return null;

    const r = Math.round(parseFloat(m[1]));
    const g = Math.round(parseFloat(m[2]));
    const b = Math.round(parseFloat(m[3]));
    if ([r, g, b].some(v => isNaN(v))) return null;

    let a = 1;
    if (m[4] !== undefined) {
        const raw = m[4];
        a = raw.endsWith('%')
            ? parseFloat(raw.slice(0, -1)) / 100
            : parseFloat(raw);
        if (isNaN(a)) return null;
    }

    return {
        r: _clampNumber(r, 0, 255),
        g: _clampNumber(g, 0, 255),
        b: _clampNumber(b, 0, 255),
        a: _clampNumber(a, 0, 1),
    };
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
export function _rgbToHsv(r, g, b) {
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
export function _hsvToHex(h, s, v) {
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
export function _hslToHex(h, s, l) {
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
export function _coglColor(r, g, b, a) {
    return new Cogl.Color({
        red: r | 0,
        green: g | 0,
        blue: b | 0,
        alpha: (a === undefined) ? 255 : (a | 0),
    });
}

// Cogl.Color from a CSS color string with optional 0-255 alpha override.
// Falls back to fully transparent on a parse failure so a typo in the
// user's saved color never crashes the render path.
export function _coglColorFromHex(hex, alpha) {
    const c = _parseCssColor(hex);
    if (!c) return _coglColor(0, 0, 0, 0);
    return _coglColor(
        c.r, c.g, c.b,
        alpha === undefined ? Math.round(c.a * 255) : alpha);
}

// Cogl.Color for an HSL hue at fixed saturation 1.0 / lightness 0.55,
// the same values used by the legacy rainbow CSS path so the new
// transition-based rainbow looks identical.  Used by the rainbow /
// cycle / wave keyframe transitions.
export function _coglColorFromHue(hue, alpha) {
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
export function _rgbChannelsFromHex(hex) {
    const c = _parseHex(hex);
    return c ? { r: c.r, g: c.g, b: c.b } : { r: 255, g: 0, b: 255 };
}

// REACTIVE press shadow: a single CSS shadow on a short-lived overlay.
// The caller passes already-capped blur and spread values so a saved
// extreme slider setting cannot create giant per-key shadows while
// typing.
export function _reactiveShadowStyle(r, g, b, alpha, blurPx, spreadPx) {
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
export function _cloneTheme(theme) {
    return JSON.parse(JSON.stringify(theme));
}

// Resolve a theme id to its definition, preferring user themes over
// built-in ones so a user can shadow a built-in id if they want (we
// don't actively prevent name collisions -- the UI picks unique ids
// by default).  Returns null when neither source has the id; callers
// fall back to the default theme.
export function _lookupTheme(id, userThemes) {
    if (userThemes && userThemes[id]) return userThemes[id];
    if (THEMES[id]) return THEMES[id];
    return null;
}

// True iff `id` is one of the shipped, immutable built-in themes.
// Used by the Customize window to decide whether to fork or edit
// in-place when the user changes a color.
export function _isBuiltInTheme(id) {
    return !!THEMES[id];
}


// Apply the user's per-element color overrides on top of a theme.
// Returns a fresh theme object -- the input theme is never mutated.
// Unknown paths in `custom.customColors` are silently ignored (so a
// stale config key from a newer build doesn't break the theme).  The
// single-level customColors dict also treats the deprecated
// `keyboardBg` field as a synonym for `customColors['keyboard.bg']`
// to preserve configs written by earlier builds.
export function _mergeCustomColors(theme, custom) {
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
export function buildStyles(theme, custom) {
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
