#!/bin/sh
# Local S3 (ADR-0019): SeaweedFS master + volume + filer + S3 gateway in one process.
# Renders the S3 identity file from S3_ACCESS_KEY / S3_SECRET_KEY, then hands over to the image entrypoint
# (which drops privileges to the `seaweed` user).
set -eu

: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"

config=/tmp/s3-identities.json
cat > "$config" <<JSON
{
  "identities": [
    {
      "name": "teamforge",
      "credentials": [{ "accessKey": "$S3_ACCESS_KEY", "secretKey": "$S3_SECRET_KEY" }],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
JSON
chown seaweed "$config"
chmod 600 "$config"

# -master.telemetry=false: no anonymous statistics leave the host.
exec /entrypoint.sh server -s3 -s3.port=9000 -s3.config="$config" \
  -master.telemetry=false -master.volumeSizeLimitMB="${SEAWEEDFS_VOLUME_SIZE_MB:-256}" "$@"
