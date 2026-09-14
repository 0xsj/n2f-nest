# Redis attempt limiter

This directory owns the Redis implementation of the identity attempt-limiter
port. It deliberately does not change application operations or HTTP policy.
See [CONTRACT.md](CONTRACT.md) for the atomic script, digest-only state and
failure behavior.
