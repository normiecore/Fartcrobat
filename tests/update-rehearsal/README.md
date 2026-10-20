# Update rehearsal

A released Fartcrobat updates itself, for real, to a build of the next version, without anything
being published. Run it before each release: the in-app updater (`docs/features/updates.md`) of the
version people have installed is what has to work, and it can only be tried with a newer release.

## How it works

- `fake-github.mjs` is an HTTP proxy that answers HTTPS for `github.com` and GitHub's release asset
  host itself, as GitHub does: the `/releases/latest` redirect and its JSON form, `releases.atom`,
  `latest*.yml`, and the installers with byte ranges (differential downloads). Every other host is
  refused and logged, so a rehearsal never reaches the internet.
- A packaged Fartcrobat ignores the `FARTCROBAT_UPDATE_*` test variables and always asks
  `github.com`, so the app is pointed at the proxy instead: the `https_proxy` variable on Linux
  (the update's restart inherits it) and `--proxy-server` on Windows.
- `make-certs.mjs` makes a test CA and a certificate for those two hosts. Linux trusts the CA in the
  test user's NSS database only; the Windows job trusts it machine-wide on its throwaway runner.
- The old version is the released file from GitHub, byte for byte. The new one is built from the
  checkout with only the version changed, or (Linux, `--new-dir`) any folder with an AppImage and its
  `latest-linux.yml`, such as the files of a release that is not published yet.

## Scenarios

| | Linux AppImage (`appimage.spec.ts`) | Windows installer (`windows.spec.ts`) |
| --- | --- | --- |
| Restart now: asks about unsaved changes first, then installs and starts the new version | yes | per user, per machine |
| Later: installs when the app quits, does not start again | yes | per user |
| A download that does not match its published checksum is refused | yes | |
| The machine policy turns updates off: no request reaches GitHub | `/etc/fartcrobat/policy.json` | `AutoUpdate`=0 |

Each run writes screenshots, the requests the app made in each scenario (`*-requests.txt`) and how the
download went (`*-download.txt`: differential or full, how many bytes) to its `out/` folder.

## Running it

- **Linux**, as root on a throwaway machine (a container, a CI runner or a Claude cloud session; it
  adds a user and trusts a test CA for that user):

  ```
  sudo env "PATH=$PATH" tests/update-rehearsal/linux.sh [--old 0.2.0] [--new 0.2.1] [--new-dir <dir>]
  ```

  Needs `npm ci`, curl, xvfb-run, runuser and certutil (`libnss3-tools`). `--old` defaults to the
  latest release and `--new` to the next patch version; set `REHEARSAL_WORK` to keep the files
  somewhere else than a new folder in `/tmp`.
- **CI**: `.github/workflows/update-rehearsal.yml` runs both, from the latest release to the next patch
  version, when these files or `src/features/updates/` change, and from the Actions tab (once the
  repository's default branch is `main`).

## What it does not cover

- macOS: updates only notify there until releases are Developer ID signed (backlog 1).
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
- A differential download on Windows: the rehearsal installs the combined x64 and arm64 installer,
  which is what an install keeps for the next update, while the updater picks the x64 installer and
  its blockmap. So the first update of such an install falls back to a full download (the
  `*-download.txt` report says which happened). On Linux the download must be differential.
- Mounting the AppImage with FUSE: the rehearsal runs it with `APPIMAGE_EXTRACT_AND_RUN=1`, which
  still sets `APPIMAGE`, the file the update replaces.
