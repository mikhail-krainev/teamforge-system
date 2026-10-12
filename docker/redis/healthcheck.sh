#!/bin/sh
# Usage: healthcheck.sh <user> <password-variable-name>
# Authenticates as a real ACL user: the `default` user is disabled.
set -eu
password=$(printenv "$2")
redis-cli --user "$1" --pass "$password" --no-auth-warning ping | grep -q PONG
