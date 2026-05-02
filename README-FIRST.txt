Nome - Onscreen Keyboard - Easy Install
=======================================

1. Extract this zip file.
2. Double-click "Install Nome - Onscreen Keyboard.sh".
3. If your desktop asks, choose "Allow Launching", "Trust and Launch",
   or "Run".
4. Follow the prompts.

The installer downloads the full English prediction vocabulary when
network access is available. If that download fails, install still
continues and you can retry from the keyboard menu later.

The installer will ask whether to add GDM/login-screen support too.
That part is optional, needs administrator authentication, and can be
skipped safely. You can add it later with:

    sudo ./install.sh gdm-install

Updating is the same as installing again. If you previously installed
GDM/login-screen support, the installer detects and updates the
login-screen/system copy too.

If GNOME shows errors, crashes, or sends you back to the login screen,
open "Nome - Error Logs" from the app grid after logging back in. It
opens a terminal, saves a related error/crash journal snapshot under
~/.local/state/gnome-osk/, and keeps the terminal open so you can read it.

At the end, the installer asks whether to log out now. Logging out and
back in is required because GNOME Shell on Wayland cannot hot-load a
newly installed extension.

If double-clicking is blocked by your file manager, or if a terminal
opens and closes immediately, open a terminal in this folder and run:

    bash "./Install Nome - Onscreen Keyboard.sh"

To uninstall, double-click "Uninstall Nome - Onscreen Keyboard.sh", or run:

    bash "./Uninstall Nome - Onscreen Keyboard.sh"
