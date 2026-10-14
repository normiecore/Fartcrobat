#!/bin/sh
# Runs a command inside a private D-Bus session with an unlocked gnome-keyring (Secret Service).
# Everything (binaries extracted from the Ubuntu .debs, keyring files) stays under this folder;
# each run gets a new, empty keyring in state-<n>/. The runtime dir is relative because the
# scratch path is too long for a Unix socket path.
# Usage: keyring/run-with-keyring.sh <absolute command...>
HERE=$(cd "$(dirname "$0")" && pwd)
export PATH="$HERE/root/usr/bin:$PATH"
export LD_LIBRARY_PATH="$HERE/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
STATE="$HERE/state-$(date +%s%N)"
mkdir -p "$STATE/r" && chmod 700 "$STATE/r"
cd "$STATE" || exit 1
export XDG_DATA_HOME="$STATE/data" XDG_CONFIG_HOME="$STATE/config" XDG_RUNTIME_DIR=r
exec dbus-run-session -- sh -c '
  printf "keyring-pw" | gnome-keyring-daemon --unlock --components=secrets --daemonize >/dev/null
  sleep 1
  "$@"' sh "$@"
