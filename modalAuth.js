/* Nome - Onscreen Keyboard modal/auth policy helpers. */

import Clutter from 'gi://Clutter';

export const OSK_MODAL_HOVER_THROTTLE_US = 33000;

export function isAuthSessionModeName(mode, sessionMode = null) {
    if (mode === 'unlock-dialog' || mode === 'gdm')
        return true;
    try {
        if (sessionMode && (sessionMode.isGreeter || sessionMode.isLocked))
            return true;
        return !!(sessionMode
            && sessionMode.hasMode
            && sessionMode.hasMode('unlock-dialog')
            && mode === 'unlock-dialog');
    } catch (_e) {
        return false;
    }
}

export function isPointerLikeEventType(type) {
    return type === Clutter.EventType.BUTTON_PRESS
        || type === Clutter.EventType.BUTTON_RELEASE
        || type === Clutter.EventType.MOTION
        || type === Clutter.EventType.ENTER
        || type === Clutter.EventType.LEAVE
        || type === Clutter.EventType.SCROLL
        || type === Clutter.EventType.TOUCH_BEGIN
        || type === Clutter.EventType.TOUCH_END
        || type === Clutter.EventType.TOUCH_UPDATE
        || type === Clutter.EventType.TOUCH_CANCEL;
}

export function isPointerTrackingOnlyEventType(type) {
    return type === Clutter.EventType.MOTION
        || type === Clutter.EventType.ENTER
        || type === Clutter.EventType.LEAVE
        || type === Clutter.EventType.TOUCH_UPDATE;
}
