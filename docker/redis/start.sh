#!/bin/sh
# Renders the ACL template with passwords from the environment, then starts redis-server.
# Usage: start.sh <acl-template> [redis-server arguments...]
set -eu

template="$1"
shift
acl_file=/tmp/users.acl

awk '
/^[[:space:]]*(#|$)/ { next }   # the ACL file format has no comments
{
  line = $0
  while (match(line, /\{\{[A-Z_]+\}\}/)) {
    name = substr(line, RSTART + 2, RLENGTH - 4)
    if (ENVIRON[name] == "") { print "missing environment variable " name > "/dev/stderr"; exit 1 }
    line = substr(line, 1, RSTART - 1) ENVIRON[name] substr(line, RSTART + RLENGTH)
  }
  print line
}' "$template" > "$acl_file"
chmod 600 "$acl_file"

exec redis-server --aclfile "$acl_file" --protected-mode yes --maxmemory-policy noeviction "$@"
