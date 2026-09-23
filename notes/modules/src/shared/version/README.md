# Version module notes

A persisted aggregate carries the optimistic-concurrency token it was loaded
at, so a write can refuse to overwrite state it never saw.

## Origin

The 2026-09-23 robustness review found that every PostgreSQL writer updated
rows by ID alone. Two operations that read the same state could both commit;
the later one silently reverted the earlier (a revoked member reactivated, a
verification challenge consumed twice). See the
[hardening bar](../../../../architecture/hardening-bar.md), item R1.

## What and why

- `restore()` requires a stored version (a positive safe integer); a newly
  created aggregate is `UNSAVED` (0).
- State transitions keep the version. It names the stored state a change was
  derived from, not a count of in-memory changes, so a command that applies
  two transitions before writing still checks against what it read.
- Writers update with `version=version+1 WHERE version=$loaded` and treat no
  matching row as a stale write (`<module>.stale_write`, kind `conflict`).
  Inserts store `FIRST` (1).
- In-memory adapters perform the same comparison and store `aggregate.saved()`
  — the state as storage holds it after the write.

A status guard (`WHERE status='pending'`) was the alternative. It suffices for
single-source transitions but not for updates that keep the status, such as a
role change, so one pattern is used everywhere.

## Example

```ts
UPDATE public.n2f_identity_sessions
   SET status=$2, revoked_at=$3, version=version+1
 WHERE id=$1::uuid AND version=$4
```

## Gotchas

- A new module that skips the version check reintroduces lost updates without
  any test failing. The adapter contract specs
  (`src/modules/*/infra/adapters.contract.spec.ts`, built on
  `test/support/adapter-contract.ts`) are the guard: copy the stale-write case
  for every new writer.
- The version is not a domain event count and must not be exposed as one.

## Used in

- `src/shared/version/index.ts`
- `src/modules/identity/domain/{identity,session,verification-challenge}.ts`
- `src/modules/identity/infra/postgres/*` and `infra/in-memory/adapters.ts`
- `src/modules/organization/domain/{organization,membership,invitation}.ts`
- `src/modules/organization/infra/{postgres,in-memory}/*-writer.ts`
- `src/modules/{document,jobs}/domain/*.ts` and their `infra/{postgres,in-memory}/writer.ts`
- `test/support/adapter-contract.ts`: shared helpers for the contract specs
