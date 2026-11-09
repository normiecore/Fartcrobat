#!/bin/sh
# Update rehearsal for the Linux AppImage (README.md): the released AppImage of OLD, installed in a
# test user's home, updates itself to NEW from a fake GitHub. Root only, on a throwaway machine (a
# container or a Claude cloud session): it adds a user, trusts a test CA for that user and writes
# /etc/fartcrobat/policy.json (the old version's policy file) during the policy scenarios.
#
#   tests/update-rehearsal/linux.sh [--old 0.2.0] [--new 0.2.1] [--new-dir <dir>]
#
# --old defaults to the latest release, --new to the next patch version (0.4.0 when that would
# still be a Fartcrobat version: this checkout builds Inkmoor; names.mjs).
# --new-dir: a folder with the NEW AppImage (Fartcrobat-x86_64.AppImage up to 0.3,
# Inkmoor-x86_64.AppImage from 0.4.0) and latest-linux.yml (for example a release's files).
# Without it, NEW is built from this checkout with only the version changed.
# Needs node, npm ci done, curl, xvfb-run, runuser, certutil (libnss3-tools) and ps/pkill.
set -eu

OLD=
NEW=
NEW_DIR=
while [ $# -gt 0 ]; do
  case "$1" in
    --old) OLD=$2; shift 2 ;;
    --new) NEW=$2; shift 2 ;;
    --new-dir) NEW_DIR=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "Run as root on a throwaway machine (see README.md)." >&2; exit 2; }
if [ -z "$OLD" ]; then
  OLD=$(curl -fsSI https://github.com/normiecore/Inkmoor/releases/latest |
    sed -n 's|^[Ll]ocation: .*/releases/tag/v\([0-9][0-9.]*\).*|\1|p' | tr -d '\r')
  [ -n "$OLD" ] || { echo "Could not find the latest release; pass --old." >&2; exit 2; }
fi
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NAMES="$ROOT/tests/update-rehearsal/names.mjs"
if [ -z "$NEW" ]; then
  NEW=$(node "$NAMES" default-new "$OLD")
fi
# OLD must ask the repository NEW is published in (normiecore/Inkmoor from 0.4.1; names.mjs).
node "$NAMES" same-repo "$OLD" "$NEW" || exit 2
# Each side's file names come from its version: Fartcrobat up to 0.3, Inkmoor from 0.4.0.
OLD_APPIMAGE=$(node "$NAMES" "$OLD" appImage)
NEW_APPIMAGE=$(node "$NAMES" "$NEW" appImage)
WORK=${REHEARSAL_WORK:-$(mktemp -d /tmp/fartcrobat-rehearsal.XXXXXX)}
TEST_USER=${REHEARSAL_USER:-fartcrobat-rehearsal}
RELEASES=$WORK/releases
mkdir -p "$RELEASES/v$OLD" "$RELEASES/v$NEW" "$WORK/out"
echo "Rehearsal $OLD -> $NEW in $WORK, as user $TEST_USER"

# 1. The released AppImage of OLD and its update metadata, as GitHub serves them.
for f in "$OLD_APPIMAGE" latest-linux.yml; do
  [ -f "$RELEASES/v$OLD/$f" ] ||
    curl -fsSL -o "$RELEASES/v$OLD/$f" "https://github.com/normiecore/Inkmoor/releases/download/v$OLD/$f"
done

# 2. NEW: given, or built from this checkout with only the version changed.
if [ -z "$NEW_DIR" ]; then
  # A build of this checkout has the names of NEW's side only if NEW is a version of that name.
  node "$NAMES" check-build "$NEW" || exit 2
  NEW_DIR=$WORK/build-new
  (cd "$ROOT" && npm run build && npx electron-builder --linux AppImage --publish never \
    -c.extraMetadata.version="$NEW" -c.directories.output="$NEW_DIR")
fi
cp "$NEW_DIR/$NEW_APPIMAGE" "$NEW_DIR/latest-linux.yml" "$RELEASES/v$NEW/"

# 3. A release whose published checksum does not match its AppImage (99.0.0, never real).
mkdir -p "$RELEASES/v99.0.0"
ln -sf "$RELEASES/v$NEW/$NEW_APPIMAGE" "$RELEASES/v99.0.0/$NEW_APPIMAGE"
OLD_SHA=$(sed -n 's/^sha512: //p' "$RELEASES/v$OLD/latest-linux.yml")
NEW_SHA=$(sed -n 's/^sha512: //p' "$RELEASES/v$NEW/latest-linux.yml")
sed -e "s/^version: .*/version: 99.0.0/" -e "s|$NEW_SHA|$OLD_SHA|g" "$RELEASES/v$NEW/latest-linux.yml" > "$RELEASES/v99.0.0/latest-linux.yml"

# 4. The test user, who trusts the rehearsal CA (Chromium reads the user's NSS database).
id "$TEST_USER" >/dev/null 2>&1 || useradd -m -s /bin/sh "$TEST_USER"
HOME_DIR=$(getent passwd "$TEST_USER" | cut -d: -f6)
chmod 755 "$HOME_DIR"
node "$ROOT/tests/update-rehearsal/make-certs.mjs" "$WORK/tls"
install -d -o "$TEST_USER" -g "$TEST_USER" "$HOME_DIR/.pki/nssdb"
install -o "$TEST_USER" -m 644 "$WORK/tls/ca.pem" "$HOME_DIR/.pki/rehearsal-ca.pem"
# A database from an earlier run is kept (certutil -N would ask for its password).
[ -f "$HOME_DIR/.pki/nssdb/cert9.db" ] ||
  runuser -u "$TEST_USER" -- certutil -d "sql:$HOME_DIR/.pki/nssdb" -N --empty-password </dev/null
runuser -u "$TEST_USER" -- certutil -d "sql:$HOME_DIR/.pki/nssdb" -D -n 'Fartcrobat Update Rehearsal CA' 2>/dev/null || true
runuser -u "$TEST_USER" -- certutil -d "sql:$HOME_DIR/.pki/nssdb" -A -t 'C,,' -n 'Fartcrobat Update Rehearsal CA' -i "$HOME_DIR/.pki/rehearsal-ca.pem"

# 5. The scenarios (appimage.spec.ts), on a virtual display the test user may use.
cd "$ROOT"
status=0
REHEARSAL_WORK=$WORK REHEARSAL_OUT=$WORK/out REHEARSAL_USER=$TEST_USER REHEARSAL_HOME=$HOME_DIR \
  REHEARSAL_OLD=$OLD REHEARSAL_NEW=$NEW \
  xvfb-run -n "${REHEARSAL_DISPLAY:-99}" -s "-screen 0 1280x900x24 -ac" \
  npx playwright test -c tests/update-rehearsal/playwright.config.ts appimage || status=$?
pkill -KILL -u "$TEST_USER" 2>/dev/null || true
rm -f "$(node "$NAMES" "$OLD" linuxPolicy)" "$(node "$NAMES" "$NEW" linuxPolicy)"
echo "Results, screenshots and the requests the app made: $WORK/out"
exit $status
