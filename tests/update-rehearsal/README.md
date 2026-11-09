# Update rehearsal

A released version of the app, installed for real from each kind of download, finds the next
version and updates to it without anything being published: the Windows installer and the Linux
AppImage install a build of the next version, the Mac app and the Ubuntu `.deb` send the person to
its release page, and the next version's `.deb` then installs over the old one. Every release runs
it before publishing (`.github/workflows/release.yml`): the in-app updater
(`docs/features/updates.md`) of the version people have installed is what has to work, and it can
only be tried with a newer release.

## Two names

The app was called Fartcrobat up to 0.3 and is called Inkmoor from 0.4.0 on
(`docs/features/rename.md`, `src/shared/identity.ts`). The rehearsal for 0.4.0 installs 0.3.x,
released as Fartcrobat, and updates it to an Inkmoor build, so each side gets its names from its
version: `names.mjs` (`productFor(version)`; the workflow and `linux.sh` run it as
`node names.mjs <version> <field>`). Which side a check is about decides the name it uses:

- **The old version, before the update**: its release files (`Fartcrobat-Setup-0.3.0-x64.exe`,
  `Fartcrobat-0.3.0-arm64.dmg`, `fartcrobat_0.3.0_amd64.deb`, `Fartcrobat-x86_64.AppImage`), its
  window global (`window.__fartcrobat`), its executables and its update card, which names itself:
  "Fartcrobat 0.4.0 is available." / "... is ready to install.".
- **The new version, after the update**: `Inkmoor.exe` (in the install folder the old version had,
  whose path keeps the old name), `/opt/Inkmoor/inkmoor` and its AppArmor profile
  `/etc/apparmor.d/inkmoor` (electron-builder names the profile after the executable), and its own
  window global and texts. An AppImage is replaced in place and keeps its file name
  (`Fartcrobat-x86_64.AppImage`).
- **Kept from the old version** (checked after the update): one Programs and Features entry (the
  same NSIS GUID key, now named Inkmoor) at the same install location; the userData folder
  (`%APPDATA%\Fartcrobat`, `~/.config/Fartcrobat`); one `.deb` package, still called `fartcrobat`;
  the GitHub repository, which the fake GitHub serves. A machine policy
  written for the old version (`HKLM\SOFTWARE\Policies\Fartcrobat`, `/etc/fartcrobat/policy.json`)
  still applies to the new one.

A build of this checkout is always called Inkmoor, so the version it gets must be 0.4.0 or later:
without `--new` / `new`, the rehearsal goes to the next patch version, or to 0.4.0 when that would
still be a Fartcrobat version (from 0.3.0, it rehearses 0.3.0 -> 0.4.0), and the workflow and
`linux.sh` stop at once when given a version whose name the build would not have
(`node names.mjs check-build <new>`). The names the old version had before the rename stay in
`names.mjs` for as long as installs of 0.3 may be updated.

## The repository rename

The repository was `normiecore/Fartcrobat` up to 0.4.0 and is `normiecore/Inkmoor` from 0.4.1
(`docs/features/rename.md`). Versions up to 0.4.0 ask the old name; GitHub redirects it to the new
one, which those versions refuse, so they cannot find 0.4.1 or later. `names.mjs` knows which
repository each version asks (`releaseRepo`), the fake GitHub answers the old name with that
redirect, and a rehearsal whose old version asks another repository than the new one is published
in stops before installing anything (`node names.mjs same-repo <old> <new>`; the workflow writes a
note in its summary and skips its jobs, `linux.sh` exits 2). The first rehearsal that runs again
is 0.4.1 to 0.4.2.

## How it works

- `fake-github.mjs` is an HTTP proxy that answers HTTPS for `github.com` and GitHub's release asset
  host itself, as GitHub does: the `/releases/latest` redirect and its JSON form, `releases.atom`,
  `latest*.yml`, and the installers with byte ranges (differential downloads). Every other host is
  refused and logged, so a rehearsal never reaches the internet.
