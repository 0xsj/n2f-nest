# Root: composing the authentication process

**Origin:** wiring AUTH_BUILD.md into the HTTP process on 2026-09-12 and running
`tools/verify_auth_http.py` against PostgreSQL 18.

Auth settings are read only when `AUTH_ENABLED` is true, so a process without
auth has an unchanged manifest; with auth the reader records every `AUTH_*` key
with secrets redacted. The manifest is a logger record, `http.manifest`, with the
mail mode, blocklist entry count and limiter kind as flat fields, emitted before
the listener opens. Nested log fields tripped the shared verifier once: it read
the route from the record root, which is where Go's logger puts it; it now reads
either shape.

The base configuration still requires `DEMO_TOKEN`, a leftover of the
foundations demo, so the auth verifier sets the same fixture value the
infrastructure verifier uses. Adapters are wrapped into ports at the root: the
hasher's `match`/`mismatch` outcome becomes a boolean, `verifyAbsent` always
false, the codec's issued pair passes through. The operations are created with
one config object and the transport with the cookie, origin and CSRF settings;
no module imports another.

**Limits:** the process-local limiter and undelivered mail are stand-ins; the
manifest says so. Readiness is unchanged and adds no auth probe.

**Used in:** src/root/auth.ts and src/root/http.ts. See [AUTH_BUILD.md](../../../../AUTH_BUILD.md).
