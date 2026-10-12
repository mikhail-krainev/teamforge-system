# ACL of the isolated redis-resume instance (architecture 13.15): only the `resume-parse` queue.
user default off
user resume_producer on >{{REDIS_RESUME_PRODUCER_PASSWORD}} resetkeys ~bull:resume-parse:* resetchannels &bull:resume-parse:* +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
user resume on >{{REDIS_RESUME_PASSWORD}} resetkeys ~bull:resume-parse:* resetchannels &bull:resume-parse:* +@all -@admin -@dangerous -keys +info +client|setname +client|setinfo +client|id