- A packaged app ignores the `INKMOOR_UPDATE_*` (before 0.4: `FARTCROBAT_UPDATE_*`) test variables and always asks
  `github.com`, so the app is pointed at the proxy instead: the `https_proxy` variable for the
  AppImage (the update's restart inherits it), `--proxy-server` everywhere else.
- `make-certs.mjs` makes a test CA and a certificate for those two hosts. On Linux the CA is trusted
  in the user's NSS database only; the Windows and Mac jobs trust it machine-wide on their
  throwaway runners.
- The old version is the released file from GitHub, byte for byte, installed the way people install
  it, and started with Chromium's sandbox on. The new one is built from the checkout with only the
  version changed, or (Linux, `--new-dir`) any folder with an AppImage and its `latest-linux.yml`,
  such as the files of a release that is not published yet.
- The `.deb` job turns on the AppArmor limit on user namespaces that Ubuntu 24.04 desktops have
  (GitHub's image turns it off), so the sandbox works only through the AppArmor profile the `.deb`
  installs. After the old version's notice it builds the new `.deb`, installs it with
  `apt install` over the old one, checks there is one package (`fartcrobat`, the new version), that
  the app moved to the new name's folder and has its AppArmor profile, and starts it with the
  sandbox (`deb-upgrade.spec.ts`). For comparison it starts the released AppImage under the same
  limit and writes whether it stayed up into the job summary.

## Scenarios

| | Linux AppImage (`appimage.spec.ts`) | Windows installer (`windows.spec.ts`) | Mac `.dmg`, Ubuntu `.deb` (`notify.spec.ts`, `deb-upgrade.spec.ts`) |
| --- | --- | --- | --- |
| Restart now: asks about unsaved changes first, then installs and starts the new version | yes | per user, per machine | |
| Later: installs when the app quits, does not start again | yes | per user | |
| The download is differential (only the changed parts) | yes | yes | |
| A download that does not match its published checksum is refused | yes | | |
| Updated in place: the same file / one Programs and Features entry at the same location, the new executable only | yes | yes | `.deb`: one package, `apt install` of the new file |
| The new version keeps the old userData folder | yes | yes | `.deb` |
| The new version is offered, and Download opens its release page | | | yes |
| The machine policy turns updates off: no request reaches GitHub | old version's `/etc/<name>/policy.json` | old version's `AutoUpdate`=0 | old version's `policy.json` |
| A policy at the old version's location still applies to the new version | yes | yes (Restart now) | `.deb` |
| No host but GitHub is contacted (the new version; the old one from 0.2.1 on) | yes | yes | old version; new `.deb` |

Windows installs the x64 installer, the one people download. One more job installs the installer for
both processors that 0.2.0 also shipped (from 0.2.1 on there is one installer per processor,
`electron-builder.yml`): its installs update too, but the first time with a full download, because
the installer an install keeps for the next update is not the x64 one the updater picks.

0.2.0 still asks Google for spell-check dictionaries at start on Linux, so its runs only
list the other hosts it tried (`contactsOnlyGitHub` in `common.ts`).

Each run writes screenshots, the requests the app made in each scenario (`*-requests.txt`) and how the
download went (`*-download.txt`: differential or full, how many bytes) to its `out/` folder.

## Running it

- **Linux AppImage**, as root on a throwaway machine (a container, a CI runner or a Claude cloud
  session; it adds a user and trusts a test CA for that user):

  ```
  sudo env "PATH=$PATH" tests/update-rehearsal/linux.sh [--old 0.3.0] [--new 0.4.0] [--new-dir <dir>]
  ```

  Needs `npm ci`, curl, xvfb-run, runuser and certutil (`libnss3-tools`). `--old` defaults to the
  latest release and `--new` to the next patch version (at least 0.4.0, see Two names); set
  `REHEARSAL_WORK` to keep the files somewhere else than a new folder in `/tmp`.
- **CI**: `.github/workflows/update-rehearsal.yml` runs all of it, from the latest release to the
  next patch version, when these files, `src/features/updates/`, `electron-builder.yml` or
  `scripts/release-downloads.mjs` change, from the Actions tab (once the repository's default
  branch is `main`), and in the release workflow before it publishes (to the version being
  released). The Mac and `.deb` steps are in its `mac` and `deb` jobs.

## What it does not cover

- Installing updates on a Mac: that waits for releases signed with a Developer ID (backlog 1), and
  the move from `/Applications/Fartcrobat.app` to `Inkmoor.app` is the person's (the rehearsal only
  sees the old app's notice). The `.deb` installs no update itself (it would need a root password
  prompt): the job installs the new file as a person would.
- Windows Start menu and taskbar pins of `Fartcrobat.exe`, the `.pdf` default-app choice and
  remembered passwords across the rename: try them by hand (`docs/features/rename.md`).
- Windows on Arm, Intel Macs and Linux on Arm: the runners are x64 Windows, Apple silicon Macs and
  x64 Linux.
- The real github.com: after publishing, start the previous version once and let it update.
- SmartScreen and Gatekeeper, and the installer's own windows.
- UAC: GitHub's Windows runners run every step as an administrator and elevate without asking, so
  the per-machine run covers replacing the files in Program Files and the HKLM entries, but not the
  UAC prompt a per-machine update shows on a normal machine, a cancelled prompt (the installer
  quits and the app stays closed), or a standard user who cannot approve it. Try those by hand
  after publishing (`docs/features/updates.md`, Testing).
- The rehearsed build's own updater: the new version only starts and checks for updates. Its
  download and install run when the next release is rehearsed with it as the old version (unit
  tests and `tests/e2e/updates.spec.ts` cover that code until then).
- Mounting the AppImage with FUSE: the rehearsal runs it with `APPIMAGE_EXTRACT_AND_RUN=1`, which
  still sets `APPIMAGE`, the file the update replaces.
