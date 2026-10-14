# Feature: updates (find, download and install new releases)

Fartcrobat checks GitHub for a newer release, tells the person with a notification in the bottom
right corner, downloads the update with a progress bar when they click Download, and installs it
when they restart (or the next time they quit). The current version is shown in Help > About
Fartcrobat and in Preferences > Updates.

Contracts: `src/shared/updates.ts` (status, phases, IPC channels), the event `updates:status` in
`src/shared/ipc.ts`, the preference `checkForUpdates`. Code: `src/features/updates/` (`main.ts` owns
the flow, `index.tsx` shows it).

## Decisions

### U1. What does the work

- [electron-updater](https://www.electron.build/auto-update) 6.8.10 (pairs with electron-builder
  26.15.3 through builder-util-runtime 9.7.0) downloads and installs, from the GitHub release's
  `latest.yml` / `latest-linux.yml` / `latest-mac.yml`, with sha512 checks and blockmap
  differential downloads. It is bundled into the main process like every other dependency.
- **Finding out** that a release exists does not use electron-updater: one request to
  `https://github.com/normiecore/Fartcrobat/releases/latest`, which redirects to
  `.../releases/tag/v<version>`. That works on every platform and install type (electron-updater
  is inactive for `.tar.gz` installs and unpackaged runs), needs no API token, and is not subject to
  the api.github.com limit of 60 requests an hour per IP address, which an office behind one
  address would reach. Requests go through Electron's `net`, so system proxy settings apply.
- Pre-releases and drafts are ignored (`releases/latest` skips them).

### U2. What each install type can do (`UpdateCapability`)

| Install | Capability | Why |
| --- | --- | --- |
| Windows (NSIS installer, per user or per machine) | install | Silent install (`/S`), then the app starts again. A per-machine install asks for administrator rights (UAC) when it installs. |
| Linux AppImage | install | The new AppImage replaces the old file. Only when this process runs from it and the person can write to its folder (see below); otherwise notify. |
| Linux .deb | notify | Installing needs root (`pkexec dpkg -i`, a password prompt), which is not silent; people with .deb installs usually update through their package tools. |
| Linux .tar.gz | notify | electron-updater cannot update it. |
| macOS | notify | Squirrel.Mac only installs updates signed with the same Developer ID as the running app; builds are ad-hoc signed today (backlog: code signing). Switch to install once releases are signed. |
| Unpackaged (`npm run dev`, tests) | notify | Nothing to install. Automatic checks are off unless a test turns them on. |

On 'notify', Download opens the release page in the browser.

AppImages, in detail:

- The AppImage runtime sets `APPIMAGE` (the file) and `APPDIR` (its temporary mount), and every
  program an AppImage starts inherits both: a .deb or .tar.gz Fartcrobat opened from an AppImage
  app (xdg-open), or started by an AI app shipped as an AppImage through the agent shim, would see
  that other app's file, and an update would delete it. So an install counts as an AppImage only
  when `process.execPath` is inside `APPDIR` (`src/main/util/appImage.ts`, shared with agent
  access and the default-app desktop entry).
- The update deletes the .AppImage file and moves the new one into its folder. In a folder the
  person cannot write to (an administrator put it in /opt), that fails, so it is 'notify' there.
  Should the installer still fail to start at Restart now, the app starts again rather than
  closing with no update.
- Release AppImages have no version in their file name (`Fartcrobat-x86_64.AppImage`,
  `electron-builder.yml` `appImage.artifactName`), so the update replaces the file in place. For a
  file whose name has a version in it, electron-updater names the new file after the new version
  and deletes the old one; the app then points the desktop entry it wrote as the default PDF app
  (`fartcrobat.desktop`, only when it starts the old file) and the agent shim's `app.json` at the
  new file, synchronously, before it exits.

### U3. The flow

- First automatic check 30 s after start-up, then every 6 hours while the app runs, when the
  preference and the machine policy allow it. Help > Check for Updates... checks at once.
- New version found: a card in the bottom right corner of every window: "Fartcrobat 0.2.0 is
  available. You have 0.1.0." Buttons: Download (primary), What's new (opens the release page),
  and a close button (hides it until the next start, or until a newer version turns up).
- Download: the card shows a progress bar, percentage and size ("52 of 115 MB") and Cancel. The
  download continues if the card is closed; the card comes back when it is ready. A download that
  was cancelled, even just as it finished, never installs when the app quits.
