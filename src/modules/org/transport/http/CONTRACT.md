# Organization HTTP transport

This boundary owns authenticated organization and membership projections. It
depends only on org application operations, root-supplied session admissions,
and a root-supplied safe principal-ID extractor. It does not import identity,
inspect cookies, choose eligibility, or access persistence.

| Scenario | Observable guarantee |
| --- | --- |
| T01 | `POST /v1/org/organizations` requires the root's authenticated session admission; the owner principal is taken from that admission, never from JSON. |
| T02 | The request is exactly one JSON object with one non-empty string member, `name`; duplicate, unknown, nested, non-string or trailing input is `400 / http.invalid_body`. |
| T03 | A successful create returns `201` with organization and initial-owner snapshots and `Cache-Control: no-store`. |
| T04 | Application failures preserve their classification and public type and are projected with `Cache-Control: no-store`. |
| T05 | The route exposes no identity or database types; root owns the translation from session admission to the org-owned principal reference and eligibility port. |
| T06 | `GET /v1/org/organizations` requires authenticated GET admission and returns only memberships for the admitted principal. |
| T07 | List responses are bounded to 1–100 items (`limit`, default 50); invalid or repeated limits are `400 / org.invalid_query`. |
| T08 | A successful list returns organization and membership snapshots with `200` and `Cache-Control: no-store`; an empty membership set is a valid empty list. |
| T09 | `POST /v1/org/invitations` requires POST admission and exactly `organization_id`, `principal_id` and `role` (`admin` or `member`); the inviter is taken from the authenticated session and success returns `201` with `Cache-Control: no-store`. |
| T10 | `POST /v1/org/invitations/accept` requires POST admission and exactly `invitation_id`; the invitee is taken from the authenticated session, and success returns the accepted invitation plus membership with `200` and `Cache-Control: no-store`. |
| T11 | `POST /v1/org/memberships/role` requires POST admission and exactly `organization_id`, `principal_id` and `role`; application authorization and owner protection are preserved with `200` success or typed refusal and `Cache-Control: no-store`. |

The shared server enforces JSON media type and body bounds before this handler;
the route owns only its object shape and response projection. CSRF and exact
Origin and CSRF checks remain identity transport policy supplied by root
admission. The transport never accepts an inviter, invitee or actor identity
from a trusted header; only the target principal in the explicit org command
body is caller-selected.
