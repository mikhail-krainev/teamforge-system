# Test stack (docker-compose.test.yml): same command restrictions as users.acl.tpl, but any key and
# channel, because every test file uses its own BullMQ prefix (QUEUE_PREFIX=tf-<random>).
user default off
user api on >{{REDIS_API_PASSWORD}} ~* &* +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
user worker on >{{REDIS_WORKER_PASSWORD}} ~* &* +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
user linkcheck on >{{REDIS_LINKCHECK_PASSWORD}} ~bull:link-check:* +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
