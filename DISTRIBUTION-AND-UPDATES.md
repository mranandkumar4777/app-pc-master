# Distributing Presenter Remote to other people, and how updates work

## The model: you control the master, they only get the finished app
- **Master** = this repo: the Kotlin/JS source, the Gradle project, everything. Nobody outside
  gets this — keep the repo Private (see the note on Public vs Private below, which only
  affects the update-checker, not this point).
- **Sub** = the finished `PresenterRemote.apk` (phone) and `Presenter-Setup.exe` / `.dmg` /
  `.AppImage` (computer) that GitHub builds for you. That is the only thing you hand to other
  people — a compiled, signed app with no source inside it. Phone builds are now also shrunk
  and obfuscated (`assembleRelease`, not `assembleDebug`) so a decompiled copy is much harder
  to make sense of. Worth being honest about: no Android app can be made 100% unreadable to
  someone determined enough — this raises the bar a lot, it doesn't make it impossible.
- Each phone app only ever does one thing: show the remote screen and click its Next/Prev
  (etc.) buttons for you. It has no path to anything else on the computer, and whoever owns a
  given computer has to tap **Allow** there the first time a phone connects to it — so the
  computer's owner always stays the one deciding who gets to control it. Nothing here needed
  changing for that to be true; it's how pairing already worked.

## Running two presenters with two remotes
Nothing extra to set up for this — it already works today:
- Each computer running Presenter is its own independent copy (its own pairing, its own PIN or
  Tailscale password).
- Install the same `PresenterRemote.apk` on each phone. The first time a phone connects to a
  computer it remembers that one and reconnects to it automatically after that.

So "Presenter A + Remote A" and "Presenter B + Remote B" just means: run Presenter on both
computers, and pair phone 1 with computer A and phone 2 with computer B once each.

If you'd rather each phone app be **hard-locked**, so it can never be pointed at the other
presenter even by someone typing a different address in — that's a bigger change (building a
separate, differently-branded app per site, using Gradle "flavors"). That wasn't built here
since the above already covers "two presenters, two remotes"; say the word if you want the
stricter locked version instead.

## The update checker
On launch, and whenever someone taps **⚙ (top-right of the remote screen) → Check for
updates**, the app fetches a small `version.json` file and compares it to its own version.
If it's newer, a dialog appears with **Update** (opens the download link in the browser) and
**✕ Later** (dismiss — it won't bring up that same version again on its own; a manual check
always reports back either way).

`version.json` looks like this, and the GitHub Action writes it for you automatically on every
push — you never edit it by hand:
```json
{
  "versionCode": 4,
  "versionName": "1.3",
  "url": "https://github.com/OWNER/REPO/releases/latest/download/PresenterRemote.apk",
  "notes": "Presenter Remote v1.3."
}
```
To publish an update: bump `versionCode` (always +1) and `versionName` in
`phone-app-android/app/build.gradle.kts`, commit, and push. Next time each phone opens the app
(or someone taps Check for updates), they'll see the notice.

### One thing to decide: Public or Private repo
The phone fetches `version.json` with no GitHub login, so GitHub only serves it anonymously if
the repo is **Public**. Two options:
1. **Make the repo Public.** Simplest — nothing else to do. The trade-off: anyone with the
   link can see the source code (the "Master" part of the model above no longer holds).
2. **Keep it Private, and add one small Public repo that holds only the built files.** A few
   extra one-time steps (create an empty public repo, create a GitHub access token, add it as
   a secret). Say the word and the extra workflow step can be added for this.

Until you pick one, the update checker just quietly finds nothing and does no harm —
everything else in the app works exactly the same either way.

## Setting it up (one-time)
In `phone-app-android/app/src/main/java/com/presenter/remote/MainActivity.kt`, find
`UPDATE_INFO_URL` near the top and replace `OWNER/REPO` with your actual GitHub
`username/repository` (the same one you used for the download link in
BUILD-APP-ON-GITHUB.md). Push — the next build publishes `version.json` next to
`PresenterRemote.apk` on the Releases page automatically.
