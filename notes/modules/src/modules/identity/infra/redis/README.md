# Shared Redis limiter

The stage 7b adapter proves that the AttemptLimiter port can move from
process-local state to shared infrastructure without changing identity
operations.

Origin: observed during implementation and the real-process check on
2026-09-13. tools/verify_limiter.py ran two independent HTTP processes against
one Redis 8 instance and saw ten distributed login 401 responses followed by a
shared 429. The Redis keys contained only HMAC-derived fields; sentinel
credentials and the limiter URL were absent from manifests and logs.

What and why: the adapter uses one atomic Lua script for subject and source
buckets. Capacity is preflighted for all new fields before any writes because a
Redis script error does not roll back earlier writes in the same script. Root
keeps the implementation swappable through AUTH_LIMITER=local or redis.

The trusted source policy stays in root. X-Forwarded-For is ignored unless the
immediate peer is in HTTP_TRUSTED_PROXIES, and malformed chains fall back to
the canonical peer address.

Used in: src/modules/identity/infra/redis/limiter.ts, src/root/proxy.ts and
tools/verify_limiter.py. The selected live mutation run caught threshold,
raw-subject and boundary-comparison regressions; see
[mutation evidence](limiter-mutation-evidence.json). See CONTRACT.md for the
requirements.
