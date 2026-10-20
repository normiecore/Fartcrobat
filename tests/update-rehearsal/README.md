# Update rehearsal

A released Fartcrobat, installed for real from each kind of download, finds the next version and
updates to it without anything being published: the Windows installer and the Linux AppImage
install a build of the next version, and the Mac app and the Ubuntu `.deb` send the person to its
release page. Run it before each release: the in-app updater (`docs/features/updates.md`) of the
version people have installed is what has to work, and it can only be tried with a newer release.

## How it works

- `fake-github.mjs` is an HTTP proxy that answers HTTPS for `github.com` and GitHub's release asset
  host itself, as GitHub does: the `/releases/latest` redirect and its JSON form, `releases.atom`,
  `latest*.yml`, and the installers with byte ranges (differential downloads). Every other host is
  refused and logged, so a rehearsal never reaches the internet.
- A packaged Fartcrobat ignores the `FARTCROBAT_UPDATE_*` test variables and always asks
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
  installs. For comparison it starts the released AppImage under the same limit and writes whether
  it stayed up into the job summary.

## Scenarios

| | Linux AppImage (`appimage.spec.ts`) | Windows installer (`windows.spec.ts`) | Mac `.dmg`, Ubuntu `.deb` (`notify.spec.ts`) |
| --- | --- | --- | --- |
| Restart now: asks about unsaved changes first, then installs and starts the new version | yes | per user, per machine | |
| Later: installs when the app quits, does not start again | yes | per user | |
| The download is differential (only the changed parts) | yes | yes | |
| A download that does not match its published checksum is refused | yes | | |
| The new version is offered, and Download opens its release page | | | yes |
| The machine policy turns updates off: no request reaches GitHub | `/etc/fartcrobat/policy.json` | `AutoUpdate`=0 | `policy.json` |
| No host but GitHub is contacted (the new version; the old one from 0.2.1 on) | yes | yes | old version |

Windows installs the x64 installer, the one people download. One more job installs the installer for
both processors that 0.2.0 also shipped (from 0.2.1 on there is one installer per processor,
`electron-builder.yml`): its installs update too, but the first time with a full download, because
the installer an install keeps for the next update is not the x64 one the updater picks.

0.2.0 still asks Google for spell-check dictionaries at start on Windows and Linux, so its runs only
list the other hosts it tried (`contactsOnlyGitHub` in `common.ts`).

Each run writes screenshots, the requests the app made in each scenario (`*-requests.txt`) and how the
download went (`*-download.txt`: differential or full, how many bytes) to its `out/` folder.

## Running it

- **Linux AppImage**, as root on a throwaway machine (a container, a CI runner or a Claude cloud
  session; it adds a user and trusts a test CA for that user):

  ```
  sudo env "PATH=$PATH" tests/update-rehearsal/linux.sh [--old 0.2.0] [--new 0.2.1] [--new-dir <dir>]
  ```

  Needs `npm ci`, curl, xvfb-run, runuser and certutil (`libnss3-tools`). `--old` defaults to the
  latest release and `--new` to the next patch version; set `REHEARSAL_WORK` to keep the files
  somewhere else than a new folder in `/tmp`.
- **CI**: `.github/workflows/update-rehearsal.yml` runs all of it, from the latest release to the
  next patch version, when these files, `src/features/updates/`, `electron-builder.yml` or
  `scripts/release-downloads.mjs` change, and from the Actions tab (once the repository's default
  branch is `main`). The Mac and `.deb` steps are in its `mac` and `deb` jobs.

## What it does not cover

- Installing updates on a Mac: that waits for releases signed with a Developer ID (backlog 1). The
  `.deb` installs none either (it would need a root password prompt).
- Windows on Arm, Intel Macs and Linux on Arm: the runners are x64 Windows, Apple silicon Macs and
  x64 Linux.
- The real github.com: after publishing, start the previous version once and let it update.
- SmartScreen and Gatekeeper, and the installer's own windows.
- UAC: GitHub's Windows runners run every step as an administrator and elevate without asking, so
  the per-machine run covers replacing the files in Program Files and the HKLM entries, but not the
  UAC prompt a per-machine update shows on a normal machine, a cancelled prompt (the installer
  quits and Fartcrobat stays closed), or a standard user who cannot approve it. Try those by hand
  after publishing (`docs/features/updates.md`, Testing).
- The rehearsed build's own updater: the new version only starts and checks for updates. Its
  download and install run when the next release is rehearsed with it as the old version (unit
  tests and `tests/e2e/updates.spec.ts` cover that code until then).
- Mounting the AppImage with FUSE: the rehearsal runs it with `APPIMAGE_EXTRACT_AND_RUN=1`, which
  still sets `APPIMAGE`, the file the update replaces.
