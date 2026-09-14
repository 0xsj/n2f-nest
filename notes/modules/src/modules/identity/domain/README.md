# Principal invariants before effects

**Current direction:** authentication is required baseline scope. These are the
completed principal leaves; the credential/session/challenge leaves are implemented
too, with their own [language walkthrough](auth-leaves-walkthrough.md),
[mutation evidence](auth-mutation-evidence.json) and
[boundary note](authentication-boundaries.md).

The first domain slice is a pure principal lifecycle; registering this value does
not persist a user, establish credentials, authenticate a caller or publish an event.

**Origin:** contract-first tests against refusing implementations on 2026-09-12,
followed by implementation-visible review and selected mutation checks.

Registration and restoration are different operations. Registration establishes
active/version 1; restoration preserves stored status, time and version after
validation. Reusing the registration constructor for a database read would silently
erase history. The restore-history mutation demonstrates that the tests detect it.

Suspend and activate return new values. The expected version detects a stale value
at this boundary, but two callers can both derive version 2 from the same version 1.
A later persistence adapter must enforce the expected version in its write and
check the affected-row count. These tests establish no database concurrency guarantee.

Display names retain spelling and surrounding spaces. The limit counts Unicode
scalar values, not bytes, UTF-16 units or user-perceived grapheme clusters.
The shared text validator handles scalar validity and blank input; the identity
rule additionally rejects C0/DEL. Display names are neither unique login names
nor verified email addresses.

The version ceiling is 2,147,483,647 in every build; timestamps use integer Unix
milliseconds up to 253402300799999. Common bounds prevent the host languages'
different numeric ranges from changing domain behavior.

## Verification and limits

Four named scenario tests cover registration, validation, immutable transitions,
and restoration. All passed. Initial positive scenarios failed against compilable
refusing stubs; those initial outputs were observed in the session, not archived.
Rust first had an inner-documentation placement compilation error; it was fixed
before the meaningful behavioral red run.

Four selected mutations compiled and were caught: removing the stale-version guard,
removing the same-state guard, omitting the version increment, and resetting version
during restore. Baseline and restored checks passed in isolated copies, and source
hashes were checked unchanged. See [mutation evidence](mutation-evidence.json)
and its adjacent raw logs. This is a selected fault set, not an exhaustive score,
and the tests were not implementation-blind.

I01–I07 are implemented. I08 records the intended application event; no event
encoding, state/outbox transaction, HTTP admission or audit consumer exists yet.

See [language details](language-walkthrough.md).