- Downloaded: "Fartcrobat 0.2.0 is ready to install. Restart to finish." Buttons: Restart now,
  Later. Later: the update installs silently the next time Fartcrobat quits.
- Restart now goes through the normal quit flow first: every window asks about its unsaved
  documents, and Cancel stops the restart (the update stays ready). Only once every window has
  closed does the installer run, so it never closes the app over unsaved work. Then the new
  version starts.
- Manual check: "Fartcrobat 0.1.0 is up to date." as a toast, or the card when there is an update.
  Automatic checks that fail stay silent; manual ones say "Couldn't check for updates. Check your
  internet connection and try again."
- Download failure: the card says so, with Try again and Download from GitHub.
- The card sits in the corner of the document area, or of the window when side panes leave the
  document area too narrow for it (a 720 px window with All tools and a right panel open). Screen
  readers hear each change through one live region that stays in place; when a button that
  changes the card had the focus, the focus moves on to the new view's main button (Cancel after
  Download, Download after Cancel, Later when a download finishes, Try again after a failure).

### U4. Turning it off

- Preferences > Updates: "Check for updates automatically" (default on), the current version,
  when it last checked, and Check Now.
- Machine policy (`src/main/policy.ts`, section `autoUpdate`): Windows REG_DWORD `AutoUpdate` under
  `HKLM\SOFTWARE\Policies\Fartcrobat` (0 off, 1 on), `policy.json`
  `{"autoUpdate":{"enabled":false}}` on macOS and Linux. Off (or unreadable) means no checks at all,
  manual ones included; the switch is read-only and Help > Check for Updates... says updates are
  managed by the organisation. On forces automatic checks on: the switch shows on and read-only,
  with a note (`UpdateStatus.checksForcedOn`), and Check Now still works.
- A check sends nothing but an HTTPS request for the releases page (GitHub sees the IP address and
  an Electron user agent). No identifiers, no telemetry. Downloading reads the release's update
  metadata with electron-updater, which would send a random ID it keeps per install
  (`x-user-staging-id`, for staged rollouts); the app sends the same all-zero ID from every install
  instead (`STAGING_ID` in `main/electronUpdater.ts`). The local `.updaterId` file is still made.
  This is the app's only network request apart from agent access (local) and links the person
  clicks.

### U5. Releases

- `electron-builder.yml` gets `publish: { provider: github, owner: normiecore, repo: Fartcrobat }` so
  builds write `resources/app-update.yml` and `release/latest*.yml`. The release workflow still
  builds with `--publish never`; its publish job uploads `latest.yml`, `latest-mac.yml`,
  `latest-linux.yml` and the `.blockmap` files with the installers, and fails if one is missing.
- v0.1.0 has no updater: people on it install the next version by hand once.
- A release written on GitHub first must be saved as a draft, not published, until the workflow
  has attached the installers: installed copies offer the latest published release at once, and
  would find no update metadata (or, while files are being replaced, metadata for files that are
  not there yet). The publish job refuses to add files to a published release.

## Testing

- Unit (vitest): version comparison and tag parsing, the state machine with a fake updater
  (check, download, cancel, error, dismiss, restart only after the quit flow approves, a failed
  installer starts the app again), capability detection per platform and install type (inherited
  `APPIMAGE`, read-only folders), policy readings for `autoUpdate`, and what the app sets on
  electron-updater with a stand-in for it (`main/electronUpdater.test.ts`: the staging ID, a late
  Cancel, an install that fails, the AppImage rename).
- End to end: `tests/e2e/updates.spec.ts` against an unpackaged build with
  `FARTCROBAT_UPDATE_URL` (a local server standing in for github.com) and `FARTCROBAT_FAKE_UPDATER`
  (a stand-in for electron-updater that reports progress and records the install call). Both work
  only in unpackaged builds, so the spec skips itself when `FARTCROBAT_EXECUTABLE` points at a
  packaged build. Every other spec runs with checks off (`launch` sets
  `FARTCROBAT_UPDATE_CHECKS=0`, the one test variable packaged builds honour, and only to turn
  automatic checks off, so runs against a packaged build ask github.com nothing either).
- Manual, before relying on it: publish 0.2.0 with this feature, then 0.2.1, and update a Windows
  per-user install, a Windows per-machine install and an AppImage from 0.2.0 to 0.2.1; check that a
  restart with unsaved changes asks first, and that the policy value hides everything.
