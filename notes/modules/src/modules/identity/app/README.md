# TypeScript: application operations against fakes

**Origin:** implementing the identity commands and the authenticate query (U01–U16)
on 2026-09-12 against specs written first, then six hand-run mutations.

The spec's fake token codec first ignored the purpose encoded in a fake token, so a
reset token presented to email verification found the verification challenge and
succeeded. The real codec cannot know a token's purpose either; it produces a
different digest because the purpose is part of the hash (T03). The fake now models
that by returning a foreign digest when purposes disagree. A fake that is more
lenient than the adapter it stands for hides exactly the confusion the contract
forbids.

Refusal order is observable through the fakes. Reset validates the new password's
shape and blocklist before evaluating the challenge, as U13 lists it, so a consumed
challenge plus a malformed password reports the request-shape refusal; the first
draft consumed first and the spec caught it. Login runs the same verification work
for wrong, unverified and suspended credentials before returning one refusal, and
the recorded call list is how the spec proves that.

The store is one intersection type of nine operation interfaces. Each command
narrows it to the members it calls, so a root can hand the same adapter to every
command while a fake for one command implements only its slice. The intersection
is a convenience for composition, not a repository abstraction.

Mail is a `Promise<boolean>` that may also reject; both are "not delivered" and
neither fails the command (A15). The result carries `mailDelivered` privately so a
transport can log a safe outcome without the application owning a logger.

Envelope payloads are plain records of IDs, enums and versions. The specs scan the
encoded bytes for the email, local part, password, hash prefix, token prefix and
source key; the private_event_data mutation adds the email to one payload and is
caught by that scan rather than by a schema.

**Limits:** every port is a fake. Transactions, locks, concurrent single-use,
timing, real mail and rate limiting are stage 5+ obligations named in CONTRACT.md.
Six mutations (enumeration leak, duplicate replacement, mail after uncertain
commit, verification without proof, stale as success, private event data) were
caught in place with hash-verified restoration; no isolated-copy evidence yet.

**Used in:** app/command/*.ts, app/query/index.ts and their specs. See the
[application contract](../../../../../../src/modules/identity/app/CONTRACT.md).
