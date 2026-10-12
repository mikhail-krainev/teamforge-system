# Test stack (docker-compose.test.yml) ACL of redis-resume: the production restrictions of
# users.resume.acl.tpl (one purpose, no admin or dangerous commands), but any key and channel because
# every test file uses its own BullMQ prefix (QUEUE_PREFIX=tf-<random>).
user default off
user resume_producer on >{{REDIS_RESUME_PRODUCER_PASSWORD}} ~* &* +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
user resume on >{{REDIS_RESUME_PASSWORD}} ~* &* +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
