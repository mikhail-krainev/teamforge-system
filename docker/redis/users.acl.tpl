# Redis ACL users (architecture 13.16, SEC-10). Rendered by docker/redis/start.sh: each double-brace placeholder is replaced
# with the environment variable of the same name. The `default` user is off, so every client must authenticate.
#
# Commands: everything except @admin, @dangerous (FLUSHALL, FLUSHDB, CONFIG, DEBUG, MODULE, ...) and KEYS.
# BullMQ additionally needs INFO (version check); ioredis names its connections with CLIENT SETNAME.
user default off
user api on >{{REDIS_API_PASSWORD}} resetkeys ~better-auth:* ~rl:* ~demand:* ~gh_state:* ~bull:* resetchannels &rt:* &outbox:kick +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
user worker on >{{REDIS_WORKER_PASSWORD}} resetkeys ~bull:* ~gh_inst_token:* ~demand:* ~user:* resetchannels &rt:* &outbox:kick +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
user linkcheck on >{{REDIS_LINKCHECK_PASSWORD}} resetkeys ~bull:link-check:* resetchannels +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
