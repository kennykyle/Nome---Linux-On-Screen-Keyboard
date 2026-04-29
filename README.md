# Nome - Onscreen Keyboard

Nome is a mouse-driven virtual on-screen keyboard for GNOME Shell 50 on Wayland. It runs inside GNOME Shell instead of as a normal app, which lets it stay above other windows, avoid stealing focus from the text field you are typing into, and send real keyboard events through Mutter's virtual input device. It is built for accessibility-first desktop use: mouse, touch, limited-movement workflows, terminals, login prompts, and any situation where GNOME's built-in keyboard is not enough.

## Why This Exists

I have SMA type 2. I always wanted to move to Linux, but accessibility was pretty poor for me on every distro I tried. Now I am finally able to use Linux thanks to AI and its power to help with coding. For some people this might be called "AI slop", but for me, and hopefully for others, it is freedom and the ability to use one of the best operating systems out there. I did my best with what I know and have, and this software is working perfectly for my needs. Nome is made from my imagination, shaped around what I personally need, and shared so others can expand it, help improve it, and see how far we can push accessibility on Linux together. This is only one accessibility tool out of many that i want to make. More are coming. Thank you!

## Very Simple Instructions

1. Download the release zip.
2. Extract it.
3. Make sure to right click the file > properties > check run as a program. Double-click `Install Nome - Onscreen Keyboard.sh`. 
4. Follow the prompts.
5. Log out and log back in.
6. Click the keyboard icon in your app menu.

The easy installer keeps learned words and UI settings when reinstalling. It also asks whether you want GDM/login-screen support. That part is optional, requires administrator authentication, and can be skipped safely.

If double-clicking is blocked, open a terminal in the extracted folder and run:

```sh
bash "./Install Nome - Onscreen Keyboard.sh"
```

## Features

### Core Keyboard

- Runs as a GNOME Shell extension, not a separate app window.
- Stays above normal application windows.
- Uses GNOME Shell chrome/top-chrome layers so it can remain available where normal Wayland apps cannot.
- Includes modal-aware input handling so it can stay usable around Shell authentication prompts and modal dialogs.
- Does not steal focus when you click a key.
- Sends real key events through Mutter's virtual keyboard device.
- Works with normal apps and terminals.
- Supports mouse and touch input.
- Floating keyboard window with title bar.
- Drag to move the keyboard.
- Resize from the bottom-right grip.
- Automatically keeps the keyboard inside the primary work area.
- Can snap to the top, middle, or bottom of the screen.
- Can lock the keyboard position to prevent accidental dragging.
- Can be minimized without disabling the extension.
- Can be closed to disable the extension.
- Optional automatic show on login.
- Panel indicator for quick access.
- Left-click the panel icon to show or hide the keyboard.
- Right-click the panel icon to open the options menu.
- Optional hover-to-open panel menu for users who find right-clicking difficult.

### Layouts

- Windows OSK layout, used by default.
- Full desktop layout with function keys.
- Compact layout without the extra navigation column.
- Laptop layout with function keys in a narrower arrangement.
- Mobile / Touch layout for smaller, touch-first use.
- Layout choice is saved across sessions.

### Typing Behavior

- Sticky modifier support for Shift, Ctrl, Alt, and Super/Meta.
- Right-click a modifier to cycle through off, armed, and locked states.
- Armed modifiers are consumed after the next keypress.
- Locked modifiers stay active until turned off.
- Left-clicking a modifier can send the modifier key itself.
- Supports chords such as Ctrl+Alt+T, Ctrl+Shift etc combinations.
- Shifted key labels update when Shift is active.
- Hold-to-repeat support.
- Key repeat modes: Off, Slow, Normal, and Fast.
- Fade button cycles keyboard opacity.

### Word Prediction

- Optional local word prediction.
- Prediction is off by default.
- No cloud service is required for prediction.
- Learns user words locally.
- Learns personal word pairs and phrases through bigrams.
- Uses a frequency-sorted English base dictionary when installed.
- Uses seed bigrams for next-word suggestions.
- User-learned phrases are weighted above seeded phrases.
- Suggestion bar grows from 3 to 6 slots depending on keyboard width.
- Clicking a suggestion types the missing part of the word plus a trailing space.
- Suggestion casing follows what you typed, including capitalized and uppercase words.
- Backspace updates the current prediction buffer.
- Space, Enter, Tab, and punctuation commit learned words.
- Prediction state clears after idle time so stale suggestions do not linger.
- Learned words and phrase data are stored under `${XDG_DATA_HOME:-~/.local/share}/gnome-osk/`.
- Menu item to download or re-download prediction data.
- Menu status shows whether words and bigrams are installed.
- Menu item to clear learned words without removing the base dictionary.
- Prediction is skipped in GDM and unlock-dialog modes for privacy and lighter login-screen behavior.

