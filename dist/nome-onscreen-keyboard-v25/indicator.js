/* Nome - Onscreen Keyboard panel indicator. */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const OSKIndicator = GObject.registerClass(
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
