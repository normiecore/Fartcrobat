#!/bin/sh
# remember in one app run, find in the next (same keyring session, same userData)
E=/home/user/Fartcrobat/node_modules/electron/dist/electron
D=$(dirname "$0")
PROBE_STEP=remember PROBE_USER_DATA="$1" "$E" --no-sandbox --disable-gpu "$D/store-e2e.cjs" 2>/dev/null | grep RESULT
PROBE_STEP=find PROBE_USER_DATA="$1" "$E" --no-sandbox --disable-gpu "$D/store-e2e.cjs" 2>/dev/null | grep RESULT
PROBE_POLICY_OFF=1 PROBE_STEP=find PROBE_USER_DATA="$1" "$E" --no-sandbox --disable-gpu "$D/store-e2e.cjs" 2>/dev/null | grep RESULT
