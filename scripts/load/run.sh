#!/bin/sh
# Runs one k6 scenario (or all of them) from the pinned grafana/k6 image against the isolated load stack.
# Usage, from the repository root:  sh scripts/load/run.sh [seat-take|stage-transition|checklist-version|webhook-storm]
# Without an argument all four run in sequence; the exit code is non-zero when any threshold failed.
# Environment: LOAD_API_URL (default http://host.docker.internal:24000), LOAD_ORIGIN (default http://localhost:23000),
# LOAD_CHECKLIST_ROUNDS, LOAD_WEBHOOK_DELIVERIES, LOAD_WEBHOOK_COPIES (see docs/release.md, section 5).
set -eu

# Pinned by tag and digest (architecture 13.18). Update the digest only together with the tag.
K6_IMAGE='grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34'
DIR="$(cd "$(dirname "$0")" && pwd)"
SCENARIOS="${1:-seat-take stage-transition checklist-version webhook-storm}"
STATUS=0

for NAME in $SCENARIOS; do
  echo "== k6: $NAME"
  # MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting the container path /work.
  MSYS_NO_PATHCONV=1 docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -v "$DIR:/work:ro" \
    -e LOAD_API_URL -e LOAD_ORIGIN -e LOAD_CHECKLIST_ROUNDS -e LOAD_WEBHOOK_DELIVERIES -e LOAD_WEBHOOK_COPIES \
    "$K6_IMAGE" run --quiet --no-usage-report "/work/$NAME.js" || STATUS=1
done
exit "$STATUS"
