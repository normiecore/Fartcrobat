#!/bin/sh
# Two app runs in the same keyring session, with different userData folders.
E=/home/user/Fartcrobat/node_modules/electron/dist/electron
PROBE_USER_DATA="$1/ud1" "$E" --no-sandbox --disable-gpu "$1/../electron-probe/persist.cjs"
PROBE_USER_DATA="$1/ud2" "$E" --no-sandbox --disable-gpu "$1/../electron-probe/persist.cjs"
