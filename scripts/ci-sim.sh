#!/bin/sh
# Runs a command the way a bare GitHub ubuntu runner would see this machine: no pip-installed
# Python packages (pypdf, reportlab), no poppler pdfsig, no LibreOffice, and only 2 CPUs.
# Everything is hidden inside a private mount namespace; nothing on the system changes.
# Linux only; needs root (or permission to use unshare -m).
#
#   scripts/ci-sim.sh [--keep-tools] <command...>
#   --keep-tools  hide nothing (as on CI, which installs the tools), only limit CPUs
#
# Examples:
#   scripts/ci-sim.sh npm test
#   scripts/ci-sim.sh --keep-tools xvfb-run -a npx playwright test
set -e
EMPTY="$(mktemp -d)"
trap 'rmdir "$EMPTY"' EXIT
KEEP=0
if [ "$1" = "--keep-tools" ]; then KEEP=1; shift; fi
export EMPTY KEEP
unshare -m --propagation private sh -c '
  set -e
  if [ "$KEEP" = 0 ]; then
    for d in /usr/local/lib/python3*/dist-packages /root/.local/lib/python3*/site-packages /usr/lib/libreoffice; do
      [ -d "$d" ] && mount --bind "$EMPTY" "$d"
    done
    [ -e /usr/bin/pdfsig ] && mount --bind /dev/null /usr/bin/pdfsig
    python3 -c "import pypdf" 2>/dev/null && { echo "ci-sim: pypdf still importable" >&2; exit 2; }
    test ! -e /usr/bin/soffice || { echo "ci-sim: soffice still present" >&2; exit 2; }
  fi
  exec taskset -c 0,1 "$@"
' ci-sim "$@"
