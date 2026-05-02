/* Nome - Onscreen Keyboard RGB effect policy. */

import { KEY_SPACING } from './layouts.js';

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
export const RGB_BREATH_PERIOD_MS = 3500;
export const RGB_REACTIVE_FADE_MS = 900;
// Cycle period: time for one full hue rotation (rainbow / cycle).
// Wave is shorter because its diagonal bands read best as a faster
// sweep across the keyboard.
export const RGB_RAINBOW_PERIOD_MS = 24000;
export const RGB_WAVE_PERIOD_MS = 12000;
// Row-canvas halo architecture.  Hue modes sample exact time-based hues
// at a fixed frame rate instead of running continuous Clutter
// transitions; fixed modes use the same geometry without hue cycling.
// This intentionally avoids forcing Mutter to repaint at the monitor
// refresh rate just for RGB lighting.
export const RGB_SHADOW_CYCLE_STEPS = 30;
export const RGB_LOW_POWER_FPS = 14;
export const RGB_LOW_POWER_INTERVAL_MS = Math.round(1000 / RGB_LOW_POWER_FPS);
export const RGB_MIN_FRAME_INTERVAL_MS = 16;
export const RGB_CANVAS_LAYERS = 1;
export const RGB_CANVAS_MIN_GLOW_BLEED = 7;
export const RGB_CANVAS_MAX_GLOW_BLEED = 56;
export const RGB_CANVAS_CORE_ALPHA = 0.36;
export const RGB_CANVAS_OUTER_ALPHA = 0.19;
export const RGB_GLOW_SIZE_MAX = 160;
export const RGB_SPREAD_SIZE_MAX = 14;
export const RGB_CSS_MAX_GLOW_SIZE = 120;
export const RGB_CSS_MAX_SPREAD = 8;
export function _haloBlendFeather(bleed, spacing = KEY_SPACING, blendPct = 65) {
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
export const RGB_PULSE_PERIOD_MS = 1200;
// Breathing modulates each OSKKey's `opacity` between these values
// (0-255 Clutter scale).  Floor at ~70% keeps key labels readable.
export const RGB_BREATH_OPACITY_MIN = 180;
export const RGB_BREATH_OPACITY_MAX = 255;
// Base alpha multiplier for the CSS shadow.  1.0 maps the intensity
// slider linearly: slider 100% = full alpha, 0% = transparent.
export const RGB_SHADOW_ALPHA_COLOR = 1.0;
// colorRing: thin sharp colored band right at the key edge, used by
// every colored mode.  Bleed is read live from rgbBorderSize so the
// "Border size" slider takes effect on the next install / resize.
export const RGB_COLOR_RING_OPACITY = 240;
