#!/bin/sh
# One-shot job: creates the private buckets through the S3 API (idempotent) and checks that they are
# not publicly readable. Runs in the amazon/aws-cli image, so it works with any S3 backend.
set -eu

export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY:?}"
export AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY:?}"
export AWS_DEFAULT_REGION=us-east-1
export AWS_EC2_METADATA_DISABLED=true
export AWS_PAGER=""

s3api() { aws --endpoint-url "$S3_ENDPOINT" s3api "$@"; }

for bucket in ${S3_BUCKETS:?}; do
  if s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    echo "bucket $bucket exists"
  else
    s3api create-bucket --bucket "$bucket" >/dev/null
    echo "bucket $bucket created"
  fi
  # Anonymous access must be refused: private buckets only.
  status=$(curl -s -o /dev/null -w '%{http_code}' "$S3_ENDPOINT/$bucket/" || true)
  case "$status" in
    403) ;;
    *) echo "bucket $bucket answers anonymous requests with HTTP $status (expected 403)" >&2; exit 1 ;;
  esac
done
echo "buckets ready"
