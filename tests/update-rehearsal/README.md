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

Each run writes screenshots, the requests the app made (`*-requests.txt`) and how much the download
fetched (`*-download.txt`) to its `out/` folder.

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
- SmartScreen and Gatekeeper, and the installer's own windows (the update installs silently).
- Mounting the AppImage with FUSE: the rehearsal runs it with `APPIMAGE_EXTRACT_AND_RUN=1`, which
  still sets `APPIMAGE`, the file the update replaces.
