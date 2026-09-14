# Organization authenticated HTTP transport

The org transport exposes the browser-facing org workflows:
`POST /v1/org/organizations`, principal-scoped `GET /v1/org/organizations`,
`POST /v1/org/invitations`, `POST /v1/org/invitations/accept` and
`POST /v1/org/memberships/role`. Create, invite and role bodies are strict
JSON objects; acceptance contains only `invitation_id`. Root supplies identity's
session admissions and a small principal-ID projection. The transport never
accepts an owner, inviter, invitee or actor identity from a trusted header.

The identity boundary used for creation is `requireSessionPost`, which performs
the session, Origin and CSRF checks before the org handler runs. The read route
uses `requireSession`, accepts a bounded `limit` query (default 50), and asks an
org-owned reader for memberships belonging to the admitted principal. Create
success is a 201 projection; list success is a 200 projection; both carry
`Cache-Control: no-store`. Malformed bodies, invalid limits, missing sessions
and admission failures retain their public failure types. The transport imports
neither identity storage nor PostgreSQL.

The root adapter checks that the admitted principal is active through the
org-owned eligibility port, then the org store writes both snapshots in one
PostgreSQL transaction. The separate eligibility check still does not promise
immunity to a concurrent suspension; a stronger guarantee belongs in a future
coordinated adapter.

Verified by the mirrored `tools/verify_auth_http.py` live process run against
PostgreSQL 18 and Mailpit: creation, principal-scoped listing, invitation,
authenticated acceptance, replay refusal, role promotion, admin/owner policy,
bounded query refusal, strict body refusal, Origin/CSRF/session refusal, one
organization row and two memberships passed in Go, Rust and Nest. See [the
evidence](org-http-verification-evidence.json).
