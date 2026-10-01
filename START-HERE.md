# Presenter - start here

**You do NOT need Command Prompt or `node server.js` any more.**

1. Install the Presenter desktop app (`Presenter-Setup.exe` from the GitHub Releases page,
   see BUILD-APP-ON-GITHUB.md). Open it - the phone connection starts by itself.
2. Install the phone app (`PresenterRemote.apk`) on your Android phone.
3. Open Presenter Remote on the phone and either scan the QR code (PC: **Phone** button) or type the
   **connection PIN** shown there. Only the configured PIN lets a phone connect - there is no "Allow" shortcut.
   The phone remembers the PIN afterwards. The PIN can only be changed on the computer (Settings -> PINs, needs the change PIN).

iPhone: click **Phone** in the Presenter window on the PC and scan the QR code with the camera.

(Advanced: running `node server.js` works the same way; the PIN is shown in that window.)

## Workspaces (panel layouts)
The bar under the title lets you arrange the Control window like Premiere Pro:
- Drag a panel's title bar and drop it on another panel's **left/right edge** (new column) or its **top/bottom half** (stack).
- Drag the dividers to resize; double-click a title bar (or press `` ` `` over a panel) to maximize.
- **+ Save as...** stores the current layout under a name; **Export / Import** moves your workspaces to a file and back.
- Layouts are saved by the Presenter server (`workspace-config.json` in the app's data folder), so they survive a cache clear
  and are the same in every Control window. The phone remote shows the same workspace names and can **switch** between them;
  creating, changing and deleting workspaces is only possible on the computer.

## OBS with a transparent background
In OBS add a **Browser Source** with the URL `http://localhost:8787/live` (Presenter must be open on the same computer).
It is transparent and follows your slides, font, colour and transition settings - no Live window needed.
(Window Capture also works: set Settings -> Display background -> Transparent, then tick **Allow Transparency**
in OBS's Window Capture properties.)

## Connecting the phone (Android)
Open **Presenter Remote** -> tap **Scan QR code** -> point it at the QR code in Presenter (PC: **Phone** button).
It connects straight away (the QR code carries the PIN). The QR lists every network address of the PC, and the app
uses the one it can reach (home Wi-Fi, phone hotspot, Ethernet-to-router, ...).
