#!/bin/sh
# Isolation check of the resume sandbox (S2-10, architecture 13.15): starts the image with the same
# restrictions as docker-compose.yml and asks the parse child for its uid, environment and whether it
# can read the environment of its parent. Usage: sh docker/resume-worker/check-isolation.sh [image]
set -eu
image="${1:-teamforge-resume-worker:local}"
report=$(docker run --rm --network none --read-only --tmpfs /tmp:size=16m,noexec,nosuid \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 512m --user 0:0 -e PARENT_ONLY_SECRET=must-not-leak \
  "$image" node dist/resume-worker/main.js --selfcheck)
echo "$report"
echo "$report" | grep -q '"uid":"10002"' || { echo "FAIL: the child does not run as uid 10002" >&2; exit 1; }
echo "$report" | grep -q '"env":\[\]' || { echo "FAIL: the child has an environment" >&2; exit 1; }
echo "$report" | grep -q '"canReadParentEnvironment":false' || { echo "FAIL: the child reads /proc/<ppid>/environ" >&2; exit 1; }
echo "OK: the child runs as uid 10002 with an empty environment and cannot read the parent's"
