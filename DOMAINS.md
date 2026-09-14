# First domains: identity, audit and org

Status: identity principal leaves I01–I07, the authentication leaves, the crypto
adapters, the application operations, the PostgreSQL store, the identity HTTP
transport, SMTP mail delivery and root composition are implemented and tested.
The first audit ingestion slice, shared Redis limiter and trusted-proxy policy
are implemented; WebSocket ticket admission and the first audit read/ingestion
slice are also implemented. Socket revalidation is now implemented and live
verified; the org value leaves, membership workflows, PostgreSQL persistence
adapter and root-composed authenticated organization routes are live-verified.
Ownership transfer, removal and suspension remain planned below.

## Ownership map

| Owner | Owns | Does not infer |
| --- | --- | --- |
| Identity | Principals, credentials, verification/recovery and revocable sessions; authentication is baseline scope | Organization membership or organization roles |
| Org | Organizations, memberships, invitations and organization roles | Authentication from a principal ID |
| Audit | Durable business facts, actor/subject/action/outcome and provenance | Business success from a diagnostic log |
| Root | Cross-domain translation, resource wiring and authorized workflow composition | Domain policy from transport or SDK configuration |

Modules do not import peers. Application consumers declare the capability they need;
root supplies translations using the other module's deliberate application surface.
No database driver, HTTP framework, NATS or OTel type enters domain/application APIs.

## First workflow and order

1. Identity leaf contracts and tests: validated principal values, explicit state,
   snapshots and versioned lifecycle transitions. Registration starts with principal
   values. Built-in authentication is required; credentials and sessions now follow
   the [auth contract and build order](AUTHENTICATION.md), before persistence.
2. Complete identity authentication: credential/session/challenge leaves, crypto
   adapters, application operations, PostgreSQL, HTTP admission and Mailpit. State
   and promised safe events commit together. Failure and uncertain commit remain
   distinct; no automatic write retry. Account/profile is not an auth prerequisite.
3. Audit ingestion: translate the identity event at root into an audit-owned fact.
   Persist its record and consumer receipt atomically. Deduplicate per consumer;
   do not let one global processed flag silently stand for multiple subscribers.
4. Organization creation, initial owner membership, invitations and role changes,
   with principal eligibility supplied through an org-owned port and composed by
   root. The value leaves, application workflows, PostgreSQL adapter and
   authenticated create/list/invite/accept/role routes are implemented and
   live-verified. Ownership transfer, removal and suspension are separate next
   policy decisions.

The domain specification precedes each implementation. Pure values and transitions
come before application ports, persistence and transport. Comparable tests exercise
refusal, rollback, concurrency and duplicate delivery through both publisher choices.
Targeted mutations probe meaningful invariants; notes mirror full source paths.

## Security and consistency decisions to preserve

A supplied principal ID is a reference, not authentication. Bootstrap/service-driven
provisioning and authenticated self-service registration are different admission
policies and must be named at the eventual transport boundary. Display names are
presentation data, not unique usernames or verified email addresses.

Identity existence and organization authorization are different questions. An org
consumer must specify whether it requires a known principal, an active principal,
or a stronger coordinated guarantee. A lookup followed by a separate transaction
cannot silently promise immunity to concurrent principal suspension.

An accepted state-changing command promises an outbox fact, not immediate audit
visibility. Audit is asynchronously observable; receipt and record must commit
atomically. Business denials may require their own audit policy and are not inferred
from successful-event ingestion. No organization workflow or audit retention policy
is implied by a placeholder directory.