### Appearance And Customization - RICE UP!

- Built-in themes: Dark, Light, Dracula, Nord, and Cyberpunk.
- Custom themes can be created by editing a built-in theme.
- Custom themes can be selected, renamed, and deleted.
- Per-element color customization.
- Color groups include Keyboard, Title bar, Keys, Prediction bar, and Misc.
- Inline color picker with hue and saturation/value controls.
- Manual hex color entry.
- Reset individual colors to theme defaults.
- Reset all colors.
- Reset all customization.
- Optional custom keyboard background image.
- Background image picker through xdg-desktop-portal when available.
- Fallback background picker support through `zenity` or `kdialog`.
- Manual background path entry.
- Background fit modes: cover, contain, and stretch.
- Background position X/Y sliders.
- Background image scale slider.
- Top bar opacity control.
- Prediction bar opacity control.
- Key opacity control.
- Text opacity control.
- Bold or normal key text.
- Key text size slider.
- Show or hide the OSK title text.
- Live preview while customizing.
- Floating customization window.
- Customization window can be moved and resized.
- Settings are saved to local config and restored on the next session.

### RGB Lighting

- RGB lighting can be turned off completely.
- Static RGB mode.
- Gradient RGB mode.
- Breathing RGB mode.
- Reactive RGB mode on keypress.
- Rainbow RGB mode.
- Cycle RGB mode.
- Wave RGB mode.
- Pulse RGB mode.
- RGB glow color picker.
- RGB color presets: Magenta, Cyan, Red, Green, Blue, Yellow, and White.
- RGB intensity slider.
- Optional RGB-colored key text for supported modes.
- Advanced RGB controls for border size, glow size, glow density, halo softness, halo coverage, corner blend, and speed.
- Advanced RGB settings are saved per mode.
- Low-power row-canvas glow rendering to avoid heavy compositor work.
- RGB effects pause or avoid unnecessary work when the keyboard is hidden.

### Login Screen And System Integration

- Optional GDM login-screen support.
- Optional unlock-dialog support through GNOME session modes.
- Auto-shows in GDM and unlock-dialog modes.
- Skips the panel indicator in authentication modes where the top bar is not the right interaction surface.
- Installer can copy the extension to the system GNOME Shell extension path for GDM.
- Installer can update GDM dconf settings.
- GDM restore command removes login-screen integration.
- Normal user install and GDM install are separate so users can skip system-level changes.
- Installer does not restart GDM automatically because that would end graphical sessions.

### Installers And Maintenance

- Easy double-click installer for release zip users.
- Easy double-click uninstaller.
- Easy scripts keep the terminal window open at the end so users can read success or failure messages.
- Terminal installer for manual use.
- Clean reinstall by default.
- `--keep-data` option preserves learned words and UI settings.
- Optional GDM prompt during install.
- Environment diagnostic command with `./install.sh check`.
- Installer can fetch English wordlist data.
- Installer can fetch and sort seed bigrams.
- Falls back to bundled seed bigrams if downloads fail.
- Creates an app-grid launcher.
- Enables the extension through `gnome-extensions`.
- Prompts to log out after install because GNOME Shell on Wayland cannot hot-load a newly installed extension.
- Logout prompt supports terminal input and GUI dialog fallbacks when available.
- Maintainer release script builds a zip or tarball.

## Requirements

### Required

- GNOME Shell 50.
- A Wayland GNOME session.
- Bash.
- `gnome-extensions` command-line tool.
- Standard GNOME Shell libraries available in GNOME 50.

The extension declares `"shell-version": ["50"]` in `metadata.json`. Other GNOME Shell versions may refuse to load it.

### Recommended

- `curl` or `wget` for downloading prediction data.
- `gsettings` for extension enable/disable cleanup.
- `update-desktop-database` for refreshing the app launcher database.
- Log out and log back in after install or update.

### Optional

- `sudo` or `pkexec` for GDM/login-screen installation.
- `dconf` for GDM dconf updates.
- `xdg-desktop-portal` for the native background image picker.
- `zenity` or `kdialog` as file picker fallbacks.
- `gnome-session-quit` or `loginctl` for the installer's optional logout prompt.
- `zip` if you want to build a release archive with `make-release.sh`.

## Manual Install

Run this from the project folder:

```sh
./install.sh
```

