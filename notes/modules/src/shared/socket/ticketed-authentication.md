# Ticketed admission is not permanent authentication

The WebSocket ticket is a one-use, purpose-bound secret with a short lifetime.
The HTTP route issues it only for a valid session; the native upgrade boundary
requires the session cookie, exact allowed Origin, `n2f.v1` and the ticket
subprotocol. The database consumes the ticket atomically while rechecking the
session, principal status and authentication epoch, so replay and concurrent
use cannot turn one ticket into two admissions.

The socket handler receives only a safe principal projection. Identity keeps
the private session proof behind its own boundary and revalidates it before
each authenticated message and on the heartbeat path. Logout therefore does
not wait for the original ticket lifetime: the next protected message is
refused after the session is revoked.

The real-process `tools/verify_auth_http.py` check covers issuance, a 101
upgrade, ping/pong, single-use replay refusal, logout and post-logout
revalidation against PostgreSQL and Mailpit. It does not claim a missing-pong
soak, slow-consumer saturation benchmark or browser-client compatibility.

This is an identity admission mechanism, not a socket subscription or business
authorization policy. A future domain owns its message authorization and must
keep its own connection cleanup bounded.

[Generic socket ownership](lifetimes.md) records the lower-level adapter
lifetime rules.