The installer copies the extension to:

```text
~/.local/share/gnome-shell/extensions/gnome-osk@linuxosk.github.io
```

Then log out and log back in. GNOME Shell on Wayland cannot load newly installed extension code until the Shell process restarts.

To reinstall while keeping learned words and UI settings:

```sh
./install.sh --keep-data
```

To install and also ask about GDM/login-screen support:

```sh
./install.sh --keep-data --ask-gdm
```

To run diagnostics:

```sh
./install.sh check
```

## Enable, Disable, And Launch

To enable the extension manually:

```sh
gnome-extensions enable gnome-osk@linuxosk.github.io
```

To disable it temporarily:

```sh
gnome-extensions disable gnome-osk@linuxosk.github.io
```

To toggle the keyboard from a script or launcher after the extension is loaded:

```sh
gdbus call --session --dest org.gnome.Shell --object-path /io/linuxosk/OSK --method io.linuxosk.OSK.Toggle
```

The installed app launcher uses that same D-Bus toggle method.

## GDM Login Screen

Login-screen support is separate because GDM runs its own GNOME Shell process and uses system extension paths.

To install GDM support:

```sh
sudo ./install.sh gdm-install
```

To remove GDM support:

```sh
sudo ./install.sh gdm-restore
```

Reboot to see the keyboard on the login screen. You can also restart GDM, but this immediately ends graphical login sessions, so save work first:

```sh
sudo systemctl restart gdm
```

## Updating

Updating is the same as installing again.

For most users:

```sh
./install.sh --keep-data
```

If you previously installed GDM/login-screen support, update that copy too:

```sh
sudo ./install.sh gdm-install
```

Log out and log back in after updating.

## Uninstall

For the easy release zip method, double-click:

```text
Uninstall Nome - Onscreen Keyboard.sh
```

Or run:

```sh
./uninstall.sh
```

By default, uninstall removes the extension files, app launcher, GNOME extension settings, downloaded prediction data, learned words, and UI config.

To remove the extension but keep learned words and UI settings:

```sh
./uninstall.sh --keep-data
```

If you installed GDM support, remove it separately:

```sh
sudo ./install.sh gdm-restore
```

## Prediction Data

Prediction is local. User data is stored under:

```text
${XDG_DATA_HOME:-~/.local/share}/gnome-osk/
```

The installer and extension menu can download:

- A frequency-sorted English word list from `hermitdave/FrequencyWords`.
- Seed bigrams from Peter Norvig's `count_2w.txt`.

If downloads fail, the keyboard still works. Prediction can still learn from typed words, and prediction data can be downloaded later from the panel menu.

## Repository Layout

```text
extension.js                         GNOME Shell extension entry point and keyboard UI
predictor.js                         Local word-prediction engine
stylesheet.css                       Minimal fallback Shell CSS
metadata.json                        GNOME Shell extension metadata
install.sh                           Per-user installer plus GDM helper commands
uninstall.sh                         Per-user uninstaller
Install Nome - Onscreen Keyboard.sh  Easy double-click installer
Uninstall Nome - Onscreen Keyboard.sh Easy double-click uninstaller
README-FIRST.txt                     Short instructions for release zip users
make-release.sh                      Builds the GitHub release archive under dist/
nome-onscreen-keyboard.desktop       App-grid launcher
seed-bigrams.txt                     Bundled fallback bigram list
```

## Build A Release Archive

For maintainers:

```sh
bash ./make-release.sh
```

Useful checks before publishing:

```sh
./install.sh check
bash -n install.sh
bash -n uninstall.sh
bash -n "./Install Nome - Onscreen Keyboard.sh"
bash -n "./Uninstall Nome - Onscreen Keyboard.sh"
bash -n make-release.sh
```

For JavaScript validation, run the extension under GNOME Shell or use a GJS-compatible parser. Node.js cannot execute GNOME Shell imports such as `gi://Clutter` or `resource:///...`.

## To Do List

1. Click/press custom key sounds.
2. Macros.
3. Custom fonts.
4. KDE Plasma support.
5. Add debugging tool and log inspection.
6. Improve Customization Window UI.
7. New update notification. No auto update for security purposes.

## Contributing

This project exists because accessibility matters. If Nome helps you, if it almost helps you, or if you know how to make it better, contributions are welcome. Good improvements include new layouts, safer installers, better prediction data handling, accessibility testing, bug fixes, GNOME version compatibility work, documentation, themes, and ideas from people who actually depend on tools like this every day.

## License

Add a license file before publishing if this repository is intended for public reuse.
